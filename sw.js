/* byteworkz Service Worker — offline + installable PWA.
 *
 * Strategy:
 *   1. precache the app shell on `install` (all sources we own)
 *   2. on `activate`, drop any older byteworkz-* caches
 *   3. on `fetch`:
 *        - same-origin only — never touch byteside.net or any external
 *        - GET only — never cache POSTs
 *        - /version.json → network-first (so update detection is fresh)
 *        - everything else → stale-while-revalidate (instant cache hit,
 *          background refresh, fall back to cache when offline)
 *
 * Update flow:
 *   - SW source change (e.g., the VERSION constant bumps) → browser fetches
 *     new sw.js → new install runs → new shell cached.
 *   - New worker enters `waiting` state instead of activating immediately.
 *     We DON'T `skipWaiting()` on its own — the page's running JS could be
 *     incompatible with newer cached chunks if we did. Instead: the page
 *     listens for `updatefound` and surfaces a toast asking the user to
 *     reload. Reload → page posts `SKIP_WAITING` → SW activates new shell.
 *
 * Bump VERSION whenever you change the cached file list or want to force a
 * cache rebuild for users. `byteworkz-shell-vX.Y.Z` cache key is keyed off
 * this; old caches are cleaned in `activate`.
 */

const VERSION = '0.4.9';
const SHELL_CACHE = `byteworkz-shell-v${VERSION}`;

const SHELL_FILES = [
    '/',
    '/index.html',
    '/app.js',
    '/doc.js',
    '/sheet.js',
    '/sheet-formula.js',
    '/csv.js',
    '/cond-format.js',
    '/storage.js',
    '/ui.js',
    '/styles.css',
    '/doc.css',
    '/sheet.css',
    '/favicon.svg',
    '/site.webmanifest',
    '/version.json',
    '/imprint.html',
    '/privacy.html',
    '/legal-lang.js',
    // Templates: precached so the Hub's "Start with a template" works
    // offline and instantiation is instant on click.
    '/templates/index.json',
    '/templates/resume.bytedoc.json',
    '/templates/meeting-notes.bytedoc.json',
    '/templates/letter.bytedoc.json',
    '/templates/budget.bytesheet.json',
    '/templates/inventory.bytesheet.json'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES))
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k.startsWith('byteworkz-') && k !== SHELL_CACHE)
                    .map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // version.json: network-first. We need the freshest version string so the
    // page can detect updates accurately. Falls back to cache when offline.
    if (url.pathname === '/version.json') {
        e.respondWith(
            fetch(req).then(r => {
                if (r.ok) {
                    const copy = r.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, copy));
                }
                return r;
            }).catch(() => caches.match(req))
        );
        return;
    }

    // Everything else: stale-while-revalidate.
    e.respondWith(
        caches.match(req).then(cached => {
            const networkFetch = fetch(req).then(r => {
                if (r.ok) {
                    const copy = r.clone();
                    caches.open(SHELL_CACHE).then(c => c.put(req, copy));
                }
                return r;
            }).catch(() => cached);
            return cached || networkFetch;
        })
    );
});

// Page posts {type: 'SKIP_WAITING'} after the user clicks "Reload" in the
// update-available toast. Without this, a waiting SW sits forever until all
// tabs close.
self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
