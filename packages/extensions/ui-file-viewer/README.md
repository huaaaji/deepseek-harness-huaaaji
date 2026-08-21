# @deepseek-ai/dsh-client-ui-file-viewer

English | [中文](README.zh.md)

The Web GUI file viewer, browser half. It contributes a sidebar foot action (the `file-viewer` entry of `sidebar.footer.action`) that opens a right-docked drawer registered under `shell.overlay`. The drawer browses a workspace directory through the `fileViewer` Host Remote and renders files in place:

- code and text files as a line-numbered, syntax-highlighted view ([`ReadBlock`](../../client/ui-primitives/README.md)) using the shared Shiki highlighter;
- Markdown (`md`/`markdown`/`mdx`) through [`MarkdownText`](../../client/ui-primitives/README.md).

The drawer and the foot action share one store handle (created in `apply`), so the action's open write and the drawer's read agree on the same instance. The browser seeds from the current session's workspace, then the recent workspace, then the first registered one; every directory read and file read is a fresh `fileViewer` Remote call, and a failed read renders a stable status message rather than an error screen.

## Model Experience

None, as this browser-side drawer renders file content in the Web GUI and registers nothing model-facing.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No open-from-conversation wiring yet** — clicking a file path in a tool result or turn tail still opens the host OS application; routing those `openFile` calls into this drawer is a follow-up across `ui-conversation`.
- **Single-pane browsing** — the drawer lists one directory at a time; there is no split tree and no in-file search.
- **No focus trap** — the drawer is a complementary region, not a modal dialog; keyboard focus is not trapped while it is open.
