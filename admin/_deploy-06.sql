-- ============================================================
-- COVERED by Mills — Quick-wins migration 06  (DATABASE objects)
-- ------------------------------------------------------------
-- Bundles the DB objects for THREE quick wins onto the LIVE public schema:
--   ITEM 1 — Compliance activation (RLS re-assert, consent, retention, status)
--   ITEM 2 — Stock telemetry + restock alerts
--   ITEM 5 — Brand-safe ad approval gate
--
-- BUILDS ON the live schema. Does NOT recreate tables. FULLY IDEMPOTENT — every
-- statement is enable-rls / add-column-if-not-exists / create-or-replace /
-- drop-constraint-then-add / drop-policy-then-create, and every backfill is
-- windowed so a second run is a no-op. Safe to run twice.  Run as ONE txn.
--
-- RUN ORDER: 01 -> 02 -> 03 -> 04 -> 05 -> 06.  (05 assumed ALREADY APPLIED.)
--
-- >>> REGRESSION SAFETY — the live vending flow must not break <<<
--   * n8n (WF1..WF5) calls fn_* with the SERVICE_ROLE key. service_role is
--     BYPASSRLS, so re-asserting RLS deny-all on vending tables does NOT affect
--     it. Every fn_* is SECURITY DEFINER owned by postgres (also BYPASSRLS).
--   * We RE-CREATE fn_dispense_demo and fn_active_ad_for_machine here. Both
--     preserve their existing contract EXACTLY (same signature, same return
--     shape; fn_dispense_demo adds ONE additive field 'stock_level'). No
--     existing field is renamed or removed.
--   * We do NOT touch the ads/ad_schedules/admins RLS policies or grants from 05.
--   * Conventions: pgcrypto in `extensions`; every function SECURITY DEFINER +
--     set search_path = public, extensions; jsonb returns; alias-qualified cols.
-- ============================================================


-- ############################################################
-- ITEM 1 — COMPLIANCE ACTIVATION
-- ############################################################

-- ------------------------------------------------------------
-- 1a. RE-ASSERT RLS deny-all on ALL current vending tables.
--     Idempotent (enable/force rls never error if already set). 02 did most of
--     these; we re-assert to cover the current set and any table 02 predates.
--     NO anon/authenticated policies are created — deny-all IS the posture.
--     service_role/definer (BYPASSRLS) still read/write. We do NOT touch
--     ads / ad_schedules / admins (05 owns their RLS + policies + grants).
-- ------------------------------------------------------------
-- PII / vending tables — DENY-ALL: RLS enabled+forced, no anon/authenticated
-- policy. Only service_role/definer (BYPASSRLS) read/write. The admin console
-- reaches this data ONLY through the guarded fn_admin_* RPCs.
alter table if exists public.sessions        enable row level security;
alter table if exists public.users           enable row level security;
alter table if exists public.events          enable row level security;
alter table if exists public.dispensing_log  enable row level security;
alter table if exists public.otp_attempts    enable row level security;

alter table if exists public.sessions        force row level security;
alter table if exists public.users           force row level security;
alter table if exists public.events          force row level security;
alter table if exists public.dispensing_log  force row level security;
alter table if exists public.otp_attempts    force row level security;

-- Belt-and-braces privilege revoke, SCOPED to the five PII tables ONLY
-- (never `all tables`) so 05's grants on ads/ad_schedules/admins stay intact.
revoke all on public.sessions, public.users, public.events,
              public.dispensing_log, public.otp_attempts
  from anon, authenticated;

-- machines is NOT PII (id / location / limits / stock) and is read+written
-- DIRECTLY by the admin console (Machines view, Add-machine, stock UI). It gets
-- the SAME admin-scoped RLS as ads/ad_schedules (the 05 pattern): RLS enabled,
-- admins allowed via fn_is_admin(), anon denied. Vending reads it via
-- service_role (BYPASSRLS) so is unaffected. ENABLE (not FORCE) to mirror 05.
alter table if exists public.machines enable row level security;
drop policy if exists p_machines_admin on public.machines;
create policy p_machines_admin on public.machines
  for all to authenticated
  using (public.fn_is_admin())
  with check (public.fn_is_admin());
grant select, insert, update, delete on public.machines to authenticated;
revoke all on public.machines from anon;

-- Self-contained: ensure dispensing_log.session_id exists (fn_dispense_demo
-- inserts it; fn_purge_pii nulls it). Nullable / additive / idempotent — so the
-- migration is correct regardless of whether an earlier migration added it.
alter table if exists public.dispensing_log add column if not exists session_id uuid;


-- ------------------------------------------------------------
-- 1b. CONSENT CAPTURE — columns.
--     users.consent_ts already exists (live) — add-if-not-exists is a no-op.
--     marketing_consent = the new canonical opt-in flag used by the web app.
--     marketing_opt_in is added defensively: 03-gdpr-functions.sql's
--     fn_erase_contact UPDATEs marketing_opt_in unconditionally, so the column
--     must exist for 03 to run. We keep it; marketing_consent is source of truth.
-- ------------------------------------------------------------
alter table if exists public.users
  add column if not exists marketing_consent boolean not null default false;
alter table if exists public.users
  add column if not exists marketing_opt_in  boolean not null default false;
alter table if exists public.users
  add column if not exists consent_ts timestamptz;

-- fn_set_consent — called by WF3 AFTER a successful fn_authorize_session, ONLY
-- when the client sent marketing_consent=true. OPTIONAL: dispense/auth work
-- whether or not this is ever called. NEVER raises (returns ok even on empty
-- lookup) so a consent-write blip cannot fail the OTP verify. service_role-only.
create or replace function public.fn_set_consent(
  p_session_id uuid,
  p_consent    boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
begin
  select s.user_id into v_user_id
    from public.sessions s
   where s.id = p_session_id;

  if v_user_id is null then
    -- Never raise: consent is fire-and-forget from WF3.
    return jsonb_build_object('ok', true, 'consented', false, 'reason', 'session_or_user_not_found');
  end if;

  -- Only ever SET consent to true (opt-in). Withdrawal is a separate GDPR path
  -- (fn_erase_contact). Keep marketing_opt_in mirrored for legacy readers.
  if coalesce(p_consent, false) then
    update public.users u
       set marketing_consent = true,
           marketing_opt_in   = true,
           consent_ts         = now()
     where u.id = v_user_id;
    return jsonb_build_object('ok', true, 'user_id', v_user_id, 'consented', true, 'consent_ts', now());
  end if;

  return jsonb_build_object('ok', true, 'user_id', v_user_id, 'consented', false);
end $$;

revoke all on function public.fn_set_consent(uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_set_consent(uuid, boolean) to service_role;


-- ------------------------------------------------------------
-- 1c. RETENTION PURGE — fn_purge_pii().
--     Superset/reconciliation of 03's fn_purge_old_data (which we KEEP).
--       * deletes events + sessions older than 90 days (FK child first).
--       * deletes otp_attempts older than 24h.
--       * anonymises dispensing_log > 90 days (nulls session_id).
--       * nulls RAW contact columns (if any exist) for users inactive > 30 days,
--         KEEPING contact_hash + monthly_count (needed for the 4/month limit).
--       * writes an events row type='purge' as a last-purge marker for the card.
--     Uses sessions.scan_ts as the age axis (live column; created_at may not
--     exist on sessions). Idempotent — all windows are "older than".
-- ------------------------------------------------------------
create or replace function public.fn_purge_pii()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_events_del   int := 0;
  v_sessions_del int := 0;
  v_otp_del      int := 0;
  v_log_anon     int := 0;
  v_raw_nulled   int := 0;
  v_has_raw      boolean := false;
begin
  -- 1. events for sessions older than 90 days (FK child first).
  delete from public.events e
   where e.session_id in (
     select s.id from public.sessions s where s.scan_ts < now() - interval '90 days'
   );
  get diagnostics v_events_del = row_count;

  -- 2. the aged sessions.
  delete from public.sessions s where s.scan_ts < now() - interval '90 days';
  get diagnostics v_sessions_del = row_count;

  -- 3. otp_attempts older than 24h.
  delete from public.otp_attempts o where o.ts < now() - interval '24 hours';
  get diagnostics v_otp_del = row_count;

  -- 4. anonymise dispensing_log > 90 days (sever link to now-deleted sessions).
  update public.dispensing_log d
     set session_id = null
   where d.ts < now() - interval '90 days'
     and d.session_id is not null;
  get diagnostics v_log_anon = row_count;

  -- 5. Null RAW contact columns (if the schema ever gains a `contact` column)
  --    for users with no dispense activity in 30 days. contact_hash +
  --    monthly_count are KEPT. No-op today (schema stores only contact_hash).
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='users' and column_name='contact') then
    v_has_raw := true;
    execute $q$
      update public.users u set contact = null
       where u.contact is not null
         and not exists (
           select 1 from public.dispensing_log d
            where d.user_id = u.id and d.ts > now() - interval '30 days'
         )
    $q$;
    get diagnostics v_raw_nulled = row_count;
  end if;

  -- 6. Last-purge marker for the compliance card (read by fn_admin_compliance_status).
  insert into public.events (type, payload, ts)
  values ('purge',
          jsonb_build_object('events_deleted', v_events_del,
                             'sessions_deleted', v_sessions_del,
                             'otp_attempts_deleted', v_otp_del,
                             'dispensing_log_anonymised', v_log_anon,
                             'raw_contact_nulled', v_raw_nulled),
          now());

  return jsonb_build_object(
    'ok', true,
    'purged_at', now(),
    'events_deleted', v_events_del,
    'sessions_deleted', v_sessions_del,
    'otp_attempts_deleted', v_otp_del,
    'dispensing_log_anonymised', v_log_anon,
    'raw_contact_nulled', v_raw_nulled,
    'raw_contact_column_present', v_has_raw
  );
end $$;

revoke all on function public.fn_purge_pii() from public, anon, authenticated;
grant execute on function public.fn_purge_pii() to service_role;


-- ------------------------------------------------------------
-- 1d. fn_admin_compliance_status()  [authenticated + guard]
--     Console compliance card. Reads pg_class for RLS state; counts consent +
--     raw-contact exposure; surfaces last purge ts from the events 'purge' marker.
-- ------------------------------------------------------------
create or replace function public.fn_admin_compliance_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  l_missing text[];
  l_all_on  boolean;
  l_last_purge timestamptz;
  l_raw     int := 0;
  l_consent int;
  l_has_raw boolean := false;
begin
  if not public.fn_is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  -- Which vending tables do NOT have RLS enabled?
  select coalesce(array_agg(c.relname order by c.relname), array[]::text[])
    into l_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname in ('sessions','users','events','dispensing_log','otp_attempts','machines')
    and c.relrowsecurity = false;

  l_all_on := (array_length(l_missing, 1) is null);

  -- consented users
  select count(*) into l_consent
    from public.users u where u.marketing_consent = true;

  -- users still holding a RAW contact (only if such a column exists)
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='users' and column_name='contact') then
    l_has_raw := true;
    execute 'select count(*) from public.users where contact is not null' into l_raw;
  end if;

  -- last purge marker (fn_purge_pii writes an events row type='purge')
  select max(e.ts) into l_last_purge
    from public.events e where e.type = 'purge';

  return jsonb_build_object(
    'rls_enabled_all',            l_all_on,
    'tables_missing_rls',         to_jsonb(l_missing),
    'last_purge_ts',              l_last_purge,
    'users_with_raw_contact',     l_raw,
    'raw_contact_column_present', l_has_raw,
    'consented_users',            l_consent
  );
end $$;

revoke all on function public.fn_admin_compliance_status() from public, anon, authenticated;
grant execute on function public.fn_admin_compliance_status() to authenticated;


-- ############################################################
-- ITEM 2 — STOCK TELEMETRY + RESTOCK ALERTS
-- ############################################################

-- ------------------------------------------------------------
-- 2a. machines: stock columns. All nullable/defaulted -> existing rows unchanged.
--     stock_level NULL = UNTRACKED machine (decrement skipped, no alert).
-- ------------------------------------------------------------
alter table if exists public.machines add column if not exists stock_level         int;
alter table if exists public.machines add column if not exists capacity            int;
alter table if exists public.machines add column if not exists low_stock_threshold int default 10;


-- ------------------------------------------------------------
-- 2b. fn_dispense_demo — CONTRACT-PRESERVING re-create.
--     Byte-for-byte the 04 body PLUS: (a) session_id in the dispensing_log
--     insert (live column), (b) an additive 'stock_level' return field and a
--     guarded atomic decrement floored at 0, applied ONLY when stock_level is
--     NOT NULL. Dispense is NEVER blocked by stock (physical truth). Every
--     existing return field (ok, dispensed, machine_id, count, limit, dwell_ms,
--     and all failure fields) is preserved verbatim.
-- ------------------------------------------------------------
create or replace function public.fn_dispense_demo(
  p_session_id uuid,
  p_raw_token  text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status     text;
  v_hash       text;
  v_token_exp  timestamptz;
  v_machine    text;
  v_scan_ts    timestamptz;
  v_campaign   uuid;
  v_user_id    uuid;
  v_month      text := to_char(now(), 'YYYY-MM');
  v_reset      text;
  v_count      int;
  v_effective  int;
  v_limit      int;
  v_dwell      int;
  v_new_stock  int;     -- NEW: post-decrement stock (null if untracked)
begin
  -- lock + load the session
  select s.status, s.session_token_hash, s.token_exp, s.machine_id,
         s.scan_ts, s.campaign_id, s.user_id
    into v_status, v_hash, v_token_exp, v_machine, v_scan_ts, v_campaign, v_user_id
    from public.sessions s
   where s.id = p_session_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'session_not_found');
  end if;

  -- validate the opaque server-side token
  if v_hash is null
     or v_hash <> encode(digest(p_raw_token, 'sha256'), 'hex')
     or v_token_exp is null
     or v_token_exp <= now() then
    return jsonb_build_object('ok', false, 'reason', 'invalid_token');
  end if;

  -- single-dispense guard
  if v_status <> 'authed' then
    return jsonb_build_object('ok', false, 'reason', 'already_dispensed_or_not_authed', 'status', v_status);
  end if;

  -- per-machine monthly limit (defaults to 4)
  select coalesce(m.monthly_limit_per_user, 4) into v_limit
    from public.machines m where m.machine_id = v_machine;
  v_limit := coalesce(v_limit, 4);

  -- lock + load the user, compute effective monthly count (reset on new month)
  select u.monthly_count, u.last_reset_month into v_count, v_reset
    from public.users u where u.id = v_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'user_not_found');
  end if;

  if v_reset is distinct from v_month then
    v_effective := 0;
  else
    v_effective := coalesce(v_count, 0);
  end if;

  if v_effective >= v_limit then
    return jsonb_build_object('ok', false, 'reason', 'monthly_limit_reached',
                              'count', v_effective, 'limit', v_limit);
  end if;

  -- all clear: dispense atomically (increment, mark dispensed, log)
  v_dwell := floor(extract(epoch from (now() - v_scan_ts)) * 1000)::int;

  update public.users u
     set monthly_count = v_effective + 1,
         last_reset_month = v_month
   where u.id = v_user_id;

  update public.sessions s
     set status = 'dispensed',
         dispense_ts = now(),
         dwell_ms = v_dwell
   where s.id = p_session_id;

  -- dispensing_log: include session_id (nullable column added this session).
  insert into public.dispensing_log (user_id, machine_id, campaign_id, ts, session_id)
  values (v_user_id, v_machine, v_campaign, now(), p_session_id);

  -- NEW: atomic stock decrement, floored at 0, ONLY when tracked (not null).
  -- WHERE stock_level IS NOT NULL means untracked machines update 0 rows and
  -- v_new_stock stays NULL — the guarded UPDATE cannot throw on them.
  update public.machines m
     set stock_level = greatest(coalesce(m.stock_level, 0) - 1, 0)
   where m.machine_id = v_machine
     and m.stock_level is not null
  returning m.stock_level into v_new_stock;   -- null if untracked (no row updated)

  return jsonb_build_object(
    'ok', true,
    'dispensed', true,
    'machine_id', v_machine,
    'count', v_effective + 1,
    'limit', v_limit,
    'dwell_ms', v_dwell,
    'stock_level', v_new_stock   -- NEW additive field; null when untracked
  );
end $$;

revoke all on function public.fn_dispense_demo(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_dispense_demo(uuid, text) to service_role;


-- ------------------------------------------------------------
-- 2c. fn_admin_set_stock — "mark restocked"  [authenticated + guard]
--     Sets stock_level (+capacity if given), logs an events row type='restock'
--     with the admin's auth.uid() as `by`. Returns jsonb.
-- ------------------------------------------------------------
create or replace function public.fn_admin_set_stock(
  p_machine  text,
  p_stock    int,
  p_capacity int default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_by  uuid := auth.uid();
  v_new int;
begin
  if not public.fn_is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  update public.machines m
     set stock_level = greatest(coalesce(p_stock, 0), 0),
         capacity    = coalesce(p_capacity, m.capacity)
   where m.machine_id = p_machine
  returning m.stock_level into v_new;

  if v_new is null then
    return jsonb_build_object('ok', false, 'reason', 'machine_not_found', 'machine_id', p_machine);
  end if;

  insert into public.events (type, machine_id, payload, ts)
  values ('restock', p_machine,
          jsonb_build_object('by', v_by, 'new_level', v_new, 'capacity', p_capacity),
          now());

  return jsonb_build_object('ok', true, 'machine_id', p_machine, 'stock_level', v_new, 'by', v_by);
end $$;

revoke all on function public.fn_admin_set_stock(text, int, int) from public, anon, authenticated;
grant execute on function public.fn_admin_set_stock(text, int, int) to authenticated;


-- ------------------------------------------------------------
-- 2d/2e. Stock status — TWO entry points sharing ONE core:
--   * _stock_status_core()      SECURITY DEFINER helper — does the work.
--   * fn_admin_stock_status()   [authenticated + guard]  -> console
--   * fn_stock_status_internal()[service_role]           -> WF8 (no admin guard)
--   Per machine: {machine_id, location, stock_level, capacity,
--   low_stock_threshold, low, days_to_empty}. days_to_empty from last-7d avg
--   daily dispenses; null when untracked or no dispenses in the window.
-- ------------------------------------------------------------
create or replace function public._stock_status_core()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  l_out jsonb;
begin
  select coalesce(jsonb_agg(row_to_jsonb(t) order by t.machine_id), '[]'::jsonb)
    into l_out
  from (
    select m.machine_id,
           m.location,
           m.stock_level,
           m.capacity,
           m.low_stock_threshold,
           (m.stock_level is not null
             and m.stock_level <= coalesce(m.low_stock_threshold, 10)) as low,
           (
             select case
                      when m.stock_level is null then null
                      when d7.avg_daily > 0 then round(m.stock_level / d7.avg_daily, 1)
                      else null
                    end
             from (
               select count(*)::numeric / 7.0 as avg_daily
               from public.dispensing_log dl
               where dl.machine_id = m.machine_id
                 and dl.ts >= now() - interval '7 days'
             ) d7
           ) as days_to_empty
    from public.machines m
  ) t;

  return l_out;
end $$;

-- console-facing (guarded)
create or replace function public.fn_admin_stock_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if not public.fn_is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
  return public._stock_status_core();
end $$;

-- WF8-facing (service_role); no admin guard because service_role is the caller.
create or replace function public.fn_stock_status_internal()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  return public._stock_status_core();
end $$;

-- lock down every stock fn
revoke all on function public._stock_status_core()       from public, anon, authenticated;
revoke all on function public.fn_admin_stock_status()    from public, anon, authenticated;
revoke all on function public.fn_stock_status_internal() from public, anon, authenticated;
grant execute on function public.fn_admin_stock_status()    to authenticated;
grant execute on function public.fn_stock_status_internal() to service_role;
grant execute on function public._stock_status_core()       to service_role;


-- ############################################################
-- ITEM 5 — BRAND-SAFE AD APPROVAL GATE
-- ############################################################

-- ------------------------------------------------------------
-- 5a. ads: approval columns + one-time SAFE backfill.
--     ORDER MATTERS: add approval_status WITHOUT a default first, so EVERY
--     pre-existing row is NULL; backfill NULL -> 'approved' (nothing live
--     disappears once the gate goes on); THEN set default 'draft' for future
--     inserts. Re-run safe: after the first run no NULLs remain, so a rejected
--     or re-drafted ad is NEVER re-approved.
-- ------------------------------------------------------------
alter table if exists public.ads add column if not exists approval_status text;
update public.ads set approval_status = 'approved' where approval_status is null;
alter table if exists public.ads alter column approval_status set default 'draft';

alter table if exists public.ads add column if not exists approved_by      uuid;
alter table if exists public.ads add column if not exists approved_at      timestamptz;
alter table if exists public.ads add column if not exists rejection_reason text;

-- CHECK constraint (idempotent: drop-if-exists then add).
alter table if exists public.ads drop constraint if exists ck_ads_approval_status;
alter table if exists public.ads
  add constraint ck_ads_approval_status
  check (approval_status in ('draft','pending','approved','rejected'));

-- 5a-lock. INTEGRITY: the approval columns may ONLY be set by
-- fn_admin_set_ad_approval (SECURITY DEFINER, which stamps approved_by =
-- auth.uid()). 05 granted authenticated a blanket insert/update on ads, which
-- would let an admin PostgREST-PATCH approval_status / approved_by directly and
-- forge the brand-safety audit trail. Narrow the grants to the CONTENT columns
-- only; approval_status / approved_by / approved_at / rejection_reason are then
-- unreachable except through the definer function. (select/delete unchanged.)
revoke insert, update on public.ads from authenticated;
grant insert (name, headline, tagline, cta_text, bg_gradient, text_color,
              image_url, duration_seconds, advertiser, campaign_id, active)
  on public.ads to authenticated;
grant update (name, headline, tagline, cta_text, bg_gradient, text_color,
              image_url, duration_seconds, advertiser, campaign_id, active,
              updated_at)
  on public.ads to authenticated;


-- ------------------------------------------------------------
-- 5b. fn_active_ad_for_machine — ENFORCEMENT POINT.
--     CONTRACT-PRESERVING re-create (same signature text->jsonb, same return
--     shape as 05). ADDS `and a.approval_status = 'approved'` to BOTH the
--     scheduled query AND the fallback query. An unapproved ad can NEVER render
--     even if scheduled. Timezone handling unchanged from 05 (UTC).
-- ------------------------------------------------------------
create or replace function public.fn_active_ad_for_machine(p_machine_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  l_date date := (now() at time zone 'UTC')::date;
  l_dow  int  := extract(dow from (now() at time zone 'UTC'))::int; -- 0=Sun
  l_min  int  := extract(hour from (now() at time zone 'UTC'))::int * 60
               + extract(minute from (now() at time zone 'UTC'))::int;
  l_ad   jsonb;
begin
  -- Scheduled match: APPROVED ads only.
  select to_jsonb(x) into l_ad from (
    select a.id, a.name, a.headline, a.tagline, a.cta_text, a.bg_gradient,
           a.text_color, a.image_url, a.duration_seconds, a.advertiser
    from public.ad_schedules s
    join public.ads a on a.id = s.ad_id
    where a.active
      and a.approval_status = 'approved'          -- <== GATE
      and s.active
      and (s.machine_id is null or s.machine_id = p_machine_id)
      and (s.starts_on is null or l_date >= s.starts_on)
      and (s.ends_on   is null or l_date <= s.ends_on)
      and (s.days_of_week is null or l_dow = any(s.days_of_week))
      and (
            s.start_min is null
         or (s.end_min is null and l_min >= s.start_min)
         or (s.end_min is not null and s.end_min >= s.start_min
             and l_min >= s.start_min and l_min < s.end_min)
         or (s.end_min is not null and s.end_min <  s.start_min   -- wrap past midnight
             and (l_min >= s.start_min or l_min < s.end_min))
      )
    order by (s.machine_id is not null) desc,
             s.priority desc,
             s.created_at desc
    limit 1
  ) x;

  if l_ad is not null then
    return l_ad;
  end if;

  -- Fallback: most-recent active AND APPROVED ad.
  select to_jsonb(x) into l_ad from (
    select a.id, a.name, a.headline, a.tagline, a.cta_text, a.bg_gradient,
           a.text_color, a.image_url, a.duration_seconds, a.advertiser
    from public.ads a
    where a.active
      and a.approval_status = 'approved'          -- <== GATE
    order by a.created_at desc
    limit 1
  ) x;

  return l_ad;  -- null if no approved+active ad exists
end;
$$;

revoke all on function public.fn_active_ad_for_machine(text) from public, anon, authenticated;
grant execute on function public.fn_active_ad_for_machine(text) to service_role;


-- ------------------------------------------------------------
-- 5c. fn_admin_set_ad_approval — trustworthy approve/reject  [authenticated + guard]
--     approved_by is set server-side from auth.uid() (never client-supplied).
-- ------------------------------------------------------------
create or replace function public.fn_admin_set_ad_approval(
  p_ad_id  uuid,
  p_status text,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_by  uuid := auth.uid();
  v_now timestamptz := now();
  v_id  uuid;
begin
  if not public.fn_is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  if p_status not in ('draft','pending','approved','rejected') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status', 'status', p_status);
  end if;

  update public.ads a
     set approval_status  = p_status,
         approved_by      = case when p_status = 'approved' then v_by else a.approved_by end,
         approved_at      = case when p_status = 'approved' then v_now else a.approved_at end,
         rejection_reason = case when p_status = 'rejected' then p_reason else null end,
         updated_at       = v_now
   where a.id = p_ad_id
  returning a.id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false, 'reason', 'ad_not_found', 'ad_id', p_ad_id);
  end if;

  return jsonb_build_object('ok', true, 'ad_id', v_id, 'approval_status', p_status,
                            'approved_by', case when p_status='approved' then v_by else null end,
                            'approved_at', case when p_status='approved' then v_now else null end);
end $$;

revoke all on function public.fn_admin_set_ad_approval(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_ad_approval(uuid, text, text) to authenticated;


-- ------------------------------------------------------------
-- FINAL: reload PostgREST schema cache so new fns/columns are visible via REST.
-- ------------------------------------------------------------
notify pgrst, 'reload schema';

-- ============================================================
-- POST-DEPLOY VERIFICATION (read-only — uncomment to run)
-- ============================================================
-- -- (i) RLS on all vending tables (expect rls + forced = true for all six):
-- select c.relname, c.relrowsecurity, c.relforcerowsecurity
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='public'
--    and c.relname in ('sessions','users','events','dispensing_log','otp_attempts','machines')
--  order by c.relname;
-- -- (ii) dispense contract preserved (service_role, real authed session):
-- --      select public.fn_dispense_demo('<authed-session-uuid>', '<raw-token>');
-- --      expect ok:true WITH ok/dispensed/machine_id/count/limit/dwell_ms + new stock_level.
-- -- (iii) approval gate: temporarily set an ad to 'draft', then
-- --      select public.fn_active_ad_for_machine('<live-machine>');  must NOT return it.
-- -- (iv) compliance card (as an admin JWT):  select public.fn_admin_compliance_status();
-- -- (v) stock status:  select public.fn_stock_status_internal();
-- ============================================================