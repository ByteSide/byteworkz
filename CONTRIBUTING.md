# Contributing to byteworkz

Issues and pull requests are welcome. byteworkz is a small project so the
contribution flow is deliberately lightweight.

## Ground rules

- **No dependencies, no build step.** byteworkz is intentionally a
  zero-install vanilla-ES6 project. Don't introduce `npm install`, bundlers,
  transpilers, or CSS preprocessors. If a feature genuinely needs a library,
  vendor it under `assets/vendor/` so the project still works without a
  package manager.
- **No CDN script tags.** Strict-`'self'` CSP for `script-src` is a hard
  rule — the only `<script>` elements are same-origin module imports.
- **Match the existing style.** Vanilla ES6 modules, single state object per
  module, function-based (no classes), `const`/`let` (no `var`), 4-space
  indentation, semicolons on. The shape of `app.js` / `doc.js` / `sheet.js`
  is the reference.
- **One feature per PR.** Keep diffs reviewable. If you're refactoring along
  the way, split it into a separate commit.

## Dev setup

```bash
git clone https://github.com/ByteSide/byteworkz.git
cd byteworkz
python3 -m http.server 8765
# open http://localhost:8765/
```

That's the entire toolchain.

## Tests

The only suite right now is the formula engine. It's pure-Node, no deps:

```bash
node tests/formula.mjs
```

Expect `30/30 passed`. If you change `sheet-formula.js` or touch how
`sheet.js` invokes it, add cases that cover the new behavior.

UI features (byteDoc and byteSheet) are not unit-tested — please describe a
manual smoke test in your PR description (e.g. "open hub, click byteDoc,
type `=SUM(A1:A3)`, verify 60") so reviewers can verify locally.

## Commit messages

Lowercase prefix, colon, brief imperative description (~50 chars). Examples
from the history:

```
feat(byteSheet): IFERROR + IFS function support
fix: sheet tab drag-reorder dropped formulas on cross-sheet refs
docs: README screenshot for byteSheet chart
```

Body (optional) wraps at 72 chars and explains *why*, not *what* — the diff
shows the what.

**Do not** add `Co-Authored-By:` trailers from AI tools or templates. The
maintainer's git config explicitly disallows them.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). The
most useful bug reports include:

- exact browser + version
- a minimal reproduction recipe (open hub → click X → see Y → expected Z)
- console errors if any

## Proposing features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md).
For anything bigger than a small UI tweak, open the issue first and let's
align on scope before you write code — it'll save us both time.

The current roadmap is in [ROADMAP.md](ROADMAP.md).
Items listed there are pre-vetted; jump on any you'd like to drive.

## Architecture pointers

If you're new to the codebase:

- Start with **`app.js`** — it shows the hash router + app registry pattern.
- **`storage.js`** + **`ui.js`** are the shared utility layer.
- **`doc.js`** and **`sheet.js`** are independent app modules that each
  self-register on `window.ByteWorkz.apps` (idempotent bootstrap pattern at
  the top of each — needed because ES module evaluation is depth-first
  post-order, so app modules run *before* `app.js`' body).
- **`sheet-formula.js`** is a standalone tokenizer + shunting-yard +
  evaluator, fully testable from Node (see `tests/formula.mjs`).
