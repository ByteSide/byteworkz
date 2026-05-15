# Changelog

All notable changes to **byteworkz** will be documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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
