// =============================================================================
// COVERED Admin Console — Status view
// -----------------------------------------------------------------------------
// Panels (top to bottom):
//
//  0) PILOT — the go-live switch. Reads settings via fn_admin_get_settings()
//     (settings.pilot_live) and flips it with fn_admin_set_pilot_live(p_live).
//     While OFF, scheduled reports (the weekly evidence pack) stay dormant;
//     switching ON marks the pilot as launched. Both directions go through a
//     confirm dialog and re-render the card from the server's response.
//
//  1) SYSTEM HEALTH — health tiles derived from fn_admin_status(). We reuse the
//     cached payload the router put on ctx.adminStatus (it was fetched by the
//     auth gate), so on first mount there is no extra round-trip. The Refresh
//     button re-calls fn_admin_status() live.
//
//  2) INTEGRATIONS HEALTH — Twilio / n8n / Supabase, fetched via the WF6
//     "secret proxy" (ctx.api.callAdminApi). WF6 may be only partially wired up
//     at first (e.g. the n8n key not pasted yet) so every service renders an
//     "unavailable" state gracefully instead of crashing. Twilio shows a
//     trial-vs-live pill and a balance if the proxy returns one.
//
// A single Refresh button reloads ALL panels and stamps the "last checked"
// time. All DB/API text is rendered via ui.el text props / textContent — no
// innerHTML with data, no XSS surface.
// =============================================================================

export default async function mount(root, ctx) {
  const { ui, api, supabase, toast } = ctx;
  const tz = ctx.adminStatus?.schedule_tz || 'Europe/London';

  // Are we still attached? The router calls the returned cleanup before mounting
  // the next view; we flip this so any in-flight refresh can bail out of writing
  // to a detached DOM.
  let live = true;

  // ---- Layout scaffold -----------------------------------------------------
  // A small header row (last-checked stamp + Refresh) and panel hosts we
  // re-render into.
  const checkedStamp = ui.el('span', {
    class: 'muted status-checked',
    text: '',
    attrs: { 'aria-live': 'polite' },
  });

  const refreshBtn = ui.button({
    label: 'Refresh',
    variant: 'ghost',
    size: 'sm',
    onClick: () => refreshAll(),
  });

  const headerRow = ui.el('div', {
    class: 'status-toolbar',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      gap: '12px', marginBottom: '16px', flexWrap: 'wrap',
    },
  }, [checkedStamp, refreshBtn]);

  const pilotHost = ui.el('div', { class: 'status-pilot', style: { marginBottom: '20px' } });
  const systemHost = ui.el('div', { class: 'status-system' });
  const integrationsHost = ui.el('div', { class: 'status-integrations', style: { marginTop: '20px' } });
  const complianceHost = ui.el('div', { class: 'status-compliance', style: { marginTop: '20px' } });

  // ---------------------------------------------------------------------------
  // Website & content editor shortcuts. The marketing site is hosted on
  // Netlify; content edits happen in the Decap CMS at /cms on that site.
  // If the Netlify site is ever renamed, update WEBSITE_URL here.
  // ---------------------------------------------------------------------------
  const WEBSITE_URL = 'https://coveredaccess.netlify.app';

  function linkBtn(label, href, variant) {
    return ui.el('a', {
      class: `btn btn--${variant}`,
      text: label,
      attrs: { href, target: '_blank', rel: 'noopener' },
      style: { textDecoration: 'none' },
    });
  }

  const websiteCard = ui.card({
    title: 'Website & content editor',
    subtitle: 'Edit the public site with live previews — no code needed.',
    body: ui.el('div', {
      style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
    }, [
      linkBtn('✏️ Open website editor (log in)', WEBSITE_URL + '/cms/', 'primary'),
      linkBtn('🌐 View live site', WEBSITE_URL + '/', 'ghost'),
    ]),
  });
  const websiteHost = ui.el('div', { class: 'status-website', style: { marginBottom: '20px' } }, [websiteCard]);

  // Pilot card goes FIRST, above System health (and the website shortcuts).
  ui.appendChildren(root, [headerRow, pilotHost, websiteHost, systemHost, complianceHost, integrationsHost]);

  // ---------------------------------------------------------------------------
  // Panel 0: Pilot go-live switch.
  //
  // fn_admin_get_settings() returns jsonb settings; we read settings.pilot_live
  // (boolean). fn_admin_set_pilot_live({ p_live }) flips it server-side (admin
  // guarded). The card re-renders from a fresh fn_admin_get_settings() read
  // after every toggle so the UI always reflects the server's truth.
  // ---------------------------------------------------------------------------

  function renderPilot(settings) {
    const isLive = settings?.pilot_live === true;

    const badgeRow = ui.el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    }, [
      ui.badge(isLive ? 'LIVE' : 'Not launched', isLive ? 'ok' : 'muted'),
    ]);

    const explainer = ui.el('p', {
      class: 'muted',
      style: { margin: '10px 0 14px' },
      text: isLive
        ? 'The pilot is live. Scheduled reports — including the weekly pilot evidence pack — are running. You can switch it off again any time.'
        : 'While the pilot is off, scheduled reports (the weekly evidence pack) stay dormant. Go live when the pilot launches to start them.',
    });

    const toggleBtn = ui.button({
      label: isLive ? 'Switch off' : 'Go live',
      variant: isLive ? 'danger' : 'primary',
      onClick: () => setPilotLive(!isLive, toggleBtn),
    });

    const c = ui.card({
      title: 'Pilot',
      subtitle: 'Go-live switch for the pilot and its scheduled reporting.',
      tone: isLive ? 'ok' : '',
      body: ui.el('div', { class: 'status-pilot-body' }, [badgeRow, explainer, toggleBtn]),
    });
    ui.render(pilotHost, c);
  }

  function renderPilotError(msg) {
    const c = ui.card({
      title: 'Pilot',
      tone: 'danger',
      body: ui.errorState(msg, () => refreshPilot()),
    });
    ui.render(pilotHost, c);
  }

  async function refreshPilot() {
    ui.render(pilotHost, ui.card({ title: 'Pilot', body: ui.spinner('Loading pilot state…') }));
    try {
      const { data, error } = await supabase.rpc('fn_admin_get_settings');
      if (!live) return;
      if (error) throw error;
      renderPilot(data || {});
    } catch (err) {
      if (!live) return;
      const msg = friendlyRpcError(err);
      toast(msg, 'error');
      renderPilotError(msg);
    }
  }

  // Confirm, flip via fn_admin_set_pilot_live, toast, and re-render the card.
  async function setPilotLive(next, btn) {
    const confirmed = await ui.confirmDialog(next
      ? {
          title: 'Go live?',
          message: 'Going live enables the weekly pilot evidence pack and marks the pilot as launched. You can switch it off again any time.',
          confirmLabel: 'Go live',
        }
      : {
          title: 'Switch the pilot off?',
          message: 'Switching off pauses scheduled reports, including the weekly pilot evidence pack. No data is deleted — you can go live again any time.',
          confirmLabel: 'Switch off',
          danger: true,
        });
    if (!confirmed || !live) return;

    if (btn) btn.disabled = true;
    try {
      const { error } = await supabase.rpc('fn_admin_set_pilot_live', { p_live: next });
      if (!live) return;
      if (error) throw error;
      toast(next
        ? 'Pilot is LIVE — the weekly evidence pack is now enabled.'
        : 'Pilot switched off — scheduled reports are dormant.', 'success');
      await refreshPilot();
    } catch (err) {
      if (!live) return;
      toast(friendlyRpcError(err), 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Panel 1: System health tiles from fn_admin_status().
  // ---------------------------------------------------------------------------

  function renderSystem(status) {
    const machinesActive = status?.machines_active ?? null;
    const machinesTotal = status?.machines_total ?? null;
    const machineTone = machinesTotal != null && machinesActive != null
      ? (machinesActive === 0 ? 'danger' : (machinesActive < machinesTotal ? 'warn' : 'ok'))
      : '';

    const lastEvent = status?.last_event_ts ?? null;

    const tiles = ui.el('div', { class: 'grid grid-auto' }, [
      ui.stat({
        label: 'Machines active',
        value: machinesActive == null ? '—'
          : `${machinesActive} / ${machinesTotal ?? '?'}`,
        sub: machinesActive != null && machinesTotal != null
          ? `${machinesTotal - machinesActive} offline`
          : undefined,
        tone: machineTone,
      }),
      ui.stat({
        label: 'Sessions (total)',
        value: fmtNum(status?.sessions_total),
      }),
      ui.stat({
        label: 'Dispenses today',
        value: fmtNum(status?.dispenses_today),
        tone: (status?.dispenses_today ?? 0) > 0 ? 'accent' : '',
      }),
      ui.stat({
        label: 'Last event',
        value: lastEvent ? ui.relativeTime(lastEvent) : '—',
        sub: lastEvent ? ui.fmtDate(lastEvent, { mode: 'datetime', tz }) : 'no events yet',
      }),
      ui.stat({
        label: 'Ads active',
        value: fmtNum(status?.ads_active),
      }),
      ui.stat({
        label: 'Schedules active',
        value: fmtNum(status?.schedules_active),
        sub: `dayparts in ${tz}`,
      }),
    ]);

    const c = ui.card({
      title: 'System health',
      subtitle: 'Live figures from the vending fleet.',
      body: tiles,
    });
    ui.render(systemHost, c);
  }

  function renderSystemError(msg) {
    const c = ui.card({
      title: 'System health',
      tone: 'danger',
      body: ui.errorState(msg, () => refreshSystem()),
    });
    ui.render(systemHost, c);
  }

  // Re-call fn_admin_status() live. Returns the fresh payload (or null on error).
  async function refreshSystem() {
    ui.render(systemHost, ui.card({ title: 'System health', body: ui.spinner('Loading system health…') }));
    try {
      const { data, error } = await supabase.rpc('fn_admin_status');
      if (!live) return null;
      if (error) throw error;
      renderSystem(data || {});
      return data || {};
    } catch (err) {
      if (!live) return null;
      const msg = friendlyRpcError(err);
      toast(msg, 'error');
      renderSystemError(msg);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Panel 2: Integrations health via WF6 (Twilio / n8n / Supabase).
  // ---------------------------------------------------------------------------

  // Build a small service card. `service` is the raw object from WF6 (may be
  // undefined/partial). `render` maps it to labelled key/value rows.
  function serviceCard(title, service, render) {
    // WF6 marks a service unavailable either by omitting it or with an explicit
    // { ok:false } / { configured:false } / { available:false } flag.
    const available = service != null && service.ok !== false &&
      service.available !== false && service.configured !== false;

    if (!available) {
      const reason = (service && (service.reason || service.error)) || 'Not configured yet.';
      return ui.card({
        title,
        tone: 'warn',
        body: ui.el('div', { class: 'status-svc status-svc--na' }, [
          ui.badge('Unavailable', 'muted'),
          ui.el('p', { class: 'muted', style: { margin: '10px 0 0' }, text: String(reason) }),
        ]),
      });
    }

    const rows = render(service) || [];
    return ui.card({
      title,
      tone: 'ok',
      body: ui.el('div', { class: 'status-svc' }, [
        ui.badge('OK', 'ok'),
        kvList(rows),
      ]),
    });
  }

  // Twilio: trial-vs-live pill + optional balance + sender/number if present.
  function twilioRows(t) {
    // WF6 may signal trial via a boolean or a status string; be liberal.
    const isTrial = t.trial === true ||
      /trial/i.test(String(t.type || t.account_type || t.status || ''));
    const rows = [
      ['Account', trialBadge(isTrial)],
    ];
    if (t.status) rows.push(['Status', String(t.status)]);
    if (t.friendly_name || t.account_name) rows.push(['Name', String(t.friendly_name || t.account_name)]);
    // Balance may arrive as {balance, currency} or a preformatted string.
    const bal = fmtBalance(t);
    if (bal != null) rows.push(['Balance', bal]);
    if (t.phone_number || t.from) rows.push(['Sender', String(t.phone_number || t.from)]);
    return rows;
  }

  function n8nRows(n) {
    const rows = [];
    if (n.status) rows.push(['Status', String(n.status)]);
    if (n.version) rows.push(['Version', String(n.version)]);
    if (n.active_workflows != null) rows.push(['Active workflows', String(n.active_workflows)]);
    if (n.instance || n.url) rows.push(['Instance', String(n.instance || n.url)]);
    if (rows.length === 0) rows.push(['Status', 'Reachable']);
    return rows;
  }

  function supabaseRows(s) {
    const rows = [];
    if (s.status) rows.push(['Status', String(s.status)]);
    if (s.db || s.database) rows.push(['Database', String(s.db || s.database)]);
    if (s.latency_ms != null) rows.push(['Latency', `${s.latency_ms} ms`]);
    if (rows.length === 0) rows.push(['Status', 'Reachable']);
    return rows;
  }

  function renderIntegrations(body) {
    // body is the WF6 response. It may be { ok:false, reason } wholesale, or
    // { ok:true, twilio, n8n, supabase, checkedAt } with any service partial.
    let cards;
    if (!body || body.ok === false) {
      const reason = (body && body.reason) || 'The Admin API is not configured yet.';
      cards = ui.el('div', { class: 'grid grid-3' }, [
        naServiceCard('Twilio', reason),
        naServiceCard('n8n', reason),
        naServiceCard('Supabase', reason),
      ]);
    } else {
      cards = ui.el('div', { class: 'grid grid-3' }, [
        serviceCard('Twilio', body.twilio, twilioRows),
        serviceCard('n8n', body.n8n, n8nRows),
        serviceCard('Supabase', body.supabase, supabaseRows),
      ]);
    }

    const checkedAt = body && body.checkedAt ? body.checkedAt : null;
    const c = ui.card({
      title: 'Integrations health',
      subtitle: 'Twilio, n8n and Supabase — checked server-side via WF6.',
      actions: checkedAt
        ? ui.badge(`Checked ${ui.relativeTime(checkedAt)}`, 'muted')
        : null,
      body: cards,
    });
    ui.render(integrationsHost, c);
  }

  function naServiceCard(title, reason) {
    return ui.card({
      title,
      tone: 'warn',
      className: 'card--nested',
      body: ui.el('div', { class: 'status-svc status-svc--na' }, [
        ui.badge('Unavailable', 'muted'),
        ui.el('p', { class: 'muted', style: { margin: '10px 0 0' }, text: String(reason) }),
      ]),
    });
  }

  function renderIntegrationsError(msg) {
    const c = ui.card({
      title: 'Integrations health',
      subtitle: 'Twilio, n8n and Supabase — checked server-side via WF6.',
      tone: 'warn',
      body: ui.el('div', {}, [
        // A hard failure of the proxy itself: show the error but keep it soft —
        // integrations being down must not block the admin from working.
        ui.errorState(msg, () => refreshIntegrations()),
      ]),
    });
    ui.render(integrationsHost, c);
  }

  async function refreshIntegrations() {
    ui.render(integrationsHost, ui.card({
      title: 'Integrations health',
      body: ui.spinner('Checking integrations…'),
    }));
    try {
      const body = await api.callAdminApi();
      if (!live) return;
      renderIntegrations(body);
    } catch (err) {
      if (!live) return;
      // callAdminApi throws on network/timeout/non-2xx. Surface a toast but keep
      // the panel usable with a retry — WF6 may just be waking up.
      const msg = err?.message || 'The Admin API is unavailable.';
      toast(msg, 'warn');
      renderIntegrationsError(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Panel 3: Compliance status from fn_admin_compliance_status().
  // ---------------------------------------------------------------------------

  // fn_admin_compliance_status() returns jsonb:
  //   { rls_enabled_all bool, tables_missing_rls text[], last_purge_ts timestamptz,
  //     users_with_raw_contact int, consented_users int }
  function renderCompliance(c) {
    const rlsOk = c?.rls_enabled_all === true;
    const missing = Array.isArray(c?.tables_missing_rls) ? c.tables_missing_rls : [];
    const lastPurge = c?.last_purge_ts ?? null;
    const rawContact = c?.users_with_raw_contact ?? null;
    const consented = c?.consented_users ?? null;

    // Stat tiles: RLS state, raw-contact backlog, consented users, last purge.
    const tiles = ui.el('div', { class: 'grid grid-auto' }, [
      ui.stat({
        label: 'RLS on vending tables',
        value: rlsOk ? 'Enabled' : 'Gaps',
        sub: rlsOk ? 'all 6 tables deny-all' : `${missing.length} table${missing.length === 1 ? '' : 's'} exposed`,
        tone: rlsOk ? 'ok' : 'danger',
      }),
      ui.stat({
        label: 'Users with raw contact',
        value: fmtNum(rawContact),
        sub: 'awaiting 30-day PII purge',
        tone: (rawContact ?? 0) > 0 ? 'warn' : 'ok',
      }),
      ui.stat({
        label: 'Marketing consented',
        value: fmtNum(consented),
        sub: 'opted in to future marketing',
        tone: (consented ?? 0) > 0 ? 'accent' : '',
      }),
      ui.stat({
        label: 'Last purge',
        value: lastPurge ? ui.relativeTime(lastPurge) : 'Never',
        sub: lastPurge ? ui.fmtDate(lastPurge, { mode: 'datetime', tz }) : 'WF7 has not run yet',
        tone: lastPurge ? '' : 'warn',
      }),
    ]);

    // If any tables are missing RLS, list them as danger badges (each name via
    // textContent inside ui.badge — no innerHTML).
    const missingBlock = missing.length
      ? ui.el('div', { class: 'compliance-missing', style: { marginTop: '14px' } }, [
          ui.el('p', {
            class: 'muted',
            style: { margin: '0 0 8px' },
            text: 'Tables WITHOUT row-level security (these expose data to authenticated clients — apply 06-quickwins.sql):',
          }),
          ui.el('div', {
            class: 'badge-row',
            style: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
          }, missing.map((t) => ui.badge(String(t), 'danger'))),
        ])
      : ui.el('p', {
          class: 'muted',
          style: { margin: '14px 0 0' },
          text: 'All vending tables enforce deny-all RLS. Service-role (n8n) bypasses RLS, so WF1–WF5 are unaffected.',
        });

    const cardEl = ui.card({
      title: 'Compliance',
      subtitle: 'RLS coverage, PII retention and marketing-consent posture.',
      tone: rlsOk && missing.length === 0 ? 'ok' : 'warn',
      body: ui.el('div', {}, [tiles, missingBlock]),
    });
    ui.render(complianceHost, cardEl);
  }

  function renderComplianceError(msg) {
    const cardEl = ui.card({
      title: 'Compliance',
      tone: 'danger',
      body: ui.errorState(msg, () => refreshCompliance()),
    });
    ui.render(complianceHost, cardEl);
  }

  async function refreshCompliance() {
    ui.render(complianceHost, ui.card({
      title: 'Compliance',
      body: ui.spinner('Checking compliance…'),
    }));
    try {
      const { data, error } = await supabase.rpc('fn_admin_compliance_status');
      if (!live) return;
      if (error) throw error;
      renderCompliance(data || {});
    } catch (err) {
      if (!live) return;
      const msg = friendlyRpcError(err);
      toast(msg, 'error');
      renderComplianceError(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // Orchestration.
  // ---------------------------------------------------------------------------

  function stampChecked() {
    checkedStamp.textContent = `Last checked ${ui.fmtDate(new Date(), { mode: 'time', tz })}`;
  }

  async function refreshAll() {
    if (!live) return;
    refreshBtn.disabled = true;
    try {
      await Promise.all([refreshPilot(), refreshSystem(), refreshCompliance(), refreshIntegrations()]);
      if (live) stampChecked();
    } finally {
      if (live) refreshBtn.disabled = false;
    }
  }

  // ---- First paint ---------------------------------------------------------
  // Reuse the cached fn_admin_status payload for an instant system panel; still
  // hit WF6 for integrations and the DB for pilot + compliance. Stamp the
  // initial check time.
  if (ctx.adminStatus) {
    renderSystem(ctx.adminStatus);
  } else {
    // No cached payload (gate may have returned null) — fetch it now.
    refreshSystem();
  }
  refreshPilot();
  refreshIntegrations();
  refreshCompliance();
  stampChecked();

  // ---- Cleanup -------------------------------------------------------------
  return () => { live = false; };

  // ===========================================================================
  // Local helpers (closures — no module-level state).
  // ===========================================================================

  function fmtNum(v) {
    if (v == null) return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString('en-GB') : '—';
  }

  // Turn WF6's balance shapes into a display string, or null if absent.
  function fmtBalance(t) {
    if (t == null) return null;
    if (typeof t.balance === 'string' && t.balance.trim()) return t.balance.trim();
    if (typeof t.balance === 'number') {
      const cur = t.currency || t.balance_currency || 'USD';
      return `${t.balance.toFixed(2)} ${cur}`;
    }
    if (t.balance && typeof t.balance === 'object' && t.balance.amount != null) {
      const amt = Number(t.balance.amount);
      const cur = t.balance.currency || 'USD';
      return Number.isFinite(amt) ? `${amt.toFixed(2)} ${cur}` : null;
    }
    return null;
  }

  // A trial/live pill for the Twilio account.
  function trialBadge(isTrial) {
    return ui.badge(isTrial ? 'Trial' : 'Live', isTrial ? 'warn' : 'ok');
  }

  // Render an array of [label, value] pairs as a definition list. `value` may be
  // a string (=> textContent, safe) or a node (e.g. a badge).
  function kvList(rows) {
    const dl = ui.el('dl', {
      class: 'status-kv',
      style: {
        display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
        margin: '12px 0 0', alignItems: 'baseline',
      },
    });
    for (const [label, value] of rows) {
      dl.appendChild(ui.el('dt', {
        class: 'muted', text: String(label),
        style: { fontSize: '13px' },
      }));
      const dd = ui.el('dd', { style: { margin: '0' } });
      // value is a node (badge) or a plain string set via textContent (safe).
      if (value && typeof value === 'object' && typeof value.nodeType === 'number') {
        dd.appendChild(value);
      } else {
        dd.textContent = value == null ? '—' : String(value);
      }
      dl.appendChild(dd);
    }
    return dl;
  }

  // Map a Postgres/RPC error to a friendly message; call out the not-admin case.
  function friendlyRpcError(err) {
    const code = err?.code;
    const msg = String(err?.message || '');
    if (code === '42501' || /not_admin|permission denied/i.test(msg)) {
      return 'You do not have admin access to read system status.';
    }
    return msg || 'Could not load system status.';
  }
}
