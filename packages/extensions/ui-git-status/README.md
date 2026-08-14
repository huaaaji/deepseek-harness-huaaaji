# @deepseek-ai/dsh-client-ui-git-status

English | [中文](README.zh.md)

Web GUI git surfaces over the [`gitStatus` Host Remote](../../host/git-status/README.md). The browser half registers one action in the `sidebar.footer.action` slot: a compact branch summary in the sidebar foot — branch name plus a badge with the total change count, colored red on conflicts — that opens a two-tab modal.

The **Status** tab shows the full working tree: branch, upstream, ahead/behind, HEAD commit, repository root, and the file list grouped into conflicted, staged, unstaged, and untracked sections.

The **History** tab replicates Git Graph's core view: a colored commit DAG (branch lanes, merge curves, fork points kept on the first-parent line), branch/tag/HEAD chips, clickable commit rows whose details panel shows the full message, per-file +/- statistics (renames and binary files included), inline per-file diffs over the shared `DiffBlock`, a case-insensitive search over message/hash/author/refs, paged "load more", and the basic mutations — checkout a branch chip, detach HEAD at a commit, and create a branch at the selected commit.

The widget follows the active workspace: it targets the workspace of the current session, falling back to the most recent workspace, then the first registered one. Every failure (git missing, not a repository, timeout, rejected mutation) renders a stable inline state instead of breaking the sidebar.

The browser half is a pure surface contribution: the node half ships an empty `apply` so the Loader row exists, and all state lives in the browser process. Dictionary keys live under the `gitStatus` locale namespace.

## Model Experience

None, as this browser-side widget registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time read** — the views refresh on mount, workspace change, mutation, and manual refresh; there is no filesystem watching or polling.
- **Mutation surface is minimal** — checkout and branch creation only; stage/commit/stash/merge/rebase and other Git Graph actions are out of scope.
- **Loaded-window search** — the search box filters the loaded pages, not the whole repository; load more pages first to search older history.
- **Single-directory target** — the widget reports the active workspace's directory only; repositories nested inside or above it are reported as git itself resolves them.
