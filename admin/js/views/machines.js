// =============================================================================
// COVERED Admin Console — Machines view
// -----------------------------------------------------------------------------
// Lists every machine (id, location, active, monthly limit, STOCK) and, per
// machine, lets the founder manage its ad SCHEDULE (rows in `ad_schedules`). For
// each machine it also computes — CLIENT-SIDE, mirroring the server SQL rules —
// which ad is resolved as "showing right now", so the founder can glance and see
// "machine-001 is showing X".
//
// Founder-facing extras:
//   * Add machine — creates a machines row and surfaces its QR scan URL.
//   * Stock gauges + 'Mark restocked' — inline SVG gauge per machine, coloured by
//     the low-stock threshold; 'Restock' opens a modal that calls
//     fn_admin_set_stock (which logs a 'restock' event server-side).
//   * Soft approval warning — scheduling a not-yet-approved ad is allowed but
//     flagged, since fn_active_ad_for_machine won't serve it until it's approved.
//
// Everything is built with the shared ui.js helpers (all DB text goes through
// textContent / safe cell renderers — no innerHTML with data). Every data call
// is wrapped and surfaces a toast + errorState on failure.
//
// FROZEN schedule semantics implemented in resolveActiveAd() below:
//   * a schedule matches a machine when: active, and
//       machine_id IS NULL (all machines) OR == this machine, and
//       today is within [starts_on, ends_on] (null bound = open), and
//       today's weekday ∈ days_of_week (null/empty = every day), and
//       now-of-day falls in the half-open window [start_min, end_min):
//         both null OR start==end            => all day
//         end < start                        => overnight wrap
//         one bound null                     => that side open
//   * among matches, HIGHER priority wins; on a priority tie a machine-specific
//     schedule (machine_id set) beats an all-machines one (machine_id NULL).
//   * all date/time comparisons are done in the schedule timezone
//     (Europe/London, from ctx.adminStatus.schedule_tz).
// =============================================================================

export default async function mount(root, ctx) {
  const { supabase, ui, toast } = ctx;
  const TZ = ctx.adminStatus?.schedule_tz || 'Europe/London';

  // Base URL every machine's QR encodes; the machineId query param is the ONLY
  // thing that differs between machines (machines are data, not workflows).
  const SCAN_BASE = 'https://coveredbymills.app.n8n.cloud/webhook/scan?machineId=';

  // Re-render clock: the "showing now" column depends on wall-clock time, so we
  // recompute the resolved ad once a minute. Tracked for cleanup.
  let tickTimer = null;
  const listeners = []; // no-op placeholder; kept for symmetry / future use

  // In-memory caches so re-rendering the schedule table after an edit doesn't
  // require a full round-trip for machines/ads.
  let machines = [];
  let ads = [];
  let schedules = [];

  root.appendChild(ui.spinner('Loading machines…'));

  // ---------------------------------------------------------------------------
  // Data loading. One shot pulls everything the view needs.
  // ---------------------------------------------------------------------------
  async function loadAll() {
    const [mRes, aRes, sRes] = await Promise.all([
      supabase.from('machines')
        .select('machine_id, active, location, campaign_id, monthly_limit_per_user, stock_level, capacity, low_stock_threshold')
        .order('machine_id', { ascending: true }),
      supabase.from('ads')
        .select('id, name, headline, active, approval_status')
        .order('name', { ascending: true }),
      supabase.from('ad_schedules')
        .select('*')
        .order('priority', { ascending: false }),
    ]);
    if (mRes.error) throw mRes.error;
    if (aRes.error) throw aRes.error;
    if (sRes.error) throw sRes.error;
    machines = mRes.data || [];
    ads = aRes.data || [];
    schedules = sRes.data || [];

    // Enrich with server-computed stock status (low bool, days_to_empty).
    // fn_admin_stock_status() is admin-guarded and returns a jsonb ARRAY.
    try {
      const { data: stock, error: stockErr } = await supabase.rpc('fn_admin_stock_status');
      if (!stockErr && Array.isArray(stock)) {
        const byId = new Map(stock.map((s) => [s.machine_id, s]));
        machines = machines.map((m) => {
          const s = byId.get(m.machine_id);
          return s ? { ...m, _low: s.low, _daysToEmpty: s.days_to_empty } : m;
        });
      }
    } catch { /* stock status is additive — never block the machines list */ }
  }

  try {
    await loadAll();
  } catch (err) {
    ui.render(root, ui.errorState(
      'Could not load machines. ' + (err?.message || ''),
      () => mount(root, ctx),
    ));
    toast(err?.message || 'Failed to load machines.', 'error');
    return () => { if (tickTimer) clearInterval(tickTimer); };
  }

  render();

  // Recompute "showing now" every minute (cheap, purely client-side).
  tickTimer = setInterval(() => {
    updateNowColumns();
  }, 60_000);

  // Return teardown.
  return () => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    for (const off of listeners) { try { off(); } catch { /* ignore */ } }
  };

  // ===========================================================================
  // Rendering
  // ===========================================================================
  function render() {
    ui.clear(root);

    if (machines.length === 0) {
      root.appendChild(ui.card({
        title: 'Machines',
        subtitle: 'Vending machines registered in the COVERED backend.',
        actions: [ui.button({
          label: 'Add machine', variant: 'primary', size: 'sm',
          onClick: () => openMachineForm(),
        })],
        body: ui.emptyState('No machines are registered yet. Add your first machine to get its QR link.'),
      }));
      return;
    }

    const adById = new Map(ads.map((a) => [a.id, a]));

    const columns = [
      { key: 'machine_id', label: 'Machine' },
      { key: 'location', label: 'Location' },
      {
        key: 'active', label: 'Active', align: 'center',
        render: (v) => v
          ? ui.badge('Active', 'ok')
          : ui.badge('Inactive', 'muted'),
      },
      {
        key: 'monthly_limit_per_user', label: 'Monthly limit', align: 'right',
        render: (v) => v == null ? '—' : String(v),
      },
      {
        key: 'stock_level', label: 'Stock', align: 'center',
        render: (_v, row) => stockCell(row),
      },
      {
        key: '_now', label: `Showing now (${TZ})`,
        render: (_v, row) => nowCell(row, adById),
      },
      {
        key: '_manage', label: '', align: 'right',
        render: (_v, row) => ui.el('div', { class: 'sched-row-actions' }, [
          ui.button({
            label: 'QR link',
            variant: 'ghost',
            size: 'sm',
            onClick: () => openQrLink(row),
          }),
          ui.button({
            label: 'Restock',
            variant: 'ghost',
            size: 'sm',
            onClick: () => openRestockForm(row),
          }),
          ui.button({
            label: 'Schedule',
            variant: 'ghost',
            size: 'sm',
            onClick: () => openScheduleManager(row),
          }),
        ]),
      },
    ];

    const activeCount = machines.filter((m) => m.active).length;

    const cardEl = ui.card({
      title: 'Machines',
      subtitle: `${machines.length} machine${machines.length === 1 ? '' : 's'} · ${activeCount} active · dayparts in ${TZ}`,
      actions: [ui.button({
        label: 'Add machine', variant: 'primary', size: 'sm',
        onClick: () => openMachineForm(),
      })],
      body: ui.table(columns, machines, {
        empty: 'No machines registered.',
        className: 'machines-table',
      }),
    });
    root.appendChild(cardEl);
  }

  // ===========================================================================
  // Add-machine form. machine_id is the permanent key that appears in the QR
  // URL and every analytics row — validated to a URL-safe slug, no spaces.
  // ===========================================================================
  function openMachineForm() {
    const idInput = ui.input({
      type: 'text', placeholder: 'e.g. machine-004',
      attrs: { autocomplete: 'off', spellcheck: 'false' },
    });
    const locInput = ui.input({ type: 'text', placeholder: 'e.g. Princesshay Shopping Centre, Exeter' });
    const limitInput = ui.input({ type: 'number', value: '4', min: 1, step: 1 });
    const activeCheck = ui.checkbox({ label: 'Active', checked: true });
    const stockInput = ui.input({ type: 'number', placeholder: 'optional', min: 0, step: 1 });
    const capInput = ui.input({ type: 'number', placeholder: 'optional', min: 0, step: 1 });
    const errorLine = ui.el('div', { class: 'auth-msg', attrs: { 'aria-live': 'polite' } });

    const form = ui.el('form', { class: 'sched-form' }, [
      ui.field('Machine ID', idInput, {
        hint: 'Permanent, URL-safe name (letters, numbers, hyphens). It goes in the QR URL and all analytics — pick something meaningful like machine-004.',
      }),
      ui.field('Location', locInput, { hint: 'Where the machine lives (shown in reports).' }),
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('Monthly limit per user', limitInput, {
          hint: 'Products per user per month. NOTE: the limit is enforced globally per user across ALL machines; this per-machine value is the limit read when this machine dispenses.',
        }),
        ui.field('Status', activeCheck),
      ]),
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('Initial stock level (optional)', stockInput, { hint: 'Units loaded now. Blank = untracked.' }),
        ui.field('Capacity (optional)', capInput, { hint: 'Max units this machine holds.' }),
      ]),
      errorLine,
    ]);

    const saveBtn = ui.button({
      label: 'Add machine',
      variant: 'primary',
      onClick: () => submit(),
    });

    const formModal = ui.modal({
      title: 'New machine',
      size: 'md',
      body: form,
      actions: [
        ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => formModal.close() }),
        saveBtn,
      ],
    });

    async function submit() {
      errorLine.textContent = '';
      const id = (idInput.value || '').trim();

      if (!id) { errorLine.textContent = 'Machine ID is required.'; return; }
      // URL-safe id used in the QR link: starts alphanumeric, then alnum/hyphen.
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(id)) {
        errorLine.textContent = 'Machine ID must start with a letter or number and contain only letters, numbers and hyphens (2–41 chars, no spaces).';
        return;
      }
      if (machines.some((m) => m.machine_id === id)) {
        errorLine.textContent = `"${id}" already exists.`;
        return;
      }

      const stockRaw = (stockInput.value || '').trim();
      const capRaw = (capInput.value || '').trim();
      const payload = {
        machine_id: id,
        location: (locInput.value || '').trim() || null,
        monthly_limit_per_user: ui.clampInt(limitInput.value, 1, 1000, 4),
        active: activeCheck.querySelector('input').checked,
        stock_level: stockRaw === '' ? null : ui.clampInt(stockRaw, 0, 100000, 0),
        capacity: capRaw === '' ? null : ui.clampInt(capRaw, 0, 100000, 0),
      };

      saveBtn.disabled = true;
      const span = saveBtn.querySelector('span');
      const prevLabel = span ? span.textContent : '';
      if (span) span.textContent = 'Adding…';

      try {
        const { data, error } = await supabase
          .from('machines').insert(payload).select().single();
        if (error) throw error;
        machines.push(data);
        machines.sort((a, b) => a.machine_id.localeCompare(b.machine_id));
        toast(`Machine ${id} added.`, 'success');
        formModal.close();
        render();
        // Hand the founder the QR link straight away — that's the next step.
        openQrLink(data);
      } catch (err) {
        const msg = (err?.code === '23505' || /duplicate|23505|unique/i.test(err?.message || ''))
          ? 'A machine with that ID already exists.'
          : (err?.message || 'Could not add the machine.');
        errorLine.textContent = msg;
        toast(msg, 'error');
      } finally {
        saveBtn.disabled = false;
        if (span) span.textContent = prevLabel;
      }
    }
  }

  // ===========================================================================
  // QR link modal — the exact URL this machine's QR must encode, with copy.
  // ===========================================================================
  function openQrLink(machine) {
    const url = SCAN_BASE + encodeURIComponent(machine.machine_id);

    const urlBox = ui.input({ type: 'text', value: url, attrs: { readonly: 'readonly' } });
    urlBox.addEventListener('focus', () => urlBox.select());

    const copyBtn = ui.button({
      label: 'Copy URL',
      variant: 'primary',
      size: 'sm',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('Scan URL copied.', 'success');
        } catch {
          urlBox.focus(); urlBox.select();
          toast('Press Ctrl+C to copy the selected URL.', 'warn');
        }
      },
    });

    ui.modal({
      title: `QR link · ${machine.machine_id}`,
      size: 'md',
      body: [
        ui.el('p', {
          class: 'sched-intro',
          text: 'Generate this machine’s QR code from the URL below (any QR generator works — or the qr-generator-multi-machine.html tool). Every scan of that QR is logged against this machine.',
        }),
        ui.field('Scan URL', urlBox),
        ui.el('div', { class: 'sched-row-actions' }, [copyBtn]),
        ui.el('p', {
          class: 'field-hint',
          text: machine.location ? `Location on file: ${machine.location}` : 'Tip: set a location so reports are readable.',
        }),
      ],
    });
  }

  // A "showing now" cell: badge with the resolved ad name (or a muted 'None').
  function nowCell(machine, adById) {
    const wrap = ui.el('span', { class: 'now-cell', dataset: { machine: machine.machine_id } });
    const resolved = resolveActiveAd(machine.machine_id);
    if (!resolved) {
      wrap.appendChild(ui.badge('None', 'muted'));
    } else {
      const ad = adById.get(resolved.ad_id);
      const name = ad?.name || `ad ${ui.shortId(resolved.ad_id)}`;
      wrap.appendChild(ui.badge(name, 'accent'));
    }
    return wrap;
  }

  // A per-machine stock cell: an inline SVG gauge + level/capacity text, or a
  // muted 'Untracked' when stock_level is null. The bar goes red when at/below
  // the low_stock_threshold (or when the server flagged _low). All text via
  // textContent; the SVG is code-authored (no DB strings in markup).
  function stockCell(machine) {
    const level = machine.stock_level;
    if (level == null) {
      return ui.el('span', { class: 'stock-cell' }, ui.badge('Untracked', 'muted'));
    }
    const cap = machine.capacity != null && machine.capacity > 0 ? machine.capacity : null;
    const threshold = machine.low_stock_threshold != null ? machine.low_stock_threshold : 10;
    const pct = cap ? Math.max(0, Math.min(1, level / cap)) : (level > 0 ? 1 : 0);
    const low = machine._low === true || level <= threshold;
    const tone = level === 0 ? 'danger' : (low ? 'warn' : 'ok');

    const wrap = ui.el('span', {
      class: 'stock-cell',
      dataset: { machine: machine.machine_id },
      style: { display: 'inline-flex', alignItems: 'center', gap: '8px' },
    });
    wrap.appendChild(stockGauge(pct, tone));
    wrap.appendChild(ui.el('span', {
      class: 'stock-label',
      style: { fontSize: '13px', whiteSpace: 'nowrap' },
      // Level (/capacity if known). textContent — safe.
      text: cap ? `${level} / ${cap}` : String(level),
    }));
    if (low) {
      const days = machine._daysToEmpty;
      wrap.appendChild(ui.badge(
        level === 0 ? 'Empty'
          : (days != null && Number.isFinite(Number(days)) ? `Low · ~${Number(days).toFixed(1)}d` : 'Low'),
        tone,
      ));
    }
    return wrap;
  }

  // A tiny fixed-width horizontal gauge as inline SVG. Colour maps to tone via
  // CSS custom properties the console already defines. Code-authored markup.
  function stockGauge(pct, tone) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 56, H = 8, R = 4;
    const fillColor = tone === 'danger' ? 'var(--danger, #e5484d)'
      : tone === 'warn' ? 'var(--warn, #f5a623)'
      : 'var(--ok, #30a46c)';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Stock ${Math.round(pct * 100)}%`);
    svg.setAttribute('class', 'stock-gauge');
    const track = document.createElementNS(NS, 'rect');
    track.setAttribute('x', '0'); track.setAttribute('y', '0');
    track.setAttribute('width', String(W)); track.setAttribute('height', String(H));
    track.setAttribute('rx', String(R));
    track.setAttribute('fill', 'var(--surface-2, rgba(255,255,255,0.12))');
    svg.appendChild(track);
    const fw = Math.max(0, Math.min(W, W * pct));
    if (fw > 0) {
      const fill = document.createElementNS(NS, 'rect');
      fill.setAttribute('x', '0'); fill.setAttribute('y', '0');
      fill.setAttribute('width', String(fw)); fill.setAttribute('height', String(H));
      fill.setAttribute('rx', String(Math.min(R, fw / 2)));
      fill.setAttribute('fill', fillColor);
      svg.appendChild(fill);
    }
    return svg;
  }

  // ==========================================================================
  // 'Mark restocked' modal. Calls fn_admin_set_stock(p_machine, p_stock,
  // p_capacity). Server logs a 'restock' event + sets approved-by via auth.uid().
  // ==========================================================================
  function openRestockForm(machine) {
    const capDefault = machine.capacity != null ? machine.capacity : '';
    // Default the new level to capacity when known (a full restock), else blank.
    const levelDefault = machine.capacity != null ? machine.capacity
      : (machine.stock_level != null ? machine.stock_level : '');

    const stockInput = ui.input({ type: 'number', value: String(levelDefault), min: 0, step: 1 });
    const capInput = ui.input({ type: 'number', value: String(capDefault), min: 0, step: 1 });
    const errorLine = ui.el('div', { class: 'auth-msg', attrs: { 'aria-live': 'polite' } });

    const form = ui.el('form', { class: 'sched-form' }, [
      ui.el('p', {
        class: 'sched-intro',
        text: machine.location
          ? `${machine.machine_id} · ${machine.location} — set the stock level after refilling. Leaving capacity blank keeps the existing value.`
          : `${machine.machine_id} — set the stock level after refilling. Leaving capacity blank keeps the existing value.`,
      }),
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('New stock level', stockInput, { hint: 'Units in the machine now. 0 = empty.' }),
        ui.field('Capacity (optional)', capInput, { hint: 'Max units this machine holds. Blank = unchanged.' }),
      ]),
      errorLine,
    ]);

    const saveBtn = ui.button({ label: 'Mark restocked', variant: 'primary', onClick: () => submit() });

    const formModal = ui.modal({
      title: `Restock · ${machine.machine_id}`,
      size: 'md',
      body: form,
      actions: [
        ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => formModal.close() }),
        saveBtn,
      ],
    });

    async function submit() {
      errorLine.textContent = '';
      const stockVal = stockInput.value === '' ? null : ui.clampInt(stockInput.value, 0, 100000, 0);
      if (stockVal == null) { errorLine.textContent = 'Enter the new stock level.'; return; }
      const capRaw = capInput.value.trim();
      const capVal = capRaw === '' ? null : ui.clampInt(capRaw, 0, 100000, 0);

      saveBtn.disabled = true;
      const span = saveBtn.querySelector('span');
      const prev = span ? span.textContent : '';
      if (span) span.textContent = 'Saving…';

      try {
        const { data, error } = await supabase.rpc('fn_admin_set_stock', {
          p_machine: machine.machine_id,
          p_stock: stockVal,
          p_capacity: capVal, // null => fn keeps existing capacity
        });
        if (error) throw error;
        // Reflect the new numbers in the cached row (data may echo them back).
        const newLevel = (data && data.new_level != null) ? data.new_level : stockVal;
        machine.stock_level = newLevel;
        if (capVal != null) machine.capacity = capVal;
        machine._low = machine.low_stock_threshold != null
          ? newLevel <= machine.low_stock_threshold
          : newLevel <= 10;
        machine._daysToEmpty = undefined; // reset until next status refresh
        toast(`${machine.machine_id} marked restocked (${newLevel}).`, 'success');
        formModal.close();
        render();
      } catch (err) {
        const msg = friendlyStockError(err);
        errorLine.textContent = msg;
        toast(msg, 'error');
      } finally {
        saveBtn.disabled = false;
        if (span) span.textContent = prev;
      }
    }
  }

  // Map RPC errors (incl. not-admin) to a friendly message.
  function friendlyStockError(err) {
    const code = err?.code;
    const msg = String(err?.message || '');
    if (code === '42501' || /not_admin|permission denied/i.test(msg)) {
      return 'You do not have admin access to change stock.';
    }
    return msg || 'Could not update stock.';
  }

  // Refresh just the "showing now" cells in place (called by the minute timer).
  function updateNowColumns() {
    const adById = new Map(ads.map((a) => [a.id, a]));
    root.querySelectorAll('.now-cell').forEach((cell) => {
      const id = cell.dataset.machine;
      const machine = machines.find((m) => m.machine_id === id);
      if (!machine) return;
      ui.clear(cell);
      const resolved = resolveActiveAd(id);
      if (!resolved) {
        cell.appendChild(ui.badge('None', 'muted'));
      } else {
        const ad = adById.get(resolved.ad_id);
        const name = ad?.name || `ad ${ui.shortId(resolved.ad_id)}`;
        cell.appendChild(ui.badge(name, 'accent'));
      }
    });
  }

  // ===========================================================================
  // Schedule manager (per machine) — a modal listing that machine's schedules
  // plus the all-machines ones that apply to it, with add / edit / delete.
  // ===========================================================================
  function openScheduleManager(machine) {
    const adById = new Map(ads.map((a) => [a.id, a]));

    // Body container we re-render in place after any mutation.
    const listHost = ui.el('div', { class: 'sched-list-host' });

    function schedulesForMachine() {
      // Machine-specific rows + all-machines rows (machine_id NULL) that this
      // machine inherits. Sorted: specific first, then by priority desc.
      return schedules
        .filter((s) => s.machine_id == null || s.machine_id === machine.machine_id)
        .sort((a, b) => {
          const aSpec = a.machine_id != null ? 1 : 0;
          const bSpec = b.machine_id != null ? 1 : 0;
          if (aSpec !== bSpec) return bSpec - aSpec;
          return (b.priority || 0) - (a.priority || 0);
        });
    }

    function renderList() {
      ui.clear(listHost);

      const resolved = resolveActiveAd(machine.machine_id);
      const resolvedAd = resolved ? adById.get(resolved.ad_id) : null;
      const nowBanner = ui.el('div', { class: 'sched-now' }, [
        ui.el('span', { class: 'sched-now-label', text: 'Showing now:' }),
        resolved
          ? ui.badge(resolvedAd?.name || `ad ${ui.shortId(resolved.ad_id)}`, 'accent')
          : ui.badge('None', 'muted'),
        ui.el('span', {
          class: 'sched-now-sub',
          text: resolved
            ? `priority ${resolved.priority || 0}${resolved.machine_id != null ? ' · machine-specific' : ' · all machines'}`
            : `no schedule active at ${ui.fmtDate(Date.now(), { mode: 'time', tz: TZ })} ${TZ}`,
        }),
      ]);

      const rows = schedulesForMachine();
      const columns = [
        {
          key: 'ad_id', label: 'Ad',
          render: (v) => {
            const ad = adById.get(v);
            return ui.el('span', { text: ad?.name || `ad ${ui.shortId(v)}` });
          },
        },
        {
          key: 'machine_id', label: 'Scope',
          render: (v) => v == null
            ? ui.badge('All machines', 'muted')
            : ui.badge('This machine', 'accent'),
        },
        {
          key: '_dates', label: 'Dates',
          render: (_v, row) => ui.el('span', { text: fmtDateRange(row.starts_on, row.ends_on) }),
        },
        {
          key: 'days_of_week', label: 'Days',
          render: (v) => ui.el('span', { text: ui.fmtDays(v) }),
        },
        {
          key: '_window', label: `Window (${TZ})`,
          render: (_v, row) => ui.el('span', { text: ui.fmtWindow(row.start_min, row.end_min) }),
        },
        {
          key: 'priority', label: 'Priority', align: 'right',
          render: (v) => String(v ?? 0),
        },
        {
          key: 'active', label: 'Active', align: 'center',
          render: (v) => v ? ui.badge('On', 'ok') : ui.badge('Off', 'muted'),
        },
        {
          key: '_actions', label: '', align: 'right',
          render: (_v, row) => {
            const inherited = row.machine_id == null;
            return ui.el('div', { class: 'sched-row-actions' }, [
              ui.button({
                label: 'Edit', variant: 'ghost', size: 'sm',
                onClick: () => openScheduleForm(machine, row),
              }),
              ui.button({
                label: 'Delete', variant: 'danger', size: 'sm',
                title: inherited ? 'This is an all-machines schedule shared by every machine.' : undefined,
                onClick: () => deleteSchedule(row, renderList),
              }),
            ]);
          },
        },
      ];

      listHost.appendChild(nowBanner);
      listHost.appendChild(ui.table(columns, rows, {
        empty: 'No schedules apply to this machine yet. Add one to control which ad shows.',
        className: 'sched-table',
      }));
    }

    renderList();

    const addBtn = ui.button({
      label: 'Add schedule',
      variant: 'primary',
      size: 'sm',
      onClick: () => openScheduleForm(machine, null),
    });

    modalRef = ui.modal({
      title: `Schedule · ${machine.machine_id}`,
      size: 'lg',
      body: [
        ui.el('p', {
          class: 'sched-intro',
          text: machine.location
            ? `${machine.location} — add, edit or remove the ad schedules that decide which ad this machine plays.`
            : 'Add, edit or remove the ad schedules that decide which ad this machine plays.',
        }),
        listHost,
      ],
      actions: [
        addBtn,
        ui.button({ label: 'Close', variant: 'ghost', onClick: () => modalRef.close() }),
      ],
    });

    // Expose renderList so the form can refresh the underlying list after saving.
    modalRef._renderList = renderList;
  }

  // Keep a handle so the form can re-render the manager list after a save.
  let modalRef = null;

  // ===========================================================================
  // Schedule add/edit form (nested modal). `existing` null = create.
  // ===========================================================================
  function openScheduleForm(machine, existing) {
    if (ads.length === 0) {
      toast('Create an ad first — there are no ads to schedule.', 'warn');
      return;
    }

    const isEdit = !!existing;
    const s = existing || {};

    // --- Ad picker -----------------------------------------------------------
    // Label non-approved ads so it's obvious in the picker.
    const adSelect = ui.select({
      options: ads.map((a) => {
        const suffix = a.approval_status && a.approval_status !== 'approved'
          ? ` (${a.approval_status})`
          : (a.active ? '' : ' (inactive)');
        return { value: a.id, label: `${a.name}${suffix}` };
      }),
      value: s.ad_id ?? ads[0].id,
      placeholder: isEdit ? undefined : 'Choose an ad…',
    });

    // Soft approval warning: shown only when the chosen ad is not 'approved'.
    // We DO NOT block saving — the row is allowed, but it won't serve until the
    // ad is approved (enforced server-side in fn_active_ad_for_machine).
    const approvalWarn = ui.el('div', {
      class: 'field-hint sched-approval-warn',
      attrs: { 'aria-live': 'polite' },
      style: { display: 'none' },
    });
    function refreshApprovalWarn() {
      const chosen = ads.find((a) => a.id === adSelect.value);
      const st = chosen?.approval_status;
      if (chosen && st && st !== 'approved') {
        approvalWarn.style.display = '';
        // textContent — safe.
        approvalWarn.textContent =
          `Heads up: “${chosen.name}” is ${st}, not approved. You can save this schedule, `
          + 'but the machine will not play this ad until it is approved on the Ads page.';
      } else {
        approvalWarn.style.display = 'none';
        approvalWarn.textContent = '';
      }
    }
    adSelect.addEventListener('change', refreshApprovalWarn);

    // --- Scope (this machine vs all machines) --------------------------------
    const scopeSelect = ui.select({
      options: [
        { value: 'machine', label: `This machine (${machine.machine_id})` },
        { value: 'all', label: 'All machines' },
      ],
      value: (s.machine_id == null && isEdit) ? 'all' : 'machine',
    });

    // --- Date range ----------------------------------------------------------
    const startsInput = ui.input({ type: 'date', value: s.starts_on || '' });
    const endsInput = ui.input({ type: 'date', value: s.ends_on || '' });

    // --- Days-of-week checkboxes (0=Sun..6=Sat) ------------------------------
    const selectedDays = new Set(Array.isArray(s.days_of_week) ? s.days_of_week : []);
    const dayBoxes = ui.WEEKDAYS.map((label, idx) =>
      ui.checkbox({
        label,
        checked: selectedDays.has(idx),
        onChange: (e) => {
          if (e.target.checked) selectedDays.add(idx);
          else selectedDays.delete(idx);
        },
      })
    );
    const daysRow = ui.el('div', { class: 'sched-days' }, dayBoxes);

    // --- Time window (HH:MM pickers -> start_min/end_min) --------------------
    const startTime = ui.input({ type: 'time', value: ui.minToHHMM(s.start_min) });
    const endTime = ui.input({ type: 'time', value: ui.minToHHMM(s.end_min) });
    const windowPreview = ui.el('div', { class: 'field-hint sched-window-preview' });
    function refreshWindowPreview() {
      const sm = ui.hhmmToMin(startTime.value);
      const em = ui.hhmmToMin(endTime.value);
      windowPreview.textContent = `${ui.fmtWindow(sm, em)} · times are ${TZ}`;
    }
    startTime.addEventListener('input', refreshWindowPreview);
    endTime.addEventListener('input', refreshWindowPreview);
    refreshWindowPreview();
    refreshApprovalWarn();

    // --- Priority + active ---------------------------------------------------
    const priorityInput = ui.input({
      type: 'number', value: String(s.priority ?? 0), min: 0, step: 1,
    });
    const activeCheck = ui.checkbox({
      label: 'Active',
      checked: isEdit ? !!s.active : true,
    });

    const errorLine = ui.el('div', { class: 'auth-msg', attrs: { 'aria-live': 'polite' } });

    const form = ui.el('form', { class: 'sched-form' }, [
      ui.field('Ad', adSelect, { hint: 'Which ad this schedule plays.' }),
      approvalWarn,
      ui.field('Scope', scopeSelect, {
        hint: 'Machine-specific schedules beat all-machines ones on a priority tie.',
      }),
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('Starts on', startsInput, { hint: 'Blank = open start.' }),
        ui.field('Ends on', endsInput, { hint: 'Blank = open end.' }),
      ]),
      ui.field('Days of week', daysRow, { hint: 'None selected = every day.' }),
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('From', startTime, { hint: `Start of window (${TZ}).` }),
        ui.field('To', endTime, { hint: `End of window (${TZ}). Equal = all day; earlier = overnight.` }),
      ]),
      windowPreview,
      ui.el('div', { class: 'sched-grid-2' }, [
        ui.field('Priority', priorityInput, { hint: 'Higher wins.' }),
        ui.field('Status', activeCheck),
      ]),
      errorLine,
    ]);

    const saveBtn = ui.button({
      label: isEdit ? 'Save changes' : 'Add schedule',
      variant: 'primary',
      onClick: () => submit(),
    });

    const formModal = ui.modal({
      title: isEdit ? 'Edit schedule' : 'New schedule',
      size: 'md',
      body: form,
      actions: [
        ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => formModal.close() }),
        saveBtn,
      ],
    });

    async function submit() {
      errorLine.textContent = '';

      const adId = adSelect.value;
      if (!adId) { errorLine.textContent = 'Pick an ad.'; return; }

      const sm = ui.hhmmToMin(startTime.value);
      const em = ui.hhmmToMin(endTime.value);
      // start_min must be 0..1439, end_min 1..1440 per the contract; both null is
      // fine (open = all day). If exactly one is set we still allow it (open on the
      // other side). Guard the numeric ranges the DB enforces.
      if (sm != null && (sm < 0 || sm > 1439)) {
        errorLine.textContent = 'Start time must be 00:00–23:59.'; return;
      }
      if (em != null && (em < 1 || em > 1440)) {
        errorLine.textContent = 'End time must be 00:01–24:00.'; return;
      }

      const daysArr = Array.from(selectedDays).sort((a, b) => a - b);

      const payload = {
        ad_id: adId,
        machine_id: scopeSelect.value === 'all' ? null : machine.machine_id,
        starts_on: startsInput.value || null,
        ends_on: endsInput.value || null,
        days_of_week: daysArr.length ? daysArr : null,
        start_min: sm,
        end_min: em,
        priority: ui.clampInt(priorityInput.value, 0, 1_000_000, 0),
        active: activeCheck.querySelector('input').checked,
      };

      saveBtn.disabled = true;
      const span = saveBtn.querySelector('span');
      const prevLabel = span ? span.textContent : '';
      if (span) span.textContent = 'Saving…';

      try {
        if (isEdit) {
          const { data, error } = await supabase
            .from('ad_schedules').update(payload).eq('id', s.id).select().single();
          if (error) throw error;
          // Replace in cache.
          const i = schedules.findIndex((x) => x.id === s.id);
          if (i >= 0) schedules[i] = data; else schedules.push(data);
        } else {
          const { data, error } = await supabase
            .from('ad_schedules').insert(payload).select().single();
          if (error) throw error;
          schedules.push(data);
        }
        toast(isEdit ? 'Schedule updated.' : 'Schedule added.', 'success');
        formModal.close();
        // Refresh the manager list + the underlying machines table "now" cells.
        if (modalRef && typeof modalRef._renderList === 'function') modalRef._renderList();
        updateNowColumns();
      } catch (err) {
        errorLine.textContent = err?.message || 'Save failed.';
        toast(err?.message || 'Could not save schedule.', 'error');
      } finally {
        saveBtn.disabled = false;
        if (span) span.textContent = prevLabel;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Delete a schedule (confirmed).
  // ---------------------------------------------------------------------------
  async function deleteSchedule(row, afterDelete) {
    const ok = await ui.confirmDialog({
      title: 'Delete schedule?',
      message: row.machine_id == null
        ? 'This is an ALL-MACHINES schedule — deleting it removes it from every machine, not just this one.'
        : 'This schedule will be removed from this machine.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      const { error } = await supabase.from('ad_schedules').delete().eq('id', row.id);
      if (error) throw error;
      schedules = schedules.filter((x) => x.id !== row.id);
      toast('Schedule deleted.', 'success');
      if (typeof afterDelete === 'function') afterDelete();
      updateNowColumns();
    } catch (err) {
      toast(err?.message || 'Could not delete schedule.', 'error');
    }
  }

  // ===========================================================================
  // resolveActiveAd(machineId) — CLIENT-SIDE mirror of the server rules.
  // Returns the winning schedule row (or null) for `machineId` at "now" in TZ.
  // ===========================================================================
  function resolveActiveAd(machineId) {
    const { dow, minutes, ymd } = londonNowParts(TZ);

    const candidates = schedules.filter((s) => {
      if (!s.active) return false;
      // Scope: NULL machine_id = all machines; else must match exactly.
      if (s.machine_id != null && s.machine_id !== machineId) return false;
      // Date range (inclusive; string YYYY-MM-DD compares lexicographically).
      if (s.starts_on && ymd < s.starts_on) return false;
      if (s.ends_on && ymd > s.ends_on) return false;
      // Weekday: null/empty = every day.
      if (Array.isArray(s.days_of_week) && s.days_of_week.length > 0 &&
          !s.days_of_week.includes(dow)) return false;
      // Time-of-day window (half-open).
      if (!withinWindow(minutes, s.start_min, s.end_min)) return false;
      return true;
    });

    if (candidates.length === 0) return null;

    // Higher priority wins; tie -> machine-specific (machine_id set) beats
    // all-machines (machine_id NULL).
    candidates.sort((a, b) => {
      const pa = a.priority || 0, pb = b.priority || 0;
      if (pa !== pb) return pb - pa;
      const aSpec = a.machine_id != null ? 1 : 0;
      const bSpec = b.machine_id != null ? 1 : 0;
      return bSpec - aSpec;
    });
    return candidates[0];
  }

  // Is minute-of-day `now` inside the half-open [start, end) window?
  // both null OR start==end => all day (always true);
  // one bound null => that side open; end<start => overnight wrap.
  function withinWindow(now, start, end) {
    if (start == null && end == null) return true;
    if (start != null && end != null && start === end) return true; // all day
    if (start == null) return now < end;          // open start -> [00:00, end)
    if (end == null) return now >= start;         // open end -> [start, 24:00)
    if (end > start) return now >= start && now < end;  // normal
    // end < start -> overnight wrap: [start, 1440) ∪ [0, end)
    return now >= start || now < end;
  }
}

// =============================================================================
// Time helpers (module scope — pure, no ctx needed).
// =============================================================================

// Current wall-clock in the given IANA tz, broken into the pieces the resolver
// needs: day-of-week (0=Sun..6=Sat), minute-of-day, and YYYY-MM-DD string.
function londonNowParts(tz) {
  const now = new Date();
  let dow = now.getDay();
  let minutes = now.getHours() * 60 + now.getMinutes();
  let ymd = toYmd(now);

  try {
    // Extract tz-local wall-clock fields via Intl (locale-independent 'en-GB').
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const wk = get('weekday');
    const WK = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    if (wk != null && WK[wk] != null) dow = WK[wk];
    let hh = Number(get('hour'));
    const mm = Number(get('minute'));
    if (hh === 24) hh = 0; // some engines emit '24' at midnight
    if (Number.isFinite(hh) && Number.isFinite(mm)) minutes = hh * 60 + mm;
    const y = get('year'), mo = get('month'), d = get('day');
    if (y && mo && d) ymd = `${y}-${mo}-${d}`;
  } catch {
    // Fall back to local time already computed above.
  }
  return { dow, minutes, ymd };
}

function toYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Human date-range label for the schedule table.
function fmtDateRange(startsOn, endsOn) {
  if (!startsOn && !endsOn) return 'Always';
  if (startsOn && !endsOn) return `From ${startsOn}`;
  if (!startsOn && endsOn) return `Until ${endsOn}`;
  return `${startsOn} → ${endsOn}`;
}
