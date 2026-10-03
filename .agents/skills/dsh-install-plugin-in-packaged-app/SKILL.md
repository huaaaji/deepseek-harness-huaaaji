---
name: dsh-install-plugin-in-packaged-app
description: Use when a changed DeepSeek Harness plugin must reach an already-installed application (DSH Desktop, a signed bundle, any frozen installation) whose own copies of the package cannot be rebuilt, to choose between rebuilding the app, installing a profile-local override, and shipping a renamed fork bundle, and to prove the install end to end.
---

# Installing a plugin into a packaged DSH application

A packaged application resolves plugins from its own frozen installation. Deciding *how* a change reaches it is a resolution question before it is a packaging question, and the answer determines what you must build.

## Decide the route first

| Situation | Route |
| --- | --- |
| The application can be rebuilt and reinstalled | Rebuild it. Nothing below applies. |
| The profile may be edited outside the GUI, package names stay as shipped | Profile-local install: `pnpm add -w link:<checkout>/packages/<group>/<pkg>` in `~/.dsh/profiles/<profile>` |
| The Plugins page must install it into a frozen application | Renamed fork bundle — the rest of this skill |

Read the resolution rules before choosing; both traps below are silent until install time.

- `resolveBundleDir` (`packages/boot/app-boot/src/profile.ts`) tries the **installation anchor first**, then the profile. `installBundle` (`packages/boot/plugin-manager/src/index.ts`) reads the bundle declaration through it, and `listBundles` lists every name in the installation manifest. A name the application already ships therefore reports the *frozen* copy: "This package declares no bundle, so it cannot be managed as a plugin", and a same-named install is rolled back after pnpm runs, whatever spec form was used.
- Runtime row resolution is the opposite order: a name in the profile manifest's **direct** dependencies routes to the profile copy before the installation entries (`routeLocalPackage` in `packages/boot/app-boot/src/profile-resolution/resolver.ts`), and `pnpm-workspace.yaml` in the profile sets `autoInstallPeers: false`, so peer packages stay the installation's single instance. This is why a profile-local install overrides a frozen copy at runtime even though the manager refuses to create it.

## Build a renamed fork bundle

One package can carry everything: a name the installation does not ship, the newer Node half, the paired browser half, and the layer patch that retires the shipped rows.

1. **Pick a name the application does not depend on** (for example `@dsh-local/git-status`). It never reaches `not-bundle`, because the installation anchor cannot resolve it and the profile anchor can.
2. **Ship the Node half without rebuilding it**: copy `lib/index.js`, `lib/typert.host.js`, `lib/typert.remote-client.js` and `lib/types/**` from the changed package and replace the old package name string inside those artifacts. Descriptor ids and the contribution's `package` field are labels; the wire endpoint is `namespace/method` and does not change. Peer imports (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-typert-protocol`) stay external and resolve to the installation's copies; keep `zod` and `@deepseek-ai/schemastery` in `dependencies`, or the Node half fails to import.
3. **Rebuild the browser half with the added behavior**, because a bundle cannot be patched in place:
   - temporarily rename the package and its `clientBundle('<id>', …)` literal to the fork id;
   - add whatever the newer widget needs — for a namespace the application's assembly already mounts, mount **only the new descriptors**:
     ```ts
     import remote from '@deepseek-ai/dsh-host-git-status/remote'
     ctx.effect(() => ctx.remote.$mount({
       ...remote,
       descriptors: remote.descriptors.filter(descriptor => descriptor.method === 'repositories'),
     }), 'ui-git-status: repositories Remote')
     ```
     A full second contribution fails with `direct method <namespace>/<method> is already mounted`.
   - make the changed package resolvable for the build (a manual `node_modules/@scope/<pkg>` symlink is enough) and run its own build (`tsc -b <pkg>/tsconfig.json` then `tsdown --env.DSH_BUILD_FACE client` from the package directory);
   - copy the emitted `lib/client.js` out, restore the manifest, config, and sources, and rebuild the original bundle so the checkout is clean again.
4. **Declare the layer** in the fork's `package.json` (`dsh.bundle.patch`) and ship the patch file in `files`:
   ```yaml
   - id: git-status
     disabled: true
   - id: ui-git-status
     disabled: true
   - insert:
       - id: git-status-local
         name: '@dsh-local/git-status'
   ```
   `disabled` is an overridable key; patches match by `id` and can never rename a row's module, which is why the fork needs its own inserted row.
5. **Package as a tarball** (`pnpm pack`) when the fork lives outside the checkout: a directory spec is recorded as `link:`, and pnpm does not install a linked package's dependencies, so the fork must sit where `zod`/`schemastery` resolve — the tarball installs them from the registry instead.

## Prove it end to end

Run a source-built DSH against an isolated home and a spare port; never reconfigure the running application's profiles to test.

```sh
PATH=<pnpm-11-shim>:$PATH DSH_HOME=/tmp/dsh-e2e dsh web --no-open --port 3097
```

- The profile's package manager must be **pnpm ≥ 11**. pnpm 9 rejects adding to a workspace root with `ERR_PNPM_ADDING_TO_ROOT`; the packaged application supplies its own bundled pnpm, which is 11.x.
- Remotes are plain HTTP: exchange `/?token=<from stdout>` for its cookie (`redirect: 'manual'`, read `set-cookie`), then `POST /api/<namespace>/<method>` with `{type:'client-request', rpcId, method, payload:{args:{…}}}` and read `result.ok`/`result.value`.
- Drive the manager through the Remotes the page calls — `pluginManager/inspect`, `installBundle`, `listBundles`, `listPlugins` — not through `pnpm` directly, so the bundle check and the layer application are covered.
- Confirm, in this order: `installBundle` reports `changed`/`enabled`/`application`; `listPlugins` shows the shipped rows `enabled: false` and the fork's row enabled; the served boot payload lists only the fork's client bundle; the fork's own endpoint answers (proof that its Node half, not the frozen one, is live).
- For a namespace-extension mount, prove the merge against the real client gateway in jsdom: mount the shipped descriptors minus the new method, assert the method is absent, mount the one-descriptor contribution, assert the new method answers with the right endpoint while the old methods still do.
- Browser-visible confirmation is a separate step; the checks above cannot see the rendering.

## Traps

- Disabling a shipped row also removes it from the browser roster; verify rather than assume, because a second widget would otherwise mount beside yours.
- A package the application ships can never be installed through its Plugins page; only names it does not supply reach the profile anchor.
- The application's assembly keeps decoding the methods it shipped. Added result fields are stripped and new failure codes fail strict input/result validation, so a fork that extends a namespace inherits the shipped schema for the methods it does not remount.
- A fork pins itself to one application version: every later application update needs the fork rebuilt, which is the argument for rebuilding the application instead when that is available.
