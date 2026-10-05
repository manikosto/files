# files

A file explorer and editor pane for Claude Code, beside the transcript.

- **Project tree**: folders open and close with the arrows, a click, or Enter.
- **Fuzzy search**: start typing (or press `/`) to search every file in the project (git's list when it is a repository).
- **Editor**: highlighting, line numbers, current line, auto-indent on Enter, paste, undo and redo, save with ctrl+s.
- **Safe with Claude around**: when Claude edits the open file, the editor reloads it, unless you have unsaved changes; a save over a file that changed on disk since you opened it asks for a second ctrl+s.
- **Stays in the project**: it reads and writes only inside the folder it opened, links resolved.

## Use

```text
/files                 open or close the pane on the session's folder
/files src/app.ts      open a file
/files ~/some/folder   open another folder
```

Click into the pane to type; Esc gives the keys back to the prompt.

| Where | Keys |
| --- | --- |
| Tree | ↑ ↓ move · → or Enter open · ← close · `/` or any letter search · Tab editor |
| Search | type · ↑ ↓ pick · Enter open · Tab back |
| Editor | arrows, Home, End, PgUp, PgDn · ctrl+s save · ctrl+z undo · ctrl+y redo · ctrl+r reload · shift+Tab tree |

## Install

```sh
claude plugin marketplace add manikosto/files
claude plugin install files@files
```

Needs Claude Code 2.1.289 or later. Files over 60k characters open read-only.

## License

MIT
