# @deepseek-ai/dsh-host-file-viewer

English | [中文](README.zh.md)

Read-only file/directory Remote for the Web GUI's file viewer. `FileViewerGateway` registers the `fileViewer` service and publishes two generated direct Remotes:

- `fileViewer/list` — one directory's direct children (files and directories, special entries dropped), name-sorted by the backend, bounded to a configurable `maxEntries` head (default 1000) with `truncated` set on overflow;
- `fileViewer/read` — one file as a bounded, line-numbered text window (1-based offset, configurable `maxLines`/`maxLineLength`/`maxBytes`; defaults 2000 lines, 2000 characters per line, 50 KB per window), with `totalLines`, `truncatedByBytes`, `binary`, and a file-extension `language` hint for syntax highlighting.

Reads go through the injected `ctx.fs` (`resolve`/`stat`/`listDir`/`readText`/`streamText`), so the shared filesystem sandbox and observation policy apply unchanged and reads pass through the sandbox fence. No method ever throws: a missing path, a non-directory/non-file target, a binary file (`FS_NOT_TEXT`), a size cap, or any other filesystem failure is reported as a structured `failure` field beside the empty default state, so the GUI renders a stable surface instead of an error screen. A binary file is a successful domain outcome (`binary: true`, empty window), not a failure.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Configuration

Every bound is a validated `Config` field changeable from `cordis.yml` (positive integers; invalid values fail the load). Defaults:

| Key | Default | Bounds |
|---|---|---|
| `maxEntries` | 1000 | directory children returned by one `list` |
| `maxLines` | 2000 | lines returned by one `read` |
| `maxLineLength` | 2000 | characters returned for a single line |
| `maxBytes` | 51200 | bytes returned for a window's lines |
| `streamMinSize` | 10485760 | file size at or above which a read streams |

## Model Experience

None, as this Host-only read projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time reads only** — every call is a fresh `ctx.fs` read per call; there is no subscription, cache, or watch between calls.
- **No search or write** — the viewer is strictly read-only; in-file search, cross-file search, and any mutation remain out of scope.
- **Window, not whole file** — `read` returns a bounded window, so a file larger than the byte cap shows its head only and reports `truncatedByBytes` rather than the full content.
