# byteworkz Roadmap

This document captures the post-v0.1 direction of byteworkz. Issues and PRs
that move any of these forward are very welcome — open the issue first if
it's a larger piece so we can align on scope.

## v0.2 — polish

- **PWA icons.** Ship a PNG icon set (192, 512, apple-touch 180) so the
  Chrome / Edge install banner appears. The current SVG favicon works in
  every modern browser but doesn't unlock the install prompt.
- **Snapshot-based undo for byteDoc.** Replace `document.execCommand` (still
  works everywhere, but unspecified and slowly being de-emphasised) with an
  in-memory snapshot stack. Preserves Ctrl+Z / Ctrl+Y semantics if and when
  `execCommand` is eventually removed.
- **Print CSS for byteSheet.** byteDoc already has print styles; byteSheet
  prints with all chrome visible.
- **Formula references update on row/column insert/delete + sort.**
  Currently formulas keep literal references — inserting a row above shifts
  cells, but the formula text still points at the old coordinates. Fix:
  walk every formula and rewrite refs.
- **Sheet rename updates cross-sheet refs.** `=Sheet1!A1` keeps pointing at
  `Sheet1` even after the sheet is renamed. Same parse-and-rewrite story.
- **Persistent filter.** Currently filter hides DOM rows only and is lost
  on sheet switch or re-render. Store the predicate on the sheet.

## v0.3 — security & format support

- **Strict CSP without `'unsafe-inline'` for `style-src`.** Move all
  programmatic cell colors and inline template `style="…"` attributes to
  CSS custom properties + classes, then tighten the CSP header.
- **`.docx` import.** Vendor
  [mammoth.js](https://github.com/mwilliamson/mammoth.js) under
  `assets/vendor/` (no CDN). One-way: `.docx` → byteDoc.
- **`.xlsx` import.** Same pattern with
  [SheetJS Community](https://sheetjs.com).
- **Export to `.docx` / `.xlsx`.** Lower priority — round-tripping these
  formats faithfully is famously hard, and the existing JSON / HTML / CSV
  exports already cover most "send this to someone else" use cases.

## v0.4 — Voidcore embedding

byteworkz was designed from day 1 to slot into
[byteside-voidcore](https://voidcore.byteside.net)'s OS-style desktop. The
app registry on `window.ByteWorkz.apps` mirrors voidcore's
`_registry.js` push-pattern intentionally.

- **`?embed=1` URL flag.** When set, hide byteworkz's own topbar +
  back-to-hub brand, and disable the hash router so the embed isn't
  fighting voidcore's navigation.
- **iframe-shaped Voidcore apps.** Two voidcore registry entries (byteDoc +
  byteSheet) whose body is an iframe pointing at
  `byteworkz.byteside.net/?embed=1#/doc` or `…#/sheet`. CSP
  `frame-ancestors` extended to permit the voidcore origin.
- **Possible follow-up: native embedding.** Same-DOM mount via the app
  registry, no iframe. Requires byteworkz to support multiple instances
  per page (currently a single shared `state` per module).

## Future / wishlist

- **Multi-user collab.** [Yjs](https://yjs.dev) over WebRTC for
  peer-to-peer CRDT sync. Default OFF, no server.
- **Mobile-first redesign.** byteworkz works on tablets and tight on
  phones; a mobile-optimised mode (touch-first toolbar, larger hit
  targets) would expand reach.
- **Themes.** Currently dark-only (Voidcore-aligned). A light mode is
  straightforward but hasn't felt necessary.

## Trade-offs (rationale for current choices)

- **MIT license**, not Apache-2.0 or GPL — chosen for minimal friction in a
  UI tool with no patent claims to grant or copyleft to enforce.
- **`'unsafe-inline'` in CSP for `style-src`.** byteSheet sets per-cell
  colors programmatically and the table-insert template emits inline
  `style="…"`. Tightening this is a v0.3 polish, not a launch blocker.
- **No PNG icons in v0.1.** SVG favicon works for every modern browser; the
  Chrome install banner is a nice-to-have, not a must.
- **No GitHub Actions workflow.** Pure static site, nothing to build or
  test in CI beyond the formula engine, which already runs via
  `node tests/formula.mjs`. Will add only if the test suite grows enough
  to warrant it.
- **No `.docx` / `.xlsx` in v0.1.** Faithful round-trip of these formats
  pulls in serious dependencies (mammoth.js ≈ 500 kB, SheetJS larger).
  Worth doing once the core editors are stable; not worth gating v0.1 on.
- **Vanilla ES6, no build step.** A bundler buys hot-reload and
  tree-shaking, but the project is ~4,300 LOC across 9 files — the JS
  budget is already tiny. Keeping the project understandable to anyone
  who can read a `<script type="module">` tag is worth more than the
  build-time savings.
