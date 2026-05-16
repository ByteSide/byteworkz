// byteworkz — bilingual toggle for imprint.html + privacy.html
//
// Detection (priority order):
//   1. ?lang=de|en URL parameter — explicit override
//   2. navigator.language starting with "de" — German variants
//   3. fallback: English
//
// Default page state (without JS) is German (matches <html lang="de"> in
// the HTML source). For visitors without JS this means German content;
// acceptable since the operator is German and the page is legally a German
// legal document with English courtesy translation.
//
// No localStorage / sessionStorage / cookies — the "no client-side
// persistence on the legal pages themselves" statement in privacy.html stays
// true. Toggle updates the URL via history.replaceState so the choice
// survives a copy-paste-share. The cross-page legal links (imprint ↔ privacy)
// get the current ?lang= appended at runtime so a user reading in their
// non-default language stays in it when they follow the footer cross-reference.

(function () {
    'use strict';

    const html = document.documentElement;

    // ── Theme preference (shared with the main app) ─────────────────────
    // Pick up data-theme from localStorage so imprint/privacy match the
    // main-app theme. 'auto' or missing = follow OS via prefers-color-scheme.
    try {
        const t = localStorage.getItem('byteworkz.theme');
        if (t === 'dark' || t === 'light') html.setAttribute('data-theme', t);
    } catch { /* localStorage blocked — falls back to OS preference */ }

    // ── Detection ────────────────────────────────────────────────────────
    const params = new URLSearchParams(location.search);
    const requested = params.get('lang');
    if (requested === 'en' || requested === 'de') {
        html.lang = requested;
    } else if (navigator.language && !navigator.language.toLowerCase().startsWith('de')) {
        html.lang = 'en';
    }
    // else: <html lang="de"> stays (German default)

    // ── Title sync ───────────────────────────────────────────────────────
    function syncTitle() {
        const meta = document.querySelector(`meta[name="page-title-${html.lang}"]`);
        if (meta && meta.content) document.title = meta.content;
    }

    // ── Toggle state on the button group ─────────────────────────────────
    function syncToggleState() {
        for (const btn of document.querySelectorAll('[data-lang-set]')) {
            const on = btn.dataset.langSet === html.lang;
            if (on) btn.setAttribute('data-active', '');
            else    btn.removeAttribute('data-active');
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
    }

    // ── Cross-page lang preservation ─────────────────────────────────────
    function syncCrossLinks() {
        const lang = html.lang;
        document.querySelectorAll('a[href]').forEach(a => {
            const raw = a.getAttribute('href');
            const m = /^\/?(imprint|privacy)\.html(\?.*)?(#.*)?$/.exec(raw);
            if (!m) return;
            const base = (raw.startsWith('/') ? '/' : '') + m[1] + '.html';
            const hash = m[3] || '';
            a.setAttribute('href', `${base}?lang=${lang}${hash}`);
        });
    }

    function syncAll() {
        syncTitle();
        syncToggleState();
        syncCrossLinks();
    }
    syncAll();

    // ── Click handler (event delegation) ─────────────────────────────────
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-lang-set]');
        if (!btn) return;
        e.preventDefault();
        const lang = btn.dataset.langSet;
        if (lang !== 'de' && lang !== 'en') return;
        html.lang = lang;
        const url = new URL(location.href);
        url.searchParams.set('lang', lang);
        history.replaceState(null, '', url.toString());
        syncAll();
    });
})();
