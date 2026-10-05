export type FilesEntry = { name: string; kind: 'file' | 'dir' }

export type FilesOpen = {
  path: string
  text: string
  version: number
  readOnly?: string
}

export type FilesStatus = { text: string; kind: 'ok' | 'err' | 'info'; at: number }

// What the explorer's surface module draws from: paths are relative to the root ('' is the root).
export type FilesModel = {
  root: string
  rootName: string
  dirs: Record<string, FilesEntry[]>
  file: FilesOpen | null
  status: FilesStatus | null
  matches: { q: string; paths: string[] } | null
  reveal: number
}

// What the surface module posts to the hooks module.
export type FilesRequest =
  | { type: 'list'; dir: string }
  | { type: 'open'; path: string }
  | { type: 'save'; path: string; text: string; version: number; force?: boolean }
  | { type: 'find'; q: string }
