import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface } from 'claude-code'
import type { FilesModel, FilesRequest } from '../types'

// The explorer runs on the drawing thread: the tree, the search and the editor are all local state here.
// Disk work goes to the hooks module as posts, and comes back as new props.

type Focus = 'tree' | 'filter' | 'editor'

type Snapshot = { lines: string[]; cx: number; cy: number }

type State = {
  ref: { props: FilesModel }
  focus: Focus
  expanded: string[]
  sel: number
  treeTop: number
  filter: string
  path?: string
  version?: number
  lines: string[]
  cx: number
  cy: number
  top: number
  dirty: boolean
  force: boolean
  undo: Snapshot[]
  redo: Snapshot[]
  reveal: number
}

type Row = { path: string; name: string; kind: 'file' | 'dir'; depth: number; isLoading?: boolean }

const C = {
  text: '#d8d8de', dim: '#8a8a96', faint: '#5b5b66', accent: '#e8875b', dir: '#8cc8e8',
  sel: '#2f3542', ok: '#7fc77a', err: '#e8645b', info: '#e8c15b', line: '#262a33', dirty: '#e8c15b',
}

const TAB = '  '

function rowsOf(model: FilesModel, expanded: Set<string>): Row[] {
  const out: Row[] = []
  const walk = (dir: string, depth: number) => {
    for (const en of model.dirs[dir] ?? []) {
      const path = dir ? `${dir}/${en.name}` : en.name
      out.push({ path, name: en.name, kind: en.kind, depth })
      if (en.kind === 'dir' && expanded.has(path)) {
        if (model.dirs[path]) walk(path, depth + 1)
        else out.push({ path: `${path}/…`, name: 'loading…', kind: 'file', depth: depth + 1, isLoading: true })
      }
    }
  }
  walk('', 0)
  return out
}

function matchRows(model: FilesModel, filter: string): Row[] | undefined {
  if (!filter) return undefined
  if (!model.matches || model.matches.q !== filter) return []
  return model.matches.paths.map(p => ({ path: p, name: p, kind: 'file' as const, depth: 0 }))
}

// A line as drawn: tabs as two spaces; the cursor's column measured the same way.
const shown = (line: string) => line.replace(/\t/g, TAB)
const shownCol = (line: string, cx: number) => shown(line.slice(0, cx)).length

function clamp(s: State) {
  s.cy = Math.max(0, Math.min(s.cy, s.lines.length - 1))
  s.cx = Math.max(0, Math.min(s.cx, s.lines[s.cy]!.length))
}

function snapshot(s: State) {
  s.undo = [...s.undo.slice(-99), { lines: s.lines, cx: s.cx, cy: s.cy }]
  s.redo = []
}

function edit(s: State, ev: ClientKeyEvent): boolean {
  const line = s.lines[s.cy]!
  const k = ev.key
  const set = (lines: string[], cx: number, cy: number) => { snapshot(s); s.lines = lines; s.cx = cx; s.cy = cy; s.dirty = true }
  const replace = (i: number, ...repl: string[]) => [...s.lines.slice(0, i), ...repl, ...s.lines.slice(i + 1)]
  if (k === 'return') {
    const indent = /^[\t ]*/.exec(line)![0]
    set(replace(s.cy, line.slice(0, s.cx), indent + line.slice(s.cx)), indent.length, s.cy + 1)
  } else if (k === 'backspace') {
    if (s.cx > 0) set(replace(s.cy, line.slice(0, s.cx - 1) + line.slice(s.cx)), s.cx - 1, s.cy)
    else if (s.cy > 0) {
      const prev = s.lines[s.cy - 1]!
      set([...s.lines.slice(0, s.cy - 1), prev + line, ...s.lines.slice(s.cy + 1)], prev.length, s.cy - 1)
    } else return false
  } else if (k === 'delete') {
    if (s.cx < line.length) set(replace(s.cy, line.slice(0, s.cx) + line.slice(s.cx + 1)), s.cx, s.cy)
    else if (s.cy < s.lines.length - 1) set([...s.lines.slice(0, s.cy), line + s.lines[s.cy + 1]!, ...s.lines.slice(s.cy + 2)], s.cx, s.cy)
    else return false
  } else if (k === 'tab') {
    set(replace(s.cy, line.slice(0, s.cx) + TAB + line.slice(s.cx)), s.cx + TAB.length, s.cy)
  } else if (k.length >= 1 && [...k].length === 1 && !ev.ctrl && !ev.meta) {
    set(replace(s.cy, line.slice(0, s.cx) + k + line.slice(s.cx)), s.cx + k.length, s.cy)
  } else if (k.length > 1 && !/^[a-z]+$/.test(k) && !ev.ctrl && !ev.meta) {
    // a paste arrives as one key of several characters
    const parts = k.replace(/\r\n?/g, '\n').split('\n')
    const head = line.slice(0, s.cx), tail = line.slice(s.cx)
    const ins = parts.length === 1 ? [head + parts[0] + tail] : [head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail]
    set([...s.lines.slice(0, s.cy), ...ins, ...s.lines.slice(s.cy + 1)], parts.length === 1 ? s.cx + parts[0]!.length : parts[parts.length - 1]!.length, s.cy + parts.length - 1)
  } else return false
  return true
}

function move(s: State, k: string, page: number): boolean {
  const line = s.lines[s.cy]!
  if (k === 'left') { if (s.cx > 0) s.cx--; else if (s.cy > 0) { s.cy--; s.cx = s.lines[s.cy]!.length } }
  else if (k === 'right') { if (s.cx < line.length) s.cx++; else if (s.cy < s.lines.length - 1) { s.cy++; s.cx = 0 } }
  else if (k === 'up') { s.cy--; clamp(s) }
  else if (k === 'down') { s.cy++; clamp(s) }
  else if (k === 'home') s.cx = /^[\t ]*/.exec(line)![0].length === s.cx ? 0 : /^[\t ]*/.exec(line)![0].length
  else if (k === 'end') s.cx = line.length
  else if (k === 'pageup') { s.cy -= page; clamp(s) }
  else if (k === 'pagedown') { s.cy += page; clamp(s) }
  else return false
  clamp(s)
  return true
}

function scroll(s: State, height: number) {
  if (s.cy < s.top) s.top = s.cy
  if (s.cy >= s.top + height) s.top = s.cy - height + 1
  s.top = Math.max(0, Math.min(s.top, Math.max(0, s.lines.length - height)))
}

function load(s: State, model: FilesModel) {
  const f = model.file
  if (!f) return
  const samePath = s.path === f.path
  if (samePath && s.version === f.version) return
  // keep unsaved work when the file changes under it; the next save says so
  if (samePath && s.dirty) { s.version = f.version; return }
  s.path = f.path
  s.version = f.version
  s.lines = f.text.length ? f.text.split('\n') : ['']
  if (!samePath) { s.cx = 0; s.cy = 0; s.top = 0; s.undo = []; s.redo = [] }
  s.dirty = false
  s.force = false
  clamp(s)
}

const Explorer: ClientModule<FilesModel, State> = (props, surface) => {
  const { Box, Text, Code } = surface.elements as any
  const W = Math.max(30, surface.columns || 80)
  const H = Math.max(8, surface.rows || 30)
  const treeW = Math.max(18, Math.min(36, Math.floor(W * 0.34)))
  const editW = W - treeW - 1
  const bodyH = H - 2
  const post = (r: FilesRequest) => surface.post(r)

  let s = surface.state
  if (!s) {
    s = {
      ref: { props }, focus: 'tree', expanded: [], sel: 0, treeTop: 0, filter: '',
      lines: [''], cx: 0, cy: 0, top: 0, dirty: false, force: false, undo: [], redo: [], reveal: props.reveal,
    }
    const st = s
    // reveal the open file's folders once it is known
    if (props.file) {
      const parts = props.file.path.split('/').slice(0, -1)
      st.expanded = parts.map((_, i) => parts.slice(0, i + 1).join('/'))
      st.focus = 'editor'
    }
    load(st, props)
    surface.onKey(ev => onKey(surface, ev))
    surface.onPointer(ev => onPointer(surface, ev, treeW))
    surface.setState(st)
    if (!props.dirs['']) post({ type: 'list', dir: '' })
  }
  s.ref.props = props
  load(s, props)
  if (props.reveal !== s.reveal && props.file) {
    s.reveal = props.reveal
    s.focus = 'editor'
  }

  // ---- tree ---------------------------------------------------------------
  const expanded = new Set(s.expanded)
  const rows = matchRows(props, s.filter) ?? rowsOf(props, expanded)
  const treeRows = bodyH - 1
  s.sel = Math.max(0, Math.min(s.sel, rows.length - 1))
  if (s.sel < s.treeTop) s.treeTop = s.sel
  if (s.sel >= s.treeTop + treeRows) s.treeTop = s.sel - treeRows + 1
  const treeFocus = s.focus === 'tree' || s.focus === 'filter'
  const tree = rows.slice(s.treeTop, s.treeTop + treeRows).map((r, i) => {
    const at = s!.treeTop + i
    const isSel = at === s!.sel && treeFocus
    const isOpen = props.file?.path === r.path
    const icon = r.kind === 'dir' ? (expanded.has(r.path) ? '▾ ' : '▸ ') : '  '
    const label = `${'  '.repeat(r.depth)}${icon}${r.kind === 'dir' ? r.name + '/' : r.name}`
    return (
      <Text key={'t' + at} wrap="truncate" backgroundColor={isSel ? C.sel : undefined} color={r.isLoading ? C.faint : isOpen ? C.accent : r.kind === 'dir' ? C.dir : C.text} bold={isOpen}>
        {label.padEnd(treeW).slice(0, treeW)}
      </Text>
    )
  })
  const filterLine = s.focus === 'filter' || s.filter
    ? <Text key="filter" wrap="truncate" color={C.accent}>{`/ ${s.filter}${s.focus === 'filter' ? '▏' : ''}`}</Text>
    : <Text key="filter" wrap="truncate" color={C.faint}>{'/ filter files'}</Text>

  // ---- editor -------------------------------------------------------------
  const f = props.file
  let editor: any[]
  if (!f) {
    editor = [<Text key="none" color={C.faint}>Pick a file on the left.</Text>]
  } else if (f.readOnly && !f.text) {
    editor = [<Text key="ro" color={C.info}>{`${f.path}: ${f.readOnly}`}</Text>]
  } else {
    scroll(s, bodyH)
    const gw = String(s.lines.length).length + 1
    const textW = Math.max(4, editW - gw - 1)
    const curCol = shownCol(s.lines[s.cy]!, s.cx)
    const left = Math.max(0, curCol - textW + 1)
    const edFocus = s.focus === 'editor'
    editor = []
    for (let i = s.top; i < Math.min(s.lines.length, s.top + bodyH); i++) {
      const raw = shown(s.lines[i]!)
      const vis = raw.slice(left, left + textW)
      const num = <Text color={i === s.cy ? C.accent : C.faint}>{String(i + 1).padStart(gw - 1) + ' '}</Text>
      if (i === s.cy && edFocus) {
        const c = curCol - left
        editor.push(
          <Box key={'e' + i} flexDirection="row" width={editW}>
            {num}
            <Text backgroundColor={C.line} color={C.text} wrap="truncate">
              {vis.slice(0, c)}<Text inverse>{vis[c] ?? ' '}</Text>{vis.slice(c + 1).padEnd(Math.max(0, textW - c - 1))}
            </Text>
          </Box>,
        )
      } else if (!vis.trim() || !Code) {
        editor.push(<Box key={'e' + i} flexDirection="row" width={editW}>{num}<Text color={C.text} wrap="truncate">{vis || ' '}</Text></Box>)
      } else {
        editor.push(
          <Box key={'e' + i} flexDirection="row" width={editW}>
            {num}
            <Box width={textW}><Code source={vis} path={f.path} wrap="truncate-end" /></Box>
          </Box>,
        )
      }
    }
  }

  // ---- header and footer --------------------------------------------------
  const st = props.status
  const head = f
    ? `${props.rootName}/${f.path}  ${s.lines.length} lines${s.dirty ? ' · ● modified' : ''}${f.readOnly ? ` · ${f.readOnly}` : ''}`
    : `${props.rootName}  ·  ${rows.length} ${s.filter ? 'matches' : 'entries'}`
  const hint = s.focus === 'editor'
    ? 'ctrl+s save · ctrl+z undo · ctrl+y redo · ctrl+r reload · shift+tab tree · esc prompt'
    : s.focus === 'filter'
      ? 'type to search · ↑↓ pick · enter open · tab back to tree'
      : '↑↓ move · → open · ← close · / or type to search · tab editor · esc prompt'

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Box key="head" flexDirection="row" justifyContent="space-between" width={W}>
        <Text wrap="truncate"><Text color={C.accent} bold>Files </Text><Text color={s.dirty ? C.dirty : C.dim}>{head}</Text></Text>
        {st ? <Text color={st.kind === 'ok' ? C.ok : st.kind === 'err' ? C.err : C.info} wrap="truncate">{st.text}</Text> : props.size ? <Text color={C.faint} wrap="truncate">{props.size}</Text> : null}
      </Box>
      <Box key="body" flexDirection="row" height={bodyH}>
        <Box flexDirection="column" width={treeW}>
          {filterLine}
          {tree}
          {rows.length === 0 ? <Text color={C.faint}>{s.filter ? 'no matches' : 'loading…'}</Text> : null}
        </Box>
        <Box width={1} flexDirection="column">{Array.from({ length: bodyH }, (_, i) => <Text key={'b' + i} color={C.faint}>│</Text>)}</Box>
        <Box flexDirection="column" width={editW}>{editor}</Box>
      </Box>
      <Text key="foot" color={C.faint} wrap="truncate">{hint}</Text>
    </Box>
  )
}

export default Explorer

// ---- input --------------------------------------------------------------

function activate(surface: ClientSurface<State>, s: State, row: Row | undefined) {
  if (!row) return
  if (row.isLoading) {
    // ask again: the first answer may not have come back
    surface.post({ type: 'list', dir: row.path.slice(0, -2) } satisfies FilesRequest)
    return
  }
  if (row.kind === 'dir') {
    const has = s.expanded.includes(row.path)
    s.expanded = has ? s.expanded.filter(p => p !== row.path && !p.startsWith(row.path + '/')) : [...s.expanded, row.path]
    if (!has && !s.ref.props.dirs[row.path]) surface.post({ type: 'list', dir: row.path } satisfies FilesRequest)
  } else {
    if (s.dirty && s.path && s.path !== row.path) {
      // leaving unsaved work: save it first rather than lose it
      surface.post({ type: 'save', path: s.path, text: s.lines.join('\n'), version: s.version ?? 0 } satisfies FilesRequest)
    }
    // open the folders down to a file picked from the search
    const parts = row.path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/')
      if (!s.expanded.includes(p)) s.expanded = [...s.expanded, p]
    }
    surface.post({ type: 'open', path: row.path } satisfies FilesRequest)
    s.focus = 'editor'
  }
}

function currentRows(s: State): Row[] {
  const props = s.ref.props
  return matchRows(props, s.filter) ?? rowsOf(props, new Set(s.expanded))
}

function onKey(surface: ClientSurface<State>, ev: ClientKeyEvent) {
  const s = surface.state
  if (!s) return
  const next = { ...s }
  const k = ev.key
  const page = Math.max(1, (surface.rows || 30) - 4)

  if (next.focus === 'editor') {
    const f = next.ref.props.file
    if (!f) { next.focus = 'tree'; surface.setState(next); return }
    if (ev.ctrl && k === 's') {
      surface.post({ type: 'save', path: f.path, text: next.lines.join('\n'), version: next.version ?? 0, force: next.force } satisfies FilesRequest)
      next.dirty = false
      next.force = true
    } else if (ev.ctrl && k === 'r') {
      next.dirty = false
      next.version = -1
      surface.post({ type: 'open', path: f.path } satisfies FilesRequest)
    } else if (ev.ctrl && k === 'z') {
      const last = next.undo[next.undo.length - 1]
      if (last) { next.redo = [...next.redo, { lines: next.lines, cx: next.cx, cy: next.cy }]; next.undo = next.undo.slice(0, -1); next.lines = last.lines; next.cx = last.cx; next.cy = last.cy; next.dirty = true }
    } else if (ev.ctrl && k === 'y') {
      const last = next.redo[next.redo.length - 1]
      if (last) { next.undo = [...next.undo, { lines: next.lines, cx: next.cx, cy: next.cy }]; next.redo = next.redo.slice(0, -1); next.lines = last.lines; next.cx = last.cx; next.cy = last.cy; next.dirty = true }
    } else if (k === 'tab' && ev.shift) {
      next.focus = 'tree'
    } else if (!move(next, k, page)) {
      if (f.readOnly) { surface.setState(next); return }
      if (!edit(next, ev)) return
      next.force = false
    }
    surface.setState(next)
    return
  }

  if (next.focus === 'filter') {
    if (k === 'tab' || (k === 'backspace' && !next.filter)) { next.focus = 'tree'; next.filter = ''; next.sel = 0 }
    else if (k === 'up') next.sel = Math.max(0, next.sel - 1)
    else if (k === 'down') next.sel++
    else if (k === 'return') { activate(surface, next, currentRows(next)[next.sel]); next.filter = '' }
    else if (k === 'backspace') { next.filter = next.filter.slice(0, -1); next.sel = 0; surface.post({ type: 'find', q: next.filter } satisfies FilesRequest) }
    else if ([...k].length === 1 && !ev.ctrl && !ev.meta) { next.filter += k; next.sel = 0; surface.post({ type: 'find', q: next.filter } satisfies FilesRequest) }
    else return
    surface.setState(next)
    return
  }

  // tree
  const rows = currentRows(next)
  const row = rows[next.sel]
  if (k === 'up') next.sel = Math.max(0, next.sel - 1)
  else if (k === 'down') next.sel = Math.min(rows.length - 1, next.sel + 1)
  else if (k === 'pageup') next.sel = Math.max(0, next.sel - page)
  else if (k === 'pagedown') next.sel = Math.min(rows.length - 1, next.sel + page)
  else if (k === 'return' || k === 'right') {
    if (row?.kind === 'dir' && k === 'right' && next.expanded.includes(row.path)) next.sel = Math.min(rows.length - 1, next.sel + 1)
    else activate(surface, next, row)
  } else if (k === 'left') {
    if (row?.kind === 'dir' && next.expanded.includes(row.path)) activate(surface, next, row)
    else if (row) {
      const parent = row.path.split('/').slice(0, -1).join('/')
      const at = rows.findIndex(r => r.path === parent)
      if (at >= 0) next.sel = at
    }
  } else if (k === 'tab') {
    if (next.ref.props.file) next.focus = 'editor'
  } else if (k === '/') {
    next.focus = 'filter'
  } else if ([...k].length === 1 && !ev.ctrl && !ev.meta && k !== ' ') {
    next.focus = 'filter'
    next.filter = k
    next.sel = 0
    surface.post({ type: 'find', q: k } satisfies FilesRequest)
  } else return
  surface.setState(next)
}

function onPointer(surface: ClientSurface<State>, ev: ClientPointerEvent, treeW: number) {
  const s = surface.state
  if (!s || ev.type !== 'down' || ev.button !== 'left') return
  const next = { ...s }
  if (ev.y === 0) return
  if (ev.x < treeW) {
    if (ev.y === 1) { next.focus = 'filter'; surface.setState(next); return }
    const at = next.treeTop + ev.y - 2
    const rows = currentRows(next)
    if (at < 0 || at >= rows.length) return
    next.sel = at
    next.focus = 'tree'
    activate(surface, next, rows[at])
    if (next.filter && rows[at]?.kind === 'file') next.filter = ''
  } else if (next.ref.props.file && ev.y < (surface.rows || 30) - 1) {
    next.focus = 'editor'
    const gw = String(next.lines.length).length + 1
    next.cy = Math.min(next.lines.length - 1, next.top + ev.y - 1)
    const line = next.lines[next.cy] ?? ''
    // the click lands on a drawn column: walk the line to the character drawn there
    const want = Math.max(0, ev.x - treeW - 1 - gw)
    let cx = 0
    while (cx < line.length && shownCol(line, cx + 1) <= want) cx++
    next.cx = cx
    clamp(next)
  }
  surface.setState(next)
}
