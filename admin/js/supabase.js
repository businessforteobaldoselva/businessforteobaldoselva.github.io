// =============================================================================
// COVERED Admin Console — Supabase client + auth helpers
// -----------------------------------------------------------------------------
// Thin, well-documented wrapper around supabase-js v2 (imported from esm.sh).
// Everything the rest of the app needs to authenticate and to gate on "admin"
// lives here, so views never touch the raw client for auth concerns.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_CONFIGURED } from './config.js';

// One shared client for the whole app. Session is persisted to localStorage and
// auto-refreshed by supabase-js so a reload keeps you logged in.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false, // no OAuth redirect flow; email+password only
  },
});

// Re-export the configured flag so callers can import it from one module.
export { IS_CONFIGURED };

// --- Session -----------------------------------------------------------------

/**
 * Current session or null. Never throws — a missing/expired session resolves
 * to null so callers can branch cleanly.
 * @returns {Promise<import('https://esm.sh/@supabase/supabase-js@2.49.4').Session|null>}
 */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session ?? null;
}

/**
 * The current access token (JWT) or null. This is the value WF6 wants.
 * @returns {Promise<string|null>}
 */
export async function getAccessToken() {
  const session = await getSession();
  return session?.access_token ?? null;
}

/**
 * The current signed-in user or null.
 */
export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

// --- Auth actions ------------------------------------------------------------

/**
 * Sign in with email + password.
 * @returns {Promise<{session: object|null, user: object|null}>}
 * @throws {Error} with a human-readable .message on failure.
 */
export async function signIn(email, pw) {
  if (!IS_CONFIGURED) {
    throw new Error(
      'Admin console is not configured yet — paste the Supabase anon key into js/config.js.'
    );
  }
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(pw || ''),
  });
  if (error) {
    // Normalise the most common messages to something friendlier.
    const msg = /invalid login credentials/i.test(error.message)
      ? 'Incorrect email or password.'
      : error.message;
    throw new Error(msg);
  }
  return { session: data.session, user: data.user };
}

/**
 * Sign out and clear the persisted session.
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);
}

/**
 * Subscribe to auth changes (login / logout / token refresh).
 * @param {(event: string, session: object|null) => void} cb
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    cb(event, session);
  });
  return () => data.subscription.unsubscribe();
}

// --- Admin gate --------------------------------------------------------------

/**
 * Decide whether the logged-in user is a COVERED admin.
 *
 * The single source of truth is the server: we call fn_admin_status(), which is
 * admin-guarded server-side. If the user is NOT an admin the RPC raises
 * 'not_admin' (or returns a 42501 permission error); we translate any such
 * failure into { isAdmin:false }. A genuine network/other error is surfaced as
 * { isAdmin:false, error } so the caller can show a real error state rather than
 * silently pretending the user is unauthorised.
 *
 * On success we also hand back the status payload so the caller (e.g. the
 * router / status view) can reuse it without a second round-trip.
 *
 * @returns {Promise<{ isAdmin: boolean, status?: object, error?: Error }>}
 */
export async function requireAdmin() {
  const session = await getSession();
  if (!session) return { isAdmin: false };

  const { data, error } = await supabase.rpc('fn_admin_status');

  if (error) {
    if (isNotAdminError(error)) {
      // Logged in, but not on the admin allow-list. Expected, not an error.
      return { isAdmin: false };
    }
    // Something actually went wrong (network, RPC missing, DB down…).
    return { isAdmin: false, error: new Error(error.message || 'Admin check failed') };
  }

  return { isAdmin: true, status: data };
}

/**
 * True when a Supabase/PostgREST error means "you're not an admin" rather than a
 * real fault. Covers the raised 'not_admin' message and the 42501 permission
 * code (and PostgREST's 401/permission-denied variants).
 */
export function isNotAdminError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || '').toLowerCase();
  return (
    code === '42501' ||
    code === 'PGRST301' ||
    msg.includes('not_admin') ||
    msg.includes('permission denied')
  );
}
