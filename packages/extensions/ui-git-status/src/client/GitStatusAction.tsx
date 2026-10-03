/** Git working-tree widget: sidebar foot summary plus a full status modal. */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type {
  GitRepositoryRef, GitRepositoryScanResult, GitStatusSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconBranchOutlineRegular, IconRefreshOutlineRegular, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitStatusLocaleKey } from './locales.ts'
import { entriesOf, resolveCwd, resolveRepository, summarize } from './model.ts'
import { GitGraphView, type GitGraphInjected } from './GitGraphView.tsx'
import css from './GitStatusAction.module.css'

/** Registration-side Remote face used by the widget and its history tab. */
export interface GitStatusActionInjected extends GitGraphInjected {
  /** Read a fresh working-tree snapshot for one directory. */
  status: (cwd: string) => Promise<GitStatusSnapshot>
  /** Discover the repositories at or below one directory. */
  repositories: (cwd: string) => Promise<GitRepositoryScanResult>
}

/**
 * One workspace's discovery outcome. `depth` and `error` are exclusive: a
 * completed discovery reports the levels it searched, a failed one reports why
 * it could not run.
 */
interface Discovery {
  readonly workspace: string
  readonly repositories: readonly GitRepositoryRef[]
  readonly depth: number | null
  readonly error: string | null
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
  wide, status, repositories, useSessions, useWorkspaces, t, ...rest
}: GitStatusActionProps): ReactNode {
  const detailsId = useId()
  const workspaces = useWorkspaces(state => state.items)
  // The main view's retained Session is the current one.
  const currentSession = useSessions(state =>
    Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [open, setOpen] = useState(false)
  const [request, setRequest] = useState(0)
  const [tab, setTab] = useState<'status' | 'history'>('status')
  // The discovery result and the workspace it belongs to. A rescan of the same
  // workspace keeps the previous list on screen; only a workspace change falls
  // back to the scanning state.
  const [discovery, setDiscovery] = useState<Discovery | null>(null)
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null)

  const workspacePath = useMemo(
    () => resolveCwd(workspaces, currentSession),
    [workspaces, currentSession],
  )

  // Discover the repositories of the workspace: its own, or the ones cloned
  // inside it. A failed discovery leaves the workspace path as the target, so
  // the status read names the actual problem.
  useEffect(() => {
    if (workspacePath === null) {
      setDiscovery(null)
      return
    }
    let current = true
    setDiscovery(currentDiscovery =>
      currentDiscovery?.workspace === workspacePath ? currentDiscovery : null)
    void Promise.resolve().then(() => repositories(workspacePath)).then(
      (result) => {
        if (!current) return
        setDiscovery({
          workspace: workspacePath,
          repositories: result.repositories,
          depth: result.scanDepth,
          error: null,
        })
      },
      (reason: unknown) => {
        // A discovery that could not run leaves the workspace path as the
        // target, and says so rather than reading as an empty workspace.
        if (!current) return
        setDiscovery({
          workspace: workspacePath,
          repositories: [],
          depth: null,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      },
    )
    return () => { current = false }
  }, [workspacePath, repositories, request])

  const here = discovery?.workspace === workspacePath ? discovery : null
  const found = here?.repositories ?? null
  const active = resolveRepository(found ?? [], selectedRoot)
  const cwd = active?.root ?? (found === null ? null : workspacePath)

  // Fetch a snapshot whenever the target or the retry counter changes. The
  // last snapshot stays rendered while a refresh is in flight, so the foot
  // never falls back to its no-data copy mid-read.
  useEffect(() => {
    if (cwd === null) {
      setLoad({ status: 'loading' })
      setRefreshing(false)
      return
    }
    let current = true
    setRefreshing(true)
    void Promise.resolve().then(() => status(cwd)).then(
      (snapshot) => {
        if (!current) return
        setLoad({ status: 'ready', snapshot })
        setRefreshing(false)
      },
      (reason: unknown) => {
        if (!current) return
        setLoad(currentLoad => currentLoad.status === 'ready'
          ? currentLoad
          : { status: 'error', message: String(reason) })
        setRefreshing(false)
      },
    )
    return () => { current = false }
  }, [cwd, status, request])

  const retry = (): void => { setRequest(value => value + 1) }
  const snapshot = load.status === 'ready' ? load.snapshot : null
  const summary = useMemo(() => summarize(snapshot), [snapshot])

  if (workspacePath === null) {
    return wide ? (
      <span className={css.footRow} data-state="empty">
        <IconBranchOutlineRegular size={14} aria-hidden="true" />
        <span className={css.footLabel}>{t('widget.noWorkspace')}</span>
      </span>
    ) : (
      <span className={css.railIcon} data-state="empty" role="img" aria-label={t('widget.noWorkspace')}>
        <IconBranchOutlineRegular size={18} />
      </span>
    )
  }

  const label = footLabel(load, snapshot, t)
  const discoveredRepositories = found ?? []

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
        <IconBranchOutlineRegular size={wide ? 14 : 18} aria-hidden="true" />
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
              <button type="button" className={css.actionButton} onClick={retry} disabled={refreshing}>
                <IconRefreshOutlineRegular size={14} aria-hidden="true" />
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
          {discoveredRepositories.length > 1 ? (
            <div className={css.repoPicker} role="group" aria-label={t('repos.label')}>
              <span className={css.repoLabel}>{t('repos.label')}</span>
              {discoveredRepositories.map(repository => (
                <button
                  key={repository.root}
                  type="button"
                  className={css.repoChip}
                  data-active={repository.root === active?.root ? 'true' : undefined}
                  aria-pressed={repository.root === active?.root}
                  title={repository.root}
                  onClick={() => { setSelectedRoot(repository.root) }}
                >
                  <IconBranchOutlineRegular size={10} aria-hidden="true" />
                  {repository.name}
                </button>
              ))}
            </div>
          ) : null}
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
          {cwd === null ? (
            <p className={css.modalStatus}>{t('modal.loading')}</p>
          ) : tab === 'status' ? (
            <div className={css.modalBody} id={detailsId} aria-busy={refreshing}>
              {here !== null ? <DiscoveryNotice discovery={here} t={t} /> : null}
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

/**
 * What the workspace-wide discovery did, when the widget has to explain an
 * empty result or a discovery that could not run at all.
 */
function DiscoveryNotice({ discovery, t }: { discovery: Discovery; t: Translate }): ReactNode {
  if (discovery.error !== null) {
    return (
      <div className={css.modalStatus} role="alert">
        <p>{t('repos.scanFailed')}</p>
        <p className={css.modalErrorDetail}>{discovery.error}</p>
      </div>
    )
  }
  if (discovery.repositories.length > 0 || discovery.depth === null) return null
  return (
    <p className={css.modalStatus}>
      {discovery.depth === -1
        ? t('repos.noneDeep', { directory: discovery.workspace })
        : t('repos.none', { directory: discovery.workspace, depth: discovery.depth })}
    </p>
  )
}

/** The sidebar-foot copy: the last known branch, or why there is none yet. */
function footLabel(load: LoadState, snapshot: GitStatusSnapshot | null, t: Translate): string {
  if (snapshot !== null) {
    if (snapshot.failure !== null) return failureText(snapshot.failure, t)
    return snapshot.branch?.name ?? t('widget.detached')
  }
  return load.status === 'error' ? t('widget.error') : t('widget.loading')
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
  if (load.status === 'error') {
    return (
      <div className={css.modalStatus} role="alert">
        <p>{t('modal.loadFailed')}</p>
        <p className={css.modalErrorDetail}>{load.message}</p>
        <button type="button" className={css.actionButton} onClick={onRetry}>{t('modal.retry')}</button>
      </div>
    )
  }
  if (load.status !== 'ready') {
    return <p className={css.modalStatus}>{t('modal.loading')}</p>
  }

  const { snapshot } = load
  if (snapshot.failure !== null) {
    return (
      <div className={css.modalStatus} role="alert">
        <p>{failureText(snapshot.failure, t)}</p>
        <p className={css.modalErrorDetail}>{snapshot.failure.message}</p>
        {/* The directory the failing read asked about: a workspace that is not
            the repository the reader expects is the common cause. */}
        <p className={css.modalRoot} title={cwd}>{t('modal.root', { root: cwd })}</p>
        <button type="button" className={css.actionButton} onClick={onRetry}>{t('modal.retry')}</button>
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
