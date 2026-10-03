---
kind: upgrade-guide
description: "The two git-status plugins stop publishing their ./invariant entry point, so a consumer importing it must delete that import."
---

# Git-status packages drop their invariant companion

English | [中文](guide.zh.md)

## Change

In v0.2.0-rc.2, `@deepseek-ai/dsh-host-git-status` and `@deepseek-ai/dsh-client-ui-git-status` each published an `./invariant` entry point. Its companion registered package ownership with the host invariant service and checked nothing: every snapshot is projected directly from git output, and the widget's mutable state lives in the browser process.

The next release removes `./invariant`, its `src/invariant.ts`, the published `lib/invariant.js`, and the `@deepseek-ai/dsh-invariants` dependency from both packages. Anyone importing `@deepseek-ai/dsh-host-git-status/invariant` or `@deepseek-ai/dsh-client-ui-git-status/invariant` now fails to resolve that specifier. Loading either package as a plugin is unchanged: both keep their entry points, the `gitStatus` service keeps its six Remotes, and the sidebar widget keeps its slot.

The same release stops declaring these packages' browser and type relationships as `peerDependencies`; those relationships now live in `devDependencies` alone. A consumer no longer has to satisfy peers such as `@deepseek-ai/dsh-api-remotes` or `react`, and a package manager that enforces peer ranges no longer reports them as missing.

## Migration

1. Delete every import of `@deepseek-ai/dsh-host-git-status/invariant` and `@deepseek-ai/dsh-client-ui-git-status/invariant`. The companion asserted nothing, so no coverage is lost.
2. Delete any composition row that mounted one of those companions; the host invariant service no longer lists either package name.
3. Keep the packages themselves: no package was renamed, no source file moved, and no configuration key changed.
4. Confirm: importing either `/invariant` specifier rejects with a module-not-found error, importing the package root still resolves, and the Web profile still renders the git widget.
