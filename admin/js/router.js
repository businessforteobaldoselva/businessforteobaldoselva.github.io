// =============================================================================
// COVERED Admin Console — hash router with auth gate
// -----------------------------------------------------------------------------
// Views are registered by name. Navigation is via the URL hash (#status,
// #ads, …) so the whole thing works from a static file server with no server
// rewrites. Every navigation passes through an auth gate:
//
//   not signed in        -> the 'login' view
//   signed in, not admin -> the 'notAuthorised' screen
//   signed in + admin    -> the requested view (default 'status')
//
// The gate consults requireAdmin() (which calls the server-guarded
// fn_admin_status). To avoid hammering the DB, the admin verdict is cached for
// the lifetime of a session and cleared on any auth change (see app.js, which
// calls router.reset()).
//
// A view module exports a default `mount(root, ctx)` function. See app.js for
// how `ctx` is assembled (supabase helpers, ui, api, router, user).
// =============================================================================

import { requireAdmin, getSession } from './supabase.js';
import * as ui from './ui.js';

// name -> { load: () => Promise<{default: mount}>, title }
const routes = new Map();

// Cached admin verdict for the current session: null = unknown yet.
let adminVerdict = null; // { isAdmin:boolean, status?:object, error?:Error }

let currentCleanup = null; // teardown fn returned by the last mounted view
let ctxRef = null;         // the shared context object (set by init)
let started = false;

/**
 * Register a view. `load` is a function returning the module (supports lazy
 * dynamic import) OR an already-imported module.
 */
export function register(name, load, opts = {}) {
  routes.set(name, { load, title: opts.title || name, requiresAdmin: opts.requiresAdmin !== false });
}

/** The list of admin nav destinations, in order, for the sidebar. */
export const NAV = [
  { name: 'status',    label: 'Status' },
  { name: 'ads',       label: 'Ads' },
  { name: 'machines',  label: 'Machines' },
  { name: 'analytics', label: 'Analytics' },
  { name: 'data',      label: 'Data' },
  { name: 'tasks',     label: 'Tasks' },
  { name: 'reports',   label: 'Reports' },
];

/** Programmatic navigation: sets the hash, which triggers handleRoute(). */
export function navigate(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  const hash = `#${name}${q ? '?' + q : ''}`;
  if (location.hash === hash) handleRoute(); // force re-render on same-hash nav
  else location.hash = hash;
}

/** Parse the current hash into { name, params }. */
export function currentRoute() {
  const raw = location.hash.replace(/^#/, '');
  const [name, query = ''] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  return { name: name || 'status', params };
}

/**
 * Clear the cached admin verdict. Call this whenever auth changes (login /
 * logout / token refresh to a different user) so the gate re-checks.
 */
export function reset() {
  adminVerdict = null;
}

/**
 * Initialise the router. `ctx` is the shared context handed to every view;
 * the router augments it with `router` (navigation API) before mounting.
 * `shell` is a callback the router asks to (re)paint the app chrome for a given
 * mode: 'login' | 'notAuthorised' | 'admin'. It must return the element the
 * view should be mounted into (the content root).
 */
export function init(ctx, shell) {
  ctxRef = { ...ctx, router: { navigate, currentRoute, NAV } };
  ctxRef.shell = shell;
  if (!started) {
    window.addEventListener('hashchange', handleRoute);
    started = true;
  }
}

/** Kick off the first render. */
export async function start() {
  await handleRoute();
}

// The gate + mount pipeline.
async function handleRoute() {
  const { name, params } = currentRoute();

  // Tear down the previous view first.
  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }

  // 1) Signed in at all?
  const session = await getSession();
  if (!session) {
    return renderMode('login', 'login', {});
  }

  // 2) Admin? (cached per session)
  if (adminVerdict == null) {
    // Show a lightweight loading chrome while we check server-side.
    const root = ctxRef.shell('admin', { name: 'status' });
    ui.render(root, ui.spinner('Checking access…'));
    adminVerdict = await requireAdmin();
  }

  if (adminVerdict.error) {
    // A real failure (not merely "not an admin"): show an error screen with retry.
    const root = ctxRef.shell('notAuthorised', {});
    ui.render(root, ui.errorState(
      'Could not verify admin access. ' + adminVerdict.error.message,
      () => { reset(); handleRoute(); }
    ));
    return;
  }

  if (!adminVerdict.isAdmin) {
    return renderMode('notAuthorised', 'notAuthorised', {});
  }

  // 3) Admin — resolve the requested view (default status, unknown -> status).
  const routeName = routes.has(name) ? name : 'status';
  return renderMode('admin', routeName, params);
}

// Paint chrome for the mode, load + mount the view module into the content root.
async function renderMode(mode, viewName, params) {
  const root = ctxRef.shell(mode, { name: viewName });
  if (!root) return;

  const route = routes.get(viewName);
  if (!route) {
    ui.render(root, ui.errorState(`Unknown view: ${viewName}`));
    return;
  }

  ui.render(root, ui.spinner());
  let mod;
  try {
    const loaded = typeof route.load === 'function' ? await route.load() : route.load;
    mod = loaded.default || loaded;
  } catch (err) {
    ui.render(root, ui.errorState('Failed to load this view. ' + (err?.message || '')));
    return;
  }

  // Give the view a fresh root and the shared context (+ current params +
  // the cached admin status payload so Status can reuse it).
  ui.clear(root);
  try {
    const ctx = {
      ...ctxRef,
      params,
      adminStatus: adminVerdict?.status || null,
    };
    const cleanup = await mod(root, ctx);
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    ui.render(root, ui.errorState('This view crashed. ' + (err?.message || '')));
    ui.toast('View error: ' + (err?.message || 'unknown'), 'error');
  }
}
