/** Pure helpers for the file-viewer drawer. */

import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'

/** The directory the drawer browses first: the current session's workspace,
 * then the recent workspace, then the first registered one. */
export function resolveCwd(
  workspaces: readonly WorkspaceView[],
  recentWorkspaceId: WorkspaceId | undefined,
  currentSession: SessionId | undefined,
): string | null {
  if (currentSession !== undefined) {
    const owner = workspaces.find(item => item.sessionIds.includes(currentSession))
    if (owner !== undefined) return owner.path
  }
  const recent = workspaces.find(item => item.workspaceId === recentWorkspaceId)
  if (recent !== undefined) return recent.path
  return workspaces[0]?.path ?? null
}

/** Whether a path renders as Markdown rather than a code window. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path)
}

/** The parent directory of a path, or null at a filesystem root. */
export function parentOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, '')
  const sep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (sep <= 0) return null
  const parent = trimmed.slice(0, sep)
  return parent === '' ? null : parent
}

/** Join a directory and a child name with the directory's own separator. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** Human file size for a listing row. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}
