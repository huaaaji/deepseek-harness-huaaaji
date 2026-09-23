/** Sidebar foot trigger that opens the file-viewer drawer. */

import type { ReactNode } from 'react'
import { IconBrowseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createFileViewerStore } from './stores.ts'
import css from './FileViewerAction.module.css'

/** Full component props assembled by the sidebar slot renderer. */
export type FileViewerActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createFileViewerStore>>
  & PropsLocale<'fileViewer'>

/** Render the sidebar-foot trigger. The open write rides the shared store, so
 * the drawer reads the same instance. */
export function FileViewerAction({
  wide, actions, t,
}: FileViewerActionProps): ReactNode {
  return (
    <button
      type="button"
      className={css.footButton}
      data-wide={wide ? 'true' : undefined}
      aria-label={t('action.aria')}
      aria-haspopup="dialog"
      title={t('action.aria')}
      onClick={() => { actions.open() }}
    >
      <IconBrowseOutlineRegular size={wide ? 14 : 18} aria-hidden="true" />
      {wide ? <span className={css.footLabel}>{t('action.label')}</span> : null}
    </button>
  )
}
