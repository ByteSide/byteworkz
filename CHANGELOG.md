# Changelog

All notable changes to **byteworkz** will be documented in this file. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

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
