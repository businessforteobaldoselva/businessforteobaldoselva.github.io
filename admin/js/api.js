// =============================================================================
// COVERED Admin Console — WF6 "secret proxy" Admin API client
// -----------------------------------------------------------------------------
// The browser must never hold Twilio / n8n secrets. Instead it posts the
// logged-in admin's own Supabase access token to WF6, which verifies the JWT
// server-side, confirms the user is an admin, then fetches Twilio / n8n /
// Supabase health using secrets that stay inside n8n.
//
// Contract:
//   POST ADMIN_API_URL   body { token: <access_token> }
//   -> { ok:true,  twilio:{...}, n8n:{...}, supabase:{...}, checkedAt }
//   -> { ok:false, reason }
// WF6 may be partially configured at first (e.g. n8n API key not pasted yet):
//   callers should render "unavailable" gracefully rather than crashing.
// =============================================================================

import { ADMIN_API_URL } from './config.js';
import { getAccessToken } from './supabase.js';

/**
 * Call the WF6 Admin API with the current access token.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutMs=12000]  abort after this many ms.
 * @param {AbortSignal} [opts.signal]       optional external abort signal.
 * @returns {Promise<object>} the parsed JSON body (whether ok:true or ok:false).
 * @throws {Error} on missing session, network failure, timeout, non-2xx HTTP,
 *                 or unparseable body. The Status view wraps this in try/catch
 *                 and shows a toast + an "unavailable" tile.
 */
export async function callAdminApi(opts = {}) {
  const { timeoutMs = 12000, signal } = opts;

  const token = await getAccessToken();
  if (!token) {
    throw new Error('Not signed in — cannot call the Admin API.');
  }

  // Wire up an abort timer, chaining any externally supplied signal.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res;
  try {
    res = await fetch(ADMIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
      // No credentials/cookies — auth is carried in the body token only.
      cache: 'no-store',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error('Admin API timed out. It may be waking up — try again.');
    }
    throw new Error('Could not reach the Admin API (network error).');
  }
  clearTimeout(timer);

  // Read the body as text first so we can give a useful error if it isn't JSON.
  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Admin API returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const reason = body && body.reason ? `: ${body.reason}` : '';
    throw new Error(`Admin API error (HTTP ${res.status})${reason}.`);
  }

  // Note: a 200 with { ok:false, reason } is a VALID response we hand back
  // as-is; the Status view decides how to render an unavailable service.
  return body;
}
