// =============================================================================
// COVERED Admin Console — bootstrap
// -----------------------------------------------------------------------------
// Entry point (loaded as a module from index.html). Responsibilities:
//   1. Assemble the shared `ctx` handed to every view (supabase helpers, api,
//      ui, toast, current user).
//   2. Register the views (login + notAuthorised are built in below; the five
//      admin views are lazy-loaded from js/views/*).
//   3. Provide the `shell` renderer the router calls to paint app chrome for
//      each mode ('login' | 'notAuthorised' | 'admin') and return the content
//      root the current view mounts into.
//   4. React to auth changes: reset the router's admin cache and re-route.
// =============================================================================

import * as ui from './ui.js';
import * as auth from './supabase.js';
import { callAdminApi } from './api.js';
import * as router from './router.js';
import { IS_CONFIGURED } from './config.js';

const appRoot = document.getElementById('app');

// -----------------------------------------------------------------------------
// Shared context handed to every view module's mount(root, ctx).
// This is the STABLE integration surface — see the view contract.
// -----------------------------------------------------------------------------
const ctx = {
  supabase: auth.supabase, // raw client for PostgREST (from/rpc) — RLS-guarded
  auth,                    // { getSession, getUser, signIn, signOut, onAuthChange, requireAdmin, getAccessToken }
  api: { callAdminApi },   // WF6 secret proxy
  ui,                      // the whole ui.js toolkit
  toast: ui.toast,         // convenience shortcut
  user: null,              // current signed-in user (kept fresh on auth change)
};

// -----------------------------------------------------------------------------
// View registry. The five admin views are lazy dynamic imports so the shell can
// ship and run before those files exist / while they are built in parallel.
// -----------------------------------------------------------------------------
router.register('status',    () => import('./views/status.js'),    { title: 'Status' });
router.register('ads',       () => import('./views/ads.js'),       { title: 'Ads' });
router.register('machines',  () => import('./views/machines.js'),  { title: 'Machines' });
router.register('analytics', () => import('./views/analytics.js'), { title: 'Analytics' });
router.register('data',      () => import('./views/data.js'),      { title: 'Data' });

// =============================================================================
// The shell renderer. Returns the content root the router mounts a view into.
// =============================================================================
function shell(mode, active = {}) {
  ui.clear(appRoot);
  appRoot.removeAttribute('aria-busy');

  if (mode === 'login') {
    const root = ui.el('div', { id: 'view-root' });
    appRoot.appendChild(ui.el('div', { class: 'auth-screen' }, root));
    renderLogin(root);
    return null; // login view is self-contained; nothing else mounts here
  }

  if (mode === 'notAuthorised') {
    const root = ui.el('div', { id: 'view-root', class: 'view-root' });
    appRoot.appendChild(ui.el('div', { class: 'auth-screen' }, root));
    renderNotAuthorised(root);
    return root; // router may render an error/retry state into this too
  }

  // mode === 'admin' — full chrome: sidebar + topbar + content root.
  const contentRoot = ui.el('main', { id: 'view-root', class: 'view-root', tabindex: '-1' });
  const layout = ui.el('div', { class: 'shell' }, [
    sidebar(active.name),
    ui.el('div', { class: 'shell-main' }, [
      topbar(active.name),
      contentRoot,
    ]),
  ]);
  appRoot.appendChild(layout);
  return contentRoot;
}

// --- Sidebar -----------------------------------------------------------------
function sidebar(activeName) {
  const links = router.NAV.map((item) =>
    ui.el('a', {
      class: `nav-link ${item.name === activeName ? 'is-active' : ''}`.trim(),
      href: `#${item.name}`,
      text: item.label,
      attrs: item.name === activeName ? { 'aria-current': 'page' } : {},
    })
  );

  const signOutBtn = ui.button({
    label: 'Sign out',
    variant: 'ghost',
    size: 'sm',
    className: 'nav-signout',
    onClick: doSignOut,
  });

  return ui.el('aside', { class: 'sidebar', attrs: { 'aria-label': 'Primary' } }, [
    ui.el('div', { class: 'brand' }, [
      ui.el('div', { class: 'brand-mark', text: 'COVERED' }),
      ui.el('div', { class: 'brand-sub', text: 'Admin console' }),
    ]),
    ui.el('nav', { class: 'nav' }, links),
    ui.el('div', { class: 'sidebar-foot' }, [
      ui.el('div', { class: 'who', text: ctx.user?.email || '' }),
      signOutBtn,
    ]),
  ]);
}

// --- Topbar (mobile nav toggle + current view title) -------------------------
function topbar(activeName) {
  const label = (router.NAV.find((n) => n.name === activeName)?.label) || 'Status';
  return ui.el('header', { class: 'topbar' }, [
    ui.el('button', {
      class: 'nav-toggle',
      text: '☰',
      attrs: { 'aria-label': 'Toggle navigation', 'aria-expanded': 'false' },
      onclick: (e) => {
        const shell = document.querySelector('.shell');
        const open = shell ? shell.classList.toggle('nav-open') : false;
        e.currentTarget.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) document.querySelector('.sidebar a, .sidebar button')?.focus();
      },
    }),
    ui.el('h1', { class: 'topbar-title', text: label }),
  ]);
}

// =============================================================================
// Built-in views: login + notAuthorised.
// =============================================================================
function renderLogin(root) {
  const emailInput = ui.input({ type: 'email', name: 'email', placeholder: 'you@covered.co', autocomplete: 'username', required: true });
  const pwInput = ui.input({ type: 'password', name: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
  const submit = ui.button({ label: 'Sign in', type: 'submit', className: 'auth-submit' });
  const msg = ui.el('div', { class: 'auth-msg', attrs: { 'aria-live': 'polite' } });

  const form = ui.el('form', {
    class: 'auth-form',
    onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      submit.disabled = true;
      submit.querySelector('span').textContent = 'Signing in…';
      try {
        await auth.signIn(emailInput.value, pwInput.value);
        // onAuthChange handles the re-route; nothing else to do here.
      } catch (err) {
        msg.textContent = err.message || 'Sign-in failed.';
        ui.toast(err.message || 'Sign-in failed.', 'error');
      } finally {
        submit.disabled = false;
        submit.querySelector('span').textContent = 'Sign in';
      }
    },
  }, [
    ui.field('Email', emailInput),
    ui.field('Password', pwInput),
    submit,
    msg,
  ]);

  const cardEl = ui.card({
    className: 'auth-card',
    body: [
      ui.el('div', { class: 'brand brand--center' }, [
        ui.el('div', { class: 'brand-mark', text: 'COVERED' }),
        ui.el('div', { class: 'brand-sub', text: 'Admin console' }),
      ]),
      form,
      !IS_CONFIGURED
        ? ui.el('p', { class: 'auth-warn', text: 'Not configured yet: paste the Supabase anon key into js/config.js.' })
        : null,
    ],
  });

  root.appendChild(cardEl);
  requestAnimationFrame(() => emailInput.focus());
}

function renderNotAuthorised(root) {
  const cardEl = ui.card({
    className: 'auth-card',
    body: [
      ui.el('div', { class: 'na-icon', text: '🔒', attrs: { 'aria-hidden': 'true' } }),
      ui.el('h2', { class: 'na-title', text: 'Not authorised' }),
      ui.el('p', { class: 'na-body', text:
        'You are signed in, but this account is not on the COVERED admin allow-list. ' +
        'Ask a founder to add you, then sign in again.' }),
      ui.el('p', { class: 'na-who', text: ctx.user?.email || '' }),
      ui.button({ label: 'Sign out', variant: 'ghost', onClick: doSignOut }),
    ],
  });
  root.appendChild(cardEl);
}

async function doSignOut() {
  try {
    await auth.signOut();
  } catch (err) {
    ui.toast(err.message || 'Sign-out failed.', 'error');
  }
}

// =============================================================================
// Boot.
// =============================================================================
// Close the mobile nav on Escape and restore focus to the toggle.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const shell = document.querySelector('.shell.nav-open');
  if (!shell) return;
  shell.classList.remove('nav-open');
  const t = document.querySelector('.nav-toggle');
  if (t) { t.setAttribute('aria-expanded', 'false'); t.focus(); }
});

async function boot() {
  // Keep ctx.user + the router in sync with auth state.
  auth.onAuthChange(async (event, session) => {
    const prevId = ctx.user?.id || null;
    const nextId = session?.user?.id || null;
    ctx.user = session?.user || null;
    // TOKEN_REFRESHED fires ~hourly and INITIAL_SESSION duplicates boot's own
    // start() — neither may remount the app (it closes modals and destroys
    // unsaved form work). Only real identity changes re-route.
    if (event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') return;
    if (event === 'SIGNED_IN' && prevId !== null && prevId === nextId) return;
    router.reset(); // force a fresh admin check on the new session
    await router.start();
  });

  // Initial user + route.
  ctx.user = await auth.getUser();
  router.init(ctx, shell);
  await router.start();
}

boot().catch((err) => {
  // Last-resort error screen so a boot failure is never a blank page.
  ui.clear(appRoot);
  appRoot.appendChild(ui.el('div', { class: 'auth-screen' },
    ui.card({
      className: 'auth-card',
      body: ui.errorState('The console failed to start. ' + (err?.message || ''), () => location.reload()),
    })
  ));
});
