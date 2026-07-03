// js/views/data.js
// COVERED admin console — Data Explorer view.
//
// Two panes:
//   1) A "trace a session" search box: paste a session UUID -> calls
//      fn_admin_session_trace -> opens a timeline drawer (scan -> events ->
//      dispense) with exact/heuristic dispense flags.
//   2) A table of recent dispenses (fn_admin_recent_dispenses). Clicking a row
//      deep-links into the trace drawer for that session.
//
// PRIVACY: this view only ever displays a contact HASH / user_id. The backend
// contract guarantees fn_admin_recent_dispenses / fn_admin_session_trace never
// return a raw phone number; we defensively render user_id via shortId and
// never surface any field that looks like a phone.
//
// Deep-linking: ctx.router.navigate('data', { session }) sets #data?session=...
// which arrives back as ctx.params.session; we auto-open the trace on mount.

const RECENT_LIMIT = 50;

// Loose UUID check so we can give a friendly "that isn't a session id" message
// before spending an RPC round-trip on obviously bad input.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function mount(root, ctx) {
  const { ui, supabase, router, params } = ctx;

  // Track teardown work (the drawer modal, if open) so the router can clean up.
  let openDrawer = null; // { close } from ui.modal
  let disposed = false;

  // ---- Layout scaffold ---------------------------------------------------
  const page = ui.el('div', { class: 'data-view', style: { display: 'grid', gap: '16px' } });
  root.appendChild(page);

  // 1) Trace search card ---------------------------------------------------
  const traceInput = ui.input({
    type: 'text',
    placeholder: 'Paste a session id (UUID)…',
    autocomplete: 'off',
    attrs: { 'aria-label': 'Session id', spellcheck: 'false' },
  });

  const traceBtn = ui.button({
    label: 'Trace session',
    variant: 'primary',
    onClick: () => runTrace(traceInput.value),
  });

  // Enter-to-submit from the input.
  traceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runTrace(traceInput.value);
    }
  });

  const searchRow = ui.el(
    'div',
    { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' } },
    [
      ui.el('div', { style: { flex: '1 1 320px', minWidth: '240px' } }, [
        ui.field('Session id', traceInput, {
          hint: 'Trace one journey: scan → events → dispense. Contact is shown as a hash only.',
        }),
      ]),
      ui.el('div', {}, [traceBtn]),
    ]
  );

  const searchCard = ui.card({
    title: 'Trace a session',
    subtitle: 'Follow a single QR journey end to end',
    body: searchRow,
  });
  page.appendChild(searchCard);

  // 2) Recent dispenses card ----------------------------------------------
  const recentCard = ui.card({
    title: 'Recent dispenses',
    subtitle: `Last ${RECENT_LIMIT} dispenses · select a row to trace`,
  });
  page.appendChild(recentCard);

  const recentBody = recentCard.body;

  // ---- Recent dispenses loading -----------------------------------------
  async function loadRecent() {
    ui.render(recentBody, ui.spinner('Loading recent dispenses…'));
    try {
      const { data, error } = await supabase.rpc('fn_admin_recent_dispenses', {
        p_limit: RECENT_LIMIT,
      });
      if (error) throw error;
      if (disposed) return;
      renderRecent(Array.isArray(data) ? data : []);
    } catch (err) {
      if (disposed) return;
      const msg = err?.message || 'Could not load recent dispenses.';
      ui.toast(msg, 'error');
      ui.render(recentBody, ui.errorState(msg, loadRecent));
    }
  }

  function renderRecent(rows) {
    if (!rows.length) {
      ui.render(
        recentBody,
        ui.emptyState('No dispenses yet. Once machines start vending, they will appear here.')
      );
      return;
    }

    const columns = [
      {
        key: 'ts',
        label: 'When',
        render: (v) => ui.fmtDate(v, { mode: 'datetime', tz: ctx.adminStatus?.schedule_tz }),
      },
      { key: 'machine_id', label: 'Machine' },
      { key: 'location', label: 'Location', render: (v) => v || '—' },
      { key: 'ad_name', label: 'Ad', render: (v) => v || '—' },
      { key: 'campaign_id', label: 'Campaign', render: (v) => v || '—' },
      {
        // Privacy: contact hash / user_id only, shortened for readability.
        key: 'user_id',
        label: 'Contact (hash)',
        render: (v) => (v ? ui.badge(ui.shortId(v), 'muted') : '—'),
      },
      {
        key: 'session_id',
        label: 'Session',
        render: (v) => (v ? ui.badge(ui.shortId(v), 'accent') : '—'),
      },
    ];

    const tableEl = ui.table(columns, rows, {
      empty: 'No dispenses yet.',
      caption: 'Recent dispenses',
      onRowClick: (row) => {
        if (!row.session_id) {
          ui.toast('This dispense has no linked session to trace.', 'warn');
          return;
        }
        // Reflect the selection in the URL and open the drawer.
        router.navigate('data', { session: row.session_id });
        runTrace(row.session_id);
      },
    });

    ui.render(recentBody, tableEl);
  }

  // ---- Trace flow --------------------------------------------------------
  async function runTrace(rawId) {
    const id = (rawId || '').trim();
    if (!id) {
      ui.toast('Paste a session id first.', 'warn');
      traceInput.focus();
      return;
    }
    if (!UUID_RE.test(id)) {
      ui.toast('That does not look like a session id (expected a UUID).', 'warn');
      traceInput.focus();
      return;
    }

    // Keep the input in sync when the trace was triggered from a row click.
    traceInput.value = id;

    // Open the drawer immediately with a spinner so the click feels responsive.
    const bodyHost = ui.el('div', { style: { minHeight: '160px' } }, [
      ui.spinner('Tracing session…'),
    ]);
    showDrawer(id, bodyHost);

    try {
      const { data, error } = await supabase.rpc('fn_admin_session_trace', {
        p_session_id: id,
      });
      if (error) throw error;
      if (disposed) return;
      renderTrace(bodyHost, id, data || {});
    } catch (err) {
      if (disposed) return;
      const msg = err?.message || 'Could not trace that session.';
      ui.toast(msg, 'error');
      ui.render(bodyHost, ui.errorState(msg, () => runTrace(id)));
    }
  }

  function showDrawer(id, bodyHost) {
    // Only one drawer at a time.
    if (openDrawer) {
      try { openDrawer.close(); } catch { /* noop */ }
      openDrawer = null;
    }
    const handle = ui.modal({
      title: `Session ${ui.shortId(id)}`,
      size: 'lg',
      body: bodyHost,
      onClose: () => {
        openDrawer = null;
        // Drop the ?session= param so a refresh doesn't reopen the drawer.
        if (!disposed && ctx.params?.session) {
          router.navigate('data');
        }
      },
    });
    openDrawer = handle;
  }

  function renderTrace(bodyHost, id, trace) {
    if (!trace.found) {
      ui.render(
        bodyHost,
        ui.emptyState(`No session found for id ${ui.shortId(id)}. Double-check the id and try again.`)
      );
      return;
    }

    const s = trace.session || {};
    const events = Array.isArray(trace.events) ? trace.events : [];
    const dispenses = Array.isArray(trace.dispenses) ? trace.dispenses : [];
    const tz = ctx.adminStatus?.schedule_tz;
    const fmtTs = (v) => (v ? ui.fmtDate(v, { mode: 'datetime', tz }) : '—');

    const container = ui.el('div', { style: { display: 'grid', gap: '16px' } });

    // --- Summary strip ----------------------------------------------------
    const summary = ui.el('div', {
      style: {
        display: 'grid',
        gap: '10px',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
      },
    });
    summary.append(
      ui.stat({ label: 'Status', value: s.status || 'unknown' }),
      ui.stat({ label: 'Machine', value: s.machine_id || '—' }),
      ui.stat({ label: 'Campaign', value: s.campaign_id || '—' }),
      ui.stat({
        label: 'Dwell',
        value: fmtDwell(s.dwell_ms),
      }),
      ui.stat({
        label: 'Contact (hash)',
        value: s.user_id ? ui.shortId(s.user_id) : '—',
      })
    );
    container.appendChild(summary);

    // Key timestamps (scan / dispense / token expiry) as a small definition row.
    const meta = ui.el('div', {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        fontSize: '13px',
        opacity: '0.85',
      },
    });
    meta.append(
      metaPill(ui, 'Scan', fmtTs(s.scan_ts)),
      metaPill(ui, 'Dispense', fmtTs(s.dispense_ts)),
      metaPill(ui, 'Token expiry', fmtTs(s.token_exp)),
      metaPill(ui, 'Session id', ui.shortId(s.id || id))
    );
    container.appendChild(meta);

    // --- Timeline ---------------------------------------------------------
    container.appendChild(
      ui.el('h3', { text: 'Timeline', style: { margin: '4px 0 0', fontSize: '15px' } })
    );

    // Build a single ordered timeline: scan marker, each event, dispense
    // markers. We sort by timestamp so heuristic/late dispenses land correctly.
    const items = [];
    if (s.scan_ts) {
      items.push({ ts: s.scan_ts, kind: 'scan', label: 'QR scanned' });
    }
    for (const ev of events) {
      items.push({
        ts: ev.ts,
        kind: 'event',
        label: ev.type || 'event',
        payload: ev.payload,
      });
    }
    for (const d of dispenses) {
      items.push({
        ts: d.ts,
        kind: 'dispense',
        label: 'Dispensed',
        match: d.match,
        machine_id: d.machine_id,
        campaign_id: d.campaign_id,
      });
    }
    items.sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0));

    if (!items.length) {
      container.appendChild(
        ui.emptyState('This session has no recorded events yet.')
      );
    } else {
      container.appendChild(buildTimeline(ui, items, fmtTs));
    }

    // --- Dispense detail (exact / heuristic flags) ------------------------
    if (dispenses.length) {
      const dispColumns = [
        { key: 'ts', label: 'When', render: (v) => fmtTs(v) },
        { key: 'machine_id', label: 'Machine', render: (v) => v || '—' },
        { key: 'campaign_id', label: 'Campaign', render: (v) => v || '—' },
        {
          key: 'match',
          label: 'Match',
          render: (v) =>
            v === 'exact'
              ? ui.badge('exact', 'ok')
              : ui.badge('heuristic', 'warn'),
        },
      ];
      const dispCard = ui.card({
        title: 'Dispenses',
        subtitle:
          'exact = session-linked · heuristic = matched by machine/time when the session link was missing',
        body: ui.table(dispColumns, dispenses, { caption: 'Dispenses for this session' }),
      });
      container.appendChild(dispCard);
    } else {
      container.appendChild(
        ui.el('div', { style: { fontSize: '13px', opacity: '0.8' } }, [
          'No dispense recorded for this session.',
        ])
      );
    }

    ui.render(bodyHost, container);
  }

  // ---- Kick things off ---------------------------------------------------
  await loadRecent();

  // Auto-open a trace if we were deep-linked (#data?session=...).
  const deepLinked = (params?.session || '').trim();
  if (deepLinked) {
    // Fire and forget; runTrace handles its own errors.
    runTrace(deepLinked);
  }

  // ---- Cleanup -----------------------------------------------------------
  return () => {
    disposed = true;
    if (openDrawer) {
      try { openDrawer.close(); } catch { /* noop */ }
      openDrawer = null;
    }
  };
}

// ===== helpers (module-scoped, no shell coupling) =========================

function fmtDwell(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 1000) return `${n} ms`;
  const secs = n / 1000;
  if (secs < 60) return `${secs.toFixed(secs < 10 ? 1 : 0)} s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return `${mins}m ${rem}s`;
}

function metaPill(ui, label, value) {
  return ui.el(
    'span',
    {
      style: {
        display: 'inline-flex',
        gap: '6px',
        padding: '4px 10px',
        borderRadius: '999px',
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.08)',
      },
    },
    [
      ui.el('strong', { text: label, style: { opacity: '0.7', fontWeight: '600' } }),
      ui.el('span', { text: value }),
    ]
  );
}

// Renders the ordered timeline as an accessible vertical list. Each row has a
// coloured node (scan / event / dispense) and, for events, an optional payload
// preview rendered safely via textContent (never innerHTML).
function buildTimeline(ui, items, fmtTs) {
  const toneFor = (kind, match) => {
    if (kind === 'scan') return 'accent';
    if (kind === 'dispense') return match === 'exact' ? 'ok' : 'warn';
    return 'muted';
  };

  const list = ui.el('ol', {
    style: {
      listStyle: 'none',
      margin: '0',
      padding: '0',
      display: 'grid',
      gap: '2px',
      position: 'relative',
    },
    attrs: { 'aria-label': 'Session timeline' },
  });

  items.forEach((item, i) => {
    const tone = toneFor(item.kind, item.match);

    // Node + connecting line column.
    const dot = ui.el('span', {
      style: {
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        marginTop: '4px',
        flex: '0 0 auto',
        background:
          item.kind === 'scan'
            ? 'var(--accent, #c026d3)'
            : item.kind === 'dispense'
            ? (item.match === 'exact' ? '#22c55e' : '#f59e0b')
            : 'rgba(255,255,255,0.4)',
        boxShadow: '0 0 0 3px rgba(0,0,0,0.25)',
      },
    });

    const isLast = i === items.length - 1;
    const line = ui.el('span', {
      style: {
        width: '2px',
        flex: '1 1 auto',
        marginTop: '4px',
        background: isLast ? 'transparent' : 'rgba(255,255,255,0.12)',
      },
    });
    const rail = ui.el(
      'span',
      {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          alignSelf: 'stretch',
          width: '14px',
        },
      },
      [dot, line]
    );

    // Content column.
    const header = ui.el(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      [
        ui.badge(
          item.kind === 'dispense'
            ? `dispense · ${item.match === 'exact' ? 'exact' : 'heuristic'}`
            : item.label,
          tone
        ),
        ui.el('span', {
          text: fmtTs(item.ts),
          style: { fontSize: '12px', opacity: '0.7' },
        }),
      ]
    );

    const contentChildren = [header];

    // Dispense meta line.
    if (item.kind === 'dispense') {
      const bits = [];
      if (item.machine_id) bits.push(`machine ${item.machine_id}`);
      if (item.campaign_id) bits.push(`campaign ${item.campaign_id}`);
      if (bits.length) {
        contentChildren.push(
          ui.el('div', {
            text: bits.join(' · '),
            style: { fontSize: '12px', opacity: '0.75', marginTop: '2px' },
          })
        );
      }
    }

    // Event payload preview — stringified and rendered as text (safe).
    if (item.kind === 'event' && item.payload != null) {
      const preview = payloadPreview(item.payload);
      if (preview) {
        contentChildren.push(
          ui.el('div', {
            text: preview,
            style: {
              fontSize: '12px',
              opacity: '0.7',
              marginTop: '2px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              wordBreak: 'break-word',
            },
          })
        );
      }
    }

    const content = ui.el(
      'div',
      { style: { paddingBottom: isLast ? '0' : '14px', flex: '1 1 auto' } },
      contentChildren
    );

    const li = ui.el(
      'li',
      { style: { display: 'flex', gap: '12px', alignItems: 'stretch' } },
      [rail, content]
    );
    list.appendChild(li);
  });

  return list;
}

// Compact, safe preview of an event payload. Never rendered as HTML.
function payloadPreview(payload) {
  try {
    if (typeof payload === 'string') return payload.slice(0, 200);
    const json = JSON.stringify(payload);
    if (!json || json === '{}' || json === 'null') return '';
    return json.length > 200 ? json.slice(0, 200) + '…' : json;
  } catch {
    return '';
  }
}
