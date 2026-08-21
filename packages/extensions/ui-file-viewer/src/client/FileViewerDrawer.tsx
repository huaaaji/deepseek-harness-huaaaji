/** Right-docked file viewer: directory browser plus file content. */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  FileViewerFailure, FileViewerListResult, FileViewerReadResult,
} from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconChevronLeftOutline14, IconChevronUpOutline14, IconCloseOutline16, IconFolderOpenOutline16,
  MarkdownText, ReadBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { FileViewerLocaleKey } from './locales.ts'
import { formatSize, isMarkdown, joinPath, parentOf, resolveCwd } from './model.ts'
import type { createFileViewerStore } from './stores.ts'
import css from './FileViewerDrawer.module.css'

/** Registration-side Remote face used by the drawer. */
export interface FileViewerInjected {
  /** List one directory's direct children. */
  list: (path: string) => Promise<FileViewerListResult>
  /** Read one file as a bounded, line-numbered window. */
  read: (path: string, offset: number, limit: number) => Promise<FileViewerReadResult>
}

/** Full component props assembled by the overlay slot renderer. */
export type FileViewerDrawerProps =
  PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createFileViewerStore>>
  & PropsLocale<'fileViewer'>
  & InjectFace<FileViewerInjected>

/** Translate seat shared by the drawer's inner views. */
type Translate = (key: FileViewerLocaleKey, params?: Record<string, unknown>) => string

/** Directory listing load lifecycle. */
type Listing =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly result: FileViewerListResult }

/** An opened file: a structured read result or a transport error. */
type Doc =
  | { readonly kind: 'file'; readonly path: string; readonly result: FileViewerReadResult }
  | { readonly kind: 'error'; readonly path: string; readonly message: string }

/** Lines requested per file read (matches the Host's line cap). */
const READ_LIMIT = 2000

/** Render the right-docked drawer over the frame's overlay layer. */
export function FileViewerDrawer({
  useStore, actions, useSessions, useWorkspaces, list, read, t,
}: FileViewerDrawerProps): ReactNode {
  const open = useStore(state => state.open)
  const workspaces = useWorkspaces(state => state.items)
  const recentWorkspaceId = useWorkspaces(state => state.recentWorkspaceId)
  const currentSession = useSessions(state => state.current)

  const root = useMemo(
    () => resolveCwd(workspaces, recentWorkspaceId, currentSession),
    [workspaces, recentWorkspaceId, currentSession],
  )

  const [dir, setDir] = useState<string | null>(null)
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const [doc, setDoc] = useState<Doc | null>(null)
  const [request, setRequest] = useState(0)

  // Seed the browser once on first open; the workspace root rides the framework
  // seats, so a baseline change re-derives it without a component subscription.
  useEffect(() => {
    if (!open) return
    setDir(current => current ?? root)
  }, [open, root])

  // Load the current directory whenever it, the retry counter, or the open
  // state changes. A stale response is dropped via the `current` flag.
  useEffect(() => {
    if (!open || dir === null) return
    let current = true
    setListing({ status: 'loading' })
    void list(dir).then(
      (result) => { if (current) setListing({ status: 'ready', result }) },
      (reason: unknown) => { if (current) setListing({ status: 'error', message: String(reason) }) },
    )
    return () => { current = false }
  }, [open, dir, list, request])

  if (!open) return null

  const retry = (): void => { setRequest(value => value + 1) }

  const openDirectory = (name: string): void => {
    if (dir === null) return
    setDoc(null)
    setDir(joinPath(dir, name))
  }

  const openFile = (path: string): void => {
    void read(path, 1, READ_LIMIT).then(
      (result) => { setDoc({ kind: 'file', path, result }) },
      (reason: unknown) => { setDoc({ kind: 'error', path, message: String(reason) }) },
    )
  }

  const goUp = (): void => {
    if (dir === null) return
    const parent = parentOf(dir)
    if (parent !== null) {
      setDoc(null)
      setDir(parent)
    }
  }

  const backToListing = (): void => { setDoc(null) }

  return (
    <div className={css.drawer} role="region" aria-label={t('action.aria')}>
      <header className={css.header}>
        <button
          type="button"
          className={css.iconButton}
          onClick={doc === null ? goUp : backToListing}
          aria-label={doc === null ? t('drawer.up') : t('drawer.back')}
          disabled={doc === null && parentOf(dir ?? '') === null}
        >
          {doc === null ? <IconChevronUpOutline14 /> : <IconChevronLeftOutline14 />}
        </button>
        <span className={css.title} title={doc?.path ?? dir ?? ''}>{doc?.path ?? dir ?? ''}</span>
        <button type="button" className={css.iconButton} onClick={() => { actions.close() }} aria-label={t('drawer.close')}>
          <IconCloseOutline16 />
        </button>
      </header>
      <div className={css.body}>
        {dir === null ? (
          <p className={css.status}>{t('drawer.noWorkspace')}</p>
        ) : doc !== null ? (
          <DocView doc={doc} t={t} />
        ) : (
          <ListingView
            listing={listing}
            dir={dir}
            t={t}
            onRetry={retry}
            onOpenDirectory={openDirectory}
            onOpenFile={openFile}
          />
        )}
      </div>
    </div>
  )
}

/** The directory listing, with a structured-failure and retry path. */
function ListingView({
  listing, dir, t, onRetry, onOpenDirectory, onOpenFile,
}: {
  listing: Listing
  dir: string
  t: Translate
  onRetry: () => void
  onOpenDirectory: (name: string) => void
  onOpenFile: (path: string) => void
}): ReactNode {
  if (listing.status === 'loading') return <p className={css.status}>{t('drawer.loading')}</p>
  if (listing.status === 'error') {
    return (
      <div className={css.status} role="alert">
        <p>{t('drawer.loadFailed')}</p>
        <p className={css.detail}>{listing.message}</p>
        <button type="button" className={css.actionButton} onClick={onRetry}>{t('drawer.retry')}</button>
      </div>
    )
  }
  const { result } = listing
  if (result.failure !== null) {
    return (
      <div className={css.status} role="alert">
        <p>{failureText(result.failure, t)}</p>
        <p className={css.detail}>{result.failure.message}</p>
      </div>
    )
  }
  if (result.entries.length === 0) return <p className={css.status}>{t('drawer.empty')}</p>
  return (
    <ul className={css.list}>
      {result.entries.map(entry => (
        <li key={entry.name}>
          <button
            type="button"
            className={css.entry}
            onClick={() => {
              if (entry.kind === 'directory') onOpenDirectory(entry.name)
              else onOpenFile(joinPath(dir, entry.name))
            }}
          >
            {entry.kind === 'directory' ? <IconFolderOpenOutline16 className={css.entryIcon} /> : null}
            <span className={css.entryName}>{entry.name}</span>
            <span className={css.entryMeta}>{entry.kind === 'directory' ? t('entry.directory') : formatSize(entry.size)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** One opened file: code window or rendered Markdown. */
function DocView({ doc, t }: { doc: Doc; t: Translate }): ReactNode {
  if (doc.kind === 'error') {
    return (
      <div className={css.status} role="alert">
        <p>{t('failure.io-error')}</p>
        <p className={css.detail}>{doc.message}</p>
      </div>
    )
  }
  const { path, result } = doc
  if (result.binary) return <p className={css.status}>{t('file.binary')}</p>
  if (result.failure !== null) {
    return (
      <div className={css.status} role="alert">
        <p>{failureText(result.failure, t)}</p>
        <p className={css.detail}>{result.failure.message}</p>
      </div>
    )
  }
  if (result.lines.length === 0) return <p className={css.status}>{t('file.empty')}</p>
  if (isMarkdown(path)) {
    const text = result.lines.map(line => line.text).join('\n')
    return <div className={css.markdown}><MarkdownText text={text} /></div>
  }
  return (
    <ReadBlock
      label={path}
      lines={result.lines}
      totalLines={result.totalLines}
      lang={result.language ?? undefined}
    />
  )
}

/** Human text for a structured file failure. */
function failureText(failure: FileViewerFailure, t: Translate): string {
  return t(`failure.${failure.code}`)
}
