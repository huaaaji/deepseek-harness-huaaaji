# @deepseek-ai/dsh-host-git-status

English | [中文](README.zh.md)

Working-tree Remote for the Web GUI's git status and history surfaces. `GitStatusGateway` registers the `gitStatus` service and publishes six generated direct Remotes:

- `gitStatus/status` — the porcelain-v2 working-tree snapshot (branch headers, per-file entries, HEAD teaser);
- `gitStatus/history` — paged commit history (newest first, capped at 500 per page) with parent hashes and `%D` ref decorations for the graph;
- `gitStatus/commitDetails` — one commit's full metadata, message body, and numstat file statistics (renames and binary files included);
- `gitStatus/fileDiff` — one file's content at a commit and at its first parent, size-capped at 64KB per side, for the GUI's diff surface;
- `gitStatus/checkout` — checkout a branch by name or detach HEAD at a commit;
- `gitStatus/createBranch` — create a branch at a commit without checking it out.

No method ever throws: a missing git binary, a non-repository directory, a hung repository (enforced 15s timeout), an invalid branch name, or any other git failure is reported as a structured `failure` field with the empty default state beside it, so the GUI can render a stable widget instead of an error screen. Paths arrive with `core.quotepath` disabled, so non-ASCII and space-containing paths are parsed verbatim. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only status projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — every read is a fresh CLI read per call; there is no subscription, diffing, or cached history between calls.
- **Mutation surface is minimal** — checkout and branch creation only; stage/commit/stash/merge/rebase and other Git Graph actions are out of scope.
- **First-parent diffs** — a merge commit's file diff reads against its first parent, matching Git Graph's default.
- **CLI-dependent** — results reflect the git binary and repository format available on the host; a repository with an unusual configuration is reported as git itself reports it.
