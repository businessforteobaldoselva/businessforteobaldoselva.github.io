// =============================================================================
// COVERED Admin Console — Login view
// -----------------------------------------------------------------------------
// A self-contained view module (default-export mount(root, ctx)) built strictly
// against the frozen shell view contract. It renders one of two states into the
// supplied `root`:
//
//   1. LOGIN   — Supabase Auth email+password form. On success we verify admin
//                status server-side and route to Status (or fall through to the
//                not-authorised state for a valid-but-non-admin account).
//   2. NOT-AUTHORISED — a clear, friendly screen for an account that is signed
//                in but is NOT on the COVERED admin allow-list. Offers sign-out.
//
// The module NEVER touches the DOM outside `root` (except ctx.ui.toast, which
// owns its own host). All user/DB text is rendered via ui.el `text` / textContent
// so there is no innerHTML XSS surface. It reuses the shell's auth helpers
// (ctx.auth.*) so there is zero duplicated Supabase logic and zero integration
// change needed to drop it in.
//
// NOTE ON ROUTING: the frozen router gates login/notAuthorised as built-in
// shell *modes* and only reaches a registered view once the session is present
// and admin-verified. This module is therefore usable in two ways with no code
// change: (a) mounted directly by app.js's login mode, or (b) registered as a
// route. In either case it drives itself off the same ctx surface and, on a
// successful admin sign-in, hands control back to the router via
// ctx.router.navigate('status') — the router's own auth gate then takes over.
// =============================================================================

export default async function mount(root, ctx) {
  const { ui, auth, router } = ctx;

  // --- Guard: not configured yet ------------------------------------------
  // If the founder hasn't pasted the anon key, signIn() would throw a doomed
  // request. We still render the form (so the layout is correct) but show a
  // clear banner and let signIn surface the friendly error.
  const configured = auth?.IS_CONFIGURED !== false;

  // We subscribe to auth changes so that, if the session appears/disappears
  // while this view is mounted (e.g. sign-out from elsewhere, token refresh),
  // we re-render the correct state instead of going stale. The returned
  // unsubscribe is called from the cleanup fn the router awaits.
  let unsub = null;
  let disposed = false;

  // Decide which state to show for the *current* session and paint it.
  async function renderForSession() {
    if (disposed) return;

    let session = null;
    try {
      session = await auth.getSession();
    } catch {
      session = null;
    }
    if (disposed) return;

    if (!session) {
      renderLogin();
      return;
    }

    // Signed in — is this account an admin? Ask the server (RLS-guarded).
    // While we check, show a lightweight spinner so there's never a flash of
    // the wrong screen.
    ui.render(root, ui.spinner('Checking access…'));
    let verdict;
    try {
      verdict = await auth.requireAdmin();
    } catch (err) {
      verdict = { isAdmin: false, error: err };
    }
    if (disposed) return;

    if (verdict?.error) {
      // A genuine failure (network / RPC down) — not merely "not an admin".
      renderCheckError(verdict.error);
      return;
    }
    if (verdict?.isAdmin) {
      // Valid admin session already present — hand back to the router, which
      // will paint the admin chrome and mount the requested/default view.
      router.navigate('status');
      return;
    }
    // Signed in, but not on the allow-list.
    renderNotAuthorised(session);
  }

  // --- STATE 1: login form -------------------------------------------------
  function renderLogin() {
    const emailInput = ui.input({
      type: 'email',
      name: 'email',
      placeholder: 'you@covered.co',
      autocomplete: 'username',
      required: true,
    });
    const pwInput = ui.input({
      type: 'password',
      name: 'password',
      placeholder: 'Password',
      autocomplete: 'current-password',
      required: true,
    });
    const submit = ui.button({ label: 'Sign in', type: 'submit', className: 'auth-submit' });

    // aria-live region so screen readers announce error text as it appears.
    const msg = ui.el('div', { class: 'auth-msg', attrs: { 'aria-live': 'polite', role: 'status' } });

    function setBusy(busy) {
      submit.disabled = busy;
      emailInput.disabled = busy;
      pwInput.disabled = busy;
      const span = submit.querySelector('span');
      if (span) span.textContent = busy ? 'Signing in…' : 'Sign in';
    }

    async function onSubmit(e) {
      e.preventDefault();
      msg.textContent = '';

      const email = emailInput.value.trim();
      const pw = pwInput.value;
      if (!email || !pw) {
        msg.textContent = 'Enter your email and password.';
        return;
      }

      setBusy(true);
      try {
        // signIn throws a friendly Error on bad credentials / not-configured.
        await auth.signIn(email, pw);
        if (disposed) return;

        // Signed in — now confirm admin before routing so a non-admin sees a
        // helpful screen rather than bouncing into a permission-denied view.
        let verdict;
        try {
          verdict = await auth.requireAdmin();
        } catch (err) {
          verdict = { isAdmin: false, error: err };
        }
        if (disposed) return;

        if (verdict?.error) {
          const m = 'Signed in, but the admin check failed. ' + (verdict.error.message || '');
          msg.textContent = m;
          ui.toast(m, 'error');
          setBusy(false);
          return;
        }
        if (verdict?.isAdmin) {
          ui.toast('Welcome back.', 'success');
          router.navigate('status'); // router's gate paints admin chrome
          return; // leave the button busy; the view is being replaced
        }
        // Valid credentials but not an admin.
        renderNotAuthorised((await auth.getSession()) || null);
      } catch (err) {
        // Friendly, already-normalised message from auth.signIn.
        const m = err?.message || 'Sign-in failed. Please try again.';
        msg.textContent = m;
        ui.toast(m, 'error');
        setBusy(false);
        // Keep focus on password for a quick retry after wrong credentials.
        pwInput.focus();
        pwInput.select();
      }
    }

    const form = ui.el('form', { class: 'auth-form', attrs: { novalidate: 'novalidate' } }, [
      ui.field('Email', emailInput),
      ui.field('Password', pwInput),
      submit,
      msg,
    ]);
    form.addEventListener('submit', onSubmit);

    const cardEl = ui.card({
      className: 'auth-card',
      body: [
        brand(),
        form,
        !configured
          ? ui.el('p', {
              class: 'auth-warn',
              text: 'Not configured yet: paste the Supabase anon key into js/config.js.',
            })
          : null,
      ],
    });

    ui.render(root, cardEl);
    // Focus the first field once painted (rAF so it lands after layout).
    requestAnimationFrame(() => { if (!disposed) emailInput.focus(); });
  }

  // --- STATE 2: not authorised --------------------------------------------
  function renderNotAuthorised(session) {
    const email = session?.user?.email || ctx.user?.email || '';

    const cardEl = ui.card({
      className: 'auth-card',
      body: [
        ui.el('div', { class: 'na-icon', text: '🔒', attrs: { 'aria-hidden': 'true' } }),
        ui.el('h2', { class: 'na-title', text: 'Not authorised' }),
        ui.el('p', {
          class: 'na-body',
          text:
            'You are signed in, but this account is not on the COVERED admin ' +
            'allow-list. Ask a founder to add you, then sign in again.',
        }),
        email ? ui.el('p', { class: 'na-who', text: email }) : null,
        ui.button({ label: 'Sign out', variant: 'ghost', onClick: doSignOut }),
      ],
    });

    ui.render(root, cardEl);
  }

  // --- STATE 3: admin-check failure (real error, retryable) ---------------
  function renderCheckError(err) {
    ui.render(
      root,
      ui.card({
        className: 'auth-card',
        body: ui.errorState(
          'Could not verify admin access. ' + (err?.message || ''),
          () => { renderForSession(); }
        ),
      })
    );
  }

  // --- Shared helpers ------------------------------------------------------
  function brand() {
    return ui.el('div', { class: 'brand brand--center' }, [
      ui.el('div', { class: 'brand-mark', text: 'COVERED' }),
      ui.el('div', { class: 'brand-sub', text: 'Admin console' }),
    ]);
  }

  async function doSignOut() {
    try {
      await auth.signOut();
      // onAuthChange (below) re-renders us into the login state.
    } catch (err) {
      ui.toast(err?.message || 'Sign-out failed.', 'error');
    }
  }

  // Re-render on external auth changes (sign-out elsewhere, token refresh).
  try {
    unsub = auth.onAuthChange(() => { renderForSession(); });
  } catch {
    unsub = null;
  }

  // Initial paint.
  await renderForSession();

  // Cleanup: drop the auth subscription so we don't leak or fire after unmount.
  return () => {
    disposed = true;
    if (typeof unsub === 'function') {
      try { unsub(); } catch { /* ignore */ }
    }
  };
}
