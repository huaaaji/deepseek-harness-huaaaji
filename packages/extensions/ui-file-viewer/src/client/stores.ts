/**
 * Shared drawer state read by both the sidebar foot action and the overlay
 * drawer. The plugin creates its handle at apply time so identity follows the
 * fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Shared file-viewer state: only whether the drawer is open. */
export interface FileViewerState {
  /** Whether the drawer is open. */
  open: boolean
}

/** Declared action shape used to give the exported factory a stable return type. */
type FileViewerActions = {
  open: (draft: FileViewerState) => void
  close: (draft: FileViewerState) => void
}

/**
 * Declare the drawer state and write surface.
 * @returns the store handle shared across the two registrations.
 */
export function createFileViewerStore(): EngineStoreHandle<FileViewerState, FileViewerActions> {
  return defineStore({
    init: (): FileViewerState => ({ open: false }),
    actions: {
      open: (draft) => { draft.open = true },
      close: (draft) => { draft.open = false },
    },
  })
}
