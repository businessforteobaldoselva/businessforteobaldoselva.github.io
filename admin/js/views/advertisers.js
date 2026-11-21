// =============================================================================
// COVERED Admin Console — Advertisers (brand dashboard control)
// -----------------------------------------------------------------------------
// The tab that decides what a brand can see on brands.coveredaccess.com, and
// lets Teo look at it before anyone else does. See
// covered-advertiser-dashboard/PLAN.md (decisions D1–D9) and
// covered-advertiser-dashboard/18-advertiser-portal.sql.
//
//   #advertisers            every advertiser: users, published state, panels
//   #advertisers?id=<uuid>  one advertiser: users, panels, floor, PREVIEW, publish
//
// The detail view does exactly five things, in this order:
//   1. users   — list, attach by email, viewer/manager, suspend, detach
//   2. panels  — which panels the portal is allowed to render
//   3. window  — date floor + the note shown at the top of their dashboard
//   4. preview — fn_admin_advertiser_preview rendered read-only, in the same
//                shape the portal renders, behind an unmissable banner
//   5. publish — the master switch (default OFF), behind a confirmDialog that
//                says in plain words what becomes visible and to whom
//
// WHY EVERY CALL HERE IS supabase.rpc(...), like qr.js and unlike ads.js:
//   advertiser_users and advertiser_dashboard_config have RLS ENABLED AND
//   FORCED with no policies and no grants to authenticated. Every read and
//   write goes through a fn_admin_advertiser_* function that re-checks
//   fn_is_admin() server side. The ONE direct table read is `app_settings`
//   (admin policy) for the two gate flags, and it is advisory only — the gates
//   themselves are enforced in SQL, never here. Do not "fix" this to match
//   ads.js.
//
// THE PAGE DECIDES NOTHING. Suppression (n<5), the dwell gate, the measurement
// gate, the date floor and the panel switches are all applied by the RPC. This
// file renders the payload it is handed and says why a value is missing. It
// never computes a metric, never fills a gap with a zero, and never hardcodes
// a caveat sentence — caveats come from the payload, assembled server side
// from MEASUREMENT-DEFINITIONS.md §6.
//
// CONTRACT NOTES this file honours (same as the other views):
//   - Everything is appended into `root`; modals via ui.modal and toasts via
//     ui.toast — the only permitted exceptions.
//   - ALL database and user text is rendered with textContent (ui.el `text`,
//     table cells, ui.badge); no innerHTML anywhere in this file.
//   - Every call is wrapped; failures toast AND render an errorState with retry.
//   - A `destroyed` flag stops a late response painting into a torn-down root.
//   - The returned cleanup closes any modal and revokes every object URL.
//
// DELIBERATELY ABSENT: any control that creates a login, sets or resets a
// password, or sends an invitation. SQL cannot create an auth user, and this
// console will not pretend to: invitations are sent from the Supabase
// dashboard (BUILD-NOTES.md), and this tab only links an account that already
// exists. There is also no field for a unique-visitor, reach or people figure,
// because COVERED does not hold one (D7) — the absence of the field is the
// control.
//
// TWO RPCs THIS VIEW NEEDS THAT THE BUILD CONTRACT DID NOT NAME:
//   a) reading the user list. fn_admin_advertiser_portal_list() returns a
//      user_count, not the users, and suspend/detach both need a user_id.
//      fn_admin_advertiser_users(p_advertiser_id) was ADDED to migration 18 in
//      the review for exactly this. The view still looks for a `users` array on
//      the list row first, and still degrades to a sentence if the function is
//      missing (an older 18 applied), rather than showing an empty table.
//   b) changing a role. There is no fn_admin_advertiser_user_set_role, so a
//      role change re-calls fn_admin_advertiser_user_attach with the same
//      email and the new role (attach is an upsert). If the server refuses,
//      the refusal is shown rather than swallowed.
// =============================================================================

const PANELS = [
  ['ads', 'Ad views', 'Views started, views completed, completion rate. Source: ad_views (server-attested).'],
  ['clicks', 'Clicks', 'Click count and click rate. Source: events of type ad_clicked. Labelled clicks, never "engagement".'],
  ['qr', 'QR scans', 'Qualified scans, gross scans and the exclusions broken out. Machine stickers are always excluded.'],
  ['trend', 'Daily trend', 'One row per day for the panels that are on. Suppressed days show a dash.'],
  ['machines', 'Machines carried', 'Which machines and surfaces carried the campaign. Names are slightly more re-identifying than counts.'],
];
const PANEL_LABEL = Object.fromEntries(PANELS.map(([k, l]) => [k, l]));
const ROLES = [['viewer', 'Viewer'], ['manager', 'Manager']];
const ROLE_LABEL = Object.fromEntries(ROLES);

// The two app_settings flags that gate what may leave the database.
const GATE_KEYS = ['measurement_definitions_signed_off', 'dispense_v2_live'];

// Server error codes -> a sentence a person can act on.
const ERRORS = {
  not_admin: 'You do not have admin access.',
  not_authorised: 'You do not have admin access to the advertiser portal.',
  no_such_user: 'No account exists for that email yet. Send the invitation from the Supabase dashboard first (Authentication → Users → Invite), then attach them here once they have accepted.',
  advertiser_required: 'Choose the advertiser.',
  advertiser_not_found: 'That advertiser no longer exists.',
  user_not_found: 'That user is no longer linked to an advertiser.',
  email_required: 'Enter an email address.',
  invalid_email: 'That is not a valid email address.',
  invalid_role: 'The role must be viewer or manager.',
  invalid_status: 'The status must be active or suspended.',
  invalid_patch: 'That change was not accepted: check the date floor and the panel switches.',
  invalid_date_floor: 'The date floor must be a real date, and not in the future.',
  invalid_panels: 'The panel switches were not in the expected shape.',
  invalid_range: 'That date range is not valid.',
  already_attached: 'That account is already linked to an advertiser. Detach it there first — an account belongs to exactly one advertiser.',
};
function friendly(err) {
  const raw = String((err && (err.message || err.details)) || err || '');
  const key = Object.keys(ERRORS).find((k) => raw === k || raw.startsWith(k + ':') || raw.includes(k));
  if (key) return ERRORS[key];
  if (err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(raw))) {
    return 'The advertiser portal is not installed in the database yet (migration 18 has not been applied).';
  }
  if (err && (err.code === '42501' || /permission denied/i.test(raw))) {
    return 'You do not have admin access to the advertiser portal.';
  }
  if (err && (err.code === '42P01' || /relation .* does not exist/i.test(raw))) {
    return 'A table the portal needs is missing. Apply migrations 14 and 17 before 18.';
  }
  return raw || 'Something went wrong.';
}
// True when a failure means "that function does not exist yet" rather than a fault.
function isMissingFunction(err) {
  const raw = String((err && (err.message || err.details)) || err || '');
  return !!err && (err.code === 'PGRST202' || err.code === '42883' || /could not find the function/i.test(raw));
}

export default async function mount(root, ctx) {
  const { supabase, ui } = ctx;
  const params = ctx.params || {};

  let destroyed = false;
  let openModal = null;
  const objectUrls = [];
  let gates = null;                 // { signed, dispense, error } — advisory only

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------
  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data;
  }
  function closeModal() { if (openModal) { const mm = openModal; openModal = null; mm.close(); } }
  function download(name, data, mime) {
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    objectUrls.push(url);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { URL.revokeObjectURL(url); }, 30000);
  }

  // Days are the database's days (Europe/London), not UTC: at 00:30 BST the UTC date is still yesterday.
  const isoDay = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-GB'));
  // REVIEW FIX. A rate from 18 is ALREADY A PERCENTAGE: _adv_rate returns
  // round(num::numeric / den * 100, 1). The earlier reading ("a value of 1 or
  // less must be a fraction, so multiply by 100") turned a genuine 0.8% into
  // 80% — a hundredfold overstatement in a brand-facing preview. Nothing is
  // rescaled and nothing is recomputed from the counts: the server's number is
  // the number.
  const pct = (v) => {
    if (v == null) return '—';
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}%`;
  };
  const secs = (v) => (v == null ? '—' : `${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 1 })} s`);
  const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
  // Accept an array, or a jsonb wrapper around one — a server shape change must
  // not blank the page silently.
  function asRows(data, ...keys) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const k of [...keys, 'rows', 'items', 'data']) if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }
  function note(text, tone = '') {
    return ui.el('p', {
      class: 'field-hint', text,
      style: tone === 'warn' ? { color: 'var(--warn, #b45309)' } : undefined,
    });
  }
  function banner(text, tone = 'warn') {
    return ui.card({ tone, body: ui.el('p', { text, style: { margin: 0 } }) });
  }
  function h3(text) { return ui.el('h3', { text, style: { margin: '24px 0 4px' } }); }

  // ---------------------------------------------------------------------------
  // The two gates. Enforced in SQL; read here only so a blocking gate is
  // visible BEFORE Teo wonders why a brand sees nothing.
  // ---------------------------------------------------------------------------
  async function loadGates(force = false) {
    if (gates && !force) return gates;
    const { data, error } = await supabase.from('app_settings').select('key,value').in('key', GATE_KEYS);
    if (error) {
      gates = { signed: null, dispense: null, error };
      return gates;
    }
    const get = (k) => {
      const row = (data || []).find((r) => r.key === k);
      return row ? truthy(row.value) : false;
    };
    gates = { signed: get('measurement_definitions_signed_off'), dispense: get('dispense_v2_live'), error: null };
    return gates;
  }
  function gateBanners(g) {
    const out = [];
    if (!g) return out;
    if (g.error) {
      out.push(note('The two measurement gates could not be read from app_settings (' + friendly(g.error) + '). They are still enforced in the database; this panel just cannot show their state.', 'warn'));
      return out;
    }
    if (!g.signed) {
      out.push(banner('BLOCKING: measurement definitions are not signed off. Until app_settings.measurement_definitions_signed_off is true, every advertiser sees a calm "not available yet" message and no number leaves the database. Your preview below still works — that is the point of it.'));
    }
    if (!g.dispense) {
      out.push(banner('BLOCKING FOR DWELL: dispense-v2 is not live (app_settings.dispense_v2_live is not true), so every dwell and credited-seconds figure comes back empty. The live sessions.dwell_ms measures scan-to-dispense, which includes waiting for an SMS — it is not attention and must never be shown to a brand as if it were.'));
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Page chrome
  // ---------------------------------------------------------------------------
  const page = ui.el('div', { class: 'view view--advertisers' });
  root.appendChild(page);

  // ===========================================================================
  // LIST
  // ===========================================================================
  async function showList() {
    ui.clear(page);
    const listCard = ui.card({
      title: 'Advertiser dashboards',
      subtitle: 'Who can sign in to the brand portal, what they are allowed to see, and whether it is switched on.',
    });
    page.appendChild(listCard);
    ui.render(listCard.body, ui.spinner('Loading advertisers…'));

    let data, g;
    try {
      [data, g] = await Promise.all([rpc('fn_admin_advertiser_portal_list'), loadGates(true)]);
    } catch (err) {
      if (destroyed) return;
      ui.toast(friendly(err), 'error');
      ui.render(listCard.body, ui.errorState(friendly(err), () => showList()));
      return;
    }
    if (destroyed) return;

    const rows = asRows(data, 'advertisers');
    const published = rows.filter((r) => r.published).length;

    let body;
    if (!rows.length) {
      body = ui.emptyState('There are no advertisers yet.', note('Advertisers are created in the QR codes tab (New QR code → Add new advertiser…) or by fn_admin_advertiser_upsert. They appear here as soon as they exist.'));
    } else {
      body = ui.table([
        { key: 'name', label: 'Advertiser', render: (v, r) => ui.el('a', { href: `#advertisers?id=${r.id}`, text: v || '—', style: { fontWeight: '600' } }) },
        { key: 'status', label: 'Account', render: (v) => ui.badge(v || 'unknown', v === 'active' ? 'ok' : v === 'archived' ? 'muted' : 'warn') },
        { key: 'user_count', label: 'Logins', align: 'right', render: (v) => ui.el('span', { text: num(v) }) },
        { key: 'published', label: 'Dashboard', render: (v) => ui.badge(v ? 'Published' : 'Off', v ? 'ok' : 'muted') },
        { key: 'panels', label: 'Panels on', render: (v) => ui.el('span', { text: panelSummary(v) }) },
        { key: 'date_floor', label: 'Visible from', render: (v) => ui.el('span', { text: v ? ui.fmtDate(v, { mode: 'date' }) : 'no floor' }) },
        { key: 'last_seen_at', label: 'Last signed in', render: (v) => ui.el('span', { text: v ? ui.fmtDate(v, { mode: 'relative' }) : 'never' }) },
        { key: 'id', label: '', align: 'right', render: (_v, r) => ui.button({ label: 'Open', variant: 'ghost', size: 'sm', onClick: () => ctx.router.navigate('advertisers', { id: r.id }) }) },
      ], rows, { empty: 'No advertisers.' });
    }

    ui.render(listCard.body, [
      ...gateBanners(g),
      rows.length ? note(`${rows.length} advertiser${rows.length === 1 ? '' : 's'}; ${published} with a published dashboard. A dashboard is off until you publish it, and an advertiser with no linked login cannot sign in at all.`) : null,
      body,
      note('An advertiser sees only their own rows: the portal resolves scope from the signed-in account (fn_advertiser_scope) and ignores any advertiser id the browser sends unless the caller is an admin. There is no unique-visitor, reach or people figure anywhere in the portal — COVERED does not hold one.'),
    ]);
  }
  function panelSummary(panels) {
    const p = panels && typeof panels === 'object' ? panels : {};
    const on = PANELS.filter(([k]) => p[k]).map(([k]) => PANEL_LABEL[k]);
    return on.length ? on.join(', ') : 'none';
  }

  // ===========================================================================
  // DETAIL
  // ===========================================================================
  async function showDetail(id) {
    ui.clear(page);
    const card = ui.card({ title: 'Advertiser dashboard' });
    page.appendChild(card);
    ui.render(card.body, ui.spinner('Loading…'));

    let rows, g;
    try {
      [rows, g] = await Promise.all([rpc('fn_admin_advertiser_portal_list'), loadGates()]);
    } catch (err) {
      if (destroyed) return;
      ui.toast(friendly(err), 'error');
      ui.render(card.body, ui.errorState(friendly(err), () => showDetail(id)));
      return;
    }
    if (destroyed) return;

    const a = asRows(rows, 'advertisers').find((r) => String(r.id) === String(id));
    if (!a) {
      ui.render(card.body, [
        ui.button({ label: '← All advertisers', variant: 'ghost', onClick: () => ctx.router.navigate('advertisers') }),
        ui.emptyState('That advertiser is not in the portal list. It may have been archived or removed.'),
      ]);
      return;
    }

    const cfg = {
      published: !!a.published,
      panels: Object.assign({}, a.panels && typeof a.panels === 'object' ? a.panels : {}),
      date_floor: a.date_floor || '',
      notes_to_advertiser: a.notes_to_advertiser || '',
    };
    const refresh = () => showDetail(id);

    // --- hosts the sub-panels paint into, so one save does not re-render the lot
    const usersHost = ui.el('div', {});
    const previewHost = ui.el('div', {});

    // =========================================================================
    // 1. USERS
    // =========================================================================
    async function loadUsers() {
      if (destroyed) return;
      ui.render(usersHost, ui.spinner('Loading logins…'));
      // Preferred: the list row already carries them. Fallback: a dedicated RPC.
      if (Array.isArray(a.users)) { renderUsers(a.users); return; }
      let data;
      try {
        data = await rpc('fn_admin_advertiser_users', { p_advertiser_id: id });
      } catch (err) {
        if (destroyed) return;
        if (isMissingFunction(err)) {
          ui.render(usersHost, [
            note(`This advertiser has ${num(a.user_count)} linked login${a.user_count === 1 ? '' : 's'}, but this database has no fn_admin_advertiser_users to list them with, so an older migration 18 is applied. Re-apply the current 18-advertiser-portal.sql and this table fills in. Attaching a login below still works; suspend and detach need the list, because they need a user_id.`, 'warn'),
            attachBar(),
          ]);
          return;
        }
        ui.toast(friendly(err), 'error');
        ui.render(usersHost, ui.errorState(friendly(err), () => loadUsers()));
        return;
      }
      if (destroyed) return;
      renderUsers(asRows(data, 'users'));
    }

    // After a write: when the user list arrived inline on the list row, only a
    // full reload of the row shows the change.
    const reloadUsers = () => (Array.isArray(a.users) ? refresh() : loadUsers());

    function attachBar() {
      return ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' } }, [
        ui.button({ label: 'Attach a login…', variant: 'primary', onClick: () => openAttach() }),
      ]);
    }

    function renderUsers(users) {
      const list = users || [];
      ui.render(usersHost, [
        attachBar(),
        list.length
          ? ui.table([
            { key: 'email', label: 'Email', render: (v) => ui.el('span', { text: v || '—' }) },
            {
              key: 'role', label: 'Role', render: (v, r) => ui.select({
                options: ROLES.map(([value, label]) => ({ value, label })),
                value: v || 'viewer',
                onChange: (e) => setRole(r, e.target.value, e.target),
              }),
            },
            { key: 'status', label: 'Status', render: (v) => ui.badge(v === 'suspended' ? 'Suspended' : 'Active', v === 'suspended' ? 'warn' : 'ok') },
            { key: 'invited_at', label: 'Linked', render: (v) => ui.el('span', { text: v ? ui.fmtDate(v, { mode: 'date' }) : '—' }) },
            { key: 'last_seen_at', label: 'Last signed in', render: (v) => ui.el('span', { text: v ? ui.fmtDate(v, { mode: 'relative' }) : 'never' }) },
            {
              key: 'user_id', label: '', align: 'right', render: (_v, r) => ui.el('span', { style: { display: 'inline-flex', gap: '6px' } }, [
                ui.button({
                  label: r.status === 'suspended' ? 'Reactivate' : 'Suspend', variant: 'ghost', size: 'sm',
                  onClick: () => setStatus(r, r.status === 'suspended' ? 'active' : 'suspended'),
                }),
                ui.button({ label: 'Detach', variant: 'danger', size: 'sm', onClick: () => detach(r) }),
              ]),
            },
          ], list, { empty: 'No logins linked.' })
          : ui.emptyState('No login is linked to this advertiser yet, so nobody can sign in — publishing the dashboard would change nothing.'),
        note('A login is created by invitation from the Supabase dashboard (Authentication → Users → Invite). This console never creates an account, sets a password or sends an email: it only links an account that already exists, and an account belongs to exactly one advertiser. Suspending a login keeps the row and blocks the scope immediately; detaching removes the link, and the account itself survives in Supabase Auth until you delete it there.'),
        note('This table holds third-party personal data (a business contact email). Retention: life of the commercial relationship plus 12 months, deleted on request — see RETENTION-ADDENDUM.md.'),
      ]);
    }

    function openAttach() {
      const emailIn = ui.input({ type: 'email', placeholder: 'name@brand.co.uk', autocomplete: 'off' });
      let role = 'viewer';
      const roleSel = ui.select({ options: ROLES.map(([value, label]) => ({ value, label })), value: role, onChange: (e) => { role = e.target.value; } });
      const go = ui.button({
        label: 'Attach', variant: 'primary', onClick: async () => {
          const email = String(emailIn.value || '').trim().toLowerCase();
          if (!email) { ui.toast('Enter an email address.', 'warn'); return; }
          go.disabled = true;
          try {
            const res = await rpc('fn_admin_advertiser_user_attach', { p_advertiser_id: id, p_email: email, p_role: role });
            if (res && res.ok === false) {
              ui.toast(ERRORS[res.reason] || friendly(res.reason), 'warn');
              go.disabled = false;
              return;
            }
            ui.toast('Login attached.', 'success');
            closeModal();
            refresh();
          } catch (err) {
            ui.toast(friendly(err), 'error');
            go.disabled = false;
          }
        },
      });
      openModal = ui.modal({
        title: 'Attach a login', size: 'sm',
        body: [
          ui.el('p', { class: 'confirm-msg', text: `Link an existing Supabase account to ${a.name}. The person must already have accepted an invitation sent from the Supabase dashboard — this console cannot create an account or send an email.` }),
          ui.field('Email', emailIn, { hint: 'Exactly the address the invitation went to. Matched case-insensitively.' }),
          ui.field('Role', roleSel, { hint: 'Viewer and manager see the same numbers today. The role exists so a later change (such as who may edit a note) does not need a migration.' }),
        ],
        actions: [ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => closeModal() }), go],
        onClose: () => { openModal = null; },
      });
    }

    async function setRole(u, nextRole, selectEl) {
      if (!nextRole || nextRole === u.role) return;
      if (selectEl) selectEl.disabled = true;
      try {
        // No fn_admin_advertiser_user_set_role exists; attach is the upsert.
        const res = await rpc('fn_admin_advertiser_user_attach', { p_advertiser_id: id, p_email: u.email, p_role: nextRole });
        if (res && res.ok === false) { ui.toast(ERRORS[res.reason] || friendly(res.reason), 'warn'); reloadUsers(); return; }
        ui.toast(`Role set to ${ROLE_LABEL[nextRole] || nextRole}.`, 'success');
        reloadUsers();
      } catch (err) {
        ui.toast(friendly(err), 'error');
        reloadUsers();
      } finally { if (selectEl && !destroyed) selectEl.disabled = false; }
    }

    async function setStatus(u, nextStatus) {
      if (nextStatus === 'suspended') {
        const yes = await ui.confirmDialog({
          title: 'Suspend this login',
          message: `${u.email} will not be able to see any COVERED data from the moment you confirm — their scope resolves to nothing. The account and the link survive, so you can reactivate it here.`,
          confirmLabel: 'Suspend', danger: true,
        });
        if (!yes || destroyed) return;
      }
      try {
        await rpc('fn_admin_advertiser_user_set_status', { p_user_id: u.user_id, p_status: nextStatus });
        ui.toast(nextStatus === 'suspended' ? 'Login suspended.' : 'Login reactivated.', 'success');
        reloadUsers();
      } catch (err) { ui.toast(friendly(err), 'error'); }
    }

    async function detach(u) {
      const yes = await ui.confirmDialog({
        title: 'Detach this login',
        message: `${u.email} will no longer be linked to ${a.name} and will see nothing when they sign in. The account itself stays in Supabase Auth until you delete it there. Attaching them again later is one step.`,
        confirmLabel: 'Detach', danger: true,
      });
      if (!yes || destroyed) return;
      try {
        await rpc('fn_admin_advertiser_user_detach', { p_user_id: u.user_id });
        ui.toast('Login detached.', 'success');
        refresh();
      } catch (err) { ui.toast(friendly(err), 'error'); }
    }

    // =========================================================================
    // 2. PANELS   +   3. DATE FLOOR AND NOTE
    // =========================================================================
    const panelBoxes = PANELS.map(([key, label, hint]) => ui.el('div', { class: 'field' }, [
      ui.checkbox({ label, checked: !!cfg.panels[key], onChange: (e) => { cfg.panels[key] = e.target.checked; } }),
      note(hint),
    ]));
    const savePanels = ui.button({
      label: 'Save panels', variant: 'primary', onClick: async () => {
        savePanels.disabled = true;
        try {
          await rpc('fn_admin_advertiser_config_set', { p_advertiser_id: id, p_patch: { panels: cfg.panels } });
          ui.toast('Panels saved.', 'success');
          refresh();
        } catch (err) { ui.toast(friendly(err), 'error'); savePanels.disabled = false; }
      },
    });

    const floorIn = ui.input({ type: 'date', value: cfg.date_floor || '', onChange: (e) => { cfg.date_floor = e.target.value; } });
    const notesIn = ui.textarea({ rows: 3, value: cfg.notes_to_advertiser || '', placeholder: 'Shown at the top of their dashboard, in your words.', onInput: (e) => { cfg.notes_to_advertiser = e.target.value; } });
    const saveWindow = ui.button({
      label: 'Save window and note', variant: 'primary', onClick: async () => {
        saveWindow.disabled = true;
        try {
          await rpc('fn_admin_advertiser_config_set', {
            p_advertiser_id: id,
            p_patch: {
              date_floor: cfg.date_floor ? cfg.date_floor : null,
              notes_to_advertiser: String(cfg.notes_to_advertiser || '').trim() || null,
            },
          });
          ui.toast('Saved.', 'success');
          refresh();
        } catch (err) { ui.toast(friendly(err), 'error'); saveWindow.disabled = false; }
      },
    });

    // =========================================================================
    // 5. PUBLISH / UNPUBLISH
    // =========================================================================
    async function setPublished(next) {
      const n = Number(a.user_count || 0);
      const whoCount = `${n} linked login${n === 1 ? '' : 's'}`;
      const panelsOn = panelSummary(cfg.panels);
      const from = cfg.date_floor ? `dates from ${ui.fmtDate(cfg.date_floor, { mode: 'date' })} onwards` : 'the whole record, with no date floor set';
      let message;
      if (next) {
        message = [
          `Publishing switches ${a.name}'s dashboard on for ${whoCount}.`,
          `Anyone signed in to one of those accounts will be able to see, for ${a.name} only: ${panelsOn}.`,
          `They will see ${from}.`,
          'Any count below five is shown as a dash, machine-sticker scans are excluded, and no dwell or credited-seconds figure is shown while dispense-v2 is not live.',
          'They cannot see any other advertiser, any venue economics, any machine takings, or anything about COVERED itself.',
          n === 0 ? 'There is no login linked yet, so publishing has no visible effect until you attach one.' : '',
          gates && gates.signed === false ? 'Measurement definitions are not signed off yet, so they will still get a calm "not available yet" message until that flag is true. Publishing now is safe but invisible.' : '',
        ].filter(Boolean).join(' ');
      } else {
        message = `Unpublishing hides ${a.name}'s dashboard immediately. ${whoCount} will still be able to sign in and will see a plain "your dashboard isn't live yet" message instead of numbers. Nothing is deleted.`;
      }
      const yes = await ui.confirmDialog({
        title: next ? 'Publish this dashboard' : 'Unpublish this dashboard',
        message, confirmLabel: next ? 'Publish' : 'Unpublish', danger: !next,
      });
      if (!yes || destroyed) return;
      try {
        await rpc('fn_admin_advertiser_config_set', { p_advertiser_id: id, p_patch: { published: next } });
        ui.toast(next ? 'Dashboard published.' : 'Dashboard unpublished.', 'success');
        refresh();
      } catch (err) { ui.toast(friendly(err), 'error'); }
    }

    // =========================================================================
    // 4. PREVIEW AS  — the most valuable control on the page
    // =========================================================================
    let previewDays = 30;
    let previewFrom = isoDay(previewDays - 1);
    let previewTo = isoDay(0);
    let lastPayload = null;

    function previewControls() {
      const presetSel = ui.select({
        options: [
          { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' },
          { value: '90', label: 'Last 90 days' }, { value: 'custom', label: 'Custom range' },
        ],
        value: previewDays === 0 ? 'custom' : String(previewDays),
        onChange: (e) => {
          if (e.target.value === 'custom') { previewDays = 0; renderPreviewShell(); return; }
          previewDays = Number(e.target.value);
          previewFrom = isoDay(previewDays - 1); previewTo = isoDay(0);
          loadPreview();
        },
      });
      const fromIn = ui.input({ type: 'date', value: previewFrom, onChange: (e) => { previewFrom = e.target.value; } });
      const toIn = ui.input({ type: 'date', value: previewTo, onChange: (e) => { previewTo = e.target.value; } });
      return ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', margin: '8px 0' } }, [
        ui.field('Range', presetSel),
        previewDays === 0 ? ui.field('From', fromIn) : null,
        previewDays === 0 ? ui.field('To', toIn) : null,
        ui.button({ label: 'Preview', variant: 'primary', onClick: () => loadPreview() }),
        ui.button({ label: 'Download preview CSV', variant: 'ghost', onClick: () => exportCsv() }),
      ]);
    }

    const previewBody = ui.el('div', { attrs: { 'aria-live': 'polite' } });
    function renderPreviewShell() {
      ui.render(previewHost, [
        banner('PREVIEW — this is what the advertiser sees, rendered read-only from fn_admin_advertiser_preview. The publish and measurement gates are bypassed for you and only for you; nothing here is visible to the brand until the dashboard is published and the measurement definitions are signed off.', 'accent'),
        previewControls(),
        previewBody,
      ]);
    }

    async function loadPreview() {
      if (destroyed) return;
      renderPreviewShell();
      ui.render(previewBody, ui.spinner('Rendering their dashboard…'));
      let payload;
      try {
        payload = await rpc('fn_admin_advertiser_preview', { p_advertiser_id: id, p_from: previewFrom || null, p_to: previewTo || null });
      } catch (err) {
        if (destroyed) return;
        ui.toast(friendly(err), 'error');
        ui.render(previewBody, ui.errorState(friendly(err), () => loadPreview()));
        return;
      }
      if (destroyed) return;
      lastPayload = payload;
      ui.render(previewBody, renderDashboard(payload));
    }

    function exportCsv() {
      if (!lastPayload) { ui.toast('Run a preview first.', 'warn'); return; }
      try {
        download(
          `covered-preview_${String(a.name || 'advertiser').replace(/[^A-Za-z0-9-]+/g, '-')}_${previewFrom}_${previewTo}.csv`,
          payloadToCsv(lastPayload), 'text/csv;charset=utf-8',
        );
        ui.toast('Downloaded exactly what is on screen.', 'success');
      } catch (err) { ui.toast(friendly(err), 'error'); }
    }

    // ---- paint
    const statusTone = a.status === 'active' ? 'ok' : a.status === 'archived' ? 'muted' : 'warn';
    ui.render(card.body, [
      ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } }, [
        ui.button({ label: '← All advertisers', variant: 'ghost', onClick: () => ctx.router.navigate('advertisers') }),
        ui.button({
          label: cfg.published ? 'Unpublish dashboard' : 'Publish dashboard',
          variant: cfg.published ? 'danger' : 'primary',
          onClick: () => setPublished(!cfg.published),
        }),
      ]),
      ui.el('h2', { text: a.name || '—', style: { margin: '0 0 4px' } }),
      ui.el('div', {}, [
        ui.badge(cfg.published ? 'Dashboard published' : 'Dashboard off', cfg.published ? 'ok' : 'muted'), ' ',
        ui.badge(`Account ${a.status || 'unknown'}`, statusTone), ' ',
        ui.badge(`${num(a.user_count)} login${Number(a.user_count) === 1 ? '' : 's'}`, 'muted'),
      ]),
      ...gateBanners(g),
      a.status !== 'active' ? note(`This advertiser's account is "${a.status}". Publishing a dashboard for a paused or archived advertiser is allowed, but check it is what you mean.`, 'warn') : null,

      h3('1. Logins'),
      usersHost,

      h3('2. Panels'),
      note('A panel that is off returns null from the RPC, not zeros: the advertiser sees that the panel is not part of their report, not that the number is nought.'),
      ui.el('div', { class: 'grid grid-2' }, panelBoxes),
      ui.el('div', { style: { marginTop: '8px' } }, savePanels),

      h3('3. Visible window and note'),
      ui.field('Visible from (date floor)', floorIn, { hint: 'Nothing before this date is returned, clamped server side. Set it to the first day of their campaign so they cannot see the period before it started. Leave empty for no floor.' }),
      ui.field('Note to the advertiser', notesIn, { hint: 'Plain text, shown at the top of their dashboard. Rendered as text, never as markup.' }),
      saveWindow,

      h3('4. Preview as this advertiser'),
      previewHost,

      h3('5. Publish'),
      note(cfg.published
        ? 'The dashboard is published. Unpublishing takes effect on their next request — it is the master switch, not a cache.'
        : 'The dashboard is off. This is the default, and nothing a brand can do changes it: published defaults to false and only an admin can set it.'),
      ui.el('div', { style: { marginTop: '8px' } }, ui.button({
        label: cfg.published ? 'Unpublish dashboard' : 'Publish dashboard',
        variant: cfg.published ? 'danger' : 'primary',
        onClick: () => setPublished(!cfg.published),
      })),
    ]);

    loadUsers();
    loadPreview();
  }

  // ===========================================================================
  // THE PAYLOAD RENDERER
  // ---------------------------------------------------------------------------
  // Deliberately the same shape the portal renders, so what Teo sees in the
  // preview is genuinely what the advertiser sees:
  //   { ok, advertiser:{id,name}, from, to, published, preview?, notes, panels,
  //     ads:{…}|null, clicks:{…}|null, qr:{…}|null, trend:[…]|null,
  //     caveats:[…], measurement_version, generated_at }
  // A number may come back as null with a sibling <key>_suppressed = true
  // (n < 5) or with a reason such as 'awaiting_dispense_v2'. Both are rendered
  // as an em dash plus one line saying why. Nothing is ever recomputed here.
  // ===========================================================================
  function reasonText(reason) {
    const r = String(reason || '');
    if (r === 'awaiting_dispense_v2') return 'Not available yet: attention is only measured once dispense-v2 is live. The current figure would be scan-to-dispense time, which includes waiting for an SMS, so it is withheld rather than mislabelled.';
    if (r === 'suppressed' || r === 'small_numbers') return 'Withheld because fewer than five were recorded in this range: at this scale a single count in a named place on a named day comes close to identifying a person.';
    // These are the codes 18 actually sends. 'ads_panel_unavailable' is the one
    // fn_advertiser_ad_summary returns when ad_views is absent; without it here
    // the raw code was shown to Teo as if it were an explanation.
    if (r === 'ads_panel_unavailable' || r === 'ads_unavailable') return 'The ad-view ledger (migration 14 / dispense-v2) is not installed in this database yet, so there is nothing to report. The panel returns "unavailable" rather than zeros.';
    if (r === 'not_published') return 'This dashboard is not published, so the advertiser sees a plain "not live yet" message.';
    if (r === 'advertiser_archived') return 'This brand is ARCHIVED in the advertiser register (17's advertisers.status), so the portal is shut whatever the published switch says. 17's duplicate-merge also archives the losing row. Set the status back to active to reopen it.';
    if (r === 'measurement_not_signed_off') return 'MEASUREMENT-DEFINITIONS.md is not signed off, so no number is released to a non-admin caller.';
    if (r === 'no_advertiser_link') return 'The signed-in account is not linked to an advertiser.';
    if (r === 'panel_off') return 'This panel is not part of this report.';
    // Every em dash gets a sentence. Silence beside a dash is how a withheld
    // figure turns into a zero in somebody's deck.
    return r || 'No figure was returned for this range.';
  }
  // One metric row: value, or an em dash and the reason it is missing.
  function metricRow(label, obj, key, fmt) {
    const o = obj || {};
    const v = o[key];
    const suppressed = o[`${key}_suppressed`] === true;
    const reason = o[`${key}_reason`] || (suppressed ? 'suppressed' : (v == null ? o.reason : null));
    return {
      k: label,
      v: v == null ? '—' : fmt(v),
      why: v == null ? reasonText(reason) : '',
    };
  }
  function metricTable(rowsIn) {
    const rows = rowsIn.filter(Boolean);
    return ui.el('div', {}, [
      ui.table([
        { key: 'k', label: 'Measure' },
        { key: 'v', label: '', align: 'right', render: (v) => ui.el('span', { text: v, style: { fontVariantNumeric: 'tabular-nums' } }) },
      ], rows, { empty: 'Nothing to show.' }),
      ...rows.filter((r) => r.why).map((r) => note(`${r.k}: ${r.why}`)),
    ]);
  }

  function renderDashboard(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (p.ok === false) {
      const msg = {
        not_published: 'Not published. The advertiser sees a plain "your dashboard isn\'t live yet" message — no partial data, no error code.',
        advertiser_archived: 'This brand is archived in the advertiser register, so the portal is shut regardless of the published switch — the advertiser sees the same "not live yet" message. 17's duplicate-merge archives the losing row, so check this first if a brand reports losing access.',
        measurement_not_signed_off: 'Measurement definitions are not signed off, so the advertiser sees a calm "not available yet" message. An admin preview is the only way to see numbers until that flag is true.',
        no_advertiser: 'This account is not linked to any advertiser, so there is nothing to show.',
        not_authorised: 'The signed-in account has no advertiser scope.',
      }[String(p.reason || '')] || `The dashboard returned: ${String(p.reason || 'no reason given')}.`;
      return ui.el('div', {}, [ui.emptyState(msg), p.reason ? note(`Server reason code: ${p.reason}`) : null]);
    }

    const adv = p.advertiser && typeof p.advertiser === 'object' ? p.advertiser : {};
    const panels = p.panels && typeof p.panels === 'object' ? p.panels : {};
    const out = [];

    out.push(ui.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', margin: '4px 0 8px' } }, [
      ui.el('strong', { text: adv.name || '—' }),
      ui.badge(`${p.from || '?'} → ${p.to || '?'}`, 'muted'),
      p.published ? ui.badge('Published', 'ok') : ui.badge('Not published', 'muted'),
      p.preview ? ui.badge('Preview', 'accent') : null,
    ]));
    if (p.notes) out.push(ui.card({ tone: 'accent', body: ui.el('p', { text: String(p.notes), style: { margin: 0, whiteSpace: 'pre-wrap' } }) }));

    // --- Ad views
    if (p.ads) {
      out.push(ui.el('h4', { text: 'Ad views', style: { margin: '16px 0 4px' } }));
      out.push(metricTable([
        metricRow('Views started', p.ads, 'views_started', num),
        metricRow('Views completed', p.ads, 'views_completed', num),
        metricRow('Completion rate', p.ads, 'completion_rate', pct),
        metricRow('Median credited seconds', p.ads, 'median_credited_s', secs),
        metricRow('Total credited seconds', p.ads, 'total_credited_s', secs),
      ]));
      if (p.ads.reason) out.push(note(reasonText(p.ads.reason)));
      (Array.isArray(p.ads.caveats) ? p.ads.caveats : []).forEach((c) => out.push(note(String(c))));
    } else if (panels.ads) {
      out.push(ui.el('h4', { text: 'Ad views', style: { margin: '16px 0 4px' } }));
      out.push(note('The panel is on but the server returned nothing for it — usually because the ad-view ledger (migration 14) is not installed yet.', 'warn'));
    }

    // --- Clicks
    if (p.clicks) {
      out.push(ui.el('h4', { text: 'Clicks', style: { margin: '16px 0 4px' } }));
      out.push(metricTable([
        metricRow('Clicks', p.clicks, 'clicks', num),
        metricRow('Click rate', p.clicks, 'click_rate', pct),
      ]));
      (Array.isArray(p.clicks.caveats) ? p.clicks.caveats : []).forEach((c) => out.push(note(String(c))));
    }

    // --- QR scans
    if (p.qr) {
      const ex = p.qr.qr_excluded && typeof p.qr.qr_excluded === 'object' ? p.qr.qr_excluded : {};
      out.push(ui.el('h4', { text: 'QR scans', style: { margin: '16px 0 4px' } }));
      out.push(metricTable([
        metricRow('Qualified scans', p.qr, 'qr_qualified_scans', num),
        metricRow('Gross scans', p.qr, 'qr_scans_gross', num),
        metricRow('Codes in the field', p.qr, 'codes', num),
        metricRow('Excluded — bots and link previews', ex, 'bots', num),
        metricRow('Excluded — repeat requests', ex, 'duplicates', num),
        metricRow('Shown separately — outside the UK', ex, 'non_uk', num),
        metricRow('Excluded — desktop on a printed code', ex, 'desktop_on_physical', num),
      ]));
      (Array.isArray(p.qr.caveats) ? p.qr.caveats : []).forEach((c) => out.push(note(String(c))));
    }

    // --- Machines
    if (p.machines) {
      const rows = asRows(p.machines, 'machines');
      out.push(ui.el('h4', { text: 'Where it ran', style: { margin: '16px 0 4px' } }));
      // REVIEW FIX: the RPC returns { machine, views_started,
      // views_started_suppressed } — not machine_id / location / surface. The
      // old columns rendered a dash in every cell and invented a "Surface"
      // column the server never sends.
      out.push(rows.length
        ? ui.table([
          { key: 'machine', label: 'Machine', render: (v) => ui.el('span', { text: v || '—' }) },
          { key: 'views_started', label: 'Views started', align: 'right', render: (_v, r) => ui.el('span', { text: metricRow('', r, 'views_started', num).v, style: { fontVariantNumeric: 'tabular-nums' } }) },
        ], rows, { empty: 'Nothing recorded.' })
        : note('Nothing recorded for this range.'));
      out.push(note('A venue with fewer than five views is not listed at all: naming the place and dashing the count would still say "at least one view happened here". Panels → Machines carried is off by default for the same reason.'));
    }

    // --- Daily trend
    if (p.trend) {
      const rows = asRows(p.trend, 'trend');
      out.push(ui.el('h4', { text: 'Daily trend', style: { margin: '16px 0 4px' } }));
      if (!rows.length) {
        out.push(note('No days in this range carry a figure.'));
      } else {
        // Whatever numeric series the server sent, in the order it sent them.
        const dayKey = ['day', 'date', 'd'].find((k) => rows.some((r) => r[k] != null)) || 'day';
        const seriesKeys = [];
        rows.forEach((r) => Object.keys(r || {}).forEach((k) => {
          if (k === dayKey || k.endsWith('_suppressed') || k.endsWith('_reason') || k === 'reason') return;
          if (!seriesKeys.includes(k)) seriesKeys.push(k);
        }));
        const cols = [{ key: dayKey, label: 'Day', render: (v) => ui.el('span', { text: v ? ui.fmtDate(v, { mode: 'date' }) : '—' }) }];
        seriesKeys.forEach((k) => cols.push({
          key: k, label: trendLabel(k), align: 'right',
          render: (v, r) => ui.el('span', {
            text: v == null ? '—' : (/(rate)$/.test(k) ? pct(v) : (/_s$/.test(k) ? secs(v) : num(v))),
            title: v == null ? reasonText(r[`${k}_suppressed`] === true ? 'suppressed' : (r[`${k}_reason`] || r.reason)) : '',
            style: { fontVariantNumeric: 'tabular-nums' },
          }),
        }));
        out.push(ui.table(cols, rows, { empty: 'No days.' }));
        // One chart, on the first complete non-rate series. A chart is drawn
        // ONLY when every day in that series carries a figure: a bar at zero
        // for a withheld day is how a dash becomes a nought in somebody's deck.
        const countKeys = seriesKeys.filter((k) => !/rate$/.test(k));
        const chartKey = countKeys.find((k) => rows.every((r) => r[k] != null));
        if (chartKey) {
          const step = Math.max(1, Math.ceil(rows.length / 6));
          const series = rows.map((r, i) => ({
            label: i % step === 0 ? String(r[dayKey] || '').slice(5) : '',
            value: Number(r[chartKey]),
          }));
          out.push(ui.el('div', { class: 'card-subtitle', text: `${trendLabel(chartKey)} per day` }));
          out.push(ui.bars(series, { ariaLabel: `${trendLabel(chartKey)} per day`, height: 140 }));
        } else if (countKeys.length) {
          out.push(note('No chart is drawn: at least one day in this range is withheld, and a bar at zero would read as a real nought. The table above is the whole truth.'));
        }
      }
    }

    // --- Caveats, straight from the payload. Never typed into this file.
    const caveats = Array.isArray(p.caveats) ? p.caveats : [];
    out.push(ui.el('h4', { text: 'What these numbers mean', style: { margin: '20px 0 4px' } }));
    out.push(caveats.length
      ? ui.el('ul', {}, caveats.map((c) => ui.el('li', { text: String(c) })))
      : note('The payload carried no caveats. That is itself a fault: the RPC is supposed to assemble them from MEASUREMENT-DEFINITIONS.md §6, and the portal renders only what it is given.', 'warn'));

    out.push(ui.el('p', {
      class: 'field-hint',
      text: [
        p.measurement_version ? `Measurement definitions ${p.measurement_version}` : 'Measurement version not stamped by the server',
        p.generated_at ? `generated ${ui.fmtDate(p.generated_at)}` : null,
      ].filter(Boolean).join(' · '),
    }));
    out.push(note('Definitions live in covered-qr-platform/MEASUREMENT-DEFINITIONS.md. The portal footer links to the served copy; this console shows the version stamp only.'));

    return ui.el('div', {}, out);
  }

  function trendLabel(key) {
    return ({
      views_started: 'Views started',
      views_completed: 'Views completed',
      completion_rate: 'Completion rate',
      clicks: 'Clicks',
      click_rate: 'Click rate',
      median_credited_s: 'Median credited s',
      total_credited_s: 'Credited s',
      qr_qualified_scans: 'Qualified scans',
      qr_scans_gross: 'Gross scans',
    })[key] || String(key).replace(/_/g, ' ');
  }

  // CSV of exactly what the preview shows. Built from the payload, suppressed
  // cells exported as empty with the reason in its own column — a dash in a
  // spreadsheet becomes a zero in somebody's deck otherwise.
  function payloadToCsv(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const q = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['section', 'measure', 'value', 'withheld_because'].join(',')];
    const push = (section, label, obj, key) => {
      const o = obj || {};
      const v = o[key];
      const why = v == null
        ? reasonText(o[`${key}_reason`] || (o[`${key}_suppressed`] === true ? 'suppressed' : o.reason))
        : '';
      lines.push([section, label, v == null ? '' : v, why].map(q).join(','));
    };
    lines.push(['meta', 'advertiser', (p.advertiser || {}).name || '', ''].map(q).join(','));
    lines.push(['meta', 'from', p.from || '', ''].map(q).join(','));
    lines.push(['meta', 'to', p.to || '', ''].map(q).join(','));
    lines.push(['meta', 'measurement_version', p.measurement_version || '', ''].map(q).join(','));
    lines.push(['meta', 'generated_at', p.generated_at || '', ''].map(q).join(','));
    if (p.ads) {
      ['views_started', 'views_completed', 'completion_rate', 'median_credited_s', 'total_credited_s']
        .forEach((k) => push('ads', trendLabel(k), p.ads, k));
    }
    if (p.clicks) ['clicks', 'click_rate'].forEach((k) => push('clicks', trendLabel(k), p.clicks, k));
    if (p.qr) {
      ['qr_qualified_scans', 'qr_scans_gross', 'codes'].forEach((k) => push('qr', trendLabel(k), p.qr, k));
      const ex = p.qr.qr_excluded || {};
      ['bots', 'duplicates', 'non_uk', 'desktop_on_physical'].forEach((k) => push('qr_excluded', k, ex, k));
    }
    if (p.machines) {
      asRows(p.machines, 'machines').forEach((r) => push('machines', String(r.machine || ''), r, 'views_started'));
    }
    if (p.trend) {
      const rows = asRows(p.trend, 'trend');
      const dayKey = ['day', 'date', 'd'].find((k) => rows.some((r) => r[k] != null)) || 'day';
      rows.forEach((r) => Object.keys(r || {}).forEach((k) => {
        if (k === dayKey || k.endsWith('_suppressed') || k.endsWith('_reason') || k === 'reason') return;
        push('trend ' + (r[dayKey] || ''), trendLabel(k), r, k);
      }));
    }
    (Array.isArray(p.caveats) ? p.caveats : []).forEach((c) => lines.push(['caveat', '', c, ''].map(q).join(',')));
    return lines.join('\r\n') + '\r\n';
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
