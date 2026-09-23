/** History tab: the commit graph list, per-commit details, diffs, and basic mutations. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  GitCommitDetails, GitCommitDetailsResult, GitCommitView, GitFileDiffResult,
  GitHistoryResult, GitMutationResult, GitRefLabel,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  DiffBlock, IconBranchOutlineRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  GRAPH_GEOMETRY, buildGraph, dotY, edgePath, graphWidth, laneX, paletteColor,
} from './graph.ts'
import type { GitStatusLocaleKey } from './locales.ts'
import { commitAge, matchesQuery } from './model.ts'
import css from './GitGraphView.module.css'

/** History-tab Remote face. */
export interface GitGraphInjected {
  history: (cwd: string, count: number, skip: number) => Promise<GitHistoryResult>
  commitDetails: (cwd: string, hash: string) => Promise<GitCommitDetailsResult>
  fileDiff: (cwd: string, hash: string, path: string, oldPath: string | null) => Promise<GitFileDiffResult>
  checkout: (cwd: string, kind: 'branch' | 'commit', target: string) => Promise<GitMutationResult>
  createBranch: (cwd: string, name: string, atHash: string) => Promise<GitMutationResult>
}

/** One history page's worth of commits. */
const PAGE_SIZE = 100

export type GitGraphViewProps = {
  /** Directory the history is read from. */
  cwd: string
  /** Called after a successful mutation so the parent refreshes the status tab. */
  onMutated: () => void
} & InjectFace<GitGraphInjected>
  & PropsLocale<'gitStatus'>

type ListPhase =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready' }

/** Render the graph list plus the selection-driven details panel. */
export function GitGraphView({
  cwd, onMutated, history, commitDetails, fileDiff, checkout, createBranch, t,
}: GitGraphViewProps): ReactNode {
  const [commits, setCommits] = useState<readonly GitCommitView[]>([])
  const [truncated, setTruncated] = useState(false)
  const [phase, setPhase] = useState<ListPhase>({ status: 'idle' })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState<GitCommitDetails | null>(null)
  const [detailsPhase, setDetailsPhase] = useState<'idle' | 'loading' | 'error'>('idle')
  const [diffPath, setDiffPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiffResult | null>(null)
  const [diffPhase, setDiffPhase] = useState<'idle' | 'loading' | 'error'>('idle')
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')

  const reload = (): void => {
    setPhase(current => current.status === 'ready' ? { status: 'loading' } : current)
    void Promise.resolve().then(() => history(cwd, PAGE_SIZE, 0)).then(
      (result) => {
        if (result.failure !== null) {
          setPhase({ status: 'error', message: result.failure.message })
          return
        }
        setCommits(result.commits)
        setTruncated(result.truncated)
        setPhase({ status: 'ready' })
      },
      (reason: unknown) => {
        setPhase({ status: 'error', message: String(reason) })
      },
    )
  }

  useEffect(() => {
    setCommits([])
    setSelected(null)
    setDetails(null)
    setDiff(null)
    reload()
  }, [cwd, history])

  const loadMore = (): void => {
    void Promise.resolve().then(() => history(cwd, PAGE_SIZE, commits.length)).then(
      (result) => {
        if (result.failure !== null) {
          setMutationError(result.failure.message)
          return
        }
        setCommits(current => [...current, ...result.commits])
        setTruncated(result.truncated)
      },
      (reason: unknown) => {
        setMutationError(String(reason))
      },
    )
  }

  const select = (hash: string): void => {
    setSelected(hash)
    setDetails(null)
    setDiff(null)
    setDiffPath(null)
    setDetailsPhase('loading')
    void Promise.resolve().then(() => commitDetails(cwd, hash)).then(
      (result) => {
        if (result.failure !== null) {
          setDetailsPhase('error')
          return
        }
        setDetails(result.details)
        setDetailsPhase('idle')
      },
      () => { setDetailsPhase('error') },
    )
  }

  const openDiff = (path: string, oldPath: string | null): void => {
    if (selected === null) return
    setDiffPath(path)
    setDiff(null)
    setDiffPhase('loading')
    void Promise.resolve().then(() => fileDiff(cwd, selected, path, oldPath)).then(
      (result) => {
        setDiff(result)
        setDiffPhase('idle')
      },
      () => { setDiffPhase('error') },
    )
  }

  const mutate = async (action: () => Promise<GitMutationResult>): Promise<void> => {
    setBusy(true)
    setMutationError(null)
    try {
      const result = await action()
      if (!result.ok) {
        setMutationError(result.failure?.message ?? '')
        return
      }
      setBranchName('')
      onMutated()
      reload()
    } finally {
      setBusy(false)
    }
  }

  const filtered = useMemo(
    () => commits.filter(commit => matchesQuery(commit, query)),
    [commits, query],
  )
  const rows = useMemo(() => buildGraph(filtered), [filtered])
  const maxLane = useMemo(
    () => rows.reduce((lane, row) => Math.max(lane, row.lane), 0),
    [rows],
  )
  const now = Date.now()

  const graphWidthPx = graphWidth(maxLane)
  const selectedRow = rows.find(row => row.commit.hash === selected)
  const selectedCommit = selectedRow?.commit

  return (
    <div className={css.view} data-commits={filtered.length}>
      <div className={css.toolbar}>
        <label className={css.search}>
          <IconSearchOutlineRegular size={14} aria-hidden="true" />
          <span className={css.visuallyHidden}>{t('history.search')}</span>
          <input
            type="search"
            value={query}
            placeholder={t('history.search')}
            aria-label={t('history.search')}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </label>
        <button
          type="button"
          className={css.toolButton}
          onClick={reload}
          disabled={phase.status === 'loading'}
          aria-label={t('history.refresh')}
        >
          <IconRefreshOutlineRegular size={14} aria-hidden="true" />
        </button>
        <span className={css.count}>{t('history.count', { count: filtered.length })}</span>
      </div>
      <div className={css.columns}>
        <div className={css.list} role="list" aria-busy={phase.status === 'loading'}>
          {phase.status === 'error' ? (
            <div className={css.status} role="alert">
              <p>{t('history.loadFailed')}</p>
              <p className={css.errorDetail}>{phase.message}</p>
              <button type="button" className={css.action} onClick={reload}>{t('modal.retry')}</button>
            </div>
          ) : null}
          {phase.status === 'loading' && filtered.length === 0 ? (
            <p className={css.status}>{t('history.loading')}</p>
          ) : null}
          {phase.status === 'ready' && filtered.length === 0 ? (
            <p className={css.status}>{t('history.empty')}</p>
          ) : null}
          {filtered.length > 0 ? (
            <div className={css.graphArea}>
              <svg
                className={css.graphSvg}
                width={graphWidthPx}
                height={rows.length * GRAPH_GEOMETRY.rowHeight}
                aria-hidden="true"
              >
                {rows.flatMap(row => row.edges.map((edge, index) => (
                  <path
                    key={`e-${row.row}-${index}`}
                    d={edgePath(edge)}
                    stroke={paletteColor(edge.color)}
                    strokeWidth={2}
                    fill="none"
                  />
                )))}
                {rows.map(row => (
                  <circle
                    key={`d-${row.row}`}
                    cx={laneX(row.lane)}
                    cy={dotY(row.row)}
                    r={GRAPH_GEOMETRY.dotRadius}
                    fill={row.commit.parents.length > 1 ? 'var(--dsh-bg-elevated, #161b22)' : paletteColor(row.color)}
                    stroke={paletteColor(row.color)}
                    strokeWidth={row.commit.parents.length > 1 ? 2 : 0}
                  />
                ))}
              </svg>
              {rows.map(row => (
                <CommitRow
                  key={row.commit.hash}
                  row={row}
                  graphLeft={graphWidthPx}
                  selected={row.commit.hash === selected}
                  onSelect={select}
                  onCheckoutBranch={(name) => { void mutate(() => checkout(cwd, 'branch', name)) }}
                  t={t}
                  now={now}
                />
              ))}
            </div>
          ) : null}
          {truncated && filtered.length > 0 ? (
            <button type="button" className={css.loadMore} onClick={loadMore}>
              {t('history.loadMore')}
            </button>
          ) : null}
        </div>
        <div className={css.details} aria-live="polite">
          {selectedCommit === undefined ? <p className={css.status}>{t('history.noSelection')}</p> : null}
          {selectedCommit !== undefined ? (
            <DetailsPanel
              commit={selectedCommit}
              laneBranch={selectedRow?.branchName ?? null}
              details={details}
              detailsPhase={detailsPhase}
              diff={diff}
              diffPath={diffPath}
              diffPhase={diffPhase}
              busy={busy}
              branchName={branchName}
              mutationError={mutationError}
              setBranchName={setBranchName}
              onOpenDiff={openDiff}
              onCheckoutCommit={() => { void mutate(() => checkout(cwd, 'commit', selectedCommit.hash)) }}
              onCreateBranch={() => { void mutate(() => createBranch(cwd, branchName.trim(), selectedCommit.hash)) }}
              onRetryDetails={() => { select(selectedCommit.hash) }}
              t={t}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** One fixed-height list row: subject, ref chips, and meta. */
function CommitRow({
  row, graphLeft, selected, onSelect, onCheckoutBranch, t, now,
}: {
  row: ReturnType<typeof buildGraph>[number]
  graphLeft: number
  selected: boolean
  onSelect: (hash: string) => void
  onCheckoutBranch: (name: string) => void
  t: (key: GitStatusLocaleKey, params?: Record<string, unknown>) => string
  now: number
}): ReactNode {
  const { commit } = row
  const age = commitAge(commit.authorDate, now)
  const ageText = age.unit === 'date'
    ? t('time.date', { value: age.value })
    : t(`time.${age.unit}`, { value: age.value })
  return (
    <div
      className={css.row}
      data-selected={selected ? 'true' : undefined}
      style={{ paddingLeft: graphLeft + 8 }}
      role="listitem"
      onClick={() => { onSelect(commit.hash) }}
    >
      <div className={css.rowSubject}>
        <span className={css.subject}>{commit.subject}</span>
        <span className={css.chips}>
          {commit.refs.map((ref, index) => (
            <RefChip key={`${ref.kind}-${ref.name}-${index}`} refLabel={ref} onCheckoutBranch={onCheckoutBranch} />
          ))}
        </span>
      </div>
      <div className={css.rowMeta}>
        <span>{commit.author}</span>
        <span>{ageText}</span>
        <span className={css.hash}>{commit.shortHash}</span>
      </div>
    </div>
  )
}

/** One ref chip: HEAD arrow, branch (click = checkout), remote, or tag. */
function RefChip({
  refLabel, onCheckoutBranch,
}: {
  refLabel: GitRefLabel
  onCheckoutBranch: (name: string) => void
}): ReactNode {
  if (refLabel.kind === 'head') {
    return <span className={css.headChip} title="HEAD">HEAD</span>
  }
  const checkoutable = refLabel.kind === 'branch'
  return (
    <span
      className={css.refChip}
      data-kind={refLabel.kind}
      data-action={checkoutable ? 'true' : undefined}
      role={checkoutable ? 'button' : undefined}
      tabIndex={checkoutable ? 0 : undefined}
      onClick={checkoutable ? (event) => {
        event.stopPropagation()
        onCheckoutBranch(refLabel.name)
      } : undefined}
      onKeyDown={checkoutable ? (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.stopPropagation()
          onCheckoutBranch(refLabel.name)
        }
      } : undefined}
    >
      <IconBranchOutlineRegular size={10} aria-hidden="true" />
      {refLabel.name}
    </span>
  )
}

/** The containing-branches row of the details panel. The arrays are new wire
 * fields: against a stale payload (mixed host/bundle deployment or an old
 * browser cache) they can be missing, so every access defaults to an empty
 * list — a render crash here would blank the whole sidebar action via the
 * slot error boundary. */
function renderBranchRow(
  details: GitCommitDetails | null,
  laneBranch: string | null,
  t: (key: GitStatusLocaleKey, params?: Record<string, unknown>) => string,
): ReactNode {
  if (details === null) return null
  // The arrays are new wire fields: against a stale payload (mixed host/bundle
  // deployment or an old browser cache) they can be missing, so default them.
  const local = (details.localBranches as readonly string[] | undefined) ?? []
  const remote = (details.remoteBranches as readonly string[] | undefined) ?? []
  if (local.length + remote.length === 0) return null
  const chip = (name: string, kind: 'branch' | 'remote'): ReactNode => (
    <span
      key={`${kind}-${name}`}
      className={css.refChip}
      data-kind={kind}
      data-active={laneBranch !== null && name === laneBranch ? 'true' : undefined}
      title={laneBranch !== null && name === laneBranch ? t('history.owningBranch') : undefined}
    >
      <IconBranchOutlineRegular size={10} aria-hidden="true" />
      {name}
    </span>
  )
  return (
    <div className={css.panelBranches}>
      <span className={css.branchesLabel}>{t('history.containingBranches')}</span>
      {local.map(name => chip(name, 'branch'))}
      {remote.map(name => chip(name, 'remote'))}
    </div>
  )
}

/** The right-hand panel: message, files, diffs, and actions for the selection. */
function DetailsPanel({
  commit, laneBranch, details, detailsPhase, diff, diffPath, diffPhase, busy, branchName,
  mutationError, setBranchName, onOpenDiff, onCheckoutCommit, onCreateBranch,
  onRetryDetails, t,
}: {
  commit: GitCommitView
  /** The branch this commit's graph lane belongs to (the highlighted chip). */
  laneBranch: string | null
  details: GitCommitDetails | null
  detailsPhase: 'idle' | 'loading' | 'error'
  diff: GitFileDiffResult | null
  diffPath: string | null
  diffPhase: 'idle' | 'loading' | 'error'
  busy: boolean
  branchName: string
  mutationError: string | null
  setBranchName: (value: string) => void
  onOpenDiff: (path: string, oldPath: string | null) => void
  onCheckoutCommit: () => void
  onCreateBranch: () => void
  onRetryDetails: () => void
  t: (key: GitStatusLocaleKey, params?: Record<string, unknown>) => string
}): ReactNode {
  return (
    <div className={css.panel}>
      <h3 className={css.panelSubject}>{commit.subject}</h3>
      <p className={css.panelMeta}>
        <span>{commit.author} &lt;{commit.authorEmail}&gt;</span>
        <span>{commit.authorDate}</span>
        <span className={css.hash}>{commit.hash}</span>
      </p>
      {renderBranchRow(details, laneBranch, t)}
      <div className={css.panelActions}>
        <button type="button" className={css.action} onClick={onCheckoutCommit} disabled={busy}>
          {busy ? t('history.mutating') : t('history.checkoutCommit')}
        </button>
        <div className={css.branchCreate}>
          <input
            type="text"
            className={css.branchInput}
            value={branchName}
            placeholder={t('history.createBranchPlaceholder')}
            aria-label={t('history.createBranchPlaceholder')}
            onChange={(event) => { setBranchName(event.currentTarget.value) }}
          />
          <button
            type="button"
            className={css.action}
            onClick={onCreateBranch}
            disabled={busy || branchName.trim() === ''}
          >
            {t('history.createBranch')}
          </button>
        </div>
      </div>
      {mutationError !== null ? (
        <p className={css.mutationError} role="alert">{t('history.mutateFailed', { message: mutationError })}</p>
      ) : null}
      {detailsPhase === 'loading' ? <p className={css.status}>{t('history.loading')}</p> : null}
      {detailsPhase === 'error' ? (
        <div className={css.status} role="alert">
          <p>{t('history.detailsFailed')}</p>
          <button type="button" className={css.action} onClick={onRetryDetails}>{t('modal.retry')}</button>
        </div>
      ) : null}
      {details !== null ? (
        <DetailsFiles
          details={details}
          diff={diff}
          diffPath={diffPath}
          diffPhase={diffPhase}
          onOpenDiff={onOpenDiff}
          t={t}
        />
      ) : null}
    </div>
  )
}

/** The message + changed-files block of the details panel. `files` is treated
 * as possibly missing (stale payload) so a crash here cannot blank the widget. */
function DetailsFiles({
  details, diff, diffPath, diffPhase, onOpenDiff, t,
}: {
  details: GitCommitDetails
  diff: GitFileDiffResult | null
  diffPath: string | null
  diffPhase: 'idle' | 'loading' | 'error'
  onOpenDiff: (path: string, oldPath: string | null) => void
  t: (key: GitStatusLocaleKey, params?: Record<string, unknown>) => string
}): ReactNode {
  // `files` is also treated as possibly missing so a stale payload cannot
  // crash the details panel (and with it the whole sidebar action).
  const files = (details.files as GitCommitDetails['files'] | undefined) ?? []
  return (
    <>
      {details.message.length > 0 ? (
        <pre className={css.message}>{details.message}</pre>
      ) : null}
      <p className={css.filesHeading}>{t('history.files', { count: files.length })}</p>
      <ul className={css.fileList}>
        {files.map(file => (
          <li key={`${file.path}:${file.oldPath ?? ''}`}>
            <button
              type="button"
              className={css.fileRow}
              data-open={diffPath === file.path ? 'true' : undefined}
              onClick={() => { onOpenDiff(file.path, file.oldPath) }}
            >
              <span className={css.fileStats}>
                {file.added === null || file.removed === null
                  ? t('history.binary')
                  : `+${file.added} -${file.removed}`}
              </span>
              <span className={css.filePath}>{file.path}</span>
              {file.oldPath !== null ? (
                <span className={css.fileOldPath}>{t('history.renamed', { oldPath: file.oldPath })}</span>
              ) : null}
            </button>
            {diffPath === file.path && diffPhase === 'loading' ? (
              <p className={css.status}>{t('history.loading')}</p>
            ) : null}
            {diffPath === file.path && diffPhase === 'error' ? (
              <p className={css.status} role="alert">{t('history.diffFailed')}</p>
            ) : null}
            {diffPath === file.path && diff !== null && diff.failure === null ? (
              <div className={css.diffArea}>
                {diff.binary ? <p className={css.status}>{t('history.binary')}</p> : null}
                {diff.truncated ? (
                  <p className={css.status}>{t('history.truncatedDiff', { limit: 64 })}</p>
                ) : null}
                {!diff.binary ? (
                  <DiffBlock
                    diffs={[{ path: diff.path, oldText: diff.oldText, newText: diff.newText ?? '' }]}
                    maxLines={40}
                    labels={{
                      codeLabel: t('codeBlock.title'),
                      wrapLabel: t('codeBlock.wrap'),
                      unwrapLabel: t('codeBlock.unwrap'),
                      copy: t('diff.copy'),
                      copied: t('diff.copied'),
                      collapseAria: t('diff.collapseAria'),
                      expandAria: count => t('diff.expandAria', { count }),
                      collapse: t('diff.collapse'),
                      expand: count => t('diff.expandRest', { count }),
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {diffPath === file.path && diff !== null && diff.failure !== null ? (
              <p className={css.status} role="alert">{diff.failure.message}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  )
}
