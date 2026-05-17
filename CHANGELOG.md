# Changelog

All notable changes to **byteworkz** will be documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## [0.4.12] — 2026-05-17 — "named ranges"

byteSheet formulas can now use friendly names instead of raw cell refs.
`=SUM(Total)` reads infinitely better than `=SUM(A1:A50)`.

### Added

- **Workbook-scoped names registry** stored as `doc.names = { Name: target }`. Survives save/load via JSON.
- **Toolbar button `Nm`** opens a dialog to add / delete defined names. Default new-target is the current selection (so the typical flow is: select a range, click Nm, type a name, hit Add).
- **Targets restricted** to one of: a single cell ref (`A1`, `Sheet2!B3`), a rectangular range (`A1:B10`), or a numeric literal (`0.19`). No expressions, no name → name chains. This keeps substitution one-pass, side-effect-free, and free of precedence surprises.
- **Formula substitution** happens at `evaluate()` entry, before tokenize: identifiers in the formula text that match a defined name get replaced with the target text. The substitutor walks the string skipping string literals, function calls (`Foo(` is left alone), sheet-qualified refs (`Foo!A1`), cell-ref-shaped tokens (`A1`), and `TRUE`/`FALSE`.
- **Validation on input**: name must be `[A-Za-z_][A-Za-z0-9_]{0,30}`, may not shadow a function name (TRUE/FALSE/AND/OR/NOT) or look like a cell ref (`A1`). Targets are pattern-checked against the three allowed shapes. Bad input shows a toast, dialog stays open.

### Caveats (deferred — user edits the name's target manually if needed)

- **Insert/delete row/col does NOT auto-shift named-range targets.** Excel does shift them; we currently leave them as-is. If a user inserts a row at the top of a named range, the name still points to the original rows — a deliberate choice for v0.4.12 to keep the implementation small.
- **Sheet rename does NOT update qualified targets** like `Sheet2!A1`. Same rationale.

## [0.4.11] — 2026-05-17 — "cell merge"

byteSheet now supports rectangular cell merges — span a header across
multiple columns, group a label across rows, build a proper title row
without resorting to a long string trailing into the next cell.

### Added

- **Two toolbar buttons** in byteSheet: `⊟` (merge selection) and `⊞` (unmerge active cell). Also wired into the right-click context menu.
- **Per-sheet `merges: [{a, b}]`** array on each sheet. Each entry is the two corners of a rectangle; the top-left is the "anchor" where data lives.
- **`renderGrid` skip + colspan/rowspan** — non-anchor cells in a merge are omitted entirely from the HTML; the anchor `<td>` carries `colspan`/`rowspan` matching the rectangle's dimensions. Table layout stays correct under the existing `table-layout: fixed` + per-column width scheme.
- **Selection snaps to the full rectangle** — clicking anywhere in a merged cell selects the whole merge range so operations (clear, copy, format) act on the merge as a unit. Dragging over a merge during a drag-select extends the selection to its far corner.
- **Arrow-key nav jumps past merges** — pressing → on a cell adjacent to a merge skips to the cell after the merge instead of landing on a non-rendered cell. Shift-arrow extends through merges to the matching far edge.
- **Structural-op safety**: `shiftMerges` runs alongside `shiftChartsAndFilter` on every insert/delete row/col. A merge whose corner falls on a deleted row/col is dropped; surviving merges have their corners shifted. Sort refuses to run while merges intersect the data range (with toast prompting unmerge first) — re-ordering rows would scramble the rectangles unpredictably.

### Why this is in scope

It's the last "people expect this on first encounter" feature — alongside frozen panes (v0.4.10) and the upcoming named ranges, the gap to a recognizable mini-spreadsheet closes.

## [0.4.10] — 2026-05-16 — "frozen panes"

Last obvious spreadsheet feature: freeze the top row and / or first column
so headers stay put while you scroll through long sheets.

### Added

- **Two toolbar toggles** in byteSheet — `⇊R` freezes the top row, `⇉C` freezes the first column. Click again to unfreeze. Both can be on simultaneously, in which case the A1 corner cell is frozen on both axes.
- **Per-sheet state** — freeze settings live on each sheet (`sheet.freeze = { rows, cols }`), so different sheets in the same document can have different freeze configurations. Preserved in JSON save/load.
- **CSS `position: sticky` based** — no virtualization, no JS scroll listeners. Frozen cells get `top: 24px` (below the column header row) and / or `left: 36px` (after the row-number gutter). Stacking via z-index: normal td (none) < frozen row/col cells (2) < frozen row-head & col-head (3) < frozen corner (4) < the all-corners `sheet-corner` th (5).
- **Active button visual** — the toggle buttons get the standard `.active` class when the corresponding axis is frozen, matching the rest of the toolbar's active-state pattern.
- **Undo carries automatically** — `commitSnapshot()` already deep-clones the entire sheets array, so freeze toggles participate in undo/redo for free without any history-stack additions.

### Why this is the last "obvious" spreadsheet feature

Everything else on the wishlist (named ranges, cell-merge, comments, search-all-docs) is either a usability nice-to-have or a niche power feature. Frozen panes is the last item people *expect* a spreadsheet to have on first encounter.

## [0.4.9] — 2026-05-16 — "light theme support"

byteworkz was dark-only since day one. Now it follows the OS preference
by default and offers an explicit override in the About modal. Same
visual identity — just inverted palette.

### Added

- **Light palette** alongside the existing dark one. Inspired by GitHub / Linear / Notion light: warm white (`#ffffff` / `#f6f8fa`) surfaces, dark slate text (`#1a1f24`), restrained shadows (`rgba(20,40,60,X)` instead of pure black). Accent (`#FD7D00`) stays — brand-canonical.
- **`data-theme` attribute on `<html>`** drives the override. `:root[data-theme="light"]` applies light tokens unconditionally; `:root[data-theme="dark"]` forces dark even on a light-preferring system; **no attribute → follows `prefers-color-scheme` media query**.
- **Theme picker in About modal**: three pill buttons (Auto / Dark / Light). Click sets `data-theme` + persists to `localStorage.byteworkz.theme`. "Auto" removes the attribute and the saved value so the OS preference takes over again.
- **Early-apply IIFE** at the top of `app.js` reads the saved preference before any view renders. Minimises flash-of-wrong-theme on first paint. (FOUC remains briefly possible when the user has explicitly picked a theme that conflicts with their OS — the stylesheet applies the OS-default first, then JS swaps to the preference.)
- **`legal-lang.js`** (loaded by imprint/privacy pages) now also reads the same `byteworkz.theme` key, so legal pages match the main-app theme.
- **`<meta name="theme-color">`** has two entries with `media` queries — mobile address-bar color matches the active theme (white on light OS, navy on dark OS).
- **`color-scheme: dark light`** declared at the meta level so native form controls (scrollbars, color pickers) follow.

### Refactor — themeable tokens

Pulled out previously-hardcoded `rgba(...)` values into new semantic tokens so they can flip per theme:

| Token | Dark | Light |
|---|---|---|
| `--input-bg` | `rgba(0,0,0,0.25)` | `rgba(0,0,0,0.03)` |
| `--chip-bg` / `-strong` | `rgba(0,0,0,0.25/.35)` | `rgba(0,0,0,0.04/.07)` |
| `--backdrop` (modal) | `rgba(3,10,13,0.55)` | `rgba(20,30,40,0.40)` |
| `--grid-line` (hub) | `rgba(255,255,255,0.020)` | `rgba(0,0,0,0.025)` |
| `--tile-grad-a/b` (hub tiles) | dark navy translucent | white / off-white translucent |
| `--code-bg` (doc pre/code) | `var(--bg-2)` ≈ near-black | `#f4f6f8` light grey |
| `--inset-highlight` | `rgba(255,255,255,0.04)` | `rgba(255,255,255,0.55)` (now meaningful on light surfaces) |
| `--shadow-1/2/3` | rgba(0,0,0,…) deep | rgba(20,40,60,…) subtle |

All consumers (`styles.css`, `doc.css`, `sheet.css`) now reference these tokens instead of the literals. Future component additions get free theme support if they use the tokens.

### Known limitations (v1 — flagged as experimental)

- **FOUC on themed users with conflicting OS preference**: ~50ms flash of OS-default before JS applies the saved override. Could be eliminated with a CSP-allowed inline script in `<head>`, but that's a deploy-config change for a marginal win.
- **Charts use hardcoded canvas colors** (axes, labels): `rgba(255,255,255,0.12)` etc. On light theme the canvas-drawn axes will be near-invisible until next iteration. Marked as cosmetic — chart data still draws correctly.
- **CF rule presets use brand colors that may need recalibration for light backgrounds** — Red on light = pink-ish. User can pick custom colors.
- **Browser-test pending**: the light palette is mathematically coherent but hasn't been verified visually. Some component-level polish may surface on first real use.

### Service worker

- VERSION bumped to 0.4.9.

## [0.4.8] — 2026-05-16 — "byteDoc outline / TOC sidebar"

Right-side TOC for long byteDoc documents. Click a heading to jump
there; the active heading highlights as you scroll. Mirrors the
navigation affordance byteSheet has via sheet tabs.

### Added

- **Right-rail outline sidebar** (`.doc-outline`, 220px) listing every `H1` / `H2` / `H3` in the doc. Indented by level (H2 +18px, H3 +28px, smaller font). Hover lifts the row to surface-2; click smooth-scrolls to that heading.
- **Active-heading tracking** via `IntersectionObserver`. The heading occupying the top 40% of the visible editor viewport gets `.active` class — accent text + left accent bar + tinted background. Re-attaches on each render so re-loaded docs / tab switches re-observe the fresh DOM.
- **Click flash**: jumped-to heading flashes accent-tinted bg for 0.8s via `outline-pulse` keyframe. Eye lands where you jumped.
- **Toolbar button `≡`** (next to Find) toggles the sidebar. State persists to `localStorage.byteworkz.doc.outlineOpen` — preference survives page reload and is shared across documents.
- **Auto-hide for short docs**: < 2 headings → sidebar hidden regardless of toggle. Re-appears once you add a 2nd heading.
- **Mobile**: hidden via `@media (max-width: 900px)` — narrow viewports need full editor width.
- **Print**: outline hidden in print stylesheet (no chrome on paper).

### Architecture

- **Headings get a runtime `data-outline-id`** so each list entry can reference back to its source heading via DOM. Re-assigned on every render — no stale IDs accumulate.
- **`bindOutlineActiveTracking()`** disconnects + recreates the IntersectionObserver each render. Necessary because setActive() resets editor.innerHTML, replacing all heading elements with fresh ones (observer can't follow garbage-collected nodes).
- **rootMargin `0px 0px -60% 0px`** biases active-detection toward the top of the viewport. Without this, scrolling slowly leaves the LAST-visible heading marked active, which is the wrong intuition for a reader.

### Hook points

- `renderOutline()` called from: `setActive` (tab switch), editor `input` event (live-update while typing), and `buildDOM` (initial state from mount).

### Service worker

- VERSION bumped to 0.4.8.

### Tests

- 107 + 29 + 41 unchanged. Outline is DOM + IntersectionObserver heavy; not unit-testable in isolation.

## [0.4.7] — 2026-05-16 — "byteSheet conditional formatting"

The last big Excel-power-feature byteSheet was missing. Define rules
like "B2:B10 > 100 → red background" and matching cells paint
themselves automatically. Survives structural edits, undo, save/load.

### Added

- **`cond-format.js`** — pure-function module, ~90 LOC:
  - `evaluateCondRule(value, rule)` — handles 10 rule types: `gt` / `lt` / `gte` / `lte` / `eq` / `neq` / `between` / `contains` / `empty` / `notempty`. Numeric coercion from strings (so `"150"` matches `> 100`). Case-insensitive `contains`. Strict string-equality for `eq` / `neq`.
  - `refInCondRange(ref, rangeStr)` — bounds-check, supports single-cell ranges.
  - `shiftRangeStr(rangeStr, rowOp, colOp)` — analog to chart-range shift, but for the string format CF uses. Returns null if any endpoint is invalidated.
  - `describeRule(rule)` — short human-readable text for the rule-list UI.
- **`sheet.condFormat`** array: `{ id, range, rule, style: { bg, c, b?, i? } }`. `ensureShape` initialises to `[]` for old docs.
- **Toolbar `CF` button** after sort/filter. Click opens the modal.
- **Modal UI**: range input (default = current selection), rule-type dropdown (auto-hides the value field for `empty`/`notempty`, shows two for `between`), 5 color presets (Red/Yellow/Green/Blue/Accent), custom bg + text color pickers, bold toggle. Below: list of existing rules with preview chip + description + delete button. Adding a rule closes the modal; deleting an existing rule updates the list in place.
- **Paint integration** in `paintCell`: applied AFTER user `cell.s` so a matching rule overrides for the affected cells. Excel-style precedence — CF wins on match, user style wins outside the range.
- **Empty-cell-aware**: cells with no `cell` object are still checked against `empty`/`notempty` rules.

### Structural-edit integrity

- **`shiftChartsAndFilter`** now also walks `sh.condFormat` and applies `shiftRangeStr` per rule. Insert/delete row + col correctly shifts every rule's range. Rules whose range gets fully invalidated (e.g., the entire range was inside a deleted col) drop out.
- **Sheet rename / sort / filter** don't affect CF (range is positional, not data-bound; sheet name isn't part of CF range).
- **Sheet delete** drops the sheet's CF along with the sheet.
- **Sheet duplicate** deep-clones CF into the copy via `JSON.parse(JSON.stringify)`.
- **Undo** carries CF automatically — `state.doc.sheets` is in every snapshot, and CF lives inside each sheet.

### Tests

- **41 new conditional-format tests** in `tests/cond-format.mjs`: all 10 rule types incl. numeric coercion + empty cell handling + case-sensitivity, range containment edges (corners, single-cell, invalid), `shiftRangeStr` for insert/delete row+col + null-on-invalidate.
- Total: **107 formula + 29 CSV + 41 CF = 177 tests**, all green.

### Service worker

- VERSION → 0.4.7. `/cond-format.js` added to SHELL_FILES.

## [0.4.6] — 2026-05-16 — "byteDoc markdown shortcuts"

Notion / GitHub-style typing affordances in byteDoc. Type `**bold**` +
space and it becomes **bold**; type `## ` at line start and it becomes
H2. The toolbar still works for everything; markdown is just a faster
path for power typists.

### Added — inline shortcuts

Triggered on space-keydown after the closing marker. Inline-typed
markers transform; space inserts naturally after.

| Type | Result |
|---|---|
| `**X**` + space | `<strong>X</strong>` |
| `__X__` + space | `<strong>X</strong>` |
| `*X*` + space | `<em>X</em>` |
| `_X_` + space | `<em>X</em>` |
| `` `X` `` + space | `<code>X</code>` |
| `~~X~~` + space | `<s>X</s>` |

Inner-edge `\S` guards: `** X **` does NOT trigger (CommonMark-ish — markers can't be adjacent to whitespace).

### Added — block shortcuts

Triggered on space-keydown when the current paragraph contains only the
trigger marker. Space is consumed; cursor lands inside the new empty
block, ready to type.

| Line content | Result |
|---|---|
| `#` + space | `<h1>` |
| `##` + space | `<h2>` |
| `###` + space | `<h3>` |
| `>` + space | `<blockquote>` |
| `-` or `*` + space | `<ul><li>` |
| `1.` + space | `<ol><li>` |

Block triggers fire only inside plain `<p>` / `<div>` blocks. Inside an existing heading, list, table cell, or code block, they're skipped.

### Skipped contexts

- **Inside `<pre>` or `<code>`** — literal regions; transforming markers there would surprise users writing code.
- **Inside existing lists / headings / tables** — block triggers only fire from a plain paragraph.

### Undo integration

Each successful transform calls `commitSnapshot(active())` so Ctrl+Z
undoes the auto-format in one step, separately from preceding/following
text input.

### About modal

The keyboard-help section now includes a "byteDoc markdown shortcuts"
table. byteSheet shortcuts gained `Ctrl+Z/Y` undo (was missing).

### Service worker

- VERSION bumped to 0.4.6.

### Tests

- 107 + 29 unchanged. Markdown transforms are DOM-mutation heavy; not unit-testable without a JSDOM-style harness.

## [0.4.5] — 2026-05-16 — "print / PDF polish"

Ctrl+P now produces printer-friendly output instead of a dark-theme
screenshot. Resume, Budget, etc. templates all print cleanly. Browser
"Save as PDF" works as a side-effect.

### Added — shared print rules (`styles.css`)

- `@page { margin: 1.5cm; }` for consistent margins across browsers.
- Force `background: #fff !important; color: #000 !important;` on `html`/`body` so the dark theme doesn't bleed into the printer (and waste ink).
- Hide everything that isn't content: `.topbar`, `.toast-host`, `.modal-host`, `.ctx-menu`, `.view-hub`.
- Reset view positioning + animations for print (they assume viewport-fit which doesn't apply to paged media).

### byteDoc print rules (`doc.css`)

- Hide editor chrome (toolbar, tabs, find bar, status bar).
- Editor: white background, black text, no shadow, no border, full width, 11pt body / 22-16-13pt headings.
- **Page-break-avoid** on headings (no orphaned H1 at page-bottom), tables, code blocks (`<pre>`), blockquotes, images.
- `orphans: 3; widows: 3;` on paragraphs.
- Code blocks: light-grey background `#f5f5f5` + thin grey border + 3px left bar in grey (not orange — printer-friendly).
- Tables: 1px grey borders, light-grey header row.
- Links: dark-blue with underline (printable, recognisable).
- Strip transient artifacts: find-hit highlights become invisible, image-resize overlay hidden.

### byteSheet print rules (`sheet.css`) — new

byteSheet had no print CSS before; entire sheet was rendered as dark grid with gradient headers. Now:

- Hide chrome: toolbar, formula bar, sheet tabs, status bar, fill handle.
- Grid: 9.5pt, black text on white, 1px grey cell borders, light-grey headers (no gradient).
- Reset selection / active-header / range / fill-preview visuals — they don't belong on paper.
- **User cell formatting preserved**: bold, italic, alignment, number-format. User-chosen background/text colors carry over too (so a Budget's accent-orange header still reads as a header on paper — trade-off: extreme dark backgrounds may print badly, but that's the user's call).
- Error cells (`#REF!` / `#DIV/0!`): visible signal in print (dark-red on light-red bg).
- Charts: white-bg box, visible grey border, canvas renders as-is.
- Honest limitation documented: only the active sheet prints. To print another sheet, switch to it first then Ctrl+P. (Sheets aren't lazy-loaded; printing all would need a "print all sheets" mode that re-renders each — out of scope for v0.4.x.)

### Added — Print toolbar buttons

- `⎙` button at the end of both byteDoc and byteSheet toolbars. Click → `window.print()`. Discoverability for users who don't know Ctrl+P. Same path as the keyboard shortcut; nothing new behavioural.

### Service worker

- VERSION bumped to 0.4.5.

### Tests

- 107 + 29 unchanged. Print stylesheets aren't unit-testable — verify manually with Ctrl+P.

## [0.4.4] — 2026-05-16 — "byteSheet undo/redo"

byteSheet finally has the same snapshot-based undo that byteDoc has had
since v0.2.2. Closes the last big "modern app convention" gap. A bad
fill-drag, sort, paste, or accidental Delete-key is now reversible.

### Added

- **`state.history = { stack, cursor }`** linear-history stack, cap **100 entries**. Each entry is a `deepClone` of `state.doc.sheets` + `activeSheet` + UI selection (`activeRef` / `selStart` / `selEnd`). Title intentionally excluded — title rename is metadata, preserved across restores.
- **`commitSnapshot()`** called at the end of every user-facing mutation:
  - Cell edit commit (cell-editor Enter/Tab, formula-bar Enter)
  - Delete-key / `clearSelection`
  - TSV paste (`doPaste`)
  - Format ops (`toggleFormat` / `setAlign` / `setStyleField` / `clearFormat`)
  - Sort, Filter Apply, Filter Clear
  - Insert/Delete row + col
  - **Fill-down** (the v0.4.3 feature is now undoable)
  - Sheet rename / duplicate / delete / add
  - Chart insert / delete / drag-end
  - CSV import (creates a new sheet)
- **Dedup**: snapshots identical to the current cursor entry are skipped via JSON.stringify compare. Prevents Enter-on-unchanged-cell from polluting the stack.
- **Toolbar buttons** ↶ Undo / ↷ Redo at the very left of the byteSheet toolbar, with separator before format buttons.
- **Keyboard**: `Ctrl+Z` undo, `Ctrl+Y` and `Ctrl+Shift+Z` redo. Gated by `!inField` — when the user is in the title input, formula bar, or cell editor, browser-native text undo wins (text within a field is more useful to undo there than restoring an older sheet state).
- **Mount-time reset**: each new doc load starts a fresh history with the loaded state as `stack[0]`. Navigating away then back wipes the stack — undo history doesn't bleed across docs.

### Architecture

- **Snapshot pattern**: linear history with truncation, same shape as `doc.js`'s per-tab undo. `commitSnapshot` is idempotent on identical state.
- **Why end-of-action, not before-action?** Low-level helpers like `setCellValueFromInput` are called in batches (paste loops, fill loops, CSV import). Committing inside each would over-snapshot. Instead, only user-facing entry points commit. Less code, cleaner stack.
- **`deepClone`** wraps `structuredClone` with a `JSON.parse(JSON.stringify)` fallback for browsers without it (older Safari). `state.doc` is JSON-safe (no DOM refs, no functions), so semantics match.
- **Memory**: 100 × ~50KB typical snapshot = ~5MB worst-case in-memory. Not persisted to localStorage.

### Known limitations

- **Title rename not undoable** (excluded by design; matches Excel-style metadata vs. cell-data distinction).
- **Sheet view switch not snapshotted** (view-only navigation — would pollute the stack with non-data changes). But `activeSheet` IS in each snapshot, so undo CAN switch sheets if the undone edit was on another sheet (so the user sees where the change happened).

### Tests

- 107 + 29 unchanged. Snapshot/restore is DOM-state heavy; not unit-testable in isolation without mocking the full grid lifecycle.

### Service worker

- VERSION bumped to 0.4.4.

## [0.4.3] — 2026-05-16 — "byteSheet fill-down handle"

The drag-the-corner gesture every spreadsheet user expects. Closes the
biggest remaining feature gap in byteSheet — no more typing `=A2*2` 100
times when you can write it once and drag.

### Added

- **Fill handle** — 9×9px accent square at the bottom-right of the active selection. Lazy-rendered as a single position-absolute div inside the grid wrap (scrolls with content via content-relative coords). Visual: bordered with bg, soft accent glow, hover scales 15%. Drag this corner to fill cells outward.
- **All four directions**: down, up, right, left. Direction is inferred from which axis the drag target falls outside the source bounds. Targets inside the source bounds are no-ops (Excel-style "shrink-fill" is out of scope for v1).
- **Multi-cell source with arithmetic-progression detection.** If the source cells along the fill axis are numbers AND have a constant step (`1, 2, 3` or `10, 20, 30` or `5, 0, -5`), the fill extrapolates by `step` past the last source value. Per-cross-axis-line analysis: vertical fill analyzes each source column independently, horizontal fill each row. Single-cell sources default to plain copy (matches Excel's default — increment-by-1 requires Ctrl in Excel; we don't have a modifier path yet).
- **Formula refs shift on fill** via the existing `shiftRef` / `shiftRange` primitives from `sheet-formula.js`. So filling `=A1+B1` down auto-targets `=A2+B2`, `=A3+B3`, etc. Absolute markers (`$A$1`, `$A1`, `A$1`) are respected — they don't shift, exactly as in insert/delete-row/col operations. Consistent behaviour across all structural ops.
- **Plain-copy with wrap** for non-numeric / non-series sources. Pattern repeats modulo source length. So filling `A, B, C` down to 8 cells produces `A, B, C, A, B, C, A, B`.
- **Post-fill selection expansion**: after fill, the selection grows to cover source + filled range. Active cell stays at the source top-left. Lets you chain a second fill from the new bottom-right.
- **Live preview** during drag — target cells get a dashed accent border + subtle accent tint (`.fill-preview`), distinct from regular selection styling so source vs. target stays readable.
- **Toast feedback**: `Filled N cells.` after a successful drop.

### Known limitations

- **No undo for byteSheet** (broader than fill — byteSheet has never had an undo stack; byteDoc does via snapshot history from v0.2.2). A bad fill is permanent in this session unless the user manually re-edits. Adding sheet-wide undo is a future v0.5.x candidate.
- **No date / weekday / "Q1" pattern detection**. Numeric arithmetic progressions only.
- **No Ctrl-drag increment-by-1** for single-cell numeric sources.
- **No shrink-fill** (dragging the handle inward to delete part of the source).

### Service worker

- VERSION bumped to 0.4.3.

### Tests

- 107 + 29 unchanged. Fill logic is integration-heavy (DOM + state); the underlying shift primitives are already covered by the 107 formula tests.

## [0.4.2] — 2026-05-16 — "byteDoc code blocks + image drop"

byteDoc was the leaner of the two apps. This release closes the feature
gap with three editor enhancements that match user expectations from
modern web editors (Notion / GitHub / etc.).

### Added — code blocks

- **`PRE` and `CODE`** added to the sanitizer whitelist (was blacklist before; now correctly typed in the per-tag allow list).
- **Toolbar `</>` button** inserts a `<pre><code>// code</code></pre>` block plus a trailing empty paragraph (so the user has a way out of the pre block via plain Enter).
- **Tab inside `<pre>`** inserts an actual `\t` character instead of moving focus out of the editor. Shift+Tab is intercepted but no-op for now (real outdent semantics would need parsing the line — out of scope).
- **CSS**: pre gets a left accent bar + slightly darker surface + horizontal scroll on overflow, `tab-size: 4`. Inline `<code>` (e.g. from pasted GitHub markdown) gets a rounded accent-tinted chip treatment.

### Added — image drop + paste

- **Drag-and-drop image** into the editor. Multiple files in one drop are all inserted. Files-only detection (`dataTransfer.types.includes('Files')`); dragging plain text falls through to the browser's default contenteditable handler. Caret is placed at the drop point via `document.caretRangeFromPoint` (with Firefox `caretPositionFromPoint` fallback) so the image lands where the pointer is, not at the end of the doc.
- **Paste image from clipboard** (screenshots, copied images). Detected via `clipboardData.files`. Processed BEFORE the text/html fallback because some websites paste both an image file AND an `<img src="https://...">` HTML fragment — the file gives us bytes to inline as a DataURL right now, while the HTML path would re-fetch over the network and break offline.
- **8 MB per-image cap**, reused from the existing image-picker flow. Oversize files toast and skip; the rest of a multi-image drop still completes.
- **Visual feedback**: `.drag-over` class on the editor applies a 3px accent halo + accent border + inner ring while a file is being dragged. Uses a depth counter (not a flag) so dragenter/leave events from child elements don't flicker the highlight.

### Service worker

- VERSION bumped to 0.4.2.

### Tests

- 29 + 107 unchanged.

## [0.4.1] — 2026-05-16 — "CSV import"

CSV import closes the export-only gap. Users can drop a `.csv` file on
the hub (creates a new bytesheet doc) or open one inside byteSheet
(adds as a new sheet in the current doc). Auto-detects delimiter,
auto-formats header row if it looks like one.

### Added

- **`csv.js`** — new module, ~120 LOC:
  - `parseCSV(text, delimiter?)` — RFC 4180-enough parser. Handles quoted fields, doubled-quote escape (`""` → `"`), CRLF + LF endings, UTF-8 BOM strip, trailing-newline tolerant.
  - `sniffDelimiter(text)` — counts `,` / `\t` / `;` in the first 2KB and picks the winner. Excel uses `;` in DE/FR locales, our sniff catches that.
  - `detectHeader(rows)` — heuristic: row 1 all non-numeric AND row 2 has at least one number → header. Avoids false positives on numeric-only data.
  - `csvToCellsObj(rows, opts)` — produces a byteSheet `cells` object. Number coercion uses the same roundtrip check as cell-edit input (`parseFloat(s)` AND `String(n) === s.trim()`) so `"1.00"` stays a string. Caps at `maxRows=1000`, `maxCols=80` (grid limits). If header detected, row 1 cells get `{ b: 1, c: "#FD7D00" }` styling.
- **byteSheet `doOpen` extended** to handle `.csv` and `.txt`. Picks the file → if JSON, existing flow; if text, parses as CSV and adds a fresh sheet to the current doc, named after the filename (`data.csv` → `Sheet "data"`). Uses `uniqueSheetName(base)` to avoid collision with existing tabs.
- **Hub `openAnyFile` extended** to handle `.csv` / `.txt`. Drops the user straight into a new bytesheet doc with the imported data. One-click path from "I have a CSV" to "it's in byteworkz".
- **Truncation toast** when CSV exceeds 1000 rows: `Imported 1000 × N (truncated from 5234 rows).`

### Tests

- **29 new CSV tests** (`tests/csv.mjs`): quoted fields, escaped quotes, CRLF, BOM, empty input, only-newlines, delimiter sniffing (comma/tab/semicolon/mixed), header detection edge cases, cell-conversion structure, number-vs-string coercion (incl. `1.00` stays string), truncation, empty-field skipping.
- Formula tests still **107/107**.

### Schema unchanged

CSV import goes through the same `docs.save()` path as everything else.
No new persistence format. Downloads continue to be JSON; CSV is import-
only at the storage layer. (We already had CSV export from a single sheet
via the toolbar.)

### Service worker

- VERSION bumped to 0.4.1. `csv.js` added to SHELL_FILES (offline-capable).

## [0.4.0] — 2026-05-16 — "Hub templates"

First-time visitors land on a hub that's no longer just an empty Recent
list with two New buttons. Five templates give a concrete starting
point and double as a showcase for both apps.

### Added

- **`/templates/` directory** with 5 high-quality starting points:
  - **Resume** (byteDoc) — headings, experience, education, skills laid out cleanly
  - **Meeting Notes** (byteDoc) — agenda, discussion, action items, parking lot
  - **Letter** (byteDoc) — formal header, subject line, signature blocks
  - **Monthly Budget** (byteSheet) — income, expenses, totals + live `SUM`, `B6-B16` formulas, savings rate as `%` formatted percentage
  - **Inventory** (byteSheet) — items × qty × unit price → line totals, grand total via `SUM`, plus `AVG` and `MAX` summary cells
- **Hub "Start with a template" section** between the big tiles and the action row. 5 cards in a responsive `auto-fill, minmax(180px, 1fr)` grid (4 per row on desktop, wraps on mobile). Each card: icon + app badge + title + 1-line description. Same accent-halo hover treatment as the main hub tiles, just tighter.
- **`instantiateTemplate(meta)`** in `app.js`: fetches the template JSON, stamps fresh `id` + `createdAt`/`updatedAt`, persists via the normal storage path, navigates to `#/doc/<id>` or `#/sheet/<id>`. The template's title (e.g. "Monthly Budget") is kept as the initial doc title — user can rename via the topbar input.

### Architecture

- **`/templates/index.json`** is the discovery manifest — `app.js` reads it once on first hub render, caches in `_templatesCache`. Adding a new template means: drop a new JSON file in `/templates/`, add an entry to `index.json`, add the filename to `sw.js`'s `SHELL_FILES`.
- **Service worker version bumped to 0.4.0**. New cache `byteworkz-shell-v0.4.0` includes the 6 new template files. Old `byteworkz-shell-v0.3.4` cache is purged in the SW `activate` step. Users on v0.3.4 will see a "New version available" toast.
- **Schema reuse**: templates are regular `.bytedoc.json` / `.bytesheet.json` files (same shape as user-downloaded docs). The only "template-ness" is at the discovery layer (`index.json` lists them). Means: a power user can save their own doc, drop the JSON in `/templates/`, and it becomes a template — no code change needed.

### Tests

- 107/107 unchanged. Templates exercise the existing formula engine (`SUM`, `AVG`, `MAX`, `B6-B16`, `B18/B6`) — all covered.

## [0.3.4] — 2026-05-15 — "PWA: offline + installable"

byteworkz is now an installable, offline-capable PWA. No accounts, no cloud
— the existing "lives in your browser" promise now extends to "lives on
your device" with full offline support after first load.

### Added

- **Service worker** (`sw.js`). Precaches the entire app shell on first install (16 files: HTML, all JS modules, all CSS, manifest, favicon, version.json, legal pages, lang script). After install:
  - **`/version.json`** → network-first (so update detection sees the real current version)
  - **Everything else** → stale-while-revalidate (instant cache hit, background refresh, cache fallback when offline)
- **Update-available toast**. When a new SW version is installed in the background, a sticky toast appears with a "Reload" button. Click → page posts `SKIP_WAITING` to the waiting SW → SW activates → page reloads into the fresh shell. No mystery cache-invalidation bugs; the user is always in control of the upgrade moment.
- **Install button in About modal**. Captures `beforeinstallprompt` and surfaces an explicit "Install byteworkz" action with an accent-tinted callout card. The browser's default install UI also still works (address-bar icon on Chromium, "Add to Home Screen" on iOS). Section only appears when the browser deems the app installable.
- **iOS PWA hooks** in index.html: `apple-mobile-web-app-capable`, status-bar-style, `apple-touch-icon` pointing at favicon.svg. iOS 16+ accepts SVG icons; earlier iOS falls back to a page screenshot but install still works.

### Update strategy

The SW deliberately does NOT `skipWaiting()` on its own. Doing so would risk a running page (with old JS bundles) suddenly seeing new cached chunks mid-session — the kind of "PWA cache hell" everybody complains about. Instead:

1. Browser detects sw.js source change → installs new SW → enters `waiting`.
2. Page's `updatefound` listener catches the state transition to `installed` (and verifies a `controller` exists, so we don't show this on first-ever visit).
3. Toast appears: "New version available — Reload".
4. User clicks Reload → page sends `SKIP_WAITING` postMessage → SW activates → `controllerchange` listener fires → `location.reload()` lands the user on the new shell.

This makes upgrades explicit and predictable. The `VERSION` constant in sw.js doubles as a cache-bust key — bumping it forces all clients to drop the old `byteworkz-shell-v0.x.x` cache and rebuild.

### Tests

- 107/107 unchanged.

## [0.3.3] — 2026-05-15 — "audit pass 4"

Fourth deep audit pass. Found one real data-loss bug, two correctness
bugs around sheet naming, plus two defensive fixes.

### Fixed (WICHTIG — data loss)

- **byteDoc: clicking the already-active tab clobbered unflushed edits.** The setActive(id) path always re-populated `editor.innerHTML` from `d.html` — but `d.html` only catches up to the live editor on the 900ms debounced save. Click your active tab within 900ms of the last keystroke and the just-typed text was reset to the last saved version. Fixed via idempotent early return when `state.activeId === id`. Paired with: `unmount()` now clears `state.activeId` so that a fresh mount after navigation-away (where the editor element was destroyed) still populates correctly.

### Fixed (WICHTIG — silent data corruption)

- **byteSheet: + button could collide with existing sheet names.** Naive `Sheet${len+1}` collides after the user deletes a middle sheet — e.g., `[Sheet1, Sheet2, Sheet3]` → delete Sheet2 → `[Sheet1, Sheet3]` (length 2) → next was "Sheet3" which already existed. Formula cross-sheet refs match by name and `findIndex` returns the first hit, so a name collision silently corrupted every formula targeting the duplicated name. Now `nextSheetName()` scans for the lowest unused `SheetN`.
- **byteSheet: Duplicate didn't check name collision.** Duplicating "Sheet1" twice produced two sheets both named "Sheet1 (copy)" — same `findIndex` corruption as above. Now `uniqueCopyName(base)` appends ` (copy 2)`, ` (copy 3)`, etc. as needed.

### Fixed (defensive)

- **`shiftChartRange` now try/catches malformed ref strings.** `splitRef` throws `#REF!` on a string that doesn't match `^[A-Z]{1,3}\d{1,5}$` — could happen via JSON tamper or format-migration debris. Without the catch, one bad chart blew up the entire row/col insert/delete operation. Catch + return null → the bad chart gets dropped, rest of the operation proceeds.
- **byteSheet: better error before opening chart dialog with single-column selection.** Chart format reserves col 1 for labels and cols 2+ for data — a single-column range renders "(no numeric data)" silently after the user goes through the modal. Now caught up-front with "Select at least 2 columns: labels + data."

### Audited but left as-is

- **Multi-tab cross-edit race** — known v1 limitation, deferred.
- **Sheet name case sensitivity** — `Sheet1` and `sheet1` are distinct in our model (Excel treats them as one). Would require non-trivial migration of existing docs. Deferred.
- **Image paste from clipboard** — feature gap, not a bug. Use the image toolbar button. Deferred.
- **Performance: querySelector storm on huge drag-selects** — selecting full grid fires ~252 querySelectors per mousemove. Real-world fine; would need a header/cell Map cache to amortize. Deferred.
- **Sort with no header row** — currently hardcoded `firstDataRow = 2`. UX limitation. Deferred.

### Tests

- 107/107 unchanged. The new code paths need a full DOM smoke-test which lives outside the formula unit-test suite.

## [0.3.2] — 2026-05-15 — "audit pass 3 — structural-edit integrity"

Third deep audit pass turned up five real correctness bugs in
byteSheet's structural-edit story. These weren't user-reported — they
just lurk until somebody inserts a row above a chart or deletes the
sheet a chart depends on. Fixed all five plus one cosmetic tweak.

### Fixed (WICHTIG)

- **Chart range refs didn't track row/col insert + delete.** Inserting a row above a chart's range left the chart pointing at the *old* row numbers — so it silently rendered the row above + missed the row below. Same for columns. Now `insertRowAtActive` / `insertColAtActive` / `deleteActiveRow` / `deleteActiveCol` all shift every affected chart's `range.start` and `range.end` via a new `shiftChartRange` helper that mirrors the formula-ref shift logic. Out-of-bounds endpoints drop the chart entirely (matches Excel — a chart whose data was deleted is broken, not silently misleading).
- **Filter column didn't track col insert + delete.** A filter on column C survived a "delete column C" with `sh.filter.col = "C"` still set — but column C now held the data from former column D, so the filter applied yesterday's allow-set against today's data. Now col-shift updates `filter.col`; if the filtered column itself was deleted, the filter is cleared.
- **Sheet delete left dangling chart references.** `chart.range.sheet` is an index (not a name) — deleting Sheet2 in a 3-sheet doc didn't touch any of the charts; charts in Sheet1 that referenced Sheet3 (index 2) now silently re-pointed at whatever sat at index 2 after the splice (the former Sheet3). Now every other sheet's charts are walked: charts referencing the deleted sheet are dropped, charts referencing later sheets shift down by 1.
- **Sheet duplicate left charts pointing at the original.** `JSON.parse(JSON.stringify(s))` deep-copied the charts but their `range.sheet` still indexed the original. The duplicate's charts rendered the original's data, ignoring any edits to the duplicate. Plus other sheets' charts referencing sheets after the insertion point silently shifted to the wrong sheet. Now both classes are fixed: copy's self-refs re-target to `idx+1`, and existing charts referencing `>= idx+1` shift up.

### Fixed (cosmetic)

- **Active cell inset glow reduced** from `inset 0 0 12px` to `inset 0 0 6px`. On 24px-tall cells the 12px shadow covered half the vertical space and read as "the whole cell is on fire" rather than "this is the focused cell". Same reduction in the cell-editor.

### Tests

- 107/107 unchanged. The new code paths aren't currently covered by tests — they require a full sheet doc + DOM. Manual smoke-test scenarios in the CHANGELOG.

## [0.3.1] — 2026-05-15 — "app interior polish"

The 0.3.0 polish landed mostly on the hub. This one targets the actual
apps — the bits the user spends 99% of their time in.

### byteSheet

- **Excel-style row + column header highlight.** Clicking C5 now highlights the C column header AND the 5 row header with an orange tint + accent text. Makes "where is the active cell?" instantly readable across a wide grid. Updates with selection drag, arrow-key navigation, click — anywhere the selection moves. Cleared automatically when selection changes.
- **Subtle cell hover state.** Hovering a cell paints it with 4% accent — Excel does this, Sheets doesn't. Doesn't compete with selection or range visuals since the tint is well below those.
- **Status bar as chips.** Was: plain pipe-separated text. Now: dark pill chips with accent labels (`CELL A1`, `∑ 1234`, `x̄ 411`, `N 3`). The active-cell chip gets an orange-tinted border + glowing strong text.
- **Accent text selection** inside cell editor and formula bar — orange-tinted background instead of browser default blue.

### byteDoc

- **Status bar as chips.** Same chip system as byteSheet. `W 142`, `C 891`, `¶ 12`, brand right-aligned.
- **Accent text selection** in the editor body — orange-tinted, visible across body / headings / bold / etc.
- **Editor focus ring.** When the editor has focus, border picks up a soft 25% accent + a 3px outer halo. Subtle — only there when you're writing.

### Shared

- **Save indicator animations.**
  - `saving` → pulsing accent dot with a soft glow (1.1s ease-in-out infinite, opacity + scale).
  - `saved` → green dot pop (0.4 → 1.3 → 1, cubic-bezier soft).
  - `error` → red dot quick horizontal shake.
- **Polished button dividers** — vertical gradient line instead of flat 1px, fades at the ends so the divider has presence without being a hard rule.

## [0.3.0] — 2026-05-15 — "visual polish"

Top-to-bottom design refresh, voidcore-aligned. No functional changes —
this release is pure aesthetics. Same JS, same persistence, same
feature set. CSS-only.

### Hub

- **Wallpaper background**: two radial gradients (orange top-left, teal bottom-right) layered over a faint 40×40px grid masked with a radial fade. Mirrors the voidcore desktop feel adapted for a single-page app.
- **Wordmark redesigned**: 56px ultra-thin (font-weight 200), -0.04em letter-spacing, accent-coloured first letter with a halo glow.
- **Tiles relifted**: gradient surfaces (`linear-gradient(155deg, …)`), multi-layer drop shadows, hover halo (radial gradient on top edge fades in), translate-Y lift, icon scale + glow. Active state has a press-down tactile feel.
- **Recent rows**: hover slides right 2px, delete button only appears on hover (reduces visual noise at rest), badge is now a pill with monospace caps.
- **Section title accent**: `// Recent` prefix in monospace, accent-coloured — picks up the voidcore comment-style typography motif.

### Topbar

- **Glassmorphic** (`backdrop-filter: blur(14px) saturate(140%)`) with feature-detect fallback to solid surface.
- Brand mark gets a `drop-shadow(0 0 8px accent-glow)` filter.
- Version chip is now a pill with mono font on dark background instead of bare text.

### Buttons

- Bigger radius (`--radius: 4px → 8px`, `--radius-lg: 8px → 14px`).
- Primary button: vertical gradient (`--accent-2 → --accent`), inset highlight, expanding glow on hover, press-down on active.
- Icon buttons: transparent at rest, subtle bg on hover (less visual chrome by default).
- Disabled state explicitly cancels hover transforms.

### Doc editor

- **Paper feel**: editor card now sits on a slightly-radial background, has 80px horizontal padding, larger radius (14px), multi-layer shadow, top inner highlight stroke.
- **Typography**: body 15.5px / 1.72 line-height (was 15 / 1.65). Headings get tighter letter-spacing.
- **Links**: underlined with 40% accent decoration; goes to full accent on hover.
- **List markers**: orange (`li::marker`).
- **Blockquote**: subtle orange-tinted background + rounded right corner.
- **Images**: drop-shadow at rest, accent-glow when selected.
- **Tables**: gradient header background, rounded corners (overflow hidden so cells fit the radius).
- **Find bar**: slides in from top, focus state gets a 3px outer ring in accent-dim.
- **Find highlights**: 1px accent-tinted box-shadow ring; active match glows.

### Sheet grid

- **Headers**: vertical gradient, accent-coloured on hover; row-head + col-head get a stronger border on the body-facing edge.
- **Formula bar**: cell-ref label in accent colour and bold mono; input gets a 3px accent-dim focus ring.
- **Active cell**: outline + inset accent-dim glow.
- **Cell editor**: inset orange glow while editing.
- **Sheet tabs**: active tab gets a top accent bar with bottom glow (mirrors doc-tabs treatment).
- **Charts**: gradient header bar, stronger drop shadow.
- **Filter popover**: glassmorphic.

### Motion

- New motion tokens (`--t-fast: 120ms`, `--t-norm: 200ms`, `--t-soft: 280ms cubic-bezier(0.2, 0.8, 0.2, 1)`).
- View transitions: 220ms fade + 4px translate-up.
- Modal: scale(0.94)+8px-down → identity, 220ms, soft cubic-bezier. Backdrop blurs in over 180ms.
- Toast: 10px lift + scale(0.96) → identity.
- Context menu: drops in with subtle scale.
- `@media (prefers-reduced-motion)` zeroes all animations + transitions globally.

### Scrollbars

- Webkit: 10px wide, 6px-radius accent-on-hover thumb on transparent track, padding inset of 2px so the thumb looks floating.
- Firefox: `scrollbar-width: thin; scrollbar-color: border-strong transparent`.

## [0.2.4] — 2026-05-15 — "audit pass 2"

Second `/byteside:debug-web-loop` pass, deeper into the formula engine
and storage layer. Three small defensive fixes — no user-visible
behaviour changes except correct error reporting on malformed formulas.

### Fixed (MINOR)

- **Tokenizer silently truncated unterminated string literals.** `="abc` with no closing `"` produced a successful STR token (value `"abc"`) and trailing source content vanished. Now throws `#ERROR! unterminated string`, matching Excel. Two new test cases lock the behaviour down.
- **`colToNum` defensively uppercases input.** The function is exported; an external caller (or manually-edited JSON) passing `'a'` would previously get 33 (`97 - 64`) instead of 1, silently mis-targeting cells. Internal callers always pass uppercase (via `parseRefMatch`'s `.toUpperCase()`), so no regression — just a hardened API surface.
- **`evictOldestUntilFits` final `setItem` was unguarded.** On browsers that bill quota against an in-progress write, the recent-list write could itself throw `QuotaExceededError` after we'd already evicted blobs — leaving recent list and blob inventory inconsistent. Wrapped in try/catch; self-heals on next save.

### Tests

- **107/107** (up from 105). Two new cases for unterminated-string error paths.

## [0.2.3] — 2026-05-15 — "audit pass"

Systematic codebase scan ([/byteside:debug-web-loop]) turned up one security
issue and one rare UI bug.

### Security (KRITISCH)

- **XSS hardening in byteDoc** — a hand-crafted `.bytedoc.json` (or a directly tampered localStorage entry) could previously inject scripts via attributes the old blacklist didn't cover: `onmouseover`, `onfocus`, `onpointerdown`, `formaction`, `srcdoc`, and many others. The sanitizer is now **whitelist-based**: per-tag enumeration of allowed attributes (`A` → `href`/`target`/`rel`, `IMG` → `src`/`alt`/`width`/`height`, everything else → zero attrs). Plus `href` must match `https?:|mailto:|tel:|ftp:|#|/|.` and `src` must match `data:image/...|https?:` — `javascript:`, `data:text/html`, `vbscript:` all get stripped.
- **Sanitize on load, not just on paste** — `setActive()` now runs `sanitizeHTML()` on the doc body before assigning to `editor.innerHTML`. Without this, malicious html persisted from any source (file open, dev-tools tamper, pre-0.2.3 entries) would re-execute on every mount. Self-healing: the next debounced save writes the cleaned html back to localStorage.

### Fixed (MINOR)

- **Context menu spurious close** (`ui.js`) — opening two context menus in rapid succession left the first menu's `{once: true}` outside-click listener stale-attached. The next click anywhere triggered it, found its (gone) menu didn't contain the target, and called `closeContextMenu()` — closing the *second* menu. The handler is now tracked explicitly and removed in `closeContextMenu()`. Side benefit: also clamps menu position to `Math.max(2, …)` so a small viewport / large menu doesn't render off-screen left.

## [0.2.2] — 2026-05-15 — "byteDoc focus"

byteDoc hadn't had a focused release in seven versions; this one is.

### Added — snapshot undo/redo

- **Per-tab linear history stack** (cap 100 entries) replaces reliance on the deprecated browser-native `document.execCommand` undo. Each entry stores `{html, sel}` where `sel` is a DOM-path encoding of the caret/range. Undo restores both content **and** caret position.
- **Keyboard**: `Ctrl+Z` undo, `Ctrl+Y` and `Ctrl+Shift+Z` redo. Intercepted with `preventDefault` so the browser's native stack doesn't fight ours.
- **Toolbar buttons**: ↶ Undo / ↷ Redo, leftmost in the toolbar.
- **Commit timing**: idle typing commits 700 ms after the last input. Structural operations (table insert, image insert, paste, formatting via execCmd, link insert, image resize, find-replace, row/col add/delete, table delete) commit synchronously — they don't fire `input` events on contenteditable reliably and would otherwise be invisible to undo.
- **Stack hygiene**: identical-html commits are no-ops. Switching tabs commits the outgoing tab's state into its own per-tab stack before navigating, so edits aren't dropped or attributed to the wrong tab. Undo branches are truncated on the next commit (standard linear-history semantics).

### Fixed

- **Find-bar `<mark>` wrappers no longer leak into persistence**. With the find bar open, the editor's innerHTML contained transient `<mark class="find-hit">` elements; the debounced autosave was writing those into localStorage, so they survived reload. Added a `cleanHtml()` helper that strips them; called from `saveDebounced`, `doDownload`, `doExportHtml`, snapshot commits, and the outgoing-tab capture in `setActive` / `unmount`.

## [0.2.1] — 2026-05-15

### Fixed (completes the v0.2 spreadsheet-parity story)

- **Sort now updates formula refs** to follow the physically-moved cells. Single refs (`=A1`, `=$A$1`, `=Sheet2!A5` from other sheets pointing back at the sorted sheet) all track to the cell's new row. Range boundaries (`SUM(A1:A3)`) are deliberately preserved — the data within a range gets reordered, not relocated, so `SUM(A1:A3)` after sorting rows 1-3 still sums the same physical cells.
- **Absolute refs follow during sort** (Excel semantics): `=$A$1` becomes `=$A$3` if the cell at A1 sorted to A3, because `$` means "this specific cell" — and that cell physically moved. This differs from insert/delete where `$` means "row 5 specifically, regardless of shifts". Implemented via `{force:true}` option on `shiftRef` / `shiftRange`.
- **Refs in other sheets that target the sorted sheet** now also update (e.g., `=Sheet1!A2` in Sheet2 becomes `=Sheet1!A5` if Sheet1's row 2 sorted to row 5).

### Tests

- 105/105 (was 100). 5 new sort scenarios: bare refs, absolute refs, range preservation, out-of-sort-range rows, cross-sheet specificity.

### v0.2 milestone closed

Spreadsheet feature parity now covers: formula re-targeting on insert/delete row+col (v0.1.8), sheet-rename ref updates (v0.1.9), 17 new functions including VLOOKUP / SUMIF / INDEX / MATCH / dates / strings, cycle detection, persistent filter (v0.2.0), and sort-refs (v0.2.1). Remaining known limitation: deleting an absolute column still leaves the absolute ref intact instead of emitting `#REF!` — small follow-up.

## [0.2.0] — 2026-05-15 — "Spreadsheet feature parity"

The four-commit milestone (v0.1.7 → v0.1.8 → v0.1.9 → v0.2.0) closes the
biggest correctness and feature gaps in byteSheet relative to user
expectations from real spreadsheets.

### Added — formula library expansion (17 new functions)

- **Lookup**: `VLOOKUP(value, range, col_index, [exact])`, `INDEX(range, row, [col])`, `MATCH(value, range, [type])` (exact match + approximate for ascending/descending)
- **Conditional aggregates**: `SUMIF(range, criterion, [sum_range])`, `COUNTIF(range, criterion)`, `AVERAGEIF(range, criterion, [avg_range])`. Criterion syntax: `">100"`, `"<=50"`, `"<>x"`, or a literal for equality
- **Date / time**: `TODAY()`, `NOW()`, `DATE(y, m, d)`, `YEAR(v)`, `MONTH(v)`, `DAY(v)` (epoch-ms underlying type)
- **Text slicing**: `LEFT`, `RIGHT`, `MID`, `FIND`, `SUBSTITUTE` (with optional nth-occurrence), `REPLACE` (Excel-style: `text, start, length, new`)
- **Numeric**: `SIGN`, `TRUNC`

### Added — cycle detection

- `markCycles()` runs Tarjan's SCC algorithm on the formula dep graph after `fullRecompute` and `recomputeDependents`. Cells in non-trivial SCCs (size > 1, or single cell with self-loop) are marked `#CYCLE!`. Before this release, a cycle like `A1 = B1, B1 = A1` would silently exhaust the 30-pass-cap and leave both cells at whatever number the last pass produced.

### Added — persistent filter

- `sheet.filter = { col, allowed: [...] }` now persists on the sheet object. Filter survives sheet switches, structural edits (insert/delete row/col), save/load. The filter modal pre-populates checkboxes from the existing filter and offers a "Clear filter" button when one is active. "Apply all" auto-clears the filter.

### Range tokens now carry 2D shape

- `RANGE` evaluation produces `{__isArray:true, values, rows, cols}` so the new lookup functions can navigate 2D grids (row-major). The existing aggregate functions ignore the shape — backwards compatible.

### Tests

- 100/100 (was 74). New cases: 8 string-slicing, 5 numeric extras, 5 conditional-aggregate, 5 lookup, 3 date.

### Known limitations remaining (deferred)

- **Sort** still doesn't update formula refs in moved rows. Sort moves data faithfully, but a formula like `=A1` inside a row that gets sorted to position 5 keeps pointing at A1 instead of tracking the moved cell. Requires "rows-as-units" semantics in the sort which the current implementation doesn't model.
- **Deleting an absolute column** (e.g. `$B$2` after delete column B) leaves the absolute ref intact rather than emitting `#REF!`. Marked in the test suite.
- **Filter on a column that's then inserted/deleted into**: the filter's stored `col` letter stays pointing at the same column letter, which now refers to different data after the shift. Manual re-apply needed for now.

## [0.1.9] — 2026-05-15

### Fixed

- **Renaming a sheet now updates every cross-sheet reference** in every formula across the whole document. Before this release, renaming `Sheet1` → `Q1` left `=Sheet1!A1` literally as-is, so every dependent cell broke silently. Now: walks all sheets, all formula cells, rewrites refs that targeted the renamed sheet to use the new name (quoted with `'…'` and `''`-escaped if the new name has spaces, special chars, or apostrophes — Excel-style).
- **Duplicate / empty sheet-name protection.** Trying to rename a sheet to an existing sibling's name (or to an empty/whitespace-only name) now toasts an error and aborts; the previous version silently accepted the rename and left a confusing duplicate or blank-named tab.

### Tests

- 74/74 (was 66). New: 8 sheet-rename scenarios — straight rename, multiple refs to same sheet, new name needing quoting, renaming a quoted name, apostrophe-in-name producing `''` escape, ranges, absolute markers preserved through rename, and only-matching-sheet specificity (an `OtherSheet!B2` stays untouched when renaming `Sheet1`).

## [0.1.8] — 2026-05-15

### Fixed (the big silent-correctness bug)

- **byteSheet formulas now follow their target cells through Insert / Delete Row + Insert / Delete Column.** Before this release, inserting a row above row 1 would leave a formula `=A1+B1` literally pointing at the new (empty) row 1 — silently wrong. Excel-style behaviour now: non-absolute refs shift with the data; absolute refs (`$A$1`, `A$1`, `$A1`) stay anchored. Refs that point AT a deleted row/column become `#REF!` in the formula text (the tokenizer rejects `#`, so the evaluator surfaces the broken cell on next eval). Sheet-qualified refs in OTHER sheets that target the modified sheet are also walked.
- `shiftRef(tk, rowOp, colOp)` and `shiftRange(tk, rowOp, colOp)` are now public exports of `sheet-formula.js`. `sheet.js` uses them in `insertRowAtActive` / `insertColAtActive` / `deleteActiveRow` / `deleteActiveCol`.

### Tests

- 66/66 (was 55). New: 11 shift-scenarios covering insert/delete row/col, absolute-ref preservation, range endpoints, cross-sheet refs, and the `#REF!` cases. A known-limitation case is also tested: deleting an absolute column (`$B$2` with delete-col B) currently leaves the absolute ref intact instead of emitting `#REF!`. Documented in the test as a v0.2 polish; the proper fix needs distinguishing "absolute-ref skips operations" from "absolute-ref breaks on target deletion".

### Known limitations carried over

- Sort still re-arranges cells but doesn't update formula refs in moved rows (the moved rows take their formulas with them as text; refs inside those formulas point at the OLD positions). Bigger redesign, deferred.
- Sheet-rename doesn't update cross-sheet refs yet — that's the v0.1.9 chunk.

## [0.1.7] — 2026-05-15

### Added (formula-engine foundation for v0.2 "spreadsheet feature parity")

- **Tokenizer emits source-position info** (`token.loc = {start, end}`) for every token, enabling lossless re-serialisation of formulas.
- **REF / RANGE tokens preserve `$` absolute-marker positions** in new `colAbs` / `rowAbs` flags (and `startCell` / `endCell` for RANGE). The existing `ref` / `start` / `end` fields stay populated as before, so the evaluator is unchanged.
- **Quoted sheet names**: formulas like `='Q1 Sales'!A1` or `=SUM('My Sheet'!$A$1:$B$5)` now parse. Excel-style `''` escape for a literal `'` is supported.
- **`rewriteFormula(formula, transform)`** — walks every REF / RANGE token, lets the transform replace its source slice, keeps everything else byte-identical. The foundation for upcoming row/column/sort-aware ref shifting and sheet-rename ref updates.
- **`refToString(parts)` / `rangeToString(start, end, sheet)`** helpers serialise parsed refs back to formula text with correct `$` markers + quoting.

### Fixed

- Tokenizer had a latent infinite-loop trap on input shaped `foo!nonref` — backed up to `i = j - 1` and re-tokenised the same word. Changed to `i = j`, which leaves `!` for the next iteration to error on cleanly.

### Tests

- Formula suite grew from 34 to 55 cases. New: absolute refs (`$A$1` etc.), quoted sheet names, round-trip identity for 13 representative formulas, `refToString` shape, and an end-to-end shift-row demonstration of the rewrite hook.

## [0.1.6] — 2026-05-15

### Fixed
- **Absolute cell references (`$A$1`, `A$1`, `$A1`) were rejected by the formula tokenizer** even though the docstring at the top of `sheet-formula.js` claimed they were supported. `=$A$1+1` returned `#ERROR! unexpected char "$"`. Fix: extend the tokenizer's word-start and word-body character classes to accept `$`; the bare-ref pattern strips the dollars via `normalizeRef` (byteworkz treats refs as logically relative — `$` markers are accepted but ignored). Tests added: 34/34 pass now.

### Changed
- README no longer claims a specific LOC count or file count, and no longer pins a version inline. Both drift quickly; the source of truth is now `CHANGELOG.md` and the topbar version pill (fetched from `/version.json`).

### Repo hygiene (out-of-changelog)
- The internal pre-launch checklist (Caddy block, bind-mount path, repo references, in-session security note) was previously committed as `PUBLIC-RELEASE-PLAN.md`. That file has been replaced by a public-friendly `ROADMAP.md` and the sensitive content was purged from the entire git history via `git filter-branch` + `--force-with-lease` push. All commit SHAs prior to v0.1.6 changed as a result.

## [0.1.5] — 2026-05-15

### Fixed (P0 — data loss / leak risks surfaced by line-by-line audit)

- **byteDoc tab-switch lost unsaved edits.** `setActive` copied the outgoing editor's HTML into the in-memory doc but never flushed the pending debounced save. The debounce would then fire later against the NEW active doc, dropping the outgoing tab's changes. Fix: `state.saveDebounced.flush()` before switching activeId.
- **byteDoc / byteSheet app-switch lost recent edits.** `unmount` tore down without flushing the pending save. Same root cause as above on a larger scope. Fix: flush in both unmounts.
- **byteSheet doc-switch lost edits.** Navigating between two existing sheets within the debounce window (700ms) caused the pending save to fire against the new `state.doc` and discard the previous sheet's edits. Fix: flush before `state.doc` is replaced in mount.
- **byteDoc "Insert image" required selecting the file twice.** `doInsertImage` called `file.openPicker` (which read the file as text and discarded it) AND `pickImageAsDataURL` (which prompted the user again). Fix: drop the first picker, use only the FileReader-based one.
- **byteDoc image-resize leaked 5 listeners per image click.** The `_cleanup` callback was defined but never invoked, and it only covered 2 of the 5 listeners. Fix: register all 5 (mousemove + mouseup + 3× reflow), call `_cleanup()` from `clearImgSelection`.
- **byteDoc "Export HTML" embedded find-highlight markup** when the find bar was open. Fix: `clearHighlights()` before serialising.

### Fixed (P1 — UX polish)

- **Empty Untitled docs in Recent.** Clicking the byteSheet/byteDoc tile (or "+ New") used to add an `Untitled` entry to Recent even if the user immediately navigated away. New `docs.save(doc, { silent: true })` option skips the Recent touch for the initial empty save; the first real edit triggers an ordinary save and the doc appears in Recent.
- **Recent cap leaked orphaned doc blobs.** When the Recent list overflowed beyond 20, the oldest entry was popped but its `byteworkz.docs.<id>` blob stayed in localStorage forever. Fix: also delete the underlying blob.
- **byteSheet `selectAll` didn't sync the formula bar** to A1 after Ctrl+A — minor cosmetic.
- **`openAnyFile` always used 'd' as the generated id prefix** regardless of app type. Fix: 's' for byteSheet, 'd' for byteDoc.
- **Dead code in `setCellValueFromInput`** (`cell.f = undefined; if (cell.f === undefined) delete cell.f`) collapsed to just `delete cell.f`.

### Changed

- `ui.js` — `debounce(fn, ms)` now exposes `.flush()` (run pending call immediately + clear timer) and `.cancel()` (drop pending call). Both are needed by the unmount / app-switch flush logic.

### Known limitations carried over to v0.2 (documented)

- Formula refs don't auto-update on row/column insert/delete or on column sort — references stay literal. Mitigated for now by avoiding structural edits to data that has formulas.
- Filter is view-only (hides DOM rows, doesn't survive sheet switch / structural ops).
- Sheet rename doesn't update cross-sheet refs in other sheets.

## [0.1.4] — 2026-05-15

### Fixed
- **Critical:** clicking the byteSheet hub tile (or "+ New byteSheet" button) showed "Sheet not found" instead of opening a fresh sheet. Root cause: `mount()` created a new doc in RAM, called `location.replace('#/sheet/<id>')` which fired an async `hashchange`, and the second `mount()` invocation looked the doc up in localStorage — where it wasn't yet saved — and aborted with the error. Fix: persist the new doc immediately on creation, and use `history.replaceState` for URL normalisation (silent, no second mount).
- Same fix applied symmetrically to byteDoc, which previously survived the click path thanks to its in-memory `openDocs` cache but broke on **page refresh** of `#/doc/<id>` for an unsaved new doc. Now refresh works in both apps.
- byteDoc's `newDoc()` returns an internal shape; added `persistDoc(d)` helper that wraps it in the on-disk persistence shape (`{app, version, …}`) so loaded docs round-trip correctly.

## [0.1.3] — 2026-05-15

### Added
- `tests/formula.mjs` — pure-Node test suite for the formula engine (`node tests/formula.mjs`, 30/30 pass), referenced from README + CONTRIBUTING
- `CONTRIBUTING.md` — dev setup, ground rules, commit-message style, architecture pointers
- `.github/ISSUE_TEMPLATE/bug_report.md` + `feature_request.md` + `config.yml` — structured issue intake, blank issues disabled

### Operations (production deploy)
- `Cache-Control: no-cache, must-revalidate` for HTML/JS/CSS/JSON (ETag-revalidate every load — fixes the "users see stale JS after a bugfix" issue we hit between v0.1.0 and v0.1.1)
- `Cache-Control: public, max-age=86400, must-revalidate` for SVG/manifest/txt

## [0.1.2] — 2026-05-15

### Added
- MIT license (`LICENSE`)
- Bilingual DE/EN imprint (`imprint.html`) and privacy notice (`privacy.html`) — full DSGVO boilerplate
- `legal-lang.js` — URL-param + browser-locale language detection with manual DE/EN toggle (no cookies, no storage)
- `info-page` styles in `styles.css` to render the legal pages
- SEO + Open Graph + Twitter Card meta tags in `index.html`
- About modal in the topbar (`?`-button) with keyboard help, version, GitHub link, imprint + privacy links
- `favicon.svg` (deep navy + accent-orange doc/sheet glyph)
- `robots.txt` + `.well-known/security.txt`
- `CHANGELOG.md`, `PUBLIC-RELEASE-PLAN.md`, `.gitignore`

### Changed
- README rewritten for a public audience (badges, live URL, install steps, contributing notes)

## [0.1.1] — 2026-05-15

### Fixed
- Critical: ES module evaluation-order crash on initial page load. `window.ByteWorkz` was initialized in the body of `app.js`, but ES modules evaluate depth-first post-order — meaning `doc.js` and `sheet.js` ran first and crashed on `window.ByteWorkz.apps.push(…)`. Registry bootstrap is now idempotent in every app module.

## [0.1.0] — 2026-05-15

### Added
- Hub launcher with hash-router (`#/`, `#/doc/<id>`, `#/sheet/<id>`)
- **byteDoc** — contenteditable editor: format toolbar (B/I/U/strike, H1–H3, lists, align L/C/R/J, link, quote), tables (insert + context menu), images (DataURL inline with corner-drag resize), find/replace with highlighting, multi-document tabs, live word/char count, autosave to localStorage, JSON download/open + HTML export
- **byteSheet** — spreadsheet: 26×100 grid, sticky headers, range selection, formula bar, formulas (`=A1+B2`, `=SUM/AVG/MIN/MAX/COUNT/IF/CONCAT/AND/OR/NOT/ABS/ROUND/SQRT/POWER/LEN/UPPER/LOWER/TRIM/MOD/INT`), cross-sheet refs (`Sheet2!A1`), cell formatting (bold/italic/align/color/background/number-format), copy/paste TSV, sort/filter, multi-sheet tabs, insert/delete rows + columns, charts (bar/line/pie, canvas-rendered, draggable), CSV export, JSON save/open
- Persistence via `localStorage` (recent list + per-doc storage) with FIFO quota eviction
- Shared dark theme aligned with byteside-voidcore design tokens
- Voidcore-ready app registry (`window.ByteWorkz.apps`) for future Voidcore window embedding
- Pure-vanilla ES6, no build step, no backend
