---
description: "The Host git Remote behind the Web GUI's git widget: working-tree snapshot, paged history, commit details, file diffs, branch checkout, and branch creation over the host's own git CLI, with configurable read budgets."
kind: "package-bundle"
---

# @deepseek-ai/dsh-host-git-status

English | [中文](README.zh.md)

## Summary

`dsh-host-git-status` answers the Web GUI's git reads from the host's git CLI: it discovers the repository the workspace holds — its own, or the clones inside it — then serves that repository's working-tree snapshot, paged history, commit metadata and file statistics, two-sided file content, and the widget's two mutations. Every read is a fresh call; a missing binary, a non-repository directory, a timeout, or a refused argument returns a structured `failure` instead of an RPC error, so the widget keeps a stable summary. Configure the read budgets, the discovery depth, and the directories discovery skips.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this row in a Web composition; the browser half ([ui-git-status](../../extensions/ui-git-status/README.md)) consumes the six generated Remotes through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing this implementation.

This package is also an installable profile layer: its manifest declares `dsh.bundle.patch`, so the Web Plugins page (or `dsh plugin --profile <name> add <spec>`) can install it into a profile. A profile-local copy takes precedence over the one shipped inside the application, which is how a deployment picks up a newer build of this plugin without repackaging the app; the layer itself declares no rows, because the composition that ships the plugin already declares them.

### Minimal configuration

```yaml
- id: git-status
  name: '@deepseek-ai/dsh-host-git-status'
  config:
    timeoutMs: 15000
    historyLimit: 500
    diffBytesLimit: 65536
```

| Field | Default | Meaning |
|---|---|---|
| `timeoutMs` | `15000` | Kill-after deadline for one git invocation, in milliseconds |
| `historyLimit` | `500` | Largest history page the Remote accepts; a larger request is clamped |
| `diffBytesLimit` | `65536` | Character budget for each side of one file diff read |
| `scanDepth` | `1` | Directory levels below the workspace that discovery searches; `0` skips discovery, `-1` walks the whole subtree |
| `scanIgnoredFolders` | `['node_modules']` | Child directory names discovery never enters, matched exactly by name |

Omitting `config` keeps these defaults.

### Remotes

- `gitStatus/status` — the porcelain-v2 working-tree snapshot: branch header, per-file entries, and a HEAD teaser.
- `gitStatus/repositories` — the repositories at or below a directory: the enclosing one first, then the subdirectory repositories within `scanDepth`, deduplicated by root.
- `gitStatus/history` — a paged commit window (newest first) with parent hashes and `%D` ref decorations for the graph.
- `gitStatus/commitDetails` — one commit's metadata, message body, changed-file statistics, and the local and remote branches containing it.
- `gitStatus/fileDiff` — one file's content at a commit and at its first parent, renames reading the parent side through the old path.
- `gitStatus/checkout` — checkout a branch by name, or detach HEAD at a commit.
- `gitStatus/createBranch` — create a branch at a commit without checking it out.

### Wire validation

Every wire string that reaches a git argument list is validated first: a revision must be 7 to 40 hexadecimal digits, a branch name must pass the ref-format subset in `validBranchName`, and a path must be non-empty, relative, and free of NUL. A refused value returns `invalid-revision`, `invalid-name`, or `invalid-path` without running git. Passing the value through instead would let git's own option parser read it: `--output=<file>` writes a host file from a `fileDiff` call, and `-f` discards uncommitted work from a `checkout` call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One snapshot is two `git` invocations (`rev-parse --show-toplevel`, then `status --porcelain=v2 --branch`) plus a HEAD teaser; commit details run four, and a file diff runs two. The independent reads of one request run together. Every invocation runs with `LC_ALL=C`, because this package reads git's diagnostics to tell an absent path from an unreadable object and shows git's first stderr line as the failure message. Paths are read with `core.quotepath` disabled, so non-ASCII names arrive verbatim; a path git still C-quotes keeps its quoting. Stdout is decoded at the stream, so a multi-byte character split across two pipe chunks stays intact, and a diff side stops at `diffBytesLimit` by killing the child rather than buffering the whole blob. Repository discovery lists the requested directory's subdirectories `scanDepth` levels deep, skipping `.git` directories and the configured names, and confirms every candidate carrying a `.git` entry with `git rev-parse --show-toplevel`; the enclosing repository comes first and a repeated root collapses into one entry. A directory that no longer exists is reported as `not-a-repo` naming the working directory, because git answers a missing binary and a missing directory with the same errno.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-git-status](../../extensions/ui-git-status/README.md) — the sidebar widget, status modal, history graph, and diff surface this Remote serves.
- [api-remotes](../../api/remotes/README.md) — the Client assembly that carries these methods to the browser.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host-only status projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when this Remote is a poor fit. They are current package constraints, not a task backlog.

- **Point-in-time state only** — every read is a fresh CLI read per call; there is no subscription, diffing, or cached history between calls.
- **Mutation surface is minimal** — checkout and branch creation only; stage/commit/stash/merge/rebase and other Git Graph actions are out of scope.
- **First-parent diffs** — a merge commit's file diff reads against its first parent, matching Git Graph's default, so a merge conflict resolution shows only the change against that parent.
- **CLI-dependent** — results reflect the git binary and repository format available on the host; a repository with an unusual configuration is reported as git itself reports it.
- **Quoted paths stay quoted** — the porcelain read does not use `-z`, so a path holding a quote, backslash, or control character reaches the widget with git's C-quoting intact; the file row renders from that spelling, but opening its diff finds no such path and shows no text sides.
- **History order is topological** — the window orders parents after their children and keeps each branch on its own line; an individual page therefore need not be in commit-date order.
- **Discovery is bounded and name-matched** — the walk descends `scanDepth` levels and skips ignored directory names exactly, so a repository deeper than the configured depth, or under a name the ignore list does not spell out, is not found; a bare repository directory has no working tree for `--show-toplevel` to report.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the Remote service, wire validation, and the read projections |
| [`src/git.ts`](src/git.ts) | The git runner (timeout, output budget, locale, stream decoding) and the porcelain-v2 parser |
| [`src/discover.ts`](src/discover.ts) | The bounded subdirectory walk that yields candidate repository directories |
| [`src/history.ts`](src/history.ts) | Log/numstat/branch parsing and the branch-name, revision, and path validators |
| [`src/types.ts`](src/types.ts) | The public wire types exported under `./types` |
| — | No invariant companion is published because every snapshot is projected directly from git output and the package holds no runtime state of its own to relate. |

</details>
