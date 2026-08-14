/** Git-status sidebar widget, browser half: registers the foot action and the Remote face. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { GitStatusAction, type GitStatusActionInjected } from './GitStatusAction.tsx'
import { en, zh, type GitStatusLocaleKey } from './locales.ts'

export type { GitStatusActionInjected, GitStatusActionProps } from './GitStatusAction.tsx'
export type { GitStatusLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Git working-tree widget copy. */
    'gitStatus': GitStatusLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'gitStatus'

/** Services required by the sidebar registration and generated Remote face. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.gitStatus',
]

/** Contribute the git-status action to the sidebar foot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-git-status: dictionaries')

  const injected = (): GitStatusActionInjected => ({
    status: async cwd => call(ctx.remote.gitStatus.status({ cwd }), 'gitStatus.status'),
    history: async (cwd, count, skip) =>
      call(ctx.remote.gitStatus.history({ cwd, count, skip }), 'gitStatus.history'),
    commitDetails: async (cwd, hash) =>
      call(ctx.remote.gitStatus.commitDetails({ cwd, hash }), 'gitStatus.commitDetails'),
    fileDiff: async (cwd, hash, path, oldPath) =>
      call(ctx.remote.gitStatus.fileDiff({ cwd, hash, path, oldPath }), 'gitStatus.fileDiff'),
    checkout: async (cwd, kind, target) =>
      call(ctx.remote.gitStatus.checkout({ cwd, kind, target }), 'gitStatus.checkout'),
    createBranch: async (cwd, name, atHash) =>
      call(ctx.remote.gitStatus.createBranch({ cwd, name, atHash }), 'gitStatus.createBranch'),
  })

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'git-status',
    order: 10,
    locale: NS,
    inject: injected,
  }, GitStatusAction))
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
