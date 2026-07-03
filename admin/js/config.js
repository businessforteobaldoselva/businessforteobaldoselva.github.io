// =============================================================================
// COVERED Admin Console — public configuration
// -----------------------------------------------------------------------------
// EVERYTHING IN THIS FILE IS PUBLIC and safe to commit / ship to GitHub Pages.
//
//   * SUPABASE_URL       — the project's public REST/Auth endpoint.
//   * SUPABASE_ANON_KEY  — the "anon" (a.k.a. "publishable") key. This is the
//                          key browsers are SUPPOSED to hold. It grants nothing
//                          on its own: Row-Level Security + fn_is_admin() decide
//                          what any logged-in user can actually see or change.
//   * ADMIN_API_URL      — the WF6 n8n "secret proxy" webhook. The browser posts
//                          the logged-in admin's *own* Supabase access token to
//                          it; the real Twilio / n8n secrets live inside n8n.
//
// >>> NEVER put a service_role key, Twilio auth token, or n8n API key here. <<<
// If you can't tell whether a key is safe: the anon key is a long JWT that
// starts with "eyJ..." and, when decoded, has  "role":"anon". A service_role
// key has "role":"service_role" — that one must NEVER touch the browser.
// =============================================================================

// Frozen backend contract — the live COVERED Supabase project.
export const SUPABASE_URL = 'https://ajvpypzdwmgblaotysbt.supabase.co';

// -----------------------------------------------------------------------------
// FOUNDER: PASTE THE ANON KEY HERE.
// Where to find it:
//   Supabase dashboard → Project Settings → API → "Project API keys"
//   → copy the key labelled  anon  /  public  (NOT service_role).
// Paste it between the quotes below, replacing the placeholder, then commit.
// -----------------------------------------------------------------------------
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqdnB5cHpkd21nYmxhb3R5c2J0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MzY3MDEsImV4cCI6MjA5ODIxMjcwMX0.0i9A5pcLXSckBx2XYQSG474lsP0Jvp04zFgDPVYPyj8';

// WF6 secret-proxy Admin API (public URL; it authenticates by your JWT, not by
// being secret). Used only by the Status view to fetch Twilio / n8n health.
export const ADMIN_API_URL = 'https://coveredbymills.app.n8n.cloud/webhook/admin/status';

// Convenience flag other modules use to show a friendly "not configured yet"
// message instead of firing a doomed request when the founder hasn't pasted the
// key. Kept here so the check lives in exactly one place.
export const IS_CONFIGURED =
  typeof SUPABASE_ANON_KEY === 'string' &&
  SUPABASE_ANON_KEY.length > 20 &&
  !SUPABASE_ANON_KEY.startsWith('PASTE_');
