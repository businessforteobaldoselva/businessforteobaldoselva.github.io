// =============================================================================
// COVERED Admin Console — Tasks view
// -----------------------------------------------------------------------------
// Launch/ops checklist backed by the `tasks` table.
//
//   • Loads all tasks ordered by (section, sort_order) and keeps a LOCAL CACHE
//     so status flips re-render instantly without a refetch.
//   • Header card: "X of N done", a simple progress bar, and per-status counts.
//   • One card per section (in load order); each row shows title (+ an
//     expandable secondary line for goal/plan/notes), assignee, a status badge,
//     and a small inline select to change status (writes status + updated_at).
//   • "Add task" and per-row "Edit" share one modal form: section (select of
//     existing sections with a "New section…" free-text option), title
//     (required), goal, plan, assignee, notes, status.
//   • Delete asks for confirmation via ui.confirmDialog.
//
// CONTRACT NOTES this file honours:
//   - Everything is appended into `root`; the modal renders into its own host
//     via ui.modal, and toasts via ui.toast — the only permitted exceptions.
//   - Every supabase call is wrapped; on error we toast (+ errorState for the
//     initial load, with retry).
//   - ALL DB/user text reaches the DOM via ui.el text props / textContent /
//     ui.badge / table cell renderers — NEVER innerHTML.
//   - Returns a cleanup fn that closes any open modal so the router can tear
//     the view down cleanly.
// =============================================================================

const STATUSES = [
  { value: 'not_started', label: 'Not started', tone: 'muted' },
  { value: 'in_progress', label: 'In progress', tone: 'accent' },
  { value: 'done',        label: 'Done',        tone: 'ok' },
  { value: 'blocked',     label: 'Blocked',     tone: 'danger' },
];

// Map a raw status value to display metadata. Unknown/blank -> shown as-is
// with a muted tone so bad data is visible rather than hidden.
function statusMeta(value) {
  const v = String(value || 'not_started');
  return STATUSES.find((s) => s.value === v)
    || { value: v, label: v, tone: 'muted' };
}

export default async function mount(root, ctx) {
  const { supabase, ui } = ctx;

  let tasks = [];        // local cache, in (section, sort_order) load order
  let openModal = null;  // { el, close } while the add/edit modal is open
  let destroyed = false;

  // --- Static skeleton: header (progress) card + host for section cards. -----
  const headerCard = ui.card({
    title: 'Tasks',
    subtitle: 'Working checklist, grouped by section.',
    actions: ui.button({
      label: 'Add task',
      variant: 'primary',
      onClick: () => openForm(null),
    }),
  });
  const sectionsHost = ui.el('div', { class: 'tasks-sections' });
  root.appendChild(headerCard);
  root.appendChild(sectionsHost);

  // ---------------------------------------------------------------------------
  // Data load.
  // ---------------------------------------------------------------------------
  async function loadTasks() {
    ui.render(headerCard.body, ui.spinner('Loading tasks…'));
    ui.clear(sectionsHost);

    let data, error;
    try {
      ({ data, error } = await supabase
        .from('tasks')
        .select('*')
        .order('section')
        .order('sort_order'));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      ui.toast(error.message || 'Failed to load tasks.', 'error');
      ui.render(headerCard.body, ui.errorState(
        'Could not load tasks. ' + (error.message || ''),
        () => loadTasks(),
      ));
      return;
    }

    tasks = data || [];
    renderAll();
  }

  // Re-render both the progress header and the section cards from the cache.
  function renderAll() {
    renderProgress();
    renderSections();
  }

  // ---------------------------------------------------------------------------
  // Header: progress bar + per-status counts.
  // ---------------------------------------------------------------------------
  function renderProgress() {
    const total = tasks.length;
    const doneCount = tasks.filter((t) => t.status === 'done').length;
    const pct = total ? Math.round((doneCount / total) * 100) : 0;

    const summary = ui.el('div', {
      class: 'tasks-progress-summary',
      text: `${doneCount} of ${total} done`,
      style: { fontWeight: '600', marginBottom: '8px' },
    });

    // Simple progress bar: outer track + inner fill sized by width %.
    const fill = ui.el('div', {
      class: 'tasks-progress-fill',
      style: {
        width: pct + '%',
        height: '100%',
        borderRadius: '999px',
        background: 'var(--accent, #4f8cff)',
        transition: 'width 0.2s ease',
      },
    });
    const bar = ui.el('div', {
      class: 'tasks-progress-bar',
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(pct),
        'aria-label': 'Tasks completed',
      },
      style: {
        height: '10px',
        borderRadius: '999px',
        background: 'rgba(127, 127, 127, 0.2)',
        overflow: 'hidden',
        marginBottom: '12px',
      },
    }, fill);

    // Counts by status as toned badges.
    const counts = ui.el('div', {
      class: 'tasks-status-counts',
      style: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
    }, STATUSES.map((s) => {
      const n = tasks.filter((t) => String(t.status || 'not_started') === s.value).length;
      return ui.badge(`${s.label}: ${n}`, s.tone);
    }));

    ui.render(headerCard.body, ui.el('div', { class: 'tasks-progress' }, [
      summary, bar, counts,
    ]));
  }

  // ---------------------------------------------------------------------------
  // Section cards (one per section, in load order) with a task table each.
  // ---------------------------------------------------------------------------
  function renderSections() {
    ui.clear(sectionsHost);

    if (!tasks.length) {
      const empty = ui.card({});
      ui.render(empty.body, ui.emptyState(
        'No tasks yet. Add the first one.',
        ui.button({ label: 'Add task', variant: 'primary', onClick: () => openForm(null) }),
      ));
      sectionsHost.appendChild(empty);
      return;
    }

    // Group by section, preserving the DB (section asc) order.
    const groups = new Map();
    for (const t of tasks) {
      const key = String(t.section || '').trim() || 'General';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }

    for (const [section, rows] of groups) {
      const done = rows.filter((r) => r.status === 'done').length;
      const cardEl = ui.card({
        title: section,
        subtitle: `${done} of ${rows.length} done`,
        className: 'tasks-section-card',
      });
      ui.render(cardEl.body, buildTable(rows));
      sectionsHost.appendChild(cardEl);
    }
  }

  function buildTable(rows) {
    const columns = [
      {
        key: 'title',
        label: 'Task',
        render: (v, row) => titleCell(v, row),
      },
      {
        key: 'assignee',
        label: 'Assignee',
        render: (v) => ui.el('span', { text: (v == null || String(v).trim() === '') ? '—' : String(v) }),
      },
      {
        key: 'status',
        label: 'Status',
        render: (_v, row) => statusCell(row),
      },
      {
        key: 'id',
        label: 'Actions',
        align: 'right',
        render: (_v, row) => ui.el('div', { class: 'row-actions' }, [
          ui.button({
            label: 'Edit', variant: 'ghost', size: 'sm',
            onClick: () => openForm(row),
          }),
          ui.button({
            label: 'Delete', variant: 'danger', size: 'sm',
            onClick: () => onDelete(row),
          }),
        ]),
      },
    ];

    return ui.table(columns, rows, { empty: 'No tasks in this section.' });
  }

  // Title + an expandable secondary block for goal / plan / notes. All text is
  // rendered via el text props (textContent) — never markup.
  function titleCell(title, row) {
    const wrap = ui.el('div', { class: 'task-title-cell' });
    const titleRow = ui.el('div', {
      class: 'task-title-row',
      style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    }, ui.el('span', {
      class: 'task-title',
      text: title || ui.shortId(row.id),
      style: { fontWeight: '500' },
    }));
    wrap.appendChild(titleRow);

    const detailBits = [];
    if (row.goal != null && String(row.goal).trim() !== '') detailBits.push(detailLine('Goal', row.goal));
    if (row.plan != null && String(row.plan).trim() !== '') detailBits.push(detailLine('Plan', row.plan));
    if (row.notes != null && String(row.notes).trim() !== '') detailBits.push(detailLine('Notes', row.notes));

    if (detailBits.length) {
      const detail = ui.el('div', {
        class: 'task-detail',
        style: {
          display: 'none',
          marginTop: '6px',
          fontSize: '0.85rem',
          opacity: '0.85',
        },
      }, detailBits);

      const toggle = ui.button({
        label: 'Details',
        variant: 'ghost',
        size: 'sm',
        onClick: () => {
          const isOpen = detail.style.display !== 'none';
          detail.style.display = isOpen ? 'none' : '';
          const span = toggle.querySelector('span');
          if (span) span.textContent = isOpen ? 'Details' : 'Hide';
        },
      });
      titleRow.appendChild(toggle);
      wrap.appendChild(detail);
    }

    return wrap;
  }

  function detailLine(label, value) {
    return ui.el('div', {
      class: 'task-detail-line',
      style: { whiteSpace: 'pre-wrap', marginBottom: '4px' },
    }, [
      ui.el('strong', { text: label + ': ' }),
      ui.el('span', { text: String(value) }),
    ]);
  }

  // Badge + inline editable status select.
  function statusCell(row) {
    const meta = statusMeta(row.status);
    const sel = ui.select({
      options: STATUSES,
      value: STATUSES.some((s) => s.value === String(row.status)) ? String(row.status) : 'not_started',
      onChange: (e) => onStatusChange(row, e.target.value, sel),
      attrs: { 'aria-label': 'Task status' },
      style: { width: 'auto', minWidth: '130px', fontSize: '0.85rem' },
    });
    return ui.el('div', {
      class: 'task-status-cell',
      style: { display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' },
    }, [
      ui.badge(meta.label, meta.tone),
      sel,
    ]);
  }

  // ---------------------------------------------------------------------------
  // Inline status change: write status + updated_at, then update the local
  // cache and re-render (badge, section subtitle, header progress) — no refetch.
  // ---------------------------------------------------------------------------
  async function onStatusChange(row, next, selectEl) {
    if (next === String(row.status || 'not_started')) return;

    selectEl.disabled = true;
    const nowIso = new Date().toISOString();
    let error;
    try {
      ({ error } = await supabase
        .from('tasks')
        .update({ status: next, updated_at: nowIso })
        .eq('id', row.id));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;
    selectEl.disabled = false;

    if (error) {
      // Revert the control to the cached value.
      selectEl.value = STATUSES.some((s) => s.value === String(row.status)) ? String(row.status) : 'not_started';
      ui.toast(error.message || 'Could not update status.', 'error');
      return;
    }

    row.status = next;
    row.updated_at = nowIso;
    ui.toast('Status updated.', 'success');
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Delete (confirm -> delete -> local cache update).
  // ---------------------------------------------------------------------------
  async function onDelete(task) {
    const ok = await ui.confirmDialog({
      title: 'Delete task?',
      message: `“${task.title || ui.shortId(task.id)}” will be permanently removed. `
        + 'This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok || destroyed) return;

    let error;
    try {
      ({ error } = await supabase.from('tasks').delete().eq('id', task.id));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      ui.toast(error.message || 'Delete failed.', 'error');
      return;
    }
    tasks = tasks.filter((t) => t.id !== task.id);
    ui.toast('Task deleted.', 'success');
    renderAll();
  }

  // ---------------------------------------------------------------------------
  // Add / edit form in a modal. `task` is null for create, or the row for edit.
  // ---------------------------------------------------------------------------
  function openForm(task) {
    const isEdit = !!task;
    const NEW_SECTION = '__new__';

    // Distinct existing sections, in current display order.
    const sections = [...new Set(
      tasks.map((t) => String(t.section || '').trim()).filter(Boolean)
    )];

    const model = {
      section: task?.section ?? (sections[0] || ''),
      title: task?.title ?? '',
      goal: task?.goal ?? '',
      plan: task?.plan ?? '',
      assignee: task?.assignee ?? '',
      notes: task?.notes ?? '',
      status: STATUSES.some((s) => s.value === String(task?.status)) ? String(task.status) : 'not_started',
    };

    // Section: select of existing sections + a "New section…" free-text option.
    const startsNew = !sections.includes(String(model.section || '').trim());
    const newSectionInput = ui.input({
      value: startsNew ? String(model.section || '') : '',
      placeholder: 'New section name',
      onInput: (e) => { model.section = e.target.value; },
    });
    const newSectionField = ui.field('New section name', newSectionInput, {
      hint: 'Blank falls back to “General”.',
    });
    newSectionField.style.display = startsNew ? '' : 'none';

    const sectionSelect = ui.select({
      options: [
        ...sections.map((s) => ({ value: s, label: s })),
        { value: NEW_SECTION, label: 'New section…' },
      ],
      value: startsNew ? NEW_SECTION : String(model.section).trim(),
      onChange: (e) => {
        if (e.target.value === NEW_SECTION) {
          model.section = newSectionInput.value;
          newSectionField.style.display = '';
          newSectionInput.focus();
        } else {
          model.section = e.target.value;
          newSectionField.style.display = 'none';
        }
      },
    });

    const titleInput = ui.input({
      value: model.title, placeholder: 'What needs doing (required)', required: true,
      onInput: (e) => { model.title = e.target.value; },
    });
    const goalInput = ui.textarea({
      value: model.goal, rows: 2, placeholder: 'What “done” looks like',
      onInput: (e) => { model.goal = e.target.value; },
    });
    const planInput = ui.textarea({
      value: model.plan, rows: 3, placeholder: 'How it will get done (steps, links)',
      onInput: (e) => { model.plan = e.target.value; },
    });
    const assigneeInput = ui.input({
      value: model.assignee, placeholder: 'Who owns this',
      onInput: (e) => { model.assignee = e.target.value; },
    });
    const notesInput = ui.textarea({
      value: model.notes, rows: 3, placeholder: 'Anything else worth knowing',
      onInput: (e) => { model.notes = e.target.value; },
    });
    const statusSelect = ui.select({
      options: STATUSES,
      value: model.status,
      onChange: (e) => { model.status = e.target.value; },
    });

    const form = ui.el('form', {
      class: 'task-form',
      onsubmit: (e) => { e.preventDefault(); save(); },
    }, [
      ui.field('Section', sectionSelect),
      newSectionField,
      ui.field('Title', titleInput, { hint: 'Required.' }),
      ui.field('Goal', goalInput),
      ui.field('Plan', planInput),
      ui.field('Assignee', assigneeInput),
      ui.field('Notes', notesInput),
      ui.field('Status', statusSelect),
    ]);

    const saveBtn = ui.button({
      label: isEdit ? 'Save changes' : 'Add task',
      variant: 'primary',
      type: 'button',
      onClick: () => save(),
    });
    const cancelBtn = ui.button({
      label: 'Cancel', variant: 'ghost',
      onClick: () => closeForm(),
    });

    let saving = false;
    async function save() {
      if (saving || destroyed) return;

      const title = model.title.trim();
      if (!title) {
        ui.toast('Title is required.', 'warn');
        titleInput.focus();
        return;
      }
      const section = String(model.section || '').trim() || 'General';

      const payload = {
        section,
        title,
        goal: nn(model.goal),
        plan: nn(model.plan),
        assignee: nn(model.assignee),
        notes: nn(model.notes),
        status: STATUSES.some((s) => s.value === model.status) ? model.status : 'not_started',
      };

      saving = true;
      saveBtn.disabled = true;

      let error;
      try {
        if (isEdit) {
          ({ error } = await supabase
            .from('tasks')
            .update({ ...payload, updated_at: new Date().toISOString() })
            .eq('id', task.id));
        } else {
          // Append at the end of the chosen section.
          const inSection = tasks.filter(
            (t) => (String(t.section || '').trim() || 'General') === section
          );
          const nextOrder = inSection.reduce(
            (m, t) => Math.max(m, Number(t.sort_order) || 0), 0
          ) + 1;
          ({ error } = await supabase
            .from('tasks')
            .insert({ ...payload, sort_order: nextOrder }));
        }
      } catch (err) {
        error = err;
      }

      saving = false;
      if (destroyed) return;
      saveBtn.disabled = false;

      if (error) {
        ui.toast(error.message || 'Save failed.', 'error');
        return;
      }
      ui.toast(isEdit ? 'Task updated.' : 'Task added.', 'success');
      closeForm();
      loadTasks();
    }

    function closeForm() {
      if (openModal) { const m = openModal; openModal = null; m.close(); }
    }

    openModal = ui.modal({
      title: isEdit ? 'Edit task' : 'Add task',
      size: 'md',
      body: form,
      actions: [cancelBtn, saveBtn],
      onClose: () => { openModal = null; },
    });
  }

  // Empty/whitespace string -> null (an "unset" optional field).
  function nn(v) {
    const s = (v == null ? '' : String(v)).trim();
    return s === '' ? null : s;
  }

  // ---------------------------------------------------------------------------
  // Initial load.
  // ---------------------------------------------------------------------------
  await loadTasks();

  // ---------------------------------------------------------------------------
  // Cleanup: close a lingering modal so nothing survives the view teardown.
  // ---------------------------------------------------------------------------
  return () => {
    destroyed = true;
    if (openModal) { try { openModal.close(); } catch { /* ignore */ } openModal = null; }
  };
}
