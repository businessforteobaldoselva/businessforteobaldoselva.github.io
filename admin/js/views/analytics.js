// =============================================================================
// COVERED Admin Console — Analytics view
// -----------------------------------------------------------------------------
// A read-only analytics dashboard built strictly against the frozen shell
// contract. Three data sources, all admin-JWT-guarded RPCs:
//
//   fn_admin_funnel(p_from, p_to, p_machine)  -> conversion funnel
//   fn_admin_daily(p_from, p_to, p_machine)   -> per-day scans vs dispensed
//   fn_admin_recent_dispenses(p_limit)        -> latest dispenses table
//
// Controls:
//   - a date-range picker with presets (today / 7d / 30d / custom)
//   - a machine filter (all machines, or a single machine_id)
//
// Everything is appended into `root`. All DB text is rendered with textContent
// (via ui.el text props / ui.table default cells). No innerHTML with data.
// A single cleanup fn cancels any in-flight refresh so a fast view switch
// can't paint stale data.
// =============================================================================

export default async function mount(root, ctx) {
  const { ui, supabase, toast } = ctx;
  const tz = ctx.adminStatus?.schedule_tz || 'Europe/London';

  // ---------------------------------------------------------------------------
  // View state. `range` is a preset key; custom uses fromDate/toDate (YYYY-MM-DD
  // strings from <input type=date>). `machine` is a machine_id or '' for all.
  // ---------------------------------------------------------------------------
  const state = {
    range: '7d',        // 'today' | '7d' | '30d' | 'custom'
    fromDate: '',       // used only when range === 'custom'
    toDate: '',
    machine: '',        // '' => all machines (passed as null to RPCs)
  };

  // A monotonically increasing token lets us ignore results from a refresh that
  // was superseded by a newer one (or by teardown).
  let loadToken = 0;
  let disposed = false;

  // ---------------------------------------------------------------------------
  // Layout scaffold. We build the controls once, then repaint only the results
  // region on each refresh.
  // ---------------------------------------------------------------------------
  const controlsHost = ui.el('div', { class: 'analytics-controls' });
  const resultsHost = ui.el('div', { class: 'analytics-results' });

  root.appendChild(
    ui.el('div', { class: 'view view--analytics' }, [
      ui.el('div', { class: 'view-header' }, [
        ui.el('h1', { class: 'view-title', text: 'Analytics' }),
        ui.el('p', {
          class: 'view-subtitle',
          text: `Scan-to-dispense funnel and daily volume. Times in ${tz}.`,
        }),
      ]),
      controlsHost,
      resultsHost,
    ])
  );

  // ---------------------------------------------------------------------------
  // Resolve the current preset/custom selection into an absolute [from,to)
  // window as ISO timestamptz strings. Presets are day-aligned in the browser's
  // local time (good enough for a founder dashboard); custom uses the picked
  // dates as full local days. `to` is exclusive (start of the day after).
  // ---------------------------------------------------------------------------
  function resolveWindow() {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let from;
    let to; // exclusive upper bound

    if (state.range === 'custom' && state.fromDate && state.toDate) {
      from = new Date(`${state.fromDate}T00:00:00`);
      const toDay = new Date(`${state.toDate}T00:00:00`);
      to = new Date(toDay.getTime() + 24 * 60 * 60 * 1000); // include the whole end day
    } else if (state.range === 'today') {
      from = startOfToday;
      to = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    } else if (state.range === '30d') {
      from = new Date(startOfToday.getTime() - 29 * 24 * 60 * 60 * 1000);
      to = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    } else {
      // default: 7d (last 7 days including today)
      from = new Date(startOfToday.getTime() - 6 * 24 * 60 * 60 * 1000);
      to = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
    }

    // Guard against an inverted custom range.
    if (from.getTime() >= to.getTime()) {
      to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    }

    return { from: from.toISOString(), to: to.toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Controls: preset buttons, custom date inputs, machine <select>, refresh.
  // The machine list is fetched lazily; until it loads we still allow "All".
  // ---------------------------------------------------------------------------
  let machineOptions = [{ value: '', label: 'All machines' }];

  function buildControls() {
    ui.clear(controlsHost);

    // Preset segmented buttons.
    const presets = [
      { key: 'today', label: 'Today' },
      { key: '7d', label: 'Last 7 days' },
      { key: '30d', label: 'Last 30 days' },
      { key: 'custom', label: 'Custom' },
    ];
    const presetRow = ui.el('div', { class: 'seg', attrs: { role: 'group', 'aria-label': 'Date range' } },
      presets.map((p) =>
        ui.button({
          label: p.label,
          size: 'sm',
          variant: state.range === p.key ? 'primary' : 'ghost',
          onClick: () => {
            if (state.range === p.key) return;
            state.range = p.key;
            // Seed sensible defaults when first entering custom mode.
            if (p.key === 'custom' && (!state.fromDate || !state.toDate)) {
              const w = resolveWindowDefaultsForCustom();
              state.fromDate = w.fromDate;
              state.toDate = w.toDate;
            }
            buildControls();
            refresh();
          },
        })
      )
    );

    // Custom date inputs (only shown in custom mode).
    let customRow = null;
    if (state.range === 'custom') {
      const todayStr = toDateInputValue(new Date());
      const fromInput = ui.input({
        type: 'date',
        value: state.fromDate,
        max: todayStr,
        onChange: (e) => { state.fromDate = e.target.value; if (bothDatesSet()) refresh(); },
      });
      const toInput = ui.input({
        type: 'date',
        value: state.toDate,
        max: todayStr,
        onChange: (e) => { state.toDate = e.target.value; if (bothDatesSet()) refresh(); },
      });
      customRow = ui.el('div', { class: 'analytics-custom' }, [
        ui.field('From', fromInput, { hint: 'Local day' }),
        ui.field('To', toInput, { hint: 'Inclusive' }),
      ]);
    }

    // Machine filter.
    const machineSelect = ui.select({
      options: machineOptions,
      value: state.machine,
      onChange: (e) => { state.machine = e.target.value; refresh(); },
    });

    const refreshBtn = ui.button({
      label: 'Refresh',
      variant: 'subtle',
      size: 'sm',
      onClick: () => refresh(),
    });

    ui.appendChildren(controlsHost, [
      ui.el('div', { class: 'analytics-controls-row' }, [
        presetRow,
        ui.el('div', { class: 'analytics-controls-right' }, [
          ui.field('Machine', machineSelect),
          refreshBtn,
        ]),
      ]),
      customRow,
    ]);
  }

  // Helpers for the custom picker.
  function bothDatesSet() { return !!(state.fromDate && state.toDate); }
  function resolveWindowDefaultsForCustom() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const from = new Date(start.getTime() - 6 * 24 * 60 * 60 * 1000);
    return { fromDate: toDateInputValue(from), toDate: toDateInputValue(now) };
  }
  function toDateInputValue(d) {
    // Local YYYY-MM-DD for <input type=date>.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // ---------------------------------------------------------------------------
  // Load the machine list for the filter. Non-fatal: on error we keep "All".
  // ---------------------------------------------------------------------------
  async function loadMachines() {
    try {
      const { data, error } = await supabase
        .from('machines')
        .select('machine_id, location')
        .order('machine_id', { ascending: true });
      if (error) throw error;
      if (disposed) return;
      const opts = [{ value: '', label: 'All machines' }];
      for (const m of data || []) {
        const label = m.location ? `${m.machine_id} — ${m.location}` : m.machine_id;
        opts.push({ value: m.machine_id, label });
      }
      machineOptions = opts;
      buildControls(); // repaint the select with the real list
    } catch (err) {
      // The dashboard is still usable across all machines; just warn quietly.
      toast(`Could not load machines: ${err.message || err}`, 'warn');
    }
  }

  // ---------------------------------------------------------------------------
  // Refresh: fetch funnel + daily + recent in parallel and repaint results.
  // Guarded by loadToken so a superseded refresh never paints.
  // ---------------------------------------------------------------------------
  async function refresh() {
    const token = ++loadToken;
    ui.render(resultsHost, ui.spinner('Loading analytics…'));

    const { from, to } = resolveWindow();
    const p_machine = state.machine || null;

    try {
      const [funnelRes, dailyRes, recentRes] = await Promise.all([
        supabase.rpc('fn_admin_funnel', { p_from: from, p_to: to, p_machine }),
        supabase.rpc('fn_admin_daily', { p_from: from, p_to: to, p_machine }),
        supabase.rpc('fn_admin_recent_dispenses', { p_limit: 25 }),
      ]);

      if (token !== loadToken || disposed) return; // superseded

      // Surface the first error we find across the three calls.
      const firstErr = funnelRes.error || dailyRes.error || recentRes.error;
      if (firstErr) throw firstErr;

      renderResults({
        funnel: funnelRes.data || null,
        daily: Array.isArray(dailyRes.data) ? dailyRes.data : [],
        recent: Array.isArray(recentRes.data) ? recentRes.data : [],
        from,
        to,
      });
    } catch (err) {
      if (token !== loadToken || disposed) return;
      const msg = err?.message || String(err);
      toast(`Failed to load analytics: ${msg}`, 'error');
      ui.render(resultsHost, ui.errorState(msg, () => refresh()));
    }
  }

  // ---------------------------------------------------------------------------
  // Render the three result blocks: funnel, daily chart, recent table.
  // ---------------------------------------------------------------------------
  function renderResults({ funnel, daily, recent, from, to }) {
    ui.render(resultsHost, [
      renderFunnel(funnel),
      renderDaily(daily),
      renderRecent(recent),
      renderRangeFootnote(from, to),
    ]);
  }

  // --- Funnel ----------------------------------------------------------------
  // The funnel is five ordered stages. We show each as a horizontal bar whose
  // width is proportional to the stage count vs the top-of-funnel (scans), plus
  // the count and the step-over-previous conversion %. The headline number is
  // the server-computed scan->dispense conversion.
  function renderFunnel(funnel) {
    const c = ui.card({
      title: 'Conversion funnel',
      subtitle: 'Scan → verified → ad started → ad completed → dispensed',
    });

    if (!funnel) {
      ui.appendChildren(c.body, ui.emptyState('No funnel data for this range.'));
      return c;
    }

    const stages = [
      { key: 'scans', label: 'Scans' },
      { key: 'otp_verified', label: 'Verified (OTP)' },
      { key: 'ad_started', label: 'Ad started' },
      { key: 'ad_completed', label: 'Ad completed' },
      { key: 'dispensed', label: 'Dispensed' },
    ];

    const top = Number(funnel.scans) || 0;

    // Overall headline conversion (scan -> dispense).
    const overallPct = funnel.conv_scan_to_dispense_pct != null
      ? `${fmtPct(funnel.conv_scan_to_dispense_pct)}%`
      : (top > 0 ? `${fmtPct((Number(funnel.dispensed) || 0) / top * 100)}%` : '—');

    const statRow = ui.el('div', { class: 'stat-row' }, [
      ui.stat({ label: 'Scans', value: fmtNum(funnel.scans), tone: 'accent' }),
      ui.stat({ label: 'Dispensed', value: fmtNum(funnel.dispensed), tone: 'ok' }),
      ui.stat({ label: 'Scan → dispense', value: overallPct, sub: 'overall conversion' }),
    ]);

    // Horizontal bars. Each row: label, proportional fill, count + step %.
    const rows = stages.map((s, i) => {
      const value = Number(funnel[s.key]) || 0;
      const widthPct = top > 0 ? Math.max(0, Math.min(100, (value / top) * 100)) : 0;

      // Step conversion vs the previous stage (first stage is the 100% base).
      let stepLabel = '100%';
      if (i > 0) {
        const prev = Number(funnel[stages[i - 1].key]) || 0;
        stepLabel = prev > 0 ? `${fmtPct((value / prev) * 100)}%` : '—';
      }

      const bar = ui.el('div', { class: 'funnel-track' },
        ui.el('div', {
          class: 'funnel-fill',
          style: { width: `${widthPct}%` },
          attrs: { 'aria-hidden': 'true' },
        })
      );

      return ui.el('div', { class: 'funnel-row' }, [
        ui.el('div', { class: 'funnel-label', text: s.label }),
        bar,
        ui.el('div', { class: 'funnel-meta' }, [
          ui.el('span', { class: 'funnel-count', text: fmtNum(value) }),
          ui.el('span', {
            class: 'funnel-step',
            text: i === 0 ? 'top of funnel' : `${stepLabel} of previous`,
          }),
        ]),
      ]);
    });

    ui.appendChildren(c.body, [
      statRow,
      ui.el('div', {
        class: 'funnel',
        attrs: { role: 'img', 'aria-label': 'Conversion funnel from scans to dispensed' },
      }, rows),
    ]);
    return c;
  }

  // --- Daily chart -----------------------------------------------------------
  // Two grouped series (scans vs dispensed) per day. ui.bars renders a single
  // series, so we render two interleaved bar charts sharing one Y-max and a
  // per-day axis, using a small local grouped-bar SVG helper below.
  function renderDaily(daily) {
    const c = ui.card({
      title: 'Daily volume',
      subtitle: 'Scans vs dispensed, per day',
    });

    if (!daily || daily.length === 0) {
      ui.appendChildren(c.body, ui.emptyState('No daily activity in this range.'));
      return c;
    }

    // Legend.
    const legend = ui.el('div', { class: 'chart-legend' }, [
      legendItem('var(--accent)', 'Scans'),
      legendItem('var(--ok, #38d39f)', 'Dispensed'),
    ]);

    const chart = groupedBars(daily);

    ui.appendChildren(c.body, [legend, chart]);
    return c;
  }

  function legendItem(color, label) {
    return ui.el('span', { class: 'legend-item' }, [
      ui.el('span', { class: 'legend-swatch', style: { background: color } }),
      ui.el('span', { text: label }),
    ]);
  }

  // Local grouped-bar SVG (two bars per day). Kept here rather than in ui.js
  // because ui.bars is single-series. Labels/values use <text> textContent.
  function groupedBars(daily) {
    const SVGNS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs = {}) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
      return n;
    };

    const width = 720;
    const height = 220;
    const pad = 28;
    const n = daily.length;
    const innerW = width - pad * 2;
    const innerH = height - pad * 2 - 14; // leave room for x labels
    const groupGap = 8;
    const groupW = Math.max(6, (innerW - groupGap * (n - 1)) / n);
    const barW = Math.max(2, (groupW - 4) / 2);

    const max = Math.max(
      1,
      ...daily.map((d) => Math.max(Number(d.scans) || 0, Number(d.dispensed) || 0))
    );

    const svg = mk('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'chart chart--grouped',
      role: 'img',
      'aria-label': 'Daily scans versus dispensed',
      preserveAspectRatio: 'none',
    });

    // Baseline.
    svg.appendChild(mk('line', {
      x1: pad, y1: pad + innerH, x2: width - pad, y2: pad + innerH, class: 'chart-axis',
    }));

    daily.forEach((d, i) => {
      const scans = Number(d.scans) || 0;
      const disp = Number(d.dispensed) || 0;
      const gx = pad + i * (groupW + groupGap);

      const scH = (scans / max) * innerH;
      const dpH = (disp / max) * innerH;

      const scRect = mk('rect', {
        x: gx, y: pad + innerH - scH, width: barW, height: Math.max(0, scH),
        rx: Math.min(3, barW / 2), fill: 'var(--accent)', class: 'chart-bar',
      });
      scRect.appendChild(titleNode(mk, `${d.day} — scans: ${scans}`));

      const dpRect = mk('rect', {
        x: gx + barW + 4, y: pad + innerH - dpH, width: barW, height: Math.max(0, dpH),
        rx: Math.min(3, barW / 2), fill: 'var(--ok, #38d39f)', class: 'chart-bar',
      });
      dpRect.appendChild(titleNode(mk, `${d.day} — dispensed: ${disp}`));

      svg.appendChild(scRect);
      svg.appendChild(dpRect);

      // X label: show only a subset when crowded to avoid overlap.
      const showEvery = n > 15 ? Math.ceil(n / 12) : 1;
      if (i % showEvery === 0) {
        const t = mk('text', {
          x: gx + groupW / 2, y: pad + innerH + 14,
          'text-anchor': 'middle', class: 'chart-label',
        });
        t.textContent = shortDay(d.day);
        svg.appendChild(t);
      }
    });

    return svg;
  }

  function titleNode(mk, text) {
    const t = mk('title');
    t.textContent = text;
    return t;
  }

  // 'YYYY-MM-DD' -> 'DD/MM' for compact axis labels.
  function shortDay(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
    if (!m) return String(day || '');
    return `${m[3]}/${m[2]}`;
  }

  // --- Recent dispenses table ------------------------------------------------
  // Never renders a raw phone (the RPC never returns one). A row click deep-links
  // to the Data view's session trace via router.navigate('data', {session}).
  function renderRecent(recent) {
    const c = ui.card({
      title: 'Recent dispenses',
      subtitle: 'Latest 25 across the selected machine filter',
    });

    if (!recent || recent.length === 0) {
      ui.appendChildren(c.body, ui.emptyState('No recent dispenses.'));
      return c;
    }

    const columns = [
      {
        key: 'ts',
        label: 'When',
        render: (v) => ui.fmtDate(v, { mode: 'datetime', tz }),
      },
      { key: 'machine_id', label: 'Machine' },
      {
        key: 'location',
        label: 'Location',
        render: (v) => (v == null || v === '' ? '—' : String(v)),
      },
      {
        key: 'ad_name',
        label: 'Ad',
        render: (v) => (v ? ui.badge(String(v), 'accent') : '—'),
      },
      {
        key: 'campaign_id',
        label: 'Campaign',
        render: (v) => (v == null || v === '' ? '—' : String(v)),
      },
      {
        key: 'session_id',
        label: 'Session',
        render: (v) => (v ? ui.el('span', { class: 'mono', text: ui.shortId(v) }) : '—'),
      },
    ];

    const tbl = ui.table(columns, recent, {
      empty: 'No recent dispenses.',
      onRowClick: (row) => {
        if (row.session_id) {
          ctx.router.navigate('data', { session: row.session_id });
        } else {
          toast('No session id for this dispense.', 'info');
        }
      },
    });

    ui.appendChildren(c.body, [
      tbl,
      ui.el('p', {
        class: 'table-hint',
        text: 'Tip: click a row to open its full session trace in the Data view.',
      }),
    ]);
    return c;
  }

  // A small footnote clarifying the exact window that was queried.
  function renderRangeFootnote(from, to) {
    return ui.el('p', {
      class: 'analytics-footnote',
      text: `Window: ${ui.fmtDate(from, { mode: 'datetime', tz })} → ${ui.fmtDate(to, { mode: 'datetime', tz })} (end exclusive), ${tz}.`,
    });
  }

  // --- number formatting -----------------------------------------------------
  function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-GB');
  }
  function fmtPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    // One decimal, but drop a trailing .0 for whole numbers.
    return (Math.round(n * 10) / 10).toString();
  }

  // ---------------------------------------------------------------------------
  // Kick off: paint controls, then fetch machines (non-blocking) and the first
  // data load in parallel.
  // ---------------------------------------------------------------------------
  buildControls();
  loadMachines();      // fire-and-forget; repaints the select when ready
  await refresh();     // await the first load so the router's spinner covers it

  // Cleanup: mark disposed so any in-flight refresh/loadMachines callbacks bail
  // out instead of painting into a torn-down root.
  return () => {
    disposed = true;
    loadToken++; // invalidate any pending refresh
  };
}
