/** File-viewer drawer dictionaries. */

/** Simplified Chinese file-viewer messages. */
export const zh = {
  'action.aria': '文件查看器',
  'action.label': '文件',
  'drawer.close': '关闭',
  'drawer.up': '上一级',
  'drawer.back': '返回目录',
  'drawer.loading': '读取中…',
  'drawer.empty': '目录为空',
  'drawer.loadFailed': '读取目录失败',
  'drawer.retry': '重试',
  'drawer.noWorkspace': '未选择工作区',
  'entry.directory': '目录',
  'file.binary': '二进制文件',
  'file.empty': '文件为空',
  'failure.not-found': '路径不存在',
  'failure.not-directory': '不是目录',
  'failure.not-text': '非文本文件',
  'failure.not-regular-file': '不是普通文件',
  'failure.too-large': '文件过大',
  'failure.permission-denied': '权限不足',
  'failure.sandbox-denied': '被沙箱拒绝',
  'failure.io-error': '读取失败',
  'failure.aborted': '读取被取消',
} satisfies Record<string, string>

/** Translation keys owned by the file-viewer UI namespace. */
export type FileViewerLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-viewer drawer copy. */
    fileViewer: FileViewerLocaleKey
  }
}

/** English file-viewer messages. */
export const en = {
  'action.aria': 'File viewer',
  'action.label': 'Files',
  'drawer.close': 'Close',
  'drawer.up': 'Up one level',
  'drawer.back': 'Back to directory',
  'drawer.loading': 'Loading…',
  'drawer.empty': 'Directory is empty',
  'drawer.loadFailed': 'Failed to read directory',
  'drawer.retry': 'Retry',
  'drawer.noWorkspace': 'No workspace',
  'entry.directory': 'directory',
  'file.binary': 'Binary file',
  'file.empty': 'File is empty',
  'failure.not-found': 'Path not found',
  'failure.not-directory': 'Not a directory',
  'failure.not-text': 'Not a text file',
  'failure.not-regular-file': 'Not a regular file',
  'failure.too-large': 'File too large',
  'failure.permission-denied': 'Permission denied',
  'failure.sandbox-denied': 'Blocked by sandbox',
  'failure.io-error': 'Read failed',
  'failure.aborted': 'Read aborted',
} satisfies Record<string, string>
