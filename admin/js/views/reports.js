// =============================================================================
// COVERED Admin Console — Reports view
// -----------------------------------------------------------------------------
// Two sections:
//
//   1. RECIPIENTS — one card per report type (weekly evidence pack, advertiser
//      post-campaign report, venue impact report, unit economics summary).
//      Each card lists rows from public.report_recipients for that type:
//      email, an Active/Paused badge, a Toggle button, and a Remove button
//      (ui.confirmDialog before delete). "Add recipient" opens a modal with a
//      single email input (validated, lowercased, trimmed) and inserts
//      { report_type, email, active: true }. A duplicate insert (23505) gets a
//      friendly toast instead of a raw Postgres error.
//
//   2. GENERATED REPORTS — the last N stored report events, read via the
//      admin RPC fn_admin_reports(p_limit) (events of type 'evidence_pack',
//      'report_pcr', 'report_host', newest first). Each renders as an
//      expandable block: type badge + timestamp + key totals pulled
//      defensively from the payload, and a native <details> element that
//      shows the full payload as key/value lines (nested values are
//      JSON.stringified) — all via textContent, never innerHTML.
//
// CONTRACT NOTES this file honours:
//   - Everything is appended into `root`; modals via ui.modal and toasts via
//     ui.toast are the only permitted exceptions.
//   - Every supabase call is wrapped; on error we toast and/or render an
//     errorState with a retry.
//   - ALL DB/user text reaches the DOM via ui.el text props / textContent /
//     ui.badge / table cell renderers — NEVER innerHTML.
//   - Returns a cleanup fn that closes any open modal so the router can tear
//     the view down cleanly.
//
// SERVER DEPENDENCIES:
//   - table public.report_recipients (id, report_type, email, active, …) with
//     the standard admin RLS pattern and a unique (report_type, email) index
//     (duplicate inserts surface as 23505).
//   - RPC public.fn_admin_reports(p_limit int default 12) — see
//     Covered-by-Mills/ADMIN-CONSOLE/08b-fn-admin-reports.sql.
// =============================================================================

const REPORT_TYPES = [
  { key: 'evidence_pack',  label: 'Weekly evidence pack' },
  { key: 'pcr',            label: 'Advertiser post-campaign report' },
  { key: 'host_report',    label: 'Venue impact report' },
  { key: 'unit_economics', label: 'Unit economics summary' },
];

// Map a stored report event type -> display badge metadata. Unknown types are
// shown as-is (muted) so bad data is visible rather than hidden.
function reportTypeMeta(type) {
  const t = String(type || '');
  if (t === 'evidence_pack') return { label: 'Evidence pack', tone: 'accent' };
  if (t === 'report_pcr')    return { label: 'Advertiser PCR', tone: 'ok' };
  if (t === 'report_host')   return { label: 'Venue report', tone: 'warn' };
  return { label: t || 'unknown', tone: 'muted' };
}

export default async function mount(root, ctx) {
  const { supabase, ui, toast } = ctx;
  const tz = ctx.adminStatus?.schedule_tz || 'Europe/London';

  let destroyed = false;
  let openModal = null; // { el, close } while a modal is open

  // ---------------------------------------------------------------------------
  // Layout scaffold.
  // ---------------------------------------------------------------------------
  const recipientsHost = ui.el('div', { class: 'reports-recipients' });
  const generatedHost = ui.el('div', { class: 'reports-generated' });

  root.appendChild(
    ui.el('div', { class: 'view view--reports' }, [
      ui.el('div', { class: 'view-header' }, [
        ui.el('h1', { class: 'view-title', text: 'Reports' }),
        ui.el('p', {
          class: 'view-subtitle',
          text: 'Reports are only sent to the people listed here. '
            + 'Email delivery activates once an email credential is added to n8n '
            + '- until then reports are generated and stored below.',
        }),
      ]),
      ui.el('h2', { class: 'section-title', text: 'Recipients', style: { margin: '16px 0 8px' } }),
      recipientsHost,
      ui.el('h2', { class: 'section-title', text: 'Generated reports', style: { margin: '24px 0 8px' } }),
      generatedHost,
    ])
  );

  // ===========================================================================
  // SECTION 1 — Recipients (one card per report type).
  // ===========================================================================
  function buildRecipientCard(rt) {
    const cardEl = ui.card({
      title: rt.label,
      className: 'report-recipients-card',
      actions: ui.button({
        label: 'Add recipient',
        variant: 'primary',
        size: 'sm',
        onClick: () => openAddRecipient(rt, load),
      }),
    });

    async function load() {
      ui.render(cardEl.body, ui.spinner('Loading recipients…'));
      let data, error;
      try {
        ({ data, error } = await supabase
          .from('report_recipients')
          .select('*')
          .eq('report_type', rt.key)
          .order('email', { ascending: true }));
      } catch (err) {
        error = err;
      }
      if (destroyed) return;

      if (error) {
        ui.render(cardEl.body, ui.errorState(
          'Could not load recipients. ' + (error.message || ''),
          () => load(),
        ));
        return;
      }
      renderRows(data || []);
    }

    function renderRows(rows) {
      if (!rows.length) {
        ui.render(cardEl.body, ui.emptyState(
          'No recipients yet — this report will not be emailed to anyone.',
        ));
        return;
      }

      const columns = [
        {
          key: 'email',
          label: 'Email',
          render: (v) => ui.el('span', { class: 'mono', text: String(v || '—') }),
        },
        {
          key: 'active',
          label: 'Status',
          render: (v) => (v ? ui.badge('Active', 'ok') : ui.badge('Paused', 'muted')),
        },
        {
          key: 'id',
          label: 'Actions',
          align: 'right',
          render: (_v, row) => ui.el('div', { class: 'row-actions' }, [
            ui.button({
              label: row.active ? 'Deactivate' : 'Activate',
              variant: 'ghost',
              size: 'sm',
              onClick: () => toggleActive(row),
            }),
            ui.button({
              label: 'Remove',
              variant: 'danger',
              size: 'sm',
              onClick: () => removeRecipient(row),
            }),
          ]),
        },
      ];

      ui.render(cardEl.body, ui.table(columns, rows, { empty: 'No recipients.' }));
    }

    // Match a row by id when the table has one, else by (report_type, email) —
    // both identify a single row under the unique (report_type, email) key.
    function matchRow(query, row) {
      if (row.id != null) return query.eq('id', row.id);
      return query.eq('report_type', rt.key).eq('email', row.email);
    }

    async function toggleActive(row) {
      let error;
      try {
        ({ error } = await matchRow(
          supabase.from('report_recipients').update({ active: !row.active }),
          row,
        ));
      } catch (err) {
        error = err;
      }
      if (destroyed) return;

      if (error) {
        toast(error.message || 'Could not update recipient.', 'error');
        return;
      }
      toast(!row.active ? 'Recipient activated.' : 'Recipient paused.', 'success');
      load();
    }

    async function removeRecipient(row) {
      const ok = await ui.confirmDialog({
        title: 'Remove recipient?',
        message: `“${row.email || ''}” will no longer receive the ${rt.label.toLowerCase()}. `
          + 'You can re-add them at any time.',
        confirmLabel: 'Remove',
        cancelLabel: 'Cancel',
        danger: true,
      });
      if (!ok || destroyed) return;

      let error;
      try {
        ({ error } = await matchRow(supabase.from('report_recipients').delete(), row));
      } catch (err) {
        error = err;
      }
      if (destroyed) return;

      if (error) {
        toast(error.message || 'Remove failed.', 'error');
        return;
      }
      toast('Recipient removed.', 'success');
      load();
    }

    load();
    return cardEl;
  }

  // "Add recipient" modal: one email input; validated, lowercased, trimmed.
  function openAddRecipient(rt, reload) {
    if (openModal) return;

    const emailInput = ui.input({
      type: 'email',
      placeholder: 'name@example.com',
      autocomplete: 'off',
    });

    let saving = false;
    async function save() {
      if (saving || destroyed) return;

      const email = String(emailInput.value || '').trim().toLowerCase();
      if (!/.+@.+\..+/.test(email)) {
        toast('Please enter a valid email address.', 'warn');
        emailInput.focus();
        return;
      }

      saving = true;
      saveBtn.disabled = true;

      let error;
      try {
        ({ error } = await supabase
          .from('report_recipients')
          .insert({ report_type: rt.key, email, active: true }));
      } catch (err) {
        error = err;
      }

      saving = false;
      if (destroyed) return;
      saveBtn.disabled = false;

      if (error) {
        // 23505 = unique violation: they are already on the list for this type.
        if (String(error.code) === '23505') {
          toast(`${email} is already a recipient for this report.`, 'warn');
        } else {
          toast(error.message || 'Could not add recipient.', 'error');
        }
        return;
      }

      toast('Recipient added.', 'success');
      closeModal();
      reload();
    }

    const saveBtn = ui.button({
      label: 'Add recipient',
      variant: 'primary',
      type: 'button',
      onClick: () => save(),
    });

    const form = ui.el('form', {
      class: 'recipient-form',
      onsubmit: (e) => { e.preventDefault(); save(); },
    }, [
      ui.field('Email', emailInput, {
        hint: `Will receive the ${rt.label.toLowerCase()} once email delivery is switched on.`,
      }),
    ]);

    openModal = ui.modal({
      title: `Add recipient — ${rt.label}`,
      size: 'sm',
      body: form,
      actions: [
        ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => closeModal() }),
        saveBtn,
      ],
      onClose: () => { openModal = null; },
    });

    requestAnimationFrame(() => emailInput.focus());
  }

  function closeModal() {
    if (openModal) { const m = openModal; openModal = null; m.close(); }
  }

  // ===========================================================================
  // SECTION 2 — Generated reports (stored report events via fn_admin_reports).
  // ===========================================================================
  const generatedCard = ui.card({
    title: 'Stored reports',
    subtitle: 'Latest generated reports, newest first.',
    actions: ui.button({
      label: 'Refresh',
      variant: 'subtle',
      size: 'sm',
      onClick: () => loadReports(),
    }),
  });
  generatedHost.appendChild(generatedCard);

  async function loadReports() {
    ui.render(generatedCard.body, ui.spinner('Loading reports…'));
    let data, error;
    try {
      ({ data, error } = await supabase.rpc('fn_admin_reports', { p_limit: 12 }));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      ui.render(generatedCard.body, ui.errorState(
        'Could not load stored reports. ' + (error.message || ''),
        () => loadReports(),
      ));
      return;
    }

    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      ui.render(generatedCard.body, ui.emptyState(
        'No generated reports yet. The weekly evidence pack lands here after its first run.',
      ));
      return;
    }

    ui.render(generatedCard.body, ui.el(
      'div',
      { class: 'report-list', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      rows.map((r) => reportBlock(r)),
    ));
  }

  // One expandable block per stored report. Totals are read defensively with
  // optional chaining — different report types carry different payload keys.
  function reportBlock(r) {
    const meta = reportTypeMeta(r?.type);

    const head = ui.el('div', {
      class: 'report-head',
      style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    }, [
      ui.badge(meta.label, meta.tone),
      ui.el('span', {
        class: 'report-ts',
        text: ui.fmtDate(r?.ts || null, { mode: 'datetime', tz }),
        style: { opacity: '0.8', fontSize: '0.85rem' },
      }),
      r?.id
        ? ui.el('span', {
            class: 'mono',
            text: ui.shortId(r.id),
            style: { opacity: '0.5', fontSize: '0.75rem' },
          })
        : null,
    ]);

    const block = ui.el('div', {
      class: 'report-block',
      style: {
        border: '1px solid rgba(127, 127, 127, 0.25)',
        borderRadius: '10px',
        padding: '12px',
      },
    }, [head]);

    const totals = totalsRow(r?.payload);
    if (totals) block.appendChild(totals);

    // Native <details> expander with the full payload as key/value lines.
    const details = ui.el('details', { class: 'report-detail', style: { marginTop: '8px' } });
    details.appendChild(ui.el('summary', {
      text: 'View full payload',
      style: { cursor: 'pointer', fontSize: '0.85rem', opacity: '0.85' },
    }));
    details.appendChild(payloadBlock(r?.payload));
    block.appendChild(details);

    return block;
  }

  // Compact "Scans 120 · Dispensed 84 · …" strip built from whichever keys the
  // payload actually has. Only scalar values are shown here.
  function totalsRow(payload) {
    const candidates = [
      ['Scans', 'scans'],
      ['OTP verified', 'otp_verified'],
      ['Ad started', 'ad_started'],
      ['Ad completed', 'ad_completed'],
      ['Dispensed', 'dispensed'],
      ['Unique users', 'unique_users'],
      ['Conv %', 'conv_scan_to_dispense_pct'],
      ['Impressions', 'impressions'],
      ['Completions', 'completions'],
      ['Clicks', 'clicks'],
    ];

    const bits = [];
    for (const [label, key] of candidates) {
      const v = payload?.[key];
      if (v == null || typeof v === 'object') continue;
      bits.push(ui.el('span', { class: 'report-total', style: { whiteSpace: 'nowrap' } }, [
        ui.el('strong', { text: `${label}: ` }),
        ui.el('span', { text: String(v) }),
      ]));
    }
    if (!bits.length) return null;

    return ui.el('div', {
      class: 'report-totals',
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 16px',
        marginTop: '8px',
        fontSize: '0.85rem',
      },
    }, bits);
  }

  // Full payload as key/value lines. Shallow recursion: top-level scalars are
  // shown inline; nested objects/arrays are JSON.stringified into a pre-wrap
  // monospace block. Everything reaches the DOM via textContent.
  function payloadBlock(payload) {
    const wrap = ui.el('div', {
      class: 'report-payload',
      style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' },
    });

    if (payload == null || typeof payload !== 'object') {
      wrap.appendChild(ui.el('div', {
        text: payload == null ? '(empty payload)' : String(payload),
        style: { fontSize: '0.85rem', opacity: '0.85' },
      }));
      return wrap;
    }

    for (const [k, v] of Object.entries(payload)) {
      const line = ui.el('div', { class: 'report-payload-line', style: { fontSize: '0.85rem' } });
      line.appendChild(ui.el('strong', { text: `${k}: ` }));

      if (v !== null && typeof v === 'object') {
        let s;
        try { s = JSON.stringify(v, null, 2); } catch { s = String(v); }
        const pre = ui.el('div', {
          style: {
            whiteSpace: 'pre-wrap',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.8rem',
            opacity: '0.85',
            marginTop: '2px',
            overflowWrap: 'anywhere',
          },
        });
        pre.textContent = s;
        line.appendChild(pre);
      } else {
        line.appendChild(ui.el('span', { text: String(v) }));
      }
      wrap.appendChild(line);
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Kick off: recipient cards (each loads itself) + the stored reports list.
  // ---------------------------------------------------------------------------
  for (const rt of REPORT_TYPES) {
    recipientsHost.appendChild(buildRecipientCard(rt));
  }
  await loadReports();

  // ---------------------------------------------------------------------------
  // Cleanup: close a lingering modal so nothing survives the view teardown.
  // ---------------------------------------------------------------------------
  return () => {
    destroyed = true;
    if (openModal) { try { openModal.close(); } catch { /* ignore */ } openModal = null; }
  };
}
