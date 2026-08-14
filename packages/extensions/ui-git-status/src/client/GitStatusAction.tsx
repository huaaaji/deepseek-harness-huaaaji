/** Git working-tree widget: sidebar foot summary plus a full status modal. */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { GitStatusSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconBranchOutline16, IconRefreshOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitStatusLocaleKey } from './locales.ts'
import { entriesOf, resolveCwd, summarize } from './model.ts'
import { GitGraphView, type GitGraphInjected } from './GitGraphView.tsx'
import css from './GitStatusAction.module.css'

/** Registration-side Remote face used by the widget and its history tab. */
export interface GitStatusActionInjected extends GitGraphInjected {
  /** Read a fresh working-tree snapshot for one directory. */
  status: (cwd: string) => Promise<GitStatusSnapshot>
}

/** Full component props assembled by the sidebar slot renderer. */
export type GitStatusActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'gitStatus'>
  & InjectFace<GitStatusActionInjected>

/** One-letter chip for each change state. */
const STATE_LETTER: Record<GitStatusSnapshot['entries'][number]['state'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: '!',
}

/** Load lifecycle of the widget's snapshot. */
type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly snapshot: GitStatusSnapshot }

/** Translate seat shared by the widget's inner components. */
type Translate = (key: GitStatusLocaleKey, params?: Record<string, unknown>) => string

/** Human text for a structured git failure. */
function failureText(failure: GitStatusSnapshot['failure'], t: Translate): string {
  return failure === null ? '' : t(`failure.${failure.code}`)
}

/** Render the sidebar-foot summary and its status modal. The target directory
 * rides the framework `useWorkspaces`/`useSessions` seats, so a baseline
 * change re-derives it without any component-owned subscription. */
export function GitStatusAction({
  wide, status, useSessions, useWorkspaces, t, ...rest
}: GitStatusActionProps): ReactNode {
  const detailsId = useId()
  const workspaces = useWorkspaces(state => state.items)
  const recentWorkspaceId = useWorkspaces(state => state.recentWorkspaceId)
  const currentSession = useSessions(state => state.current)
  const [load, setLoad] = useState<LoadState>({ status: 'idle' })
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState(0)
  const [tab, setTab] = useState<'status' | 'history'>('status')

  const cwd = useMemo(
    () => resolveCwd(workspaces, recentWorkspaceId, currentSession),
    [workspaces, recentWorkspaceId, currentSession],
  )

  // Fetch a snapshot whenever the target or the retry counter changes.
  useEffect(() => {
    if (cwd === null) {
      setLoad({ status: 'idle' })
      return
    }
    let current = true
    setLoad({ status: 'loading' })
    void Promise.resolve().then(() => status(cwd)).then(
      (snapshot) => {
        if (current) setLoad({ status: 'ready', snapshot })
      },
      (reason: unknown) => {
        if (current) setLoad({ status: 'error', message: String(reason) })
      },
    )
    return () => { current = false }
  }, [cwd, status, request])

  const retry = (): void => { setRequest(value => value + 1) }
  const snapshot = load.status === 'ready' ? load.snapshot : null
  const summary = useMemo(() => summarize(snapshot), [snapshot])

  if (cwd === null) {
    return wide ? (
      <span className={css.footRow} data-state="empty">
        <IconBranchOutline16 size={14} aria-hidden="true" />
        <span className={css.footLabel}>{t('widget.noWorkspace')}</span>
      </span>
    ) : (
      <span className={css.railIcon} data-state="empty" role="img" aria-label={t('widget.noWorkspace')}>
        <IconBranchOutline16 size={18} />
      </span>
    )
  }

  const label = snapshot?.failure !== null && snapshot?.failure !== undefined
    ? failureText(snapshot.failure, t)
    : (snapshot?.branch?.name ?? t('widget.detached'))

  return (
    <>
      <button
        type="button"
        className={css.footButton}
        data-wide={wide ? 'true' : undefined}
        aria-label={t('widget.aria')}
        aria-haspopup="dialog"
        aria-controls={open ? detailsId : undefined}
        title={wide ? label : t('widget.aria')}
        onClick={() => { setOpen(true) }}
      >
        <IconBranchOutline16 size={wide ? 14 : 18} aria-hidden="true" />
        {wide ? (
          <span className={css.footLabel} data-state={summary.state}>{label}</span>
        ) : null}
        {summary.total > 0 ? (
          <span className={css.badge} data-state={summary.state} aria-hidden="true">{summary.total}</span>
        ) : null}
      </button>
      <Modal
        open={open}
        onClose={() => { setOpen(false) }}
        title={t('modal.title')}
        closeLabel={t('modal.close')}
        className={css.modalWide ?? ''}
        contentClassName={css.modalContent ?? ''}
        footer={(
          <div className={css.modalFooter}>
            {tab === 'status' ? (
              <button type="button" className={css.actionButton} onClick={retry} disabled={load.status === 'loading'}>
                <IconRefreshOutline16 size={14} aria-hidden="true" />
                {t('modal.refresh')}
              </button>
            ) : null}
            <button type="button" className={css.actionButton} onClick={() => { setOpen(false) }}>
              {t('modal.close')}
            </button>
          </div>
        )}
      >
        <div className={css.pane}>
          <div className={css.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'status'}
              className={css.tab}
              data-active={tab === 'status' ? 'true' : undefined}
              onClick={() => { setTab('status') }}
            >
              {t('tab.status')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={css.tab}
              data-active={tab === 'history' ? 'true' : undefined}
              onClick={() => { setTab('history') }}
            >
              {t('tab.history')}
            </button>
          </div>
          {tab === 'status' ? (
            <div className={css.modalBody} id={detailsId} aria-busy={load.status === 'loading'}>
              <ModalBody load={load} cwd={cwd} onRetry={retry} t={t} />
            </div>
          ) : (
            <GitGraphView cwd={cwd} onMutated={retry} {...rest} t={t} />
          )}
        </div>
      </Modal>
    </>
  )
}

/** Modal body for every load phase. */
function ModalBody({
  load, cwd, onRetry, t,
}: {
  load: LoadState
  cwd: string
  onRetry: () => void
  t: Translate
}): ReactNode {
  if (load.status === 'loading' || load.status === 'idle') {
    return <p className={css.modalStatus}>{t('modal.loading')}</p>
  }
  if (load.status === 'error') {
    return (
      <div className={css.modalStatus} role="alert">
        <p>{t('modal.loadFailed')}</p>
        <p className={css.modalErrorDetail}>{load.message}</p>
        <button type="button" className={css.actionButton} onClick={onRetry}>{t('modal.retry')}</button>
      </div>
    )
  }

  const { snapshot } = load
  if (snapshot.failure !== null) {
    return (
      <div className={css.modalStatus} role="alert">
        <p>{failureText(snapshot.failure, t)}</p>
        <p className={css.modalErrorDetail}>{snapshot.failure.message}</p>
      </div>
    )
  }
  const counts = snapshot.counts
  const total = counts.conflicted + counts.staged + counts.unstaged + counts.untracked
  const branchName = snapshot.branch?.name ?? t('widget.detached')
  const upstream = snapshot.branch?.upstream ?? null
  return (
    <>
      <p className={css.modalMeta}>
        <strong>{branchName}</strong>
        {upstream !== null
          ? <span className={css.modalMetaItem}>{t('modal.upstream', { upstream })}</span>
          : null}
        {(snapshot.branch?.ahead ?? 0) + (snapshot.branch?.behind ?? 0) > 0
          ? <span className={css.modalMetaItem}>{t('modal.aheadBehind', {
            ahead: snapshot.branch?.ahead ?? 0,
            behind: snapshot.branch?.behind ?? 0,
          })}</span>
          : null}
      </p>
      {snapshot.head !== null ? (
        <p className={css.modalMeta}>
          <span className={css.modalMetaItem}>{t('modal.head', {
            shortHash: snapshot.head.shortHash,
            subject: snapshot.head.subject,
          })}</span>
        </p>
      ) : null}
      <p className={css.modalRoot} title={cwd}>{t('modal.root', { root: snapshot.root ?? cwd })}</p>
      {total === 0 ? <p className={css.modalStatus}>{t('modal.clean')}</p> : null}
      <FileGroup
        title={t('group.conflicted')}
        state="conflicted"
        entries={entriesOf(snapshot, 'conflicted')}
        t={t}
      />
      <FileGroup
        title={t('group.staged')}
        state="staged"
        entries={entriesOf(snapshot, 'staged')}
        t={t}
      />
      <FileGroup
        title={t('group.unstaged')}
        state="unstaged"
        entries={entriesOf(snapshot, 'unstaged')}
        t={t}
      />
      <FileGroup
        title={t('group.untracked')}
        state="untracked"
        entries={entriesOf(snapshot, 'untracked')}
        t={t}
      />
    </>
  )
}

/** One file-list section inside the modal. */
function FileGroup({
  title, state, entries, t,
}: {
  title: string
  state: 'conflicted' | 'staged' | 'unstaged' | 'untracked'
  entries: readonly GitStatusSnapshot['entries'][number][]
  t: Translate
}): ReactNode {
  if (entries.length === 0) return null
  return (
    <section className={css.group} data-state={state}>
      <h3 className={css.groupHeading}>
        <span>{title}</span>
        <span className={css.groupCount}>{entries.length}</span>
      </h3>
      <ul className={css.fileList}>
        {entries.map(entry => (
          <li className={css.fileRow} key={`${entry.staged ? 's' : 'u'}:${entry.path}`}>
            <span className={css.fileLetter} data-state={state} title={t(`state.${entry.state}`)}>
              {STATE_LETTER[entry.state]}
            </span>
            <span className={css.filePath} title={entry.path}>{entry.path}</span>
            {entry.oldPath !== null ? (
              <span className={css.fileOldPath}>{t('renamed.from', { oldPath: entry.oldPath })}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
