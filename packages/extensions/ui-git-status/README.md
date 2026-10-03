---
description: "The Web GUI git surface: a sidebar-foot branch summary with a working-tree modal and a history tab carrying the commit graph, per-file diffs, search, checkout, and branch creation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-git-status

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-git-status` puts the working tree and the commit history in the sidebar foot. The foot shows the current branch plus a change-count badge, red on conflicts; clicking opens a modal whose Status tab lists conflicted, staged, unstaged, and untracked files and whose History tab draws the commit graph with ref chips, per-file diffs, and search. The widget reports on the repository the workspace holds — its own or a clone inside it — with a picker when there are several, and offers three actions: checkout a branch, detach HEAD at a commit, and create a branch. Every failure renders inline.

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

Mount the plugin beside the git Host row it reads; the browser half registers one action in the `sidebar.footer.action` slot and the node half ships an empty `apply` so the Loader row exists.

This package is also an installable profile layer: its manifest declares `dsh.bundle.patch`, so the Web Plugins page (or `dsh plugin --profile <name> add <spec>`) can install it into a profile. A profile-local copy takes precedence over the one shipped inside the application; the layer declares no rows of its own, because the composition that ships the widget already declares them.

### What the widget shows

A workspace that is not itself a repository still reports the repositories cloned into it, because the Host discovers them; when it holds more than one, a picker above the tabs switches the widget between them. The Status tab reports the branch, upstream, ahead/behind counts, the HEAD commit, the repository root, and one section per display group — a file with both staged and unstaged changes is listed under staged, matching the snapshot's counts. The History tab keeps the whole loaded window as its graph and only hides rows a search does not match, so a visible commit keeps the lane and connectors the full window gave it; the details panel then shows the message, the changed-file statistics, and an inline diff over the shared code block. Search matches subject, hashes, author, and ref names case-insensitively. Commit rows and branch chips take focus and answer Enter and Space, so the same selection and checkout actions are reachable from the keyboard.

### Remote failures

Reads and mutations report their own failures where the user is looking: a failed history read replaces the list, a failed load-more appears under it, a failed commit-details or diff read stays in the details panel, and a refused or rejected mutation shows the operation and git's message above the actions. A refresh keeps the last snapshot on screen until the new one arrives, so the sidebar never falls back to its no-data copy mid-read. When the workspace holds no repository at all, the Status tab names the directory it searched and how many levels below it were inspected, and a discovery call that could not run reports its own error rather than reading as an empty workspace.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half holds no state; every read is a call through the generated `gitStatus` Remote face. Each asynchronous read carries a token, and a reply whose token is no longer current is dropped, so a slower reply from an earlier selection cannot overwrite a newer one. The graph layout and the summary are pure functions in `src/client/graph.ts` and `src/client/model.ts`, unit-testable without React; the components hold only view state. Product copy lives in the `gitStatus` locale namespace in both languages, and the two locale dictionaries must stay key-for-key identical.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [host-git-status](../../host/git-status/README.md) — the working-tree snapshot, history, diff, and mutation Remotes this widget reads.
- [Slots reference](../../../docs/subsystems/slots.md) — how the sidebar contribution registers and receives its props.

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser-side widget registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current surface. They are current package constraints, not a task backlog.

- **Point-in-time read** — the views refresh on mount, workspace change, mutation, and manual refresh; there is no filesystem watching or polling.
- **Mutation surface is minimal** — checkout and branch creation only; stage/commit/stash/merge/rebase and other Git Graph actions are out of scope.
- **Loaded-window search** — the search box filters the loaded pages, not the whole repository; load more pages first to search older history.
- **Workspace-scoped discovery** — the widget reports the repository the active session's workspace holds — its own, or a clone inside it within the Host's scan depth — and falls back to the first registered workspace when no session is current; a repository above the workspace is reported as git itself resolves it, and one deeper than the scan depth is not listed at all.
- **Diff text only** — a diff renders the two file sides as text; a binary file reports that it is binary instead of showing bytes, and a side past the Host read budget renders truncated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Plugin entry: dictionary registration and the sidebar slot contribution |
| [`src/client/GitStatusAction.tsx`](src/client/GitStatusAction.tsx) | Sidebar-foot summary, the modal shell, and the status tab |
| [`src/client/GitGraphView.tsx`](src/client/GitGraphView.tsx) | History tab: graph list, details panel, diffs, and actions |
| [`src/client/graph.ts`](src/client/graph.ts) | Pure graph layout: branch coloring, lanes, edge paths, and row compaction |
| [`src/client/model.ts`](src/client/model.ts) | Pure status model: target directory, summary, grouping, and search |
| — | No invariant companion is published because the widget's only mutable relation is its own browser-process load state, which the host invariant service cannot observe. |

</details>
