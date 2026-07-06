// =============================================================================
// COVERED Admin Console — Ads view
// -----------------------------------------------------------------------------
// Full CRUD over the `ads` table plus a live consumer-card preview.
//
//   • Lists all ads in a table (name, advertiser, duration, active, approval,
//       updated).
//   • "New ad" and per-row "Edit" open a modal form with every ad field:
//       name (required), headline, tagline, cta_text, bg_gradient, text_color,
//       image_url, duration_seconds (2..30), advertiser, active.
//   • The modal shows a LIVE PREVIEW (ui.adCard) that re-renders as you type,
//       exactly mirroring the consumer ad card.
//   • Per-row Approve/Reject drive the approval_status via the admin RPC
//       fn_admin_set_ad_approval (Reject prompts for a reason).
//   • Per-row Delete asks for confirmation (ui.confirmDialog) then removes.
//
// CONTRACT NOTES this file honours:
//   - Everything is appended into `root`; the modal renders into its own host
//     via ui.modal, and toasts via ui.toast — the only permitted exceptions.
//   - Every supabase call is wrapped; on error we toast + render errorState.
//   - ALL DB/user text is rendered with textContent (ui.el text / table cells /
//     adCard). Gradient/colour/image only ever reach a style property through
//     ui.safeGradient / safeColor / safeImageUrl (adCard does this internally).
//   - The ad create/edit insert+update payloads contain ONLY content columns —
//     NEVER the approval_* columns. Those column grants are REVOKED for the
//     console; approval changes MUST go through fn_admin_set_ad_approval, which
//     sets approval_status + approved_by/approved_at server-side. Including any
//     approval_* field in a PATCH/POST returns PostgREST 403.
//   - Returns a cleanup fn that stops the live preview countdown + closes any
//     open modal, so the router can tear the view down cleanly.
// =============================================================================

export default async function mount(root, ctx) {
  const { supabase, ui } = ctx;

  // Track disposable resources so the router's teardown is total.
  let previewHandle = null;     // { el, start, stop } from ui.adCard (live)
  let openModal = null;         // { el, close } while a form modal is open
  let destroyed = false;

  // The card that hosts the ads table; we re-render its body on data changes.
  const listCard = ui.card({
    title: 'Ads',
    subtitle: 'Creatives shown on the machine before a dispense.',
    actions: ui.button({
      label: 'New ad',
      variant: 'primary',
      onClick: () => openForm(null),
    }),
  });
  root.appendChild(listCard);

  // ---------------------------------------------------------------------------
  // Data load + list render.
  // ---------------------------------------------------------------------------
  async function loadAds() {
    ui.render(listCard.body, ui.spinner('Loading ads…'));
    let data, error;
    try {
      ({ data, error } = await supabase
        .from('ads')
        .select('*')
        .order('created_at', { ascending: false }));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      ui.toast(error.message || 'Failed to load ads.', 'error');
      ui.render(listCard.body, ui.errorState(
        'Could not load ads. ' + (error.message || ''),
        () => loadAds(),
      ));
      return;
    }

    renderList(data || []);
  }

  function renderList(ads) {
    if (!ads.length) {
      ui.render(listCard.body, ui.emptyState(
        'No ads yet. Create your first creative.',
        ui.button({ label: 'New ad', variant: 'primary', onClick: () => openForm(null) }),
      ));
      return;
    }

    const columns = [
      {
        key: 'name',
        label: 'Name',
        // Show the name; fall back to a short id if somehow blank.
        render: (v, row) => ui.el('span', { text: v || ui.shortId(row.id) }),
      },
      {
        key: 'advertiser',
        label: 'Advertiser',
        render: (v) => ui.el('span', { text: v || '—' }),
      },
      {
        key: 'duration_seconds',
        label: 'Duration',
        align: 'right',
        render: (v) => ui.el('span', { text: `${ui.clampInt(v, 2, 30, 5)}s` }),
      },
      {
        key: 'active',
        label: 'Active',
        render: (v) => v ? ui.badge('Active', 'ok') : ui.badge('Paused', 'muted'),
      },
      {
        key: 'approval_status',
        label: 'Approval',
        render: (v) => approvalBadge(v),
      },
      {
        key: 'updated_at',
        label: 'Updated',
        render: (v) => ui.el('span', {
          text: ui.fmtDate(v || null, { mode: 'relative' }),
        }),
      },
      {
        key: 'id',
        label: 'Actions',
        align: 'right',
        render: (_v, row) => {
          const status = row.approval_status || 'draft';
          const kids = [
            ui.button({
              label: 'Edit', variant: 'ghost', size: 'sm',
              onClick: () => openForm(row),
            }),
          ];
          // Approve unless already approved; Reject unless already rejected.
          if (status !== 'approved') {
            kids.push(ui.button({
              label: 'Approve', variant: 'ghost', size: 'sm',
              onClick: () => setApproval(row, 'approved'),
            }));
          }
          if (status !== 'rejected') {
            kids.push(ui.button({
              label: 'Reject', variant: 'ghost', size: 'sm',
              onClick: () => setApproval(row, 'rejected'),
            }));
          }
          kids.push(ui.button({
            label: 'Delete', variant: 'danger', size: 'sm',
            onClick: () => onDelete(row),
          }));
          return ui.el('div', { class: 'row-actions' }, kids);
        },
      },
    ];

    ui.render(listCard.body, ui.table(columns, ads, {
      empty: 'No ads yet.',
      caption: 'All ads, newest first.',
    }));
  }

  // ---------------------------------------------------------------------------
  // Delete (confirm -> delete -> reload).
  // ---------------------------------------------------------------------------
  async function onDelete(ad) {
    const ok = await ui.confirmDialog({
      title: 'Delete ad?',
      message: `“${ad.name || ui.shortId(ad.id)}” will be permanently removed. `
        + 'This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok || destroyed) return;

    let error;
    try {
      ({ error } = await supabase.from('ads').delete().eq('id', ad.id));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      ui.toast(error.message || 'Delete failed.', 'error');
      return;
    }
    ui.toast('Ad deleted.', 'success');
    loadAds();
  }

  // ---------------------------------------------------------------------------
  // Approval (approve / reject via fn_admin_set_ad_approval).
  // ---------------------------------------------------------------------------

  // Map approval_status -> a toned badge. Unknown/blank => 'draft'.
  function approvalBadge(status) {
    const s = String(status || 'draft');
    const tone = s === 'approved' ? 'ok'
      : s === 'rejected' ? 'danger'
      : s === 'pending' ? 'warn'
      : 'muted'; // draft
    const label = s.charAt(0).toUpperCase() + s.slice(1);
    return ui.badge(label, tone);
  }

  // Approve or reject an ad via fn_admin_set_ad_approval(p_ad_id, p_status,
  // p_reason). approved_by / approved_at are set SERVER-SIDE from auth.uid(), so
  // the client can never spoof the approver. Reject prompts for a reason.
  async function setApproval(ad, status) {
    let reason = null;
    if (status === 'rejected') {
      reason = await promptReason(ad);
      if (reason === null) return; // cancelled
    } else {
      const ok = await ui.confirmDialog({
        title: 'Approve ad?',
        message: `“${ad.name || ui.shortId(ad.id)}” will become eligible to serve on machines.`,
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    }
    if (destroyed) return;

    let error;
    try {
      ({ error } = await supabase.rpc('fn_admin_set_ad_approval', {
        p_ad_id: ad.id,
        p_status: status,
        p_reason: reason, // null for approve
      }));
    } catch (err) {
      error = err;
    }
    if (destroyed) return;

    if (error) {
      const code = error.code;
      const msg = (code === '42501' || /not_admin|permission denied/i.test(String(error.message || '')))
        ? 'You do not have admin access to change ad approval.'
        : (error.message || 'Could not update approval.');
      ui.toast(msg, 'error');
      return;
    }
    ui.toast(status === 'approved' ? 'Ad approved.' : 'Ad rejected.', 'success');
    loadAds();
  }

  // A small modal that collects an optional rejection reason. Resolves to the
  // string (possibly empty) on confirm, or null on cancel.
  function promptReason(ad) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
      const reasonInput = ui.textarea({
        placeholder: 'Why is this creative rejected? (optional — shown to whoever revisits it)',
        rows: 3,
      });
      const body = ui.el('div', {}, [
        ui.el('p', {
          class: 'confirm-msg',
          text: `Reject “${ad.name || ui.shortId(ad.id)}”? It will stop serving on all machines immediately.`,
        }),
        ui.field('Reason', reasonInput),
      ]);
      const m = ui.modal({
        title: 'Reject ad',
        size: 'sm',
        body,
        actions: [
          ui.button({ label: 'Cancel', variant: 'ghost', onClick: () => finish(null) }),
          ui.button({ label: 'Reject', variant: 'danger', onClick: () => finish((reasonInput.value || '').trim() || null) }),
        ],
        onClose: () => finish(null),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Create / edit form in a modal, with a live preview.
  // `ad` is null for create, or the existing row for edit.
  // ---------------------------------------------------------------------------
  function openForm(ad) {
    const isEdit = !!ad;

    // Working copy of the fields the form owns. For a new ad we seed sensible
    // defaults that match the DB defaults (duration 5, active true).
    const model = {
      name: ad?.name ?? '',
      headline: ad?.headline ?? '',
      tagline: ad?.tagline ?? '',
      cta_text: ad?.cta_text ?? '',
      bg_gradient: ad?.bg_gradient ?? '',
      text_color: ad?.text_color ?? '',
      image_url: ad?.image_url ?? '',
      duration_seconds: ui.clampInt(ad?.duration_seconds, 2, 30, 5),
      advertiser: ad?.advertiser ?? '',
      active: ad?.active ?? true,
    };

    // --- Live preview --------------------------------------------------------
    // adCard validates gradient/colour/image and runs a live countdown; we
    // rebuild it whenever a preview-relevant field changes so the founder sees
    // exactly what a consumer would.
    const previewHost = ui.el('div', { class: 'ad-preview-host' });

    function rebuildPreview() {
      if (previewHandle) { try { previewHandle.stop(); } catch { /* ignore */ } }
      ui.clear(previewHost);
      previewHandle = ui.adCard({
        headline: model.headline,
        tagline: model.tagline,
        cta_text: model.cta_text,
        bg_gradient: model.bg_gradient,
        text_color: model.text_color,
        image_url: model.image_url,
        duration_seconds: model.duration_seconds,
      }, { live: true });
      previewHost.appendChild(previewHandle.el);
    }
    rebuildPreview();

    // --- Field controls ------------------------------------------------------
    // Text/textarea fields update the model then refresh the preview live.
    const nameInput = ui.input({
      value: model.name, placeholder: 'Internal name (required)', required: true,
      onInput: (e) => { model.name = e.target.value; },
    });
    const advertiserInput = ui.input({
      value: model.advertiser, placeholder: 'Advertiser / brand',
      onInput: (e) => { model.advertiser = e.target.value; },
    });
    const headlineInput = ui.input({
      value: model.headline, placeholder: 'Big bold headline',
      onInput: (e) => { model.headline = e.target.value; rebuildPreview(); },
    });
    const taglineInput = ui.input({
      value: model.tagline, placeholder: 'Supporting tagline',
      onInput: (e) => { model.tagline = e.target.value; rebuildPreview(); },
    });
    const ctaInput = ui.input({
      value: model.cta_text, placeholder: 'e.g. Learn more',
      onInput: (e) => { model.cta_text = e.target.value; rebuildPreview(); },
    });
    const gradientInput = ui.input({
      value: model.bg_gradient,
      placeholder: ui.DEFAULT_AD_GRADIENT,
      onInput: (e) => { model.bg_gradient = e.target.value; rebuildPreview(); },
    });
    const textColorInput = ui.input({
      value: model.text_color, placeholder: '#ffffff',
      onInput: (e) => { model.text_color = e.target.value; rebuildPreview(); },
    });
    const imageInput = ui.input({
      value: model.image_url, placeholder: 'https://… (optional)',
      onInput: (e) => { model.image_url = e.target.value; rebuildPreview(); },
    });
    const durationInput = ui.input({
      type: 'number', value: String(model.duration_seconds),
      min: 2, max: 30, step: 1,
      onInput: (e) => {
        // Keep the model clamped so the live countdown stays in range.
        model.duration_seconds = ui.clampInt(e.target.value, 2, 30, 5);
        rebuildPreview();
      },
    });
    const activeCheck = ui.checkbox({
      label: 'Active (eligible to be shown)',
      checked: model.active,
      onChange: (e) => { model.active = e.target.checked; },
    });

    // --- Form layout ---------------------------------------------------------
    const form = ui.el('form', {
      class: 'ad-form',
      // Submitting via Enter should save, not reload the page.
      onSubmit: (e) => { e.preventDefault(); save(); },
    }, [
      ui.el('div', { class: 'ad-form-grid' }, [
        // Left column: the editable fields.
        ui.el('div', { class: 'ad-form-fields' }, [
          ui.field('Name', nameInput, { hint: 'Required. Shown in this console only.' }),
          ui.field('Advertiser', advertiserInput),
          ui.field('Headline', headlineInput),
          ui.field('Tagline', taglineInput),
          ui.field('CTA text', ctaInput),
          ui.field('Background gradient', gradientInput, {
            hint: 'CSS gradient or colour. Blank = default. Invalid values fall back safely.',
          }),
          ui.field('Text colour', textColorInput, { hint: 'Hex / rgb / named. Blank = white.' }),
          ui.field('Image URL', imageInput, { hint: 'https or relative only (optional).' }),
          ui.field('Duration (seconds)', durationInput, { hint: 'Between 2 and 30.' }),
          ui.el('div', { class: 'field' }, activeCheck),
        ]),
        // Right column: sticky live preview.
        ui.el('div', { class: 'ad-form-preview' }, [
          ui.el('div', { class: 'ad-preview-label', text: 'Live preview' }),
          previewHost,
        ]),
      ]),
    ]);

    // --- Save handler --------------------------------------------------------
    const saveBtn = ui.button({
      label: isEdit ? 'Save changes' : 'Create ad',
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

      // Minimal client-side validation: name is required by the schema.
      const name = model.name.trim();
      if (!name) {
        ui.toast('Name is required.', 'warn');
        nameInput.focus();
        return;
      }

      // Build the payload. Empty optional strings are stored as null so the
      // consumer app + validators treat them as "unset" rather than "".
      //
      // IMPORTANT: only CONTENT columns go here. The approval_* columns
      // (approval_status, approved_by, approved_at, rejection_reason) are
      // REVOKED for the console and are set exclusively by
      // fn_admin_set_ad_approval — including any of them here would 403.
      const payload = {
        name,
        headline: nn(model.headline),
        tagline: nn(model.tagline),
        cta_text: nn(model.cta_text),
        bg_gradient: nn(model.bg_gradient),
        text_color: nn(model.text_color),
        image_url: nn(model.image_url),
        duration_seconds: ui.clampInt(model.duration_seconds, 2, 30, 5),
        advertiser: nn(model.advertiser),
        active: !!model.active,
      };

      saving = true;
      saveBtn.disabled = true;

      let error;
      try {
        if (isEdit) {
          ({ error } = await supabase.from('ads').update(payload).eq('id', ad.id));
        } else {
          ({ error } = await supabase.from('ads').insert(payload));
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
      ui.toast(isEdit ? 'Ad updated.' : 'Ad created.', 'success');
      closeForm();
      loadAds();
    }

    // Stop the live countdown before the modal tears down, then reload the
    // list once (so an aborted edit still shows fresh data if anything moved).
    function closeForm() {
      if (previewHandle) { try { previewHandle.stop(); } catch { /* ignore */ } previewHandle = null; }
      if (openModal) { const m = openModal; openModal = null; m.close(); }
    }

    openModal = ui.modal({
      title: isEdit ? 'Edit ad' : 'New ad',
      size: 'lg',
      body: form,
      actions: [cancelBtn, saveBtn],
      // onClose fires on Esc / backdrop / X too — make sure the preview stops.
      onClose: () => {
        if (previewHandle) { try { previewHandle.stop(); } catch { /* ignore */ } previewHandle = null; }
        openModal = null;
      },
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
  await loadAds();

  // ---------------------------------------------------------------------------
  // Cleanup: stop any live countdown and close a lingering modal so nothing
  // keeps ticking after the view is torn down.
  // ---------------------------------------------------------------------------
  return () => {
    destroyed = true;
    if (previewHandle) { try { previewHandle.stop(); } catch { /* ignore */ } previewHandle = null; }
    if (openModal) { try { openModal.close(); } catch { /* ignore */ } openModal = null; }
  };
}
