import type { EngineInterface, Register } from 'claude-code'
import type { FilesEntry, FilesModel, FilesRequest } from '../types'

type Engine = EngineInterface

const PANE = 'files'
const MIN_COLS = 60
// The editor keeps files it can hold in its props and draw quickly; larger ones open read-only, cut.
const MAX_EDIT = 60_000
const MAX_READ = 2_000_000
const MAX_ENTRIES = 600
const MAX_MATCHES = 200

let share = 0.66
let lastTerm = 0
let rootReal = ''
let fileList: { at: number; paths: string[] } | null = null

const model: FilesModel = { root: '', rootName: '', dirs: {}, file: null, status: null, matches: null, reveal: 0 }

const openArgs = (term?: number) =>
  term && term > 0 ? { id: PANE, title: 'files', columns: Math.max(MIN_COLS, Math.round(term * share)) } : { id: PANE, title: 'files' }

const status = (text: string, kind: 'ok' | 'err' | 'info' = 'info') => { model.status = { text, kind, at: Date.now() } }

// A path from the explorer, relative to the root, as an absolute path that stays inside it: no '..', no
// absolute path, and its real location (links resolved) under the root's.
async function inside($: Engine, rel: string): Promise<string | undefined> {
  if (rel.startsWith('/') || rel.split('/').some(p => p === '..')) return undefined
  const abs = rel ? `${model.root}/${rel}` : model.root
  try {
    const st = await $.fs.stat(abs, { resolve: true })
    const real = (st as { realPath?: string }).realPath ?? abs
    if (real !== rootReal && !real.startsWith(rootReal + '/')) return undefined
    return abs
  } catch {
    // a file that does not exist yet: judge it by its folder
    const dir = abs.slice(0, abs.lastIndexOf('/'))
    if (dir === abs || !dir) return undefined
    const parent = await inside($, rel.split('/').slice(0, -1).join('/'))
    return parent ? abs : undefined
  }
}

async function setRoot($: Engine, root: string) {
  model.root = root.replace(/\/+$/, '') || '/'
  model.rootName = model.root.split('/').pop() || model.root
  model.dirs = {}
  model.file = null
  model.matches = null
  model.status = null
  fileList = null
  try {
    const st = await $.fs.stat(model.root, { resolve: true })
    rootReal = (st as { realPath?: string }).realPath ?? model.root
  } catch {
    rootReal = model.root
  }
  await listDir($, '')
}

async function listDir($: Engine, rel: string) {
  const abs = await inside($, rel)
  if (!abs) { status(`Outside the project: ${rel}`, 'err'); return }
  try {
    const entries = await $.fs.list(abs)
    const out: FilesEntry[] = entries
      .filter(en => en.name !== '.git' && en.name !== '.DS_Store' && (en.kind === 'file' || en.kind === 'dir'))
      .map(en => ({ name: en.name, kind: en.kind as 'file' | 'dir' }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
      .slice(0, MAX_ENTRIES)
    model.dirs = { ...model.dirs, [rel]: out }
  } catch (err) {
    status(`Cannot list ${rel || model.rootName}: ${err instanceof Error ? err.message : String(err)}`, 'err')
  }
}

async function openFile($: Engine, rel: string, quiet = false) {
  const abs = await inside($, rel)
  if (!abs) { status(`Outside the project: ${rel}`, 'err'); return }
  try {
    const st = await $.fs.stat(abs)
    if ((st as { size?: number }).size !== undefined && (st as { size: number }).size > MAX_READ) {
      model.file = { path: rel, text: '', version: (model.file?.version ?? 0) + 1, readOnly: 'too large to show here' }
      return
    }
    const text = await $.fs.read(abs)
    const binary = text.includes('\u0000')
    const big = text.length > MAX_EDIT
    model.file = {
      path: rel,
      text: binary ? '' : big ? text.slice(0, MAX_EDIT) : text,
      version: (model.file?.version ?? 0) + 1,
      ...(binary ? { readOnly: 'binary file' } : big ? { readOnly: `read-only: first ${MAX_EDIT / 1000}k characters of ${Math.round(text.length / 1000)}k` } : {}),
    }
    model.reveal++
    if (!quiet) model.status = null
  } catch (err) {
    status(`Cannot open ${rel}: ${err instanceof Error ? err.message : String(err)}`, 'err')
  }
}

// What the file held when the editor loaded it, to tell a save that would overwrite someone else's change.
const loadedText = new Map<string, string>()

async function saveFile($: Engine, rel: string, text: string, force: boolean) {
  const abs = await inside($, rel)
  if (!abs) { status(`Outside the project: ${rel}`, 'err'); return }
  if (model.file?.readOnly) { status(`Not saved: ${model.file.readOnly}`, 'err'); return }
  try {
    const onDisk = await $.fs.read(abs).catch(() => '')
    const base = loadedText.get(rel)
    if (!force && base !== undefined && onDisk !== base && onDisk !== text) {
      status('Changed on disk since you opened it. ctrl+s again to overwrite, ctrl+r to reload', 'err')
      model.file = model.file && { ...model.file }
      return
    }
    await $.fs.write(abs, text)
    loadedText.set(rel, text)
    model.file = { path: rel, text, version: (model.file?.version ?? 0) + 1 }
    status(`✓ Saved at ${new Date().toLocaleTimeString()}`, 'ok')
  } catch (err) {
    status(`Not saved: ${err instanceof Error ? err.message : String(err)}`, 'err')
  }
}

// Every file under the root once (git's list when it is a repository), then fuzzy matching on it.
async function allFiles($: Engine): Promise<string[]> {
  if (fileList && Date.now() - fileList.at < 30_000) return fileList.paths
  let paths: string[] = []
  const r = await $.process.run(['git', '-C', model.root, 'ls-files', '--cached', '--others', '--exclude-standard'], { timeoutMs: 8000 }).catch(() => undefined)
  if (r && r.exitCode === 0) paths = r.stdout.split('\n').filter(Boolean)
  else {
    const queue = ['']
    while (queue.length && paths.length < 5000) {
      const dir = queue.shift()!
      const abs = dir ? `${model.root}/${dir}` : model.root
      const entries = await $.fs.list(abs).catch(() => [])
      for (const en of entries) {
        if (en.name === '.git' || en.name === 'node_modules') continue
        const rel = dir ? `${dir}/${en.name}` : en.name
        if (en.kind === 'dir') queue.push(rel)
        else if (en.kind === 'file') paths.push(rel)
      }
    }
  }
  fileList = { at: Date.now(), paths }
  return paths
}

function score(path: string, q: string): number {
  const p = path.toLowerCase()
  const name = p.slice(p.lastIndexOf('/') + 1)
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.includes(q)) return 2
  if (p.includes(q)) return 3
  let i = 0
  for (const ch of p) if (ch === q[i]) i++
  return i === q.length ? 4 + p.length / 1000 : -1
}

async function find($: Engine, q: string) {
  const query = q.trim().toLowerCase()
  if (!query) { model.matches = null; return }
  const paths = await allFiles($)
  const ranked = paths.map(p => [p, score(p, query)] as const).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
  model.matches = { q, paths: ranked.slice(0, MAX_MATCHES).map(([p]) => p) }
}

async function handle($: Engine, req: FilesRequest) {
  if (req.type === 'list') await listDir($, req.dir)
  else if (req.type === 'open') await openFile($, req.path)
  else if (req.type === 'save') await saveFile($, req.path, req.text, req.force === true)
  else if (req.type === 'find') await find($, req.q)
  if (req.type === 'open' && model.file && !model.file.readOnly) loadedText.set(req.path, model.file.text)
}

const relOf = (abs: string) => (abs === model.root ? '' : abs.startsWith(model.root + '/') ? abs.slice(model.root.length + 1) : undefined)

// The dock is shared by every pane in it, so a pane asks for its width again each time its tab comes to the
// front: switching tabs moves the dock between widths. A width the person drags still wins until then.
let termCols = 0
let wasShown = false
async function watchTab($: EngineInterface) {
  const me = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  const shownNow = !!me?.isShown
  if (shownNow && !wasShown && termCols > 0) void $.ui.open(openArgs(termCols))
  wasShown = shownNow
}

export const register: Register = (on, options) => {
  const pct = Number(options.widthPercent)
  share = Number.isFinite(pct) && pct >= 20 && pct <= 90 ? pct / 100 : 0.66

  on('session.start', async ($, e, next) => {
    await setRoot($, e.cwd)
    $.clock.every(800, () => { void watchTab($) })
    await $.command.register({ name: 'files', description: 'Open the file explorer and editor', argumentHint: '[file or folder]' })
    return next(e)
  })

  on('command.run', { command: 'files' }, async ($, e) => {
    lastTerm = e.presentation.columns
    termCols = lastTerm
    const arg = e.args.trim()
    if (!arg && (await $.ui.panes()).some(p => p.id === PANE && p.isShown)) {
      await $.ui.close({ id: PANE })
      return { text: 'File explorer closed.' }
    }
    if (arg) {
      const cwd = await $.session.cwd()
      const abs = arg.startsWith('/') ? arg : arg.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}${arg.slice(1)}` : `${cwd}/${arg}`
      const st = await $.fs.stat(abs).catch(() => undefined)
      const kind = (st as { kind?: string } | undefined)?.kind
      if (kind === 'dir') await setRoot($, abs)
      else if (st) {
        if (relOf(abs) === undefined) await setRoot($, abs.slice(0, abs.lastIndexOf('/')))
        const rel = relOf(abs)!
        // open the folders down to it so the tree shows where it is
        const parts = rel.split('/').slice(0, -1)
        for (let i = 1; i <= parts.length; i++) await listDir($, parts.slice(0, i).join('/'))
        await openFile($, rel)
        if (model.file && !model.file.readOnly) loadedText.set(rel, model.file.text)
      } else return { text: `No such file or folder: ${arg}` }
    }
    const r = await $.ui.open(openArgs(lastTerm))
    $.ui.invalidate('ui.render')
    return { text: r.isPlaced ? 'File explorer opened. Click into it to type; Esc gives the keys back.' : `File explorer waits: ${r.reason ?? 'no room'}` }
  })

  // Posts from the explorer: answered with the new model as its props, and the pane redrawn with it too.
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'explorer') return next(e)
    const req = e.data as FilesRequest
    if (!req || typeof req !== 'object' || typeof (req as { type?: unknown }).type !== 'string') return {}
    try {
      await handle($, req)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      status(`${req.type} failed: ${why}`, 'err')
      $.ui.toast(`files: ${req.type} failed: ${why}`)
    }
    $.ui.invalidate('ui.render')
    return { props: { ...model } }
  })

  // When Claude edits the open file, the editor picks the new text up (it keeps yours if you have unsaved changes).
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const tool = String(e.tool)
    if (ran.isError || ran.deny !== undefined || !(tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit')) return ran
    try {
      const path = String((e as unknown as Record<string, unknown>).file_path ?? '')
      const rel = relOf(path)
      if (rel === undefined) return ran
      fileList = null
      const dir = rel.split('/').slice(0, -1).join('/')
      if (model.dirs[dir]) await listDir($, dir)
      if (model.file?.path === rel) {
        await openFile($, rel, true)
        if (model.file && !model.file.readOnly) loadedText.set(rel, model.file.text)
        status(`↻ ${rel.split('/').pop()} changed by Claude`, 'info')
      }
      $.ui.invalidate('ui.render')
    } catch {}
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Client, Text } = $.ui.resolve(e) as any
    const props = e.props as { bodyColumns?: number; scroll?: { bodyRows?: number } }
    const cols = Math.max(30, props.bodyColumns ?? e.viewport?.columns ?? 80)
    const rows = Math.max(8, props.scroll?.bodyRows ?? e.viewport?.rows ?? 30)
    const term = e.viewport?.columns
    if (term && props.bodyColumns && term > props.bodyColumns + 4) termCols = term
    if (term && props.bodyColumns && term > props.bodyColumns + 4 && term !== lastTerm) {
      lastTerm = term
      const want = Math.max(MIN_COLS, Math.round(term * share))
      if (Math.abs(want - props.bodyColumns) > 2) $.clock.after(0, () => { void $.ui.open(openArgs(term)) })
    }
    if (!Client) return <Text dimColor>The file explorer needs the terminal or desktop app.</Text>
    return <Client key="explorer" module="./explorer.tsx" props={{ ...model }} width={cols} height={rows} />
  })
}
