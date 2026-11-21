// =============================================================================
// COVERED Admin Console — QR codes view
// -----------------------------------------------------------------------------
// The register of every QR code COVERED prints or displays: machine stickers,
// carton/poster/screen codes for advertisers. See QR-PLATFORM-PLAN.md.
//
//   #qr            list, filters, New QR code / New batch / Import machines
//   #qr?id=<uuid>  one code: stats, destination, approval, lifecycle, downloads
//
// WHY THIS FILE USES supabase.rpc(...) EXCLUSIVELY, unlike ads.js which does
// supabase.from('ads').select('*'):
//   the qr_* tables are RPC-only (RLS enabled AND forced, no policies, no
//   grants to authenticated). Every read and write goes through a
//   fn_admin_qr_* function that re-checks fn_is_admin() and validates server
//   side. The only direct table reads here are `advertisers` (policy-guarded),
//   `machines`, `ads` and `app_settings` (admin policies), for the pickers.
//   Do not "fix" this to match ads.js.
//
// CONTRACT NOTES this file honours (same as the other views):
//   - Everything is appended into `root`; modals via ui.modal, toasts via
//     ui.toast — the only permitted exceptions.
//   - ALL database and user text is rendered with textContent (ui.el `text`,
//     table cells); no innerHTML anywhere in this file.
//   - Every call is wrapped; failures toast AND render an errorState with retry.
//   - A `destroyed` flag stops a late response painting into a torn-down root.
//   - The returned cleanup closes any modal and revokes every object URL.
//
// DELIBERATELY ABSENT: any field for a tracking pixel, container id, custom
// script or "extra head HTML". The absence of the field is the control — a
// text box called "tracking code (optional)" gets filled in eventually.
//
// PREVIEW AND DOWNLOADS never leave the browser: the QR is encoded by the
// vendored nayuki library (js/vendor/qrcodegen.js) through js/qr-engine.js, so
// the CSP is unchanged (script-src 'self' https://esm.sh) and the preview is an
// SVG data: URI, already allowed by img-src.
// =============================================================================

import { QR_SHORT_DOMAIN } from '../config.js';
import * as engine from '../qr-engine.js';
import { makeZip } from '../vendor/zip.js';

const SURFACES = [
  ['machine', 'Machine sticker'], ['carton', 'Carton (16-pack)'], ['poster', 'Poster / flyer'],
  ['screen', '32-inch screen'], ['other', 'Other'],
];
const SURFACE_LABEL = Object.fromEntries(SURFACES);
const LIFECYCLES = [['draft', 'Draft'], ['approved_for_print', 'Approved for print'], ['in_field', 'In the field'], ['suspended', 'Suspended'], ['retired', 'Retired']];
const SAMPLE_CODE = 'ABCD2345';                       // preview only; never a real code
const FALLBACK_WF1 = 'https://coveredbymills.app.n8n.cloud/webhook/scan';

// Server error codes -> a sentence a person can act on.
const ERRORS = {
  not_admin: 'You do not have admin access.',
  label_required: 'Give the code a label.',
  invalid_surface: 'Pick a surface.',
  invalid_destination_url: 'The destination must be an https:// address with a real hostname, no spaces and no username in it.',
  invalid_fallback_url: 'The fallback must be a valid https:// address.',
  blocked_destination_host: 'That website is on the blocked list. coveredaccess.com is blocked while its public pages return 401 — a printed code pointing at it would be a dead end.',
  machine_guard: 'A machine sticker may only point at a URL that carries its own machineId. This destination names a different (or no) machine.',
  machine_required: 'Choose the machine this sticker is for.',
  machine_already_has_active_code: 'That machine already has an active sticker code. Deactivate it first, or edit it instead.',
  machine_only_for_machine_surface: 'Only a machine sticker is tied to a machine.',
  advertiser_required: 'Choose the advertiser this code belongs to.',
  advertiser_not_found: 'That advertiser no longer exists.',
  advertiser_exists: 'An advertiser with that name already exists.',
  name_required: 'Enter a name.',
  fallback_required: 'A printed code needs a fallback address for when its campaign ends.',
  invalid_code_fields: 'The window, owner or fallback rules were not met.',
  reason_required: 'A reason is required.',
  static_code_cannot_be_repointed: 'A static code is a promise that its destination never changes. Create a new code instead.',
  destination_unchanged: 'That is already the destination.',
  code_retired: 'A retired code cannot be changed.',
  approval_required: 'Approve the destination first: a code cannot be released for print, or put (back) into the field, until its current destination is approved.',
  carton_batch_below_minimum: 'A carton batch must cover at least 500 units, otherwise one scan could be tied to one person.',
  too_many_codes_for_quantity: 'Too many codes for that quantity: each carton code must cover at least 500 units.',
  print_run_ref_required: 'Enter the print run reference — a batch is a physical commitment.',
  invalid_quantity: 'Quantity must be between 1 and 5,000 units. A 10,000-unit run is two batches.',
  units_distributed_out_of_range: 'You cannot have distributed more units than were printed.',
  qr_not_found: 'That code no longer exists.',
  invalid_range: 'That date range is not valid.',
};
function friendly(err) {
  const raw = String((err && (err.message || err.details)) || err || '');
  const key = Object.keys(ERRORS).find((k) => raw === k || raw.startsWith(k + ':') || raw.includes(k));
  if (key) return ERRORS[key];
  if (err && (err.code === '42501' || /permission denied/i.test(raw))) return 'You do not have admin access to the QR register.';
  if (err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(raw))) {
    return 'The QR register is not installed in the database yet (migration 17 has not been applied).';
  }
  if (/invalid_transition/.test(raw)) return 'That change of state is not allowed from where the code is now.';
  if (/field_not_editable/.test(raw)) return 'That field cannot be edited here.';
  return raw || 'Something went wrong.';
}

export default async function mount(root, ctx) {
  const { supabase, ui } = ctx;
  const params = ctx.params || {};

  let destroyed = false;
  let openModal = null;
  const objectUrls = [];
  let filters = { surface: '', lifecycle: '', search: '' };
  let lookups = null;                                   // { advertisers, machines, ads, settings }

  const host = engine.normaliseHost(QR_SHORT_DOMAIN || '');

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------
  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data;
  }
  function copyText(text, what) {
    const done = () => ui.toast(`${what} copied.`, 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => ui.toast('Could not copy.', 'error'));
    } else ui.toast('Copy is not available in this browser.', 'warn');
  }
  function download(name, data, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    objectUrls.push(url);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); }, 30000);
  }
  function svgDataUri(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
  const trunc = (s, n = 48) => (s && s.length > n ? s.slice(0, n - 1) + '…' : (s || ''));
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-GB'));
  // Days are the database's days (fn_schedule_tz, Europe/London), not UTC: at 00:30 BST the UTC date is still yesterday.
  const isoDay = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

  async function loadLookups(force = false) {
    if (lookups && !force) return lookups;
    const [adv, mac, ads, set] = await Promise.all([
      supabase.from('advertisers').select('id,name,status').order('name'),
      supabase.from('machines').select('machine_id,location,active').order('machine_id'),
      supabase.from('ads').select('id,name,advertiser_id').order('name'),
      supabase.from('app_settings').select('key,value').in('key', ['qr_wf1_scan_url', 'qr_blocked_destination_hosts']),
    ]);
    lookups = {
      advertisers: adv.error ? [] : (adv.data || []).filter((a) => a.status !== 'archived'),
      advertisersError: adv.error || null,
      machines: mac.error ? [] : (mac.data || []),
      ads: ads.error ? [] : (ads.data || []),
      wf1: ((set.data || []).find((s) => s.key === 'qr_wf1_scan_url') || {}).value || FALLBACK_WF1,
    };
    return lookups;
  }

  // ---------------------------------------------------------------------------
  // Shared little renderers
  // ---------------------------------------------------------------------------
  function lifecycleBadge(c) {
    const tone = { draft: 'muted', approved_for_print: 'accent', in_field: 'ok', suspended: 'warn', retired: 'muted' }[c.lifecycle] || '';
    return ui.badge((LIFECYCLES.find((l) => l[0] === c.lifecycle) || [0, c.lifecycle])[1], tone);
  }
  function approvalBadge(c) {
    const tone = { draft: 'muted', pending: 'warn', approved: 'ok', rejected: 'danger' }[c.approval_status] || '';
    const label = { draft: 'Not submitted', pending: 'Awaiting approval', approved: 'Approved', rejected: 'Rejected' }[c.approval_status] || c.approval_status;
    return ui.badge(label, tone);
  }
  function windowBadge(c) {
    if (c.window_state === 'pre_window') return ui.badge('Scheduled', 'accent');
    if (c.window_state === 'post_window') return ui.badge('Expired', 'warn');
    if (c.window_state === 'inactive') return ui.badge('Inactive', 'muted');
    return ui.badge('Live window', 'ok');
  }
  // Phase 4: what the daily destination check last saw (null when it has not looked yet)
  function destFlag(c) {
    const k = c.dest_check;
    if (!k || !k.needs_attention) return '';
    return ui.el('span', {}, [' ', ui.badge(k.host_ok === false ? 'Moved to another site' : (k.http_status === 0 ? 'Could not be reached' : `Answering ${k.http_status}`), 'warn')]);
  }
  // What a scan actually gets right now, in the resolver's own order: paused, retired, window, approval.
  function servedNow(c) {
    const fb = c.fallback_url ? `fallback ${c.fallback_url}` : 'nothing (no fallback)';
    if (c.lifecycle === 'suspended') return '— paused: visitors see the COVERED “paused” page';
    if (c.lifecycle === 'retired') return c.on_expiry === 'gone' ? '— retired: visitors see “this offer has ended”' : `— retired: ${fb}`;
    if (c.window_state === 'pre_window') return `— not open yet: ${fb}`;
    if (c.window_state === 'post_window') return c.on_expiry === 'gone' ? '— ended: visitors see “this offer has ended”' : `— window ended: ${fb}`;
    if (c.window_state === 'inactive') return `— switched off: ${fb}`;
    return c.approved_destination_url || `— nothing approved yet: ${fb}`;
  }
  function mono(text) { return ui.el('code', { class: 'qr-mono', text, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', letterSpacing: '0.04em' } }); }
  function note(text, tone = '') {
    return ui.el('p', { class: 'field-hint' + (tone ? ' qr-note--' + tone : ''), text, style: tone === 'warn' ? { color: 'var(--warn, #b45309)' } : undefined });
  }
  function owner(c) {
    if (c.surface === 'machine') return c.machine_id || '—';
    return c.advertiser_name || '—';
  }

  // The in-spec preview, with the numbers the printer needs.
  function previewBlock(code, symbolMm) {
    const surface = code.surface || 'other';
    const spec = engine.SURFACE_SPECS[surface] || engine.SURFACE_SPECS.other;
    const useHost = host || 'EXAMPLE.UK';
    let qr, checks, g = null, svg;
    try {
      const url = engine.payloadFor(useHost, code.short_code || SAMPLE_CODE);
      qr = engine.encode(url, spec.ecl);
      const sym = surface === 'screen' ? null : (symbolMm || spec.symbolMm);
      g = sym ? engine.geometry(qr.size, sym) : null;
      checks = engine.assessments(qr, surface, sym);
      svg = engine.toSvg(qr, { symbolMm: sym });
    } catch (e) {
      return ui.el('div', {}, note('Preview unavailable: ' + (e.message || e), 'warn'));
    }
    const facts = [
      ['Encodes', qr.text], ['Version / modules', `v${qr.version} · ${qr.size} × ${qr.size}`],
      ['Error correction', qr.ecl], ['Mask', String(qr.mask)],
    ];
    if (g) {
      facts.push(['Module (X)', `${g.xMm.toFixed(3)} mm`], ['Quiet zone / side', `${g.quietMm.toFixed(2)} mm`],
        ['Reserve on artwork', `${g.footprintMm.toFixed(1)} × ${g.footprintMm.toFixed(1)} mm`]);
    } else {
      facts.push(['Size', `${spec.pxPerModule} px per module (whole pixels only)`]);
    }
    return ui.el('div', { class: 'qr-preview' }, [
      ui.el('img', {
        src: svgDataUri(svg), alt: `QR code preview, version ${qr.version}`,
        style: { width: '200px', height: '200px', imageRendering: 'pixelated', background: '#fff', border: '1px solid var(--border, #ddd)', borderRadius: '6px' },
      }),
      ui.el('dl', { class: 'qr-facts', style: { margin: '8px 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: '0.85rem' } },
        facts.flatMap(([k, v]) => [ui.el('dt', { text: k, style: { opacity: '0.7' } }), ui.el('dd', { text: v, style: { margin: '0', wordBreak: 'break-all' } })])),
      ...checks.map((c) => ui.el('p', {
        class: 'field-hint', text: (c.level === 'error' ? '✕ ' : c.level === 'warn' ? '! ' : '✓ ') + c.text,
        style: { color: c.level === 'error' ? 'var(--danger, #b91c1c)' : c.level === 'warn' ? 'var(--warn, #b45309)' : 'var(--ok, #15803d)', margin: '2px 0' },
      })),
      host ? null : note(`Preview uses EXAMPLE.UK — not a real domain. Set QR_SHORT_DOMAIN in js/config.js once the short domain is registered; until then print-ready files are disabled.`, 'warn'),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Page chrome
  // ---------------------------------------------------------------------------
  const page = ui.el('div', {});
  root.appendChild(page);

  function banner(text, tone = 'warn') {
    return ui.card({ tone, body: ui.el('p', { text, style: { margin: 0 } }) });
  }

  // The logging-health light (plan R7). A quiet week and a broken logger look
  // identical in the numbers, so this is shown ABOVE them, and it says so in words.
  function loggingText(h) {
    const st = h && h.state;
    const ago = h && h.minutes_since != null ? `${h.minutes_since} minute${h.minutes_since === 1 ? '' : 's'} ago` : 'a while ago';
    if (!st || st === 'never') return { text: 'Scan counting is not live yet: the redirect service has not reported in. Every number below is zero by design, not a fault.', tone: 'accent' };
    if (st === 'stale') return { text: `Scan logging has gone quiet: the redirect service last reported ${ago}. Numbers may be missing scans — do not quote them until this clears.`, tone: 'warn' };
    if (st === 'backlog') return { text: `${h.dead_letter_backlog} scan${h.dead_letter_backlog === 1 ? ' is' : 's are'} waiting in the redirect service's retry queue. They are added to the day they happened once the database is reachable again.`, tone: 'warn' };
    return { text: `Scan logging is healthy (the redirect service reported ${ago}).${h.last_note ? ` Last note from it: ${h.last_note}.` : ''}`, tone: 'accent' };
  }
  function loggingBanner(h) { const l = loggingText(h); return banner(l.text, l.tone); }

  // D12: the Worker carries a compiled-in map of machine codes so a resolver outage
  // can never stop a dispense. This copies what to feed tools/make-machine-map.mjs.
  async function copyMachineMap() {
    try {
      const res = await rpc('fn_admin_qr_machine_map');
      const n = Object.keys(res.map || {}).length;
      if (!n) { ui.toast('There are no live machine codes to put in the map yet.', 'warn'); return; }
      copyText(JSON.stringify(res, null, 2), `Machine map (${n} code${n === 1 ? '' : 's'})`);
    } catch (err) { ui.toast(friendly(err), 'error'); }
  }

  // ===========================================================================
  // LIST
  // ===========================================================================
  let refocusSearch = false;                       // the list is re-rendered after a search pause: give the box back its focus
  async function showList() {
    ui.clear(page);
    const listCard = ui.card({
      title: 'QR codes',
      subtitle: 'Every printed or displayed code, who it belongs to, and where it goes.',
    });
    page.appendChild(listCard);
    ui.render(listCard.body, ui.spinner('Loading QR codes…'));

    let data;
    try {
      [data] = await Promise.all([rpc('fn_admin_qr_list', { p_filters: cleanFilters() }), loadLookups(true)]);
    } catch (err) {
      if (destroyed) return;
      ui.toast(friendly(err), 'error');
      ui.render(listCard.body, ui.errorState(friendly(err), () => showList()));
      return;
    }
    if (destroyed) return;

    const codes = data.codes || [];
    const actions = [];
    if ((data.machines_without_code || 0) > 0) {
      actions.push(ui.button({ label: `Import ${data.machines_without_code} machine sticker${data.machines_without_code === 1 ? '' : 's'}`, variant: 'ghost', onClick: () => importMachines(data.machines_without_code) }));
    }
    actions.push(ui.button({ label: 'Copy machine map', variant: 'ghost', onClick: () => copyMachineMap() }));
    actions.push(ui.button({ label: 'New batch', variant: 'ghost', onClick: () => openBatch() }));
    actions.push(ui.button({ label: 'New QR code', variant: 'primary', onClick: () => openCreate() }));
    const head = listCard.querySelector('.card-header');
    if (head) head.appendChild(ui.el('div', { class: 'card-actions' }, actions));

    const banners = [];
    if (!host) banners.push(banner('No short domain is configured (QR_SHORT_DOMAIN in js/config.js). Codes can be registered and previewed, but print-ready files are switched off so a placeholder domain can never be printed.'));
    banners.push(loggingBanner(data.logging_health));
    if (data.destination_alerts > 0) banners.push(banner(`${data.destination_alerts} destination${data.destination_alerts === 1 ? ' needs' : 's need'} a look: the daily check found a page that moved to a different site or stopped answering. See the flagged rows.`));
    if (lookups && lookups.advertisersError) banners.push(banner('The advertiser list could not be read: ' + friendly(lookups.advertisersError)));

    const surfaceSel = ui.select({
      options: [{ value: '', label: 'All surfaces' }, ...SURFACES.map(([v, l]) => ({ value: v, label: l }))],
      value: filters.surface, onChange: (e) => { filters.surface = e.target.value; showList(); },
    });
    const lifeSel = ui.select({
      options: [{ value: '', label: 'Any state' }, ...LIFECYCLES.map(([v, l]) => ({ value: v, label: l }))],
      value: filters.lifecycle, onChange: (e) => { filters.lifecycle = e.target.value; showList(); },
    });
    const searchIn = ui.input({
      value: filters.search, placeholder: 'Search label or short code', type: 'search',
      onInput: ui.debounce((e) => { filters.search = e.target.value; refocusSearch = true; showList(); }, 400),
    });
    const filterRow = ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } }, [surfaceSel, lifeSel, searchIn]);

    let body;
    const anyFilter = filters.surface || filters.lifecycle || filters.search;
    if (!data.total_codes) {
      body = ui.emptyState('No QR codes yet.', ui.el('div', {}, [
        !data.advertisers_exist ? note('There are no advertisers yet. Add one before creating a code for an advertiser.') : null,
        ui.button({ label: 'New QR code', variant: 'primary', onClick: () => openCreate() }),
      ]));
    } else if (!codes.length && anyFilter) {
      body = ui.emptyState('No codes match those filters.', ui.button({ label: 'Clear filters', variant: 'ghost', onClick: () => { filters = { surface: '', lifecycle: '', search: '' }; showList(); } }));
    } else {
      body = ui.table([
        { key: 'label', label: 'Label', render: (v, r) => ui.el('a', { href: `#qr?id=${r.id}`, text: v, style: { fontWeight: '600' } }) },
        { key: 'short_code', label: 'Short code', render: (v) => ui.el('span', {}, [mono(v), ' ', ui.button({ label: 'Copy', variant: 'subtle', size: 'sm', onClick: () => copyText(host ? engine.payloadFor(host, v) : v, host ? 'Full URL' : 'Short code') })]) },
        { key: 'surface', label: 'Surface', render: (v) => ui.badge(SURFACE_LABEL[v] || v, 'muted') },
        { key: 'advertiser_name', label: 'Owner', render: (_v, r) => ui.el('span', { text: owner(r) }) },
        { key: 'destination_url', label: 'Destination', render: (v, r) => ui.el('span', {}, [ui.el('span', { text: trunc(v), title: v }), destFlag(r)]) },
        { key: 'window_state', label: 'Window', render: (_v, r) => windowBadge(r) },
        { key: 'qualified_7d', label: 'Qualified 7d', align: 'right', render: (v) => ui.el('span', { text: num(v) }) },
        { key: 'lifetime', label: 'Lifetime*', align: 'right', render: (v) => ui.el('span', { text: num(v) }) },
        { key: 'lifecycle', label: 'Status', render: (_v, r) => ui.el('span', {}, [lifecycleBadge(r), ' ', approvalBadge(r)]) },
        { key: 'updated_at', label: 'Updated', render: (v) => ui.el('span', { text: ui.fmtDate(v, { mode: 'relative' }) }) },
        { key: 'id', label: '', align: 'right', render: (_v, r) => ui.button({ label: 'Open', variant: 'ghost', size: 'sm', onClick: () => ctx.router.navigate('qr', { id: r.id }) }) },
      ], codes, { empty: 'No codes.' });
    }
    ui.render(listCard.body, [
      ...banners, filterRow, body,
      note('* Lifetime includes days whose raw log has since been purged (raw scans are kept 30 days; daily totals are kept indefinitely). A scan is a camera resolving a code — not a visit, a purchase or a person.'),
    ]);
    if (refocusSearch) {
      refocusSearch = false;
      searchIn.focus();
      try { const n = searchIn.value.length; searchIn.setSelectionRange(n, n); } catch { /* type=search may refuse */ }
    }
  }
  function cleanFilters() {
    const f = {};
    if (filters.surface) f.surface = filters.surface;
    if (filters.lifecycle) f.lifecycle = filters.lifecycle;
    if (filters.search) f.search = filters.search;
    return f;
  }

  async function importMachines(n) {
    const yes = await ui.confirmDialog({
      title: 'Import machine stickers',
      message: `Register a sticker code for ${n} machine${n === 1 ? '' : 's'} that ${n === 1 ? 'has' : 'have'} none, pointing at the current WF1 scan URL with each machine's own id. They are created as drafts; nothing changes on any machine until you approve and print them.`,
      confirmLabel: 'Import',
    });
    if (!yes || destroyed) return;
    try {
      const res = await rpc('fn_admin_qr_import_machines');
      ui.toast(`Registered ${res.created} machine sticker${res.created === 1 ? '' : 's'}.`, 'success');
      showList();
    } catch (err) { ui.toast(friendly(err), 'error'); }
  }

  // ===========================================================================
  // CREATE (modal, live preview)
  // ===========================================================================
  async function openCreate() {
    let L;
    try { L = await loadLookups(); } catch (err) { ui.toast(friendly(err), 'error'); return; }
    if (destroyed) return;

    const m = { label: '', surface: 'carton', mode: 'dynamic', machine_id: '', advertiser_id: '', ad_id: '', destination_url: '', fallback_url: '', on_expiry: 'fallback', starts_at: '', ends_at: '', minimal_mode: false, expectation_set: '', notes: '', print_run_ref: '' };
    const previewHost = ui.el('div', {});
    const dynamicHost = ui.el('div', {});
    let saving = false;

    const refreshPreview = () => { ui.render(previewHost, previewBlock({ surface: m.surface }, null)); };

    function renderDynamic() {
      const isMachine = m.surface === 'machine';
      const advOptions = [{ value: '', label: 'Choose an advertiser…' }, ...L.advertisers.map((a) => ({ value: a.id, label: a.name })), { value: '__new', label: 'Add new advertiser…' }];
      const adOptions = [{ value: '', label: 'None' }, ...L.ads.filter((a) => !m.advertiser_id || a.advertiser_id === m.advertiser_id).map((a) => ({ value: a.id, label: a.name }))];
      const machineSel = ui.select({
        options: [{ value: '', label: 'Choose a machine…' }, ...L.machines.map((x) => ({ value: x.machine_id, label: x.machine_id + (x.location ? ` — ${x.location}` : '') }))],
        value: m.machine_id,
        onChange: (e) => {
          m.machine_id = e.target.value;
          if (m.machine_id) { m.destination_url = `${L.wf1}?machineId=${m.machine_id}`; m.fallback_url = m.destination_url; if (!m.label) m.label = `Machine sticker ${m.machine_id}`; }
          renderDynamic();
        },
      });
      const advSel = ui.select({
        options: advOptions, value: m.advertiser_id,
        onChange: async (e) => {
          if (e.target.value === '__new') { e.target.value = m.advertiser_id; const created = await addAdvertiser(); if (created) { L = await loadLookups(true); m.advertiser_id = created.id; renderDynamic(); } return; }
          m.advertiser_id = e.target.value; m.ad_id = ''; renderDynamic();       // the ad list belongs to the advertiser
        },
      });
      const destIn = ui.input({ value: m.destination_url, placeholder: 'https://…', onInput: (e) => { m.destination_url = e.target.value; } });
      const fbIn = ui.input({ value: m.fallback_url, placeholder: 'https://… shown when the campaign ends', onInput: (e) => { m.fallback_url = e.target.value; } });
      const modeSel = ui.select({
        options: [{ value: 'dynamic', label: 'Dynamic — can be repointed, with approval' }, { value: 'static', label: 'Static — destination can never change' }, { value: 'direct', label: 'Direct — encodes the destination itself (not counted)' }],
        value: m.mode, onChange: (e) => { m.mode = e.target.value; renderDynamic(); },
      });
      const modeHelp = {
        dynamic: 'Every printed code is a COVERED short code, so the destination can be corrected after printing. Any change has to be re-approved, and the last approved destination keeps being served meanwhile.',
        static: 'The destination is frozen: it can never be repointed. Use it for a promise made in print, such as a legal notice.',
        direct: 'Not recommended: the code goes straight to the destination and COVERED can neither count nor correct it.',
      }[m.mode];
      ui.render(dynamicHost, [
        isMachine ? ui.field('Machine', machineSel) : ui.field('Advertiser', advSel, { hint: L.advertisers.length ? '' : 'There are no advertisers yet — choose “Add new advertiser…”.' }),
        isMachine ? null : ui.field('Ad (optional)', ui.select({ options: adOptions, value: m.ad_id, onChange: (e) => { m.ad_id = e.target.value; } })),
        ui.field('Mode', modeSel, { hint: modeHelp }),
        ui.field('Destination URL', destIn, { hint: 'https only. Server-side checked; coveredaccess.com is refused while its pages return 401.' }),
        ui.field('Fallback URL', fbIn, { hint: 'Required for machine, carton and poster codes: where a scan goes when the campaign has ended.' }),
        ui.field('When the window ends', ui.select({ options: [{ value: 'fallback', label: 'Go to the fallback' }, { value: 'gone', label: 'Show "no longer available"' }], value: m.on_expiry, onChange: (e) => { m.on_expiry = e.target.value; } })),
      ]);
    }

    const surfaceSel = ui.select({
      options: SURFACES.map(([v, l]) => ({ value: v, label: l })), value: m.surface,
      onChange: (e) => { m.surface = e.target.value; if (m.surface === 'machine') m.ad_id = ''; renderDynamic(); refreshPreview(); },
    });
    const labelIn = ui.input({ value: m.label, placeholder: 'e.g. READING-26 carton, Acme poster', onInput: (e) => { m.label = e.target.value; } });
    const startIn = ui.input({ type: 'datetime-local', value: '', onChange: (e) => { m.starts_at = e.target.value; } });
    const endIn = ui.input({ type: 'datetime-local', value: '', onChange: (e) => { m.ends_at = e.target.value; } });
    const minimal = ui.checkbox({ label: 'Minimal mode — do not even record country or device type', checked: false, onChange: (e) => { m.minimal_mode = e.target.checked; } });
    const expectIn = ui.textarea({ rows: 2, placeholder: 'What the artwork promises the scanner will get', onInput: (e) => { m.expectation_set = e.target.value; } });
    const notesIn = ui.textarea({ rows: 2, placeholder: 'Internal notes', onInput: (e) => { m.notes = e.target.value; } });
    const refIn = ui.input({ placeholder: 'Print run reference (if known)', onInput: (e) => { m.print_run_ref = e.target.value; } });

    const form = ui.el('form', { onSubmit: (e) => { e.preventDefault(); save(); } }, [
      ui.el('button', { attrs: { type: 'submit', hidden: 'hidden' }, text: 'Save' }),
      ui.el('div', { class: 'ad-form-grid' }, [
        ui.el('div', { class: 'ad-form-fields' }, [
          ui.field('Label', labelIn), ui.field('Surface', surfaceSel), dynamicHost,
          ui.field('Starts (optional)', startIn), ui.field('Ends (optional)', endIn),
          ui.el('div', { class: 'field' }, minimal),
          ui.field('Expectation set', expectIn), ui.field('Print run ref', refIn), ui.field('Notes', notesIn),
          note('A new code is always a draft: it is not printable until its destination has been approved and it has been released for print.'),
        ]),
        ui.el('div', { class: 'ad-form-preview' }, [ui.el('div', { class: 'ad-preview-label', text: 'Live preview (sample code)' }), previewHost]),
      ]),
    ]);
    renderDynamic(); refreshPreview();

    const saveBtn = ui.button({ label: 'Save as draft', variant: 'primary', onClick: () => save() });
    async function save() {
      if (saving || destroyed) return;
      const payload = {
        label: m.label.trim(), surface: m.surface, mode: m.mode, destination_url: m.destination_url.trim(),
        fallback_url: m.fallback_url.trim() || null, on_expiry: m.on_expiry, minimal_mode: m.minimal_mode,
        advertiser_id: m.surface === 'machine' ? null : (m.advertiser_id || null),
        machine_id: m.surface === 'machine' ? (m.machine_id || null) : null,
        ad_id: m.surface === 'machine' ? null : (m.ad_id || null), expectation_set: m.expectation_set.trim() || null,
        notes: m.notes.trim() || null, print_run_ref: m.print_run_ref.trim() || null,
        starts_at: m.starts_at ? new Date(m.starts_at).toISOString() : null,
        ends_at: m.ends_at ? new Date(m.ends_at).toISOString() : null,
      };
      saving = true; saveBtn.disabled = true;
      try {
        const res = await rpc('fn_admin_qr_create', { p_payload: payload });
        ui.toast('Draft code created.', 'success');
        closeModal();
        ctx.router.navigate('qr', { id: res.id });
      } catch (err) {
        ui.toast(friendly(err), 'error');
      } finally { saving = false; if (!destroyed) saveBtn.disabled = false; }
    }
    openModal = ui.modal({ title: 'New QR code', size: 'lg', body: form, actions: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => closeModal() }), saveBtn], onClose: () => { openModal = null; } });
  }

  async function addAdvertiser() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; mm.close(); resolve(v); };
      const nameIn = ui.input({ placeholder: 'Advertiser or brand name' });
      const mm = ui.modal({
        title: 'Add advertiser', size: 'sm',
        body: [ui.field('Name', nameIn, { hint: 'Used for ads, codes and reports. Names are matched ignoring case and spaces.' })],
        actions: [
          ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => finish(null) }),
          ui.button({ label: 'Add', variant: 'primary', onClick: async () => {
            try { finish(await rpc('fn_admin_advertiser_upsert', { p_payload: { name: nameIn.value } })); }
            catch (err) { ui.toast(friendly(err), 'error'); }
          } }),
        ],
        onClose: () => finish(null),
      });
    });
  }

  // ===========================================================================
  // BATCH (modal)
  // ===========================================================================
  async function openBatch() {
    let L;
    try { L = await loadLookups(); } catch (err) { ui.toast(friendly(err), 'error'); return; }
    if (destroyed) return;
    const m = { label: '', surface: 'carton', advertiser_id: '', quantity: 1000, code_count: 2, destination_url: '', fallback_url: '', print_run_ref: '', event_label: '', event_date: '', event_location: '', expectation_set: '' };
    let saving = false;
    const resultHost = ui.el('div', {});
    const f = (k, opts = {}) => ui.input({ value: String(m[k] ?? ''), ...opts, onInput: (e) => { m[k] = e.target.value; } });

    const advSel = ui.select({ options: [{ value: '', label: 'Choose an advertiser…' }, ...L.advertisers.map((a) => ({ value: a.id, label: a.name }))], value: '', onChange: (e) => { m.advertiser_id = e.target.value; } });
    const surfSel = ui.select({ options: SURFACES.filter(([v]) => v !== 'machine').map(([v, l]) => ({ value: v, label: l })), value: m.surface, onChange: (e) => { m.surface = e.target.value; } });
    const body = ui.el('div', {}, [
      ui.el('p', { class: 'confirm-msg', text: 'A batch is a physical commitment. Codes are created as drafts, one per distribution event — not one per carton — and the manifest goes to the printer with the artwork.' }),
      ui.field('Label prefix', f('label', { placeholder: 'READING-26-D1' })), ui.field('Surface', surfSel), ui.field('Advertiser', advSel),
      ui.field('Units printed', f('quantity', { type: 'number', min: 1, max: 5000 }), { hint: '1–5,000 per batch (a 10,000-unit run is two batches). Carton batches under 500 units are refused.' }),
      ui.field('Number of codes', f('code_count', { type: 'number', min: 1, max: 50 }), { hint: 'Each carton code must cover at least 500 units, so a scan can never be tied to a person.' }),
      ui.field('Destination URL', f('destination_url', { placeholder: 'https://…' })), ui.field('Fallback URL', f('fallback_url', { placeholder: 'https://…' })),
      ui.field('Print run reference', f('print_run_ref', { placeholder: 'Required' })),
      ui.field('Event (optional)', f('event_label', { placeholder: 'e.g. Reading Festival' })), ui.field('Event date', f('event_date', { type: 'date' })), ui.field('Event location', f('event_location')),
      ui.field('Expectation set', f('expectation_set', { placeholder: 'What the artwork promises the scanner' })),
      resultHost,
    ]);
    const go = ui.button({ label: 'Create batch', variant: 'primary', onClick: async () => {
      if (saving) return; saving = true; go.disabled = true;
      try {
        const res = await rpc('fn_admin_qr_batch_create', { p_payload: {
          label: m.label, surface: m.surface, advertiser_id: m.advertiser_id || null, quantity: Number(m.quantity), code_count: Number(m.code_count),
          destination_url: m.destination_url.trim(), fallback_url: m.fallback_url.trim() || null, print_run_ref: m.print_run_ref,
          event_label: m.event_label || null, event_date: m.event_date || null, event_location: m.event_location || null, expectation_set: m.expectation_set || null } });
        ui.toast(`Batch created with ${res.codes.length} code${res.codes.length === 1 ? '' : 's'}.`, 'success');
        ui.render(resultHost, ui.el('div', {}, [
          ui.el('p', { text: `${res.codes.length} codes created as drafts:` }),
          ui.el('ul', {}, res.codes.map((c) => ui.el('li', {}, [mono(c.short_code), ` — ${c.label} `, ui.el('a', { href: `#qr?id=${c.id}`, text: 'open' })]))),
          ui.button({ label: 'Download manifest + files', variant: 'ghost', onClick: () => downloadSet(res.codes, `${res.batch.label}`) }),
        ]));
        go.style.display = 'none';
        if (!destroyed) showList();
      } catch (err) { ui.toast(friendly(err), 'error'); go.disabled = false; }
      finally { saving = false; }
    } });
    openModal = ui.modal({ title: 'New batch', size: 'lg', body, actions: [ui.button({ label: 'Close', variant: 'ghost', onClick: () => closeModal() }), go], onClose: () => { openModal = null; } });
  }

  // ===========================================================================
  // DOWNLOADS
  // ===========================================================================
  async function downloadSet(codes, name) {
    if (!host) { ui.toast('Set QR_SHORT_DOMAIN in js/config.js first: print files are disabled until the short domain exists.', 'warn'); return; }
    try {
      const files = []; const rows = []; const names = {};
      (lookups ? lookups.advertisers : []).forEach((a) => { names[a.id] = a.name; });
      for (const c of codes) {
        const art = await engine.buildArtefacts(c, { host, advertiserName: names[c.advertiser_id] || '' });
        files.push(...art.files); rows.push(art.manifestRow);
        if (art.checks.some((k) => k.level === 'error')) { ui.toast(`${c.short_code}: ${art.checks.find((k) => k.level === 'error').text}`, 'error'); return; }
      }
      files.push({ name: 'manifest.csv', data: engine.manifestCsv(rows) });
      download(`covered-qr_${String(name).replace(/[^A-Za-z0-9-]+/g, '-')}.zip`, makeZip(files), 'application/zip');
      ui.toast('Downloaded. Drafts are named DRAFT-… and are not for print.', 'success');
    } catch (err) { ui.toast(friendly(err), 'error'); }
  }

  function closeModal() { if (openModal) { const mm = openModal; openModal = null; mm.close(); } }

  // ===========================================================================
  // DETAIL
  // ===========================================================================
  async function showDetail(id, days = 30) {
    ui.clear(page);
    const card = ui.card({ title: 'QR code' });
    page.appendChild(card);
    ui.render(card.body, ui.spinner('Loading…'));
    let d;
    try {
      [d] = await Promise.all([rpc('fn_admin_qr_detail', { p_id: id, p_from: isoDay(days - 1), p_to: isoDay(0) }), loadLookups()]);
    } catch (err) {
      if (destroyed) return;
      ui.toast(friendly(err), 'error');
      ui.render(card.body, ui.errorState(friendly(err), () => showDetail(id, days)));
      return;
    }
    if (destroyed) return;
    const c = d.code;
    const refresh = () => showDetail(id, days);

    const act = async (fn, args, ok) => { try { await rpc(fn, args); ui.toast(ok, 'success'); refresh(); } catch (err) { ui.toast(friendly(err), 'error'); } };
    const reasonDialog = (title, message, label) => new Promise((resolve) => {
      let done = false; const finish = (v) => { if (done) return; done = true; mm.close(); resolve(v); };
      const inp = ui.textarea({ rows: 3, placeholder: 'Reason' });
      const mm = ui.modal({ title, size: 'sm', body: [ui.el('p', { class: 'confirm-msg', text: message }), ui.field('Reason (required)', inp)],
        actions: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => finish(null) }),
          ui.button({ label, variant: 'danger', onClick: () => { const v = inp.value.trim(); if (!v) { ui.toast('A reason is required.', 'warn'); return; } finish(v); } })],
        onClose: () => finish(null) });
    });

    const buttons = [ui.button({ label: '← All codes', variant: 'ghost', onClick: () => ctx.router.navigate('qr') })];
    if (c.lifecycle !== 'retired' && c.mode !== 'static') buttons.push(ui.button({ label: 'Repoint…', variant: 'ghost', onClick: () => openRepoint(c, refresh) }));
    if (c.approval_status === 'draft' || c.approval_status === 'rejected') buttons.push(ui.button({ label: 'Submit for approval', variant: 'ghost', onClick: () => act('fn_admin_qr_set_approval', { p_id: c.id, p_status: 'pending', p_reason: null }, 'Submitted for approval.') }));
    if (c.approval_status === 'pending') {
      buttons.push(ui.button({ label: 'Approve destination', variant: 'primary', onClick: async () => {
        const yes = await ui.confirmDialog({ title: 'Approve destination', message: `Approve this code to go to ${c.destination_url}? Once approved and released for print, a printed code will follow this address.`, confirmLabel: 'Approve' });
        if (yes) act('fn_admin_qr_set_approval', { p_id: c.id, p_status: 'approved', p_reason: null }, 'Approved.');
      } }));
      buttons.push(ui.button({ label: 'Reject', variant: 'ghost', onClick: async () => { const r = await reasonDialog('Reject destination', 'Say why, so whoever revisits it knows.', 'Reject'); if (r) act('fn_admin_qr_set_approval', { p_id: c.id, p_status: 'rejected', p_reason: r }, 'Rejected.'); } }));
    }
    if (c.lifecycle === 'draft' && c.approval_status === 'approved') buttons.push(ui.button({ label: 'Release for print', variant: 'primary', onClick: () => act('fn_admin_qr_set_lifecycle', { p_id: c.id, p_state: 'approved_for_print', p_reason: null }, 'Released for print.') }));
    if (c.lifecycle === 'approved_for_print') buttons.push(ui.button({ label: 'Mark in the field', variant: 'primary', onClick: () => act('fn_admin_qr_set_lifecycle', { p_id: c.id, p_state: 'in_field', p_reason: null }, 'Marked in the field.') }));
    if (c.lifecycle === 'suspended') buttons.push(ui.button({ label: 'Resume', variant: 'primary', onClick: () => act('fn_admin_qr_set_lifecycle', { p_id: c.id, p_state: 'in_field', p_reason: null }, 'Resumed.') }));
    if (['draft', 'approved_for_print', 'in_field'].includes(c.lifecycle)) buttons.push(ui.button({ label: 'Suspend', variant: 'ghost', onClick: async () => { const r = await reasonDialog('Suspend code', 'While suspended, a scan shows the COVERED holding page instead of the destination.', 'Suspend'); if (r) act('fn_admin_qr_set_lifecycle', { p_id: c.id, p_state: 'suspended', p_reason: r }, 'Suspended.'); } }));
    if (c.lifecycle !== 'retired') buttons.push(ui.button({ label: 'Retire', variant: 'danger', onClick: async () => {
      const printed = c.printed_qty ? ` About ${num(c.printed_qty)} printed pieces point at it.` : '';
      const r = await reasonDialog('Retire code', `Retiring ${SURFACE_LABEL[c.surface] || c.surface} code ${c.short_code} is permanent: scans will go to its fallback page.${printed}`, 'Retire');
      if (r) act('fn_admin_qr_set_lifecycle', { p_id: c.id, p_state: 'retired', p_reason: r }, 'Retired.'); } }));
    if (c.lifecycle !== 'retired') buttons.push(ui.button({ label: c.active ? 'Deactivate' : 'Reactivate', variant: 'ghost', onClick: () => act('fn_admin_qr_update', { p_id: c.id, p_patch: { active: !c.active } }, c.active ? 'Deactivated.' : 'Reactivated.') }));

    // ---- sizing + downloads
    const spec = engine.SURFACE_SPECS[c.surface] || engine.SURFACE_SPECS.other;
    const sizeIn = ui.input({ type: 'number', min: 5, max: 600, step: 1, value: String(spec.symbolMm || ''), disabled: c.surface === 'screen' });
    const prevHost = ui.el('div', {});
    const drawPreview = () => ui.render(prevHost, previewBlock(c, c.surface === 'screen' ? null : Number(sizeIn.value) || spec.symbolMm));
    sizeIn.addEventListener('input', drawPreview);
    drawPreview();
    const dl = async (kind) => {
      if (!host) { ui.toast('Set QR_SHORT_DOMAIN in js/config.js first: print files are disabled until the short domain exists.', 'warn'); return; }
      try {
        const names = {}; (lookups.advertisers || []).forEach((a) => { names[a.id] = a.name; });
        const art = await engine.buildArtefacts(c, { host, advertiserName: names[c.advertiser_id] || d.advertiser_name || '', symbolMm: c.surface === 'screen' ? undefined : Number(sizeIn.value) || spec.symbolMm });
        const err = art.checks.find((k) => k.level === 'error');
        if (err) { ui.toast(err.text, 'error'); return; }
        if (kind === 'svg') download(art.files[0].name, art.svg, 'image/svg+xml');
        else if (kind === 'png') {
          if (!art.png) { ui.toast('This symbol is too large for a PNG. Use the SVG for print at this size.', 'warn'); return; }
          download(art.files[1].name, art.png, 'image/png');
        }
        else download(art.files[0].name.replace(/\.svg$/, '') + '.zip', makeZip([...art.files, { name: 'manifest.csv', data: engine.manifestCsv([art.manifestRow]) }]), 'application/zip');
        ui.toast(art.draft ? 'Downloaded as DRAFT — not for print until the code is released.' : 'Downloaded.', art.draft ? 'warn' : 'success');
      } catch (e) { ui.toast(friendly(e), 'error'); }
    };

    // ---- stats + chart
    const dailyMap = new Map((d.daily || []).map((x) => [x.day, x]));
    const series = []; const excluded = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = isoDay(i); const x = dailyMap.get(day) || {};
      const label = i % Math.ceil(days / 6) === 0 ? day.slice(5) : '';
      series.push({ label, value: x.qualified_scans || 0 }); excluded.push({ label, value: (x.bot_scans || 0) + (x.duplicate_scans || 0) + (x.non_uk_scans || 0) + (x.desktop_scans || 0) });
    }
    const sum = (k) => (d.daily || []).reduce((n, x) => n + (x[k] || 0), 0);
    const last = c.last_scan_at ? ui.fmtDate(c.last_scan_at, { mode: 'relative' }) : 'never';
    const rangeSel = ui.select({ options: [{ value: 7, label: 'Last 7 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' }], value: days, onChange: (e) => showDetail(id, Number(e.target.value)) });

    const fullUrl = host ? engine.payloadFor(host, c.short_code) : null;
    const pending = c.approval_status !== 'approved' || c.approved_destination_url !== c.destination_url;

    ui.render(card.body, [
      ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } }, buttons),
      ui.el('h2', { text: c.label, style: { margin: '0 0 4px' } }),
      ui.el('div', {}, [ui.badge(SURFACE_LABEL[c.surface] || c.surface, 'muted'), ' ', lifecycleBadge(c), ' ', approvalBadge(c), ' ', windowBadge(c), ' ', ui.badge(c.mode, 'muted')]),
      ui.el('p', {}, [mono(c.short_code), ' ', fullUrl ? ui.el('span', {}, [mono(fullUrl), ' ', ui.button({ label: 'Copy URL', variant: 'subtle', size: 'sm', onClick: () => copyText(fullUrl, 'URL') })]) : note('No short domain configured yet.', 'warn')]),
      ui.el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '8px', margin: '12px 0' } }, [
        ui.stat({ label: `Qualified (${days}d)`, value: num(sum('qualified_scans')) }),
        ui.stat({ label: 'Bots excluded', value: num(sum('bot_scans')) }),
        ui.stat({ label: 'Duplicates excluded', value: num(sum('duplicate_scans')) }),
        ui.stat({ label: 'Non-UK (shown separately)', value: num(sum('non_uk_scans')) }),
        ui.stat({ label: 'Desktop on a printed code (excluded)', value: num(sum('desktop_scans')) }),
        ui.stat({ label: 'Lifetime*', value: num(c.scan_count_cache) }),
        ui.stat({ label: 'Last scan', value: last }),
      ]),
      ui.el('div', { style: { margin: '8px 0' } }, rangeSel),
      ui.el('div', { class: 'card-subtitle', text: 'Qualified scans per day' }), ui.bars(series, { ariaLabel: 'Qualified scans per day', height: 140 }),
      ui.el('div', { class: 'card-subtitle', text: 'Excluded per day (bots, duplicates, non-UK, desktop on a printed code)' }), ui.bars(excluded, { ariaLabel: 'Excluded scans per day', height: 100 }),
      note(loggingText(d.logging_health).text),
      note('* Lifetime includes days whose raw log has been purged. There is no unique-scanner figure: COVERED does not store anything that could count one.'),

      ui.el('h3', { text: 'Destination' }),
      ui.table([{ key: 'k', label: '' }, { key: 'v', label: '', render: (v) => ui.el('span', { text: v, style: { wordBreak: 'break-all' } }) }], [
        { k: 'Goes to', v: c.destination_url },
        { k: 'Served right now', v: servedNow(c) },
        { k: 'Fallback', v: (c.fallback_url || '—') + (c.on_expiry === 'gone' ? ' (expiry shows “no longer available”)' : '') },
        { k: 'Window', v: `${c.starts_at ? ui.fmtDate(c.starts_at) : 'no start'} → ${c.ends_at ? ui.fmtDate(c.ends_at) : 'no end'}` },
        { k: 'Expectation set', v: c.expectation_set || '—' },
        { k: 'Print run', v: [c.print_run_ref, c.printed_qty ? `${num(c.printed_qty)} printed` : ''].filter(Boolean).join(' · ') || '—' },
        { k: 'Health check', v: d.latest_check ? `${d.latest_check.http_status ?? '?'} · ${d.latest_check.host_ok === false ? 'host moved outside its approved host' : 'ok'} · ${ui.fmtDate(d.latest_check.checked_at, { mode: 'relative' })}` : 'Not checked yet (daily destination sweep ships with the redirect)' },
      ]),
      pending && c.approved_destination_url ? note('The destination was changed after approval. Scans keep going to the last approved address until a new approval.', 'warn') : null,
      c.rejection_reason ? note('Rejected: ' + c.rejection_reason, 'warn') : null,

      ui.el('h3', { text: 'QR image and print files' }),
      ui.el('div', { class: 'ad-form-grid' }, [
        ui.el('div', {}, [
          c.surface === 'screen' ? note('The screen code is sized in whole pixels, not millimetres.') : ui.field('Symbol size (mm, quiet zone not included)', sizeIn, { hint: `Planned: ${spec.symbolMm} mm. Hard floor ${spec.floorMm} mm.` }),
          ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
            ui.button({ label: 'SVG (print)', variant: 'primary', onClick: () => dl('svg') }),
            ui.button({ label: 'PNG', variant: 'ghost', onClick: () => dl('png') }),
            ui.button({ label: 'ZIP + manifest', variant: 'ghost', onClick: () => dl('zip') }),
          ]),
          c.lifecycle === 'draft' || c.approval_status !== 'approved' ? note('Drafts download with a DRAFT- prefix and must not be printed.', 'warn') : null,
          note('Black on white, 4-module quiet zone inside the file, alphanumeric mode. The pre-print checklist on a physical proof still applies.'),
        ]),
        ui.el('div', {}, prevHost),
      ]),

      ui.el('h3', { text: 'Recent scans' }),
      ui.table([
        { key: 'scanned_at', label: 'When', render: (v) => ui.el('span', { text: ui.fmtDate(v) }) },
        { key: 'country_code', label: 'Country', render: (v) => ui.el('span', { text: v || '—' }) },
        { key: 'device_class', label: 'Device', render: (v) => ui.el('span', { text: v || '—' }) },
        { key: 'outcome', label: 'Outcome' },
        { key: 'is_bot', label: 'Flags', render: (_v, r) => ui.el('span', { text: [r.is_bot ? 'bot' : '', r.duplicate ? 'duplicate' : ''].filter(Boolean).join(', ') || '—' }) },
      ], d.recent_scans || [], { empty: 'No scans recorded.' }),
      note('COVERED does not store IP addresses, user agents or any device identifier for QR scans. This log is kept for 30 days.'),

      ui.el('h3', { text: 'Destination history' }),
      ui.table([
        { key: 'changed_at', label: 'When', render: (v) => ui.el('span', { text: ui.fmtDate(v) }) },
        { key: 'old_url', label: 'From', render: (v) => ui.el('span', { text: trunc(v, 60), title: v || '' }) },
        { key: 'new_url', label: 'To', render: (v) => ui.el('span', { text: trunc(v, 60), title: v || '' }) },
      ], d.destination_history || [], { empty: 'The destination has never been changed.' }),

      ui.el('h3', { text: 'Audit trail' }),
      ui.table([
        { key: 'at', label: 'When', render: (v) => ui.el('span', { text: ui.fmtDate(v) }) },
        { key: 'action', label: 'Action' },
        { key: 'reason', label: 'Reason', render: (v) => ui.el('span', { text: v || '—' }) },
      ], d.audit || [], { empty: 'No audit entries.' }),
    ]);
  }

  // ---- repoint modal
  function openRepoint(c, done) {
    const newIn = ui.input({ value: c.destination_url, placeholder: 'https://…' });
    const reasonIn = ui.textarea({ rows: 2, placeholder: 'Why is it changing? (required)' });
    const printed = c.printed_qty ? ` About ${num(c.printed_qty)} printed pieces carry this code.` : '';
    const body = ui.el('div', {}, [
      ui.el('p', { class: 'confirm-msg', text: `${SURFACE_LABEL[c.surface] || c.surface} code ${c.short_code} currently goes to:` }),
      ui.el('p', { text: c.destination_url, style: { wordBreak: 'break-all', fontFamily: 'ui-monospace, Consolas, monospace' } }),
      ui.field('New destination', newIn), ui.field('Reason', reasonIn),
      note(`Changing the destination resets approval to “awaiting approval”. Until it is approved again, scans keep going to the last approved address.${printed}`, 'warn'),
      c.surface === 'machine' ? note(`The new address must still carry machineId=${c.machine_id}.`) : null,
    ]);
    const go = ui.button({ label: 'Repoint', variant: 'danger', onClick: async () => {
      go.disabled = true;
      try { await rpc('fn_admin_qr_repoint', { p_id: c.id, p_new_url: newIn.value.trim(), p_reason: reasonIn.value.trim() }); ui.toast('Destination changed — awaiting approval.', 'success'); closeModal(); done(); }
      catch (err) { ui.toast(friendly(err), 'error'); go.disabled = false; }
    } });
    openModal = ui.modal({ title: 'Repoint code', size: 'md', body, actions: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => closeModal() }), go], onClose: () => { openModal = null; } });
  }

  // ---------------------------------------------------------------------------
  // Route
  // ---------------------------------------------------------------------------
  if (params.id) await showDetail(params.id); else await showList();

  return () => {
    destroyed = true;
    closeModal();
    objectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* ignore */ } });
  };
}
