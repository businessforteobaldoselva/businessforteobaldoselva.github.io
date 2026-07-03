// =============================================================================
// COVERED Admin Console — dependency-free UI helpers
// -----------------------------------------------------------------------------
// A tiny DOM toolkit. No framework, no innerHTML-with-data. Every piece of
// user/DB-provided text is set with textContent, so there is no XSS surface.
// The ONLY places we touch style strings (gradients / colours / image URLs) go
// through the validators at the bottom of this file.
//
// This module is the shared vocabulary the six view modules build against:
//   el, card, table, button, input, select, modal, confirmDialog, toast,
//   bars, sparkline, fmtDate, minToHHMM, hhmmToMin, and small helpers.
// =============================================================================

// -----------------------------------------------------------------------------
// el(tag, props, children) — the core element factory.
// -----------------------------------------------------------------------------
// props:  { class|className, text (=> textContent), html (ONLY for trusted,
//           code-authored markup — never pass DB data here), style (object),
//           dataset (object), attrs (object of setAttribute), on{Event} handlers,
//           and any other key set as a DOM property (e.g. type, value, disabled) }
// children: a node, a string (=> text node), or an array of those (nullish
//           entries are skipped).
//
// Passing text as a prop is the safe default. `html` exists only for static,
// developer-written SVG/markup and is never fed dynamic data anywhere in this
// codebase.
export function el(tag, props = {}, children = null) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null) continue;

    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value); // SAFE: never parsed as HTML
    } else if (key === 'html') {
      node.innerHTML = value; // trusted static markup only (see note above)
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else if (key === 'attrs' && typeof value === 'object') {
      for (const [ak, av] of Object.entries(value)) {
        if (av != null) node.setAttribute(ak, av);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      // Assign as a DOM property (type, value, disabled, href, htmlFor, …).
      try { node[key] = value; } catch { node.setAttribute(key, value); }
    }
  }

  appendChildren(node, children);
  return node;
}

/** Append a node | string | (nested) array of those. Skips null/undefined/false. */
export function appendChildren(node, children) {
  if (children == null || children === false) return node;
  if (Array.isArray(children)) {
    for (const child of children) appendChildren(node, child);
  } else if (child_isNode(children)) {
    node.appendChild(children);
  } else {
    node.appendChild(document.createTextNode(String(children)));
  }
  return node;
}
function child_isNode(x) {
  return x && typeof x === 'object' && typeof x.nodeType === 'number';
}

/** Remove all children of a node (used before re-render). */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Convenience: replace a node's children with new content. */
export function render(node, children) {
  clear(node);
  return appendChildren(node, children);
}

// -----------------------------------------------------------------------------
// card(opts) — a surface with optional title, subtitle, actions, body.
// -----------------------------------------------------------------------------
// opts: { title, subtitle, actions (node|array), body (node|array),
//         className, tone ('' | 'accent' | 'ok' | 'warn' | 'danger') }
// Returns the card element. If body is omitted, append to card.body yourself.
export function card(opts = {}) {
  const { title, subtitle, actions, body, className = '', tone = '' } = opts;

  const header = (title || subtitle || actions)
    ? el('div', { class: 'card-header' }, [
        el('div', { class: 'card-heads' }, [
          title ? el('h2', { class: 'card-title', text: title }) : null,
          subtitle ? el('p', { class: 'card-subtitle', text: subtitle }) : null,
        ]),
        actions ? el('div', { class: 'card-actions' }, actions) : null,
      ])
    : null;

  const bodyEl = el('div', { class: 'card-body' }, body);
  const node = el('div', {
    class: `card ${tone ? 'card--' + tone : ''} ${className}`.trim(),
  }, [header, bodyEl]);

  // Expose the body so callers can append later.
  node.body = bodyEl;
  return node;
}

/** A compact stat tile: big value + label + optional sub/delta. */
export function stat(opts = {}) {
  const { label, value, sub, tone = '' } = opts;
  return el('div', { class: `stat ${tone ? 'stat--' + tone : ''}`.trim() }, [
    el('div', { class: 'stat-value', text: value == null ? '—' : String(value) }),
    label ? el('div', { class: 'stat-label', text: label }) : null,
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

// -----------------------------------------------------------------------------
// table(columns, rows, opts) — accessible data table.
// -----------------------------------------------------------------------------
// columns: [{ key, label, render?(value,row,index)->node|string, align?, width? }]
//   - render lets a view build cell content safely (e.g. a badge, a button).
//     A string return is inserted as text; a node is appended as-is.
//   - with no render, the raw value is shown via textContent (safe).
// rows: array of row objects.
// opts: { empty ('No data'), className, caption, onRowClick?(row,index) }
export function table(columns, rows, opts = {}) {
  const { empty = 'No data.', className = '', caption, onRowClick } = opts;

  const thead = el('thead', {}, el('tr', {},
    columns.map((c) =>
      el('th', {
        text: c.label ?? c.key,
        attrs: { scope: 'col' },
        style: {
          ...(c.align ? { textAlign: c.align } : {}),
          ...(c.width ? { width: c.width } : {}),
        },
      })
    )
  ));

  let tbody;
  if (!rows || rows.length === 0) {
    tbody = el('tbody', {}, el('tr', {},
      el('td', {
        class: 'table-empty',
        text: empty,
        attrs: { colspan: String(columns.length) },
      })
    ));
  } else {
    tbody = el('tbody', {}, rows.map((row, i) => {
      const tr = el('tr', {
        class: onRowClick ? 'row-clickable' : '',
        ...(onRowClick ? { attrs: { tabindex: '0', role: 'button' } } : {}),
        onclick: onRowClick ? () => onRowClick(row, i) : undefined,
        onkeydown: onRowClick
          ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row, i); } }
          : undefined,
      }, columns.map((c) => {
        const value = row[c.key];
        const td = el('td', { style: c.align ? { textAlign: c.align } : undefined });
        if (typeof c.render === 'function') {
          const out = c.render(value, row, i);
          appendChildren(td, out); // node OR string, both handled safely
        } else {
          td.textContent = value == null ? '—' : String(value);
        }
        return td;
      }));
      return tr;
    }));
  }

  return el('div', { class: `table-wrap ${className}`.trim() },
    el('table', { class: 'table' }, [
      caption ? el('caption', { text: caption }) : null,
      thead,
      tbody,
    ])
  );
}

// -----------------------------------------------------------------------------
// Form controls: button, input, select, textarea, field, checkbox.
// -----------------------------------------------------------------------------

// button(opts): { label, onClick, variant ('primary'|'ghost'|'danger'|'subtle'),
//                 type ('button'), disabled, size ('sm'|''), icon (node), title }
export function button(opts = {}) {
  const {
    label, onClick, variant = 'primary', type = 'button',
    disabled = false, size = '', icon, title, className = '',
  } = opts;
  return el('button', {
    class: `btn btn--${variant} ${size ? 'btn--' + size : ''} ${className}`.trim(),
    type,
    disabled,
    title: title || undefined,
    onclick: onClick,
  }, [icon || null, label != null ? el('span', { text: label }) : null]);
}

// input(opts): { type, value, placeholder, name, id, required, min, max, step,
//                disabled, onInput, onChange, autocomplete, ...attrs }
export function input(opts = {}) {
  const { onInput, onChange, attrs, ...rest } = opts;
  return el('input', {
    class: 'input',
    type: 'text',
    ...rest,
    attrs,
    oninput: onInput,
    onchange: onChange,
  });
}

// select(opts): { options:[{value,label}] | [string], value, name, id,
//                 onChange, disabled, placeholder }
export function select(opts = {}) {
  const { options = [], value, onChange, placeholder, ...rest } = opts;
  const optionNodes = [];
  if (placeholder != null) {
    optionNodes.push(el('option', { value: '', text: placeholder, disabled: true }));
  }
  for (const o of options) {
    const ov = typeof o === 'object' ? o.value : o;
    const ol = typeof o === 'object' ? (o.label ?? o.value) : o;
    optionNodes.push(el('option', {
      value: String(ov),
      text: String(ol),
      selected: value != null && String(ov) === String(value),
    }));
  }
  return el('select', { class: 'input select', onchange: onChange, ...rest }, optionNodes);
}

export function textarea(opts = {}) {
  const { onInput, onChange, ...rest } = opts;
  return el('textarea', { class: 'input textarea', ...rest, oninput: onInput, onchange: onChange });
}

// field(label, control, opts): labelled wrapper with optional hint/error.
export function field(label, control, opts = {}) {
  const { hint, id } = opts;
  const inputId = id || control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = inputId;
  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', text: label, attrs: { for: inputId } }),
    control,
    hint ? el('div', { class: 'field-hint', text: hint }) : null,
  ]);
}

export function checkbox(opts = {}) {
  const { label, checked = false, onChange, name, id } = opts;
  const box = el('input', { type: 'checkbox', class: 'checkbox', checked, name, id, onchange: onChange });
  return el('label', { class: 'check-row' }, [box, label ? el('span', { text: label }) : null]);
}

// badge(text, tone): small pill. tone: '' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted'
export function badge(text, tone = '') {
  return el('span', { class: `badge ${tone ? 'badge--' + tone : ''}`.trim(), text: String(text) });
}

// -----------------------------------------------------------------------------
// toast(msg, type) — transient notification. type: 'info'|'success'|'error'|'warn'
// -----------------------------------------------------------------------------
let _toastHost = null;
function toastHost() {
  if (!_toastHost) _toastHost = document.getElementById('toast-host') || document.body;
  return _toastHost;
}
export function toast(msg, type = 'info', opts = {}) {
  const { timeout = type === 'error' ? 6000 : 3500 } = opts;
  const node = el('div', {
    class: `toast toast--${type}`,
    attrs: { role: type === 'error' ? 'alert' : 'status' },
  }, [
    el('span', { class: 'toast-msg', text: String(msg) }),
    el('button', {
      class: 'toast-close', text: '×', attrs: { 'aria-label': 'Dismiss' },
      onclick: () => dismiss(),
    }),
  ]);
  function dismiss() {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 200);
  }
  toastHost().appendChild(node);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return { dismiss };
}

// -----------------------------------------------------------------------------
// modal(opts) — accessible dialog with focus trap + Esc + backdrop close.
// -----------------------------------------------------------------------------
// opts: { title, body (node|array), actions (node|array), onClose, size ('sm'|'md'|'lg'),
//         dismissable (default true) }
// Returns { el, close() }.
export function modal(opts = {}) {
  const { title, body, actions, onClose, size = 'md', dismissable = true } = opts;
  const host = document.getElementById('modal-host') || document.body;
  const previouslyFocused = document.activeElement;

  const dialog = el('div', {
    class: `modal modal--${size}`,
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
  }, [
    el('div', { class: 'modal-header' }, [
      title ? el('h2', { class: 'modal-title', text: title }) : el('span'),
      dismissable
        ? el('button', { class: 'modal-close', text: '×', attrs: { 'aria-label': 'Close' }, onclick: () => close() })
        : null,
    ]),
    el('div', { class: 'modal-body' }, body),
    actions ? el('div', { class: 'modal-actions' }, actions) : null,
  ]);

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (dismissable && e.target === backdrop) close(); },
  }, dialog);

  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') trapFocus(e, dialog);
  }

  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.add('modal--out');
    setTimeout(() => backdrop.remove(), 180);
    if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    if (typeof onClose === 'function') onClose(result);
  }

  document.addEventListener('keydown', onKey, true);
  host.appendChild(backdrop);
  // Focus the first focusable control (or the dialog) for keyboard users.
  requestAnimationFrame(() => (firstFocusable(dialog) || dialog).focus());

  return { el: dialog, close };
}

function focusables(root) {
  return Array.from(root.querySelectorAll(
    'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
  )).filter((n) => n.offsetParent !== null || n === document.activeElement);
}
function firstFocusable(root) { return focusables(root)[0] || null; }
function trapFocus(e, root) {
  const list = focusables(root);
  if (list.length === 0) return;
  const first = list[0], last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// -----------------------------------------------------------------------------
// confirmDialog(opts) — promise-returning yes/no modal.
// -----------------------------------------------------------------------------
// opts: { title, message, confirmLabel ('Confirm'), cancelLabel ('Cancel'),
//         danger (bool) }
// Resolves true if confirmed, false otherwise.
export function confirmDialog(opts = {}) {
  const {
    title = 'Are you sure?', message = '',
    confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false,
  } = opts;

  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = modal({
      title,
      body: message ? el('p', { class: 'confirm-msg', text: message }) : null,
      actions: [
        button({ label: cancelLabel, variant: 'ghost', onClick: () => finish(false) }),
        button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => finish(true) }),
      ],
      onClose: () => finish(false),
    });
  });
}

// -----------------------------------------------------------------------------
// State helpers: loading spinner, empty state, error state.
// -----------------------------------------------------------------------------
export function spinner(label = 'Loading…') {
  return el('div', { class: 'state state--loading', attrs: { role: 'status' } }, [
    el('div', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'state-label', text: label }),
  ]);
}
export function emptyState(msg = 'Nothing here yet.', action) {
  return el('div', { class: 'state state--empty' }, [
    el('p', { class: 'state-label', text: msg }),
    action || null,
  ]);
}
export function errorState(msg = 'Something went wrong.', onRetry) {
  return el('div', { class: 'state state--error', attrs: { role: 'alert' } }, [
    el('p', { class: 'state-label', text: msg }),
    onRetry ? button({ label: 'Retry', variant: 'ghost', size: 'sm', onClick: onRetry }) : null,
  ]);
}

// =============================================================================
// Inline-SVG charts: bars() and sparkline(). No external deps.
// =============================================================================
const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  return n;
}

/**
 * bars(data, opts) — vertical bar chart as inline SVG.
 * data: [{ label, value }] OR [number].
 * opts: { width=560, height=180, max?, color?, showValues=false, ariaLabel }
 * Returns an <svg> node. Labels/values use <text> with textContent (safe).
 */
export function bars(data = [], opts = {}) {
  const {
    width = 560, height = 180, color = 'var(--accent)',
    showValues = false, ariaLabel = 'Bar chart', pad = 24, gap = 6,
  } = opts;
  const items = data.map((d) => (typeof d === 'object' ? d : { label: '', value: d }));
  const max = opts.max ?? Math.max(1, ...items.map((d) => Number(d.value) || 0));
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const n = Math.max(1, items.length);
  const barW = Math.max(2, (innerW - gap * (n - 1)) / n);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'chart chart--bars',
    role: 'img', 'aria-label': ariaLabel, preserveAspectRatio: 'none',
  });
  // baseline
  svg.appendChild(svgEl('line', {
    x1: pad, y1: height - pad, x2: width - pad, y2: height - pad,
    class: 'chart-axis',
  }));

  items.forEach((d, i) => {
    const v = Number(d.value) || 0;
    const h = max > 0 ? (v / max) * innerH : 0;
    const x = pad + i * (barW + gap);
    const y = height - pad - h;
    const rect = svgEl('rect', {
      x, y, width: barW, height: Math.max(0, h),
      rx: Math.min(4, barW / 2), fill: color, class: 'chart-bar',
    });
    const title = svgEl('title');
    title.textContent = `${d.label ? d.label + ': ' : ''}${v}`;
    rect.appendChild(title);
    svg.appendChild(rect);

    if (d.label) {
      const t = svgEl('text', {
        x: x + barW / 2, y: height - pad + 14,
        'text-anchor': 'middle', class: 'chart-label',
      });
      t.textContent = String(d.label);
      svg.appendChild(t);
    }
    if (showValues && v > 0) {
      const t = svgEl('text', {
        x: x + barW / 2, y: y - 4, 'text-anchor': 'middle', class: 'chart-value',
      });
      t.textContent = String(v);
      svg.appendChild(t);
    }
  });

  return svg;
}

/**
 * sparkline(values, opts) — compact line chart as inline SVG.
 * values: [number].
 * opts: { width=160, height=40, color?, fill=true, ariaLabel }
 */
export function sparkline(values = [], opts = {}) {
  const {
    width = 160, height = 40, color = 'var(--accent)',
    fill = true, ariaLabel = 'Trend', pad = 3,
  } = opts;
  const nums = values.map((v) => Number(v) || 0);
  const max = Math.max(1, ...nums);
  const min = Math.min(0, ...nums);
  const range = max - min || 1;
  const n = nums.length;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`, class: 'chart chart--spark',
    role: 'img', 'aria-label': ariaLabel, preserveAspectRatio: 'none',
  });
  if (n === 0) return svg;

  const step = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const pts = nums.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');

  if (fill && n > 1) {
    const area = `${d} L${pts[n - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
    svg.appendChild(svgEl('path', { d: area, class: 'spark-fill', fill: color, opacity: 0.15 }));
  }
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, class: 'spark-line' }));
  // last-point dot
  const last = pts[n - 1];
  svg.appendChild(svgEl('circle', { cx: last[0], cy: last[1], r: 2.5, fill: color }));
  return svg;
}

// =============================================================================
// Formatting + time helpers.
// =============================================================================

/**
 * fmtDate(value, opts) — format a timestamp for display.
 * value: Date | ISO string | epoch ms/number. Returns '—' for nullish/invalid.
 * opts: { mode: 'datetime'|'date'|'time'|'relative', tz? (IANA, e.g. 'Europe/London') }
 */
export function fmtDate(value, opts = {}) {
  const { mode = 'datetime', tz } = opts;
  if (value == null || value === '') return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '—';

  if (mode === 'relative') return relativeTime(d);

  const base = tz ? { timeZone: tz } : {};
  const fmt = {
    datetime: { ...base, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' },
    date:     { ...base, year: 'numeric', month: 'short', day: '2-digit' },
    time:     { ...base, hour: '2-digit', minute: '2-digit' },
  }[mode] || base;
  try {
    return new Intl.DateTimeFormat('en-GB', fmt).format(d);
  } catch {
    return d.toISOString();
  }
}

/** Human relative time: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '—';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(secs);
  if (abs < 45) return 'just now';
  if (abs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (abs < 86400) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} d ago`;
}

/**
 * minToHHMM(min) — minute-of-day (0..1440) to "HH:MM".
 * 1440 is a valid end-of-day marker for the half-open [start,end) windows and
 * renders as "24:00". Returns '' for null/undefined.
 */
export function minToHHMM(min) {
  if (min == null) return '';
  const m = Math.max(0, Math.min(1440, Math.round(Number(min))));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * hhmmToMin("HH:MM") — parse a time string to minute-of-day.
 * Accepts "24:00" -> 1440. Returns null for empty/invalid input so callers can
 * store NULL (open bound).
 */
export function hhmmToMin(str) {
  if (str == null || str === '') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
  const total = hh * 60 + mm;
  return total > 1440 ? null : total;
}

/** Weekday names indexed 0=Sun..6=Sat (matches days_of_week ints). */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Format a days_of_week int[] (or null=all) as a short label. */
export function fmtDays(daysOfWeek) {
  if (!daysOfWeek || daysOfWeek.length === 0 || daysOfWeek.length === 7) return 'Every day';
  return daysOfWeek.slice().sort((a, b) => a - b).map((d) => WEEKDAYS[d] ?? '?').join(', ');
}

/**
 * fmtWindow(startMin, endMin) — describe a daypart per the FROZEN semantics:
 *   both null            -> "All day"
 *   start == end         -> "All day"
 *   end < start          -> overnight wrap, "22:00 → 06:00 (overnight)"
 *   otherwise            -> "09:00 → 17:00"
 */
export function fmtWindow(startMin, endMin) {
  if (startMin == null && endMin == null) return 'All day';
  if (startMin != null && endMin != null && startMin === endMin) return 'All day';
  const s = startMin == null ? '00:00' : minToHHMM(startMin);
  const e = endMin == null ? '24:00' : minToHHMM(endMin);
  if (startMin != null && endMin != null && endMin < startMin) return `${s} → ${e} (overnight)`;
  return `${s} → ${e}`;
}

/** Short id for display: first 8 chars of a UUID. */
export function shortId(id) {
  if (!id) return '—';
  return String(id).slice(0, 8);
}

// =============================================================================
// Style validators — the ONLY place DB-provided style strings are used.
// =============================================================================

// Default consumer ad-card gradient (mirrors covered-webapp.html).
export const DEFAULT_AD_GRADIENT = 'linear-gradient(135deg,#ff7eb3 0%,#ff758c 40%,#7367f0 100%)';

/**
 * safeGradient(str) — validate a CSS gradient/background value before it is put
 * into an element's style. We whitelist a conservative character set and require
 * it to look like a gradient or a hex/rgb colour. Anything suspicious (url(),
 * expression(), semicolons, angle brackets) is rejected and the default is used.
 * This guards the one spot where DB text reaches a style property.
 */
export function safeGradient(str) {
  const v = String(str || '').trim();
  if (!v) return DEFAULT_AD_GRADIENT;
  // Reject anything that could break out of the value or load a resource.
  if (/[<>;{}]|url\s*\(|expression|javascript:|@import|image-set/i.test(v)) {
    return DEFAULT_AD_GRADIENT;
  }
  // Allow gradients and plain colours built from a safe character set.
  const gradientOk = /^(linear|radial|conic)-gradient\(/i.test(v) &&
    /^[\w\s.,%#()°-]+$/.test(v);
  const colourOk = /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|hsl)a?\([\d\s.,%]+\)$/i.test(v);
  return gradientOk || colourOk ? v : DEFAULT_AD_GRADIENT;
}

/**
 * safeColor(str, fallback) — validate a CSS colour (hex / rgb / hsl / named).
 */
export function safeColor(str, fallback = '#ffffff') {
  const v = String(str || '').trim();
  if (!v) return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(v)) return v;
  if (/^(rgb|hsl)a?\([\d\s.,%]+\)$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v; // named colours (white, black, …)
  return fallback;
}

/**
 * safeImageUrl(str) — only allow https/relative image URLs. Returns '' if unsafe
 * so callers can skip rendering the image. Never allows javascript:/data:.
 */
export function safeImageUrl(str) {
  const v = String(str || '').trim();
  if (!v) return '';
  if (/^https:\/\//i.test(v) || /^\/[^/]/.test(v) || /^\.{0,2}\//.test(v)) {
    if (/[\s<>"']/.test(v)) return '';
    return v;
  }
  return '';
}

// =============================================================================
// adCard(ad, opts) — the consumer ad preview, mirroring covered-webapp.html.
// -----------------------------------------------------------------------------
// ad: { headline, tagline, cta_text, bg_gradient, text_color, image_url,
//       duration_seconds }
// opts: { live=false }  when live, a countdown ticks from duration_seconds.
// Returns { el, start(), stop() } so the Ads view can animate the preview.
// All text via textContent; gradient/colour/image via the validators above.
// =============================================================================
export function adCard(ad = {}, opts = {}) {
  const { live = false } = opts;
  const gradient = safeGradient(ad.bg_gradient);
  const textColor = safeColor(ad.text_color, '#ffffff');
  const imageUrl = safeImageUrl(ad.image_url);
  const duration = clampInt(ad.duration_seconds, 2, 30, 5);

  const timerEl = el('div', { class: 'adp-timer', text: `${duration}s` });

  const creative = el('div', {
    class: 'adp-creative',
    style: { background: gradient, color: textColor },
  }, [
    el('div', { class: 'adp-badge', text: 'Ad' }),
    imageUrl ? el('img', { class: 'adp-img', src: imageUrl, alt: '', attrs: { loading: 'lazy' } }) : null,
    el('div', { class: 'adp-copy' }, [
      el('div', { class: 'adp-headline', text: ad.headline || 'Your headline' }),
      ad.tagline ? el('div', { class: 'adp-tagline', text: ad.tagline }) : null,
      (ad.cta_text) ? el('div', { class: 'adp-cta', text: ad.cta_text }) : null,
    ]),
    timerEl,
  ]);

  let interval = null;
  function stop() { if (interval) { clearInterval(interval); interval = null; } timerEl.textContent = `${duration}s`; }
  function start() {
    stop();
    let remaining = duration;
    timerEl.textContent = `${remaining}s`;
    interval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) { remaining = duration; }
      timerEl.textContent = `${remaining}s`;
    }, 1000);
  }
  if (live) start();

  return { el: creative, start, stop };
}

/** Clamp to an int in [min,max], falling back to def for invalid input. */
export function clampInt(value, min, max, def) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** Debounce a function by ms (used by search inputs in the views). */
export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
