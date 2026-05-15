# Changelog

All notable changes to **byteworkz** will be documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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
