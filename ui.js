/* byteworkz/ui.js — shared widget helpers (toast, modal, prompt, confirm, ctx menu).
 * No state, no framework. Each helper returns a Promise or accepts a callback. */

const toastHost = () => document.getElementById('toast-host');
const modalHost = () => document.getElementById('modal-host');

export function toast(message, { kind = 'info', timeout = 2400 } = {}) {
    const host = toastHost();
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.kind = kind;
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity .2s';
        setTimeout(() => el.remove(), 220);
    }, timeout);
}

/* showModal({title, bodyHTML, actions:[{label, kind?, onClick(close)}]})
 * - actions[].kind: 'primary' | 'secondary' | 'danger'  (default secondary)
 * - returns Promise<void> resolved when modal closes.
 * - ESC + backdrop click closes via the first 'secondary'/Cancel action if present. */
export function showModal({ title, bodyHTML = '', actions = [], onMount = null, dismissable = true }) {
    return new Promise(resolve => {
        const host = modalHost();
        if (!host) { resolve(); return; }
        host.innerHTML = '';
        host.hidden = false;

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-header">
                <div class="modal-title"></div>
                <button class="btn-icon modal-close" title="Close">✕</button>
            </div>
            <div class="modal-body"></div>
            <div class="modal-actions"></div>
        `;
        modal.querySelector('.modal-title').textContent = title || '';
        modal.querySelector('.modal-body').innerHTML = bodyHTML;

        const actionsEl = modal.querySelector('.modal-actions');
        const close = () => {
            host.hidden = true;
            host.innerHTML = '';
            document.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };

        actions.forEach(a => {
            const b = document.createElement('button');
            b.className = a.kind === 'primary' ? 'btn-primary' : (a.kind === 'danger' ? 'btn' : 'btn-secondary');
            if (a.kind === 'danger') b.style.borderColor = 'var(--danger)';
            b.textContent = a.label;
            b.addEventListener('click', () => a.onClick ? a.onClick(close) : close());
            actionsEl.appendChild(b);
        });

        modal.querySelector('.modal-close').addEventListener('click', () => { if (dismissable) close(); });
        host.addEventListener('click', (e) => { if (e.target === host && dismissable) close(); }, { once: true });
        document.addEventListener('keydown', onKey);

        host.appendChild(modal);
        if (onMount) onMount(modal, close);
    });
}

/* prompt({title, label, initial}) → Promise<string|null> */
export function prompt({ title, label = '', initial = '', placeholder = '' }) {
    return new Promise(resolve => {
        let value = null;
        showModal({
            title,
            bodyHTML: `
                <label>${escapeHtml(label)}</label>
                <input type="text" id="prompt-input" value="${escapeAttr(initial)}" placeholder="${escapeAttr(placeholder)}">
            `,
            actions: [
                { label: 'Cancel', kind: 'secondary', onClick: (close) => { value = null; close(); } },
                { label: 'OK', kind: 'primary', onClick: (close) => {
                    value = document.getElementById('prompt-input').value;
                    close();
                } }
            ],
            onMount: (m, close) => {
                const input = m.querySelector('#prompt-input');
                input.focus(); input.select();
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { value = input.value; close(); }
                });
            }
        }).then(() => resolve(value));
    });
}

/* confirm({title, message, danger}) → Promise<bool> */
export function confirm({ title = 'Confirm', message, danger = false, okLabel = 'OK' }) {
    return new Promise(resolve => {
        let result = false;
        showModal({
            title,
            bodyHTML: `<p style="margin:0;color:var(--fg)">${escapeHtml(message)}</p>`,
            actions: [
                { label: 'Cancel', kind: 'secondary', onClick: (close) => { result = false; close(); } },
                { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: (close) => { result = true; close(); } }
            ]
        }).then(() => resolve(result));
    });
}

/* showContextMenu(x, y, items:[{label, onClick, sep?}]) */
// Module-private — we track the active outside-click handler so closeContextMenu
// can remove it. Without this, rapid open of two menus left the stale {once:true}
// listener from the first menu attached; on the next click anywhere, it fired,
// saw its (gone) menu didn't contain the target, and called closeContextMenu —
// which closed the SECOND menu unexpectedly.
let _ctxOutsideHandler = null;

export function showContextMenu(x, y, items) {
    closeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.id = 'byteworkz-ctx-menu';
    items.forEach(it => {
        if (it.sep) {
            const s = document.createElement('div');
            s.className = 'ctx-sep';
            menu.appendChild(s);
            return;
        }
        const b = document.createElement('button');
        b.textContent = it.label;
        b.addEventListener('click', () => {
            closeContextMenu();
            it.onClick && it.onClick();
        });
        menu.appendChild(b);
    });
    document.body.appendChild(menu);
    // Clamp to viewport (also guard left/top from negative — a tiny viewport or
    // huge menu would otherwise render the menu off-screen left).
    const rect = menu.getBoundingClientRect();
    const px = Math.max(2, Math.min(x, window.innerWidth - rect.width - 4));
    const py = Math.max(2, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';

    const onDocClick = (e) => {
        if (!menu.contains(e.target)) closeContextMenu();
    };
    _ctxOutsideHandler = onDocClick;
    setTimeout(() => {
        // If we got pre-empted by another open/close before this timeout fired,
        // _ctxOutsideHandler points at a different function — don't attach.
        if (_ctxOutsideHandler === onDocClick) {
            document.addEventListener('mousedown', onDocClick);
        }
    }, 0);
}
export function closeContextMenu() {
    const old = document.getElementById('byteworkz-ctx-menu');
    if (old) old.remove();
    if (_ctxOutsideHandler) {
        document.removeEventListener('mousedown', _ctxOutsideHandler);
        _ctxOutsideHandler = null;
    }
}

/* ── Tag editor (shared by byteDoc + byteSheet) ──────────────────────────
 * Mutates `doc.tags` (creating it as [] if missing) and calls onChange()
 * after every add / remove so the caller can mark-dirty + save. The dialog
 * renders the current tags as chips with an × button; an input below the
 * chip row adds a new tag on Enter. Tags are normalised:
 *   - trimmed
 *   - lowercased (so "Work" / "work" don't collide)
 *   - alphanumerics + hyphen + underscore only (everything else stripped)
 *   - capped at 20 chars
 *   - max 8 tags per doc (Excel's namespace pressure isn't a thing here,
 *     but UI gets noisy past ~8 chips)
 */
export function tagEditorDialog(doc, onChange) {
    if (!Array.isArray(doc.tags)) doc.tags = [];

    const normalise = (raw) => {
        const t = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
        return t || null;
    };
    const renderChips = () => {
        if (!doc.tags.length) return '<span class="tag-empty">No tags yet — type a tag and press Enter to add.</span>';
        return doc.tags.map(t => `<span class="tag-chip" data-tag="${escapeAttr(t)}">${escapeHtml(t)}<button class="tag-remove" type="button" aria-label="Remove ${escapeAttr(t)}">×</button></span>`).join('');
    };

    return showModal({
        title: 'Tags',
        bodyHTML: `
            <div class="tag-chips" id="tag-chips">${renderChips()}</div>
            <input type="text" id="tag-input" placeholder="Add a tag and press Enter" autocomplete="off" spellcheck="false" maxlength="20">
            <p class="tag-hint">Lowercase, max 8 tags per document.</p>
        `,
        actions: [
            { label: 'Done', kind: 'primary' }
        ],
        onMount: (modal) => {
            const chipsEl = modal.querySelector('#tag-chips');
            const input = modal.querySelector('#tag-input');
            input.focus();

            const rerender = () => { chipsEl.innerHTML = renderChips(); };

            chipsEl.addEventListener('click', (e) => {
                const btn = e.target.closest('.tag-remove');
                if (!btn) return;
                const chip = btn.closest('.tag-chip');
                const t = chip && chip.dataset.tag;
                if (!t) return;
                doc.tags = doc.tags.filter(x => x !== t);
                rerender();
                onChange();
            });

            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const t = normalise(input.value);
                if (!t) { input.value = ''; return; }
                if (doc.tags.includes(t)) { input.value = ''; return; }
                if (doc.tags.length >= 8) {
                    toast('Max 8 tags per document.', { kind: 'error' });
                    return;
                }
                doc.tags.push(t);
                input.value = '';
                rerender();
                onChange();
            });
        }
    });
}

/* tiny escapers */
export function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;');
}

/* fmt: format Date or ISO string → short relative ("3m ago", "2h ago", "May 14") */
export function fmtRelative(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* uid: short unique id */
export function uid(prefix = '') {
    return prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/* Debounce with flush + cancel — `flush()` runs the pending call immediately
 * and clears the timer; `cancel()` drops the pending call. Both are needed on
 * unmount / navigate-away so debounced saves don't get lost or fire late
 * against stale state. */
export function debounce(fn, ms = 300) {
    let t = null, pendingArgs = null, pendingThis = null;
    const debounced = function (...args) {
        if (t) clearTimeout(t);
        pendingArgs = args; pendingThis = this;
        t = setTimeout(() => {
            t = null;
            fn.apply(pendingThis, pendingArgs);
        }, ms);
    };
    debounced.flush = () => {
        if (t) {
            clearTimeout(t);
            t = null;
            fn.apply(pendingThis, pendingArgs || []);
        }
    };
    debounced.cancel = () => {
        if (t) { clearTimeout(t); t = null; }
    };
    return debounced;
}
