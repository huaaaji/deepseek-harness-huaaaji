/** File-viewer drawer, browser half: the foot action and the overlay drawer. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots) and the session
// and workspace global standard-props merges (useSessions/useWorkspaces).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { FileViewerAction } from './FileViewerAction.tsx'
import { FileViewerDrawer, type FileViewerInjected } from './FileViewerDrawer.tsx'
import { en, zh, type FileViewerLocaleKey } from './locales.ts'
import { createFileViewerStore } from './stores.ts'

export type { FileViewerInjected } from './FileViewerDrawer.tsx'
export type { FileViewerLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-viewer drawer copy. */
    'fileViewer': FileViewerLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'fileViewer'

/** Services required by the two registrations and the generated Remote face. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.fileViewer',
]

/**
 * Contribute the sidebar foot action and the frame overlay drawer. Both share
 * one store handle, so the action's open write and the drawer's read agree on
 * the same instance.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-file-viewer: dictionaries')

  const store = createFileViewerStore()

  const injected = (): FileViewerInjected => ({
    list: async path => call(ctx.remote.fileViewer.list({ path }), 'fileViewer.list'),
    read: async (path, offset, limit) =>
      call(ctx.remote.fileViewer.read({ path, offset, limit }), 'fileViewer.read'),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'file-viewer',
    order: 20,
    locale: NS,
    store,
  }, FileViewerAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'file-viewer',
    locale: NS,
    store,
    inject: injected,
  }, FileViewerDrawer))
}

/** Unwrap one generated Remote result into its value or a labeled error. */
async function call<T>(
  invoke: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>,
  label: string,
): Promise<T> {
  const result = await invoke
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}
