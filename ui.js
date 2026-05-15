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
    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - rect.width - 4);
    const py = Math.min(y, window.innerHeight - rect.height - 4);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';

    const onDocClick = (e) => {
        if (!menu.contains(e.target)) closeContextMenu();
    };
    setTimeout(() => document.addEventListener('mousedown', onDocClick, { once: true }), 0);
}
export function closeContextMenu() {
    const old = document.getElementById('byteworkz-ctx-menu');
    if (old) old.remove();
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

/* debounce */
export function debounce(fn, ms = 300) {
    let t;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}
