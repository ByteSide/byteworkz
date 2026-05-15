# byteworkz

A tiny browser-side office suite. **byteDoc** writes, **byteSheet** calculates.
No accounts, no cloud, no tracking — everything lives in your browser.

**Live:** [https://byteworkz.byteside.net](https://byteworkz.byteside.net)
&nbsp;·&nbsp; **License:** [MIT](LICENSE)
&nbsp;·&nbsp; **Status:** v0.1.2

It is a tiny vanilla-ES6 single-page app — about 4,300 lines of code across
9 files, no build step, no backend, no dependencies. Designed as a companion
to [bytepaint](https://github.com/ByteSide/bytepaint) and pre-wired for later
embedding into the [byteside-voidcore](https://voidcore.byteside.net) OS-style
shell.

---

## What's in the box

### byteDoc — rich-text editor

- **Format toolbar:** bold / italic / underline / strike, H1–H3, paragraph,
  ordered + unordered lists, align L/C/R/J, link, blockquote, clear format
- **Tables:** insert dialog (rows × cols), right-click in a cell to add /
  remove rows + columns or delete the table
- **Images:** file picker → DataURL inline, click to select + corner-drag to
  resize
- **Find &amp; replace:** highlights every match, Enter/Shift+Enter to walk
  hits, Replace / Replace All
- **Multi-document tabs**, **live word + character + block count** in the
  status bar, **autosave** to `localStorage` (debounced 900 ms)
- **Export:** JSON (round-trippable) or HTML (standalone styled page)

### byteSheet — spreadsheet

- **26 × 100 grid** with sticky headers, range selection (mouse drag,
  Shift+arrow, Ctrl+A)
- **Formulas:** `=A1+B2`, `=SUM(A1:A10)`, `AVERAGE / MIN / MAX / COUNT /
  COUNTA / IF / CONCAT / ABS / ROUND / FLOOR / CEILING / SQRT / POWER /
  AND / OR / NOT / LEN / UPPER / LOWER / TRIM / MOD / INT`, cross-sheet
  refs (`Sheet2!A1`), comparison ops, `&` for string concat
- **Cell formatting:** bold, italic, align L/C/R, foreground + background
  color, number format (default / `0.00` / integer / % / € / $ / date)
- **Sort &amp; filter** by active column (row 1 = header)
- **Multi-sheet tabs** at the bottom: add, rename (double-click), duplicate,
  delete via right-click
- **Charts:** bar / line / pie rendered to `<canvas>` (no library), draggable
  by header
- **Copy / paste TSV** (round-trips with Excel and Google Sheets), **CSV
  export**, JSON save / open
- **Insert / delete row + column** that shift the existing cells

### Hub

- Big tiles for byteDoc and byteSheet
- Recent-documents list (up to 20) backed by `localStorage`
- "Open from file…" picks the right app based on the JSON's `app` field

---

## Run locally

```bash
git clone https://github.com/ByteSide/byteworkz.git
cd byteworkz
python3 -m http.server 8765
# open http://localhost:8765/
```

That's it. No `npm install`, no bundler.

## Deploy

The repository is a pure static site. Serve it with any static host. The
production deployment uses Caddy:

```caddy
byteworkz.byteside.net {
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        Permissions-Policy "camera=(), microphone=(), geolocation=()"
        # 'unsafe-inline' for styles: byteSheet sets per-cell colors
        # programmatically + table templates emit inline style="…".
        Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'; manifest-src 'self'"
    }
    root * /srv/byteworkz
    file_server
    encode zstd gzip
}
```

---

## Architecture at a glance

```
index.html         Shell: 3 hidden <section>s (hub / doc / sheet), topbar
app.js             Hash router, hub render, recent list, About modal, app registry
doc.js             byteDoc — contenteditable editor, multi-tabs
doc.css            byteDoc styles (editor "page" look + print CSS)
sheet.js           byteSheet — grid, selection, formatting, charts
sheet-formula.js   Formula tokenizer + shunting-yard + evaluator (30/30 unit tests)
sheet.css          byteSheet styles (sticky headers, in-place cell editor)
storage.js         localStorage + JSON file I/O + recent list + FIFO quota eviction
ui.js              Toast, modal, prompt, confirm, ctx menu, escapers
styles.css         Shared dark tokens (Voidcore-aligned), hub, topbar, info pages
legal-lang.js      DE/EN toggle for legal pages (URL param, no cookies)
imprint.html       § 5 DDG site notice — bilingual
privacy.html       Full DSGVO privacy policy — bilingual
```

### Routes

| Hash               | Action                                |
| ------------------ | ------------------------------------- |
| `#/`               | Hub (tiles + recent)                  |
| `#/doc`            | New byteDoc                           |
| `#/doc/<id>`       | Open existing byteDoc                 |
| `#/sheet`          | New byteSheet                         |
| `#/sheet/<id>`     | Open existing byteSheet               |

### App registry (Voidcore-ready)

Each app self-registers on `window.ByteWorkz.apps` with:

```js
{ id, title, mount(container, params), unmount() }
```

The router calls `unmount()` on the outgoing app and `mount()` on the incoming
one. The same shape can later be `push()`'d into
[byteside-voidcore](https://voidcore.byteside.net)'s `_registry.js` to embed
each app as a moveable Voidcore window.

---

## Privacy &amp; data

- **localStorage** (`byteworkz.recent` + `byteworkz.docs.<id>`) holds your
  recent list and your documents. Nothing here ever reaches a server.
- **No cookies.** No analytics. No third-party scripts. No fonts CDN.
- **Server logs** record anonymised request metadata (IPs masked to /24
  IPv4 / /48 IPv6, Cookie / Authorization / Accept-Language /
  X-Forwarded-For / X-Real-IP headers stripped pre-disk, 14-day retention).
- See [`/privacy.html`](https://byteworkz.byteside.net/privacy.html) for the
  full DSGVO-grade policy.

---

## Contributing

Issues and pull requests welcome. A few ground rules:

- Keep it dependency-free: no `npm install`, no bundler. If a feature
  genuinely needs a library, vendor it under `assets/vendor/` rather than
  pulling from a CDN.
- Match the existing style (vanilla ES6 modules, single state object per
  module, function-based, no classes).
- Don't introduce inline `<script>` blocks — strict-`'self'` CSP for
  `script-src` is a hard rule.
- For bigger ideas: open an issue first so we can align on scope before you
  write code.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the public-release
checklist and post-v0.1 roadmap (PWA install icons, snapshot-based byteDoc
undo, strict CSP without `'unsafe-inline'`, optional .docx/.xlsx import,
Voidcore embedding).

## Not in scope

- `.docx` / `.xlsx` import-export — real Office formats are dependency-heavy.
  See roadmap.
- Real-time collaboration / cloud sync — by design.
- Mobile-first redesign — works on tablets, tight on phones.
