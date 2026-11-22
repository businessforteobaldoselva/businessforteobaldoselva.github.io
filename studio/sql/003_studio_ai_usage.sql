-- REVIEW BEFORE APPLYING - applied by a human in the Supabase SQL editor; Studio code never runs it.
--
-- OPTIONAL (Phase 1). Moves Studio's AI daily allowance from "counted in memory, once per running copy of the API" to ONE shared
-- counter, adds a per-person counter, and keeps a short "recent requests" list for each person. Apply it, then set
-- STUDIO_AI_BUDGET_STORE=supabase on the API. Until you do both, nothing changes: Studio keeps counting in memory.
-- If this file is applied but the setting is off, the tables sit unused. If the setting is on and these functions are missing or
-- Supabase is down, Studio falls back to the memory counters (the caps still apply) and logs one "usage.store_fallback" line.
--
-- It builds on 002_studio_ai.sql, which stays as it is: the table studio_ai_usage (one row per UTC day) is reused for the
-- GLOBAL counters. What this file adds:
--   studio_ai_user_usage   one row per person per UTC day: requests and tokens. Counters only.
--   studio_ai_requests     one row per AI request a person made: when, which mode, what kind of answer, how many tokens, how many
--                          suggestions they accepted and which pull request it became. NO instruction text, NO page content,
--                          NO names. A person's own rows older than 30 days are deleted whenever they make a new request.
-- Both tables have row level security ON and NO policies, and everything is revoked from anon and signed-in users: nobody can
-- read or write them directly. They are reached only through the functions below, which run as their owner (security definer),
-- pin their search path, refuse anyone who is not an ACTIVE person in studio_roles (see 001_studio_roles.sql), and only ever touch
-- the caller's own rows (auth.uid()). They are callable by signed-in people only (never anon).
--
--   studio_ai_reserve2   adds one request and an estimated token count for the day, to the global counter AND the person's counter,
--                        in ONE transaction: it succeeds only if every cap holds, and it undoes the global step when the person's
--                        own cap refuses. Lock order is always global, then person, so two calls cannot deadlock.
--   studio_ai_settle2    replaces the estimate by the real tokens; can give the request back (an answer Studio had to reject).
--   studio_ai_release2   gives the request and the estimate back (the AI service did not answer).
--   studio_ai_snapshot2  today's numbers: global and the caller's.
--   studio_ai_record     writes / refreshes one row of "recent requests" for the caller.
--   studio_ai_attach     says how many suggestions were accepted and which pull request they became.
--   studio_ai_recent     the caller's last requests (at most 20), newest first.

create table if not exists public.studio_ai_user_usage (
  day      date    not null,
  user_id  uuid    not null,
  requests integer not null default 0 check (requests >= 0),
  tokens   bigint  not null default 0 check (tokens >= 0),
  primary key (day, user_id)
);

create table if not exists public.studio_ai_requests (
  id        text primary key check (id ~ '^p_[a-z0-9]{12}$'),
  user_id   uuid not null,
  at        timestamptz not null default now(),
  mode      text,
  kind      text,
  tokens    integer not null default 0 check (tokens >= 0),
  accepted  integer check (accepted >= 0),
  total     integer check (total >= 0),
  pr_number integer check (pr_number > 0)
);
create index if not exists studio_ai_requests_user_at on public.studio_ai_requests (user_id, at desc);

alter table public.studio_ai_user_usage enable row level security;
alter table public.studio_ai_requests enable row level security;
-- deliberately no policies: both tables are closed to direct access
revoke all on public.studio_ai_user_usage from anon, authenticated;
revoke all on public.studio_ai_requests from anon, authenticated;

create or replace function public.studio_ai_reserve2(p_day date, p_tokens bigint, p_max_requests integer, p_max_tokens bigint, p_user_max_requests integer)
returns table (ok boolean, reason text, g_requests integer, g_tokens bigint, u_requests integer, u_tokens bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  g record;
  u record;
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_tokens < 0 or p_max_requests < 1 or p_max_tokens < 1 or p_user_max_requests < 1 then
    raise exception 'bad arguments' using errcode = '22023';
  end if;
  insert into public.studio_ai_usage (day) values (p_day) on conflict (day) do nothing;
  insert into public.studio_ai_user_usage (day, user_id) values (p_day, caller) on conflict (day, user_id) do nothing;

  -- 1. the global counter (locks its row first)
  update public.studio_ai_usage x
     set requests = x.requests + 1, tokens = x.tokens + p_tokens
   where x.day = p_day and x.requests + 1 <= p_max_requests and x.tokens + p_tokens <= p_max_tokens
  returning x.requests, x.tokens into g;
  if not found then
    select x.requests, x.tokens into g from public.studio_ai_usage x where x.day = p_day;
    select y.requests, y.tokens into u from public.studio_ai_user_usage y where y.day = p_day and y.user_id = caller;
    return query select false, case when g.requests + 1 > p_max_requests then 'global_requests' else 'global_tokens' end, g.requests, g.tokens, u.requests, u.tokens;
    return;
  end if;

  -- 2. the person's counter; if THEIR cap refuses, undo step 1 in the same transaction
  update public.studio_ai_user_usage y
     set requests = y.requests + 1, tokens = y.tokens + p_tokens
   where y.day = p_day and y.user_id = caller and y.requests + 1 <= p_user_max_requests
  returning y.requests, y.tokens into u;
  if not found then
    update public.studio_ai_usage x
       set requests = x.requests - 1, tokens = x.tokens - p_tokens
     where x.day = p_day
    returning x.requests, x.tokens into g;
    select y.requests, y.tokens into u from public.studio_ai_user_usage y where y.day = p_day and y.user_id = caller;
    return query select false, 'user_requests', g.requests, g.tokens, u.requests, u.tokens;
    return;
  end if;
  return query select true, null::text, g.requests, g.tokens, u.requests, u.tokens;
end;
$$;

create or replace function public.studio_ai_settle2(p_day date, p_reserved bigint, p_actual bigint, p_count_request boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  give_back integer := case when p_count_request then 0 else 1 end;
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.studio_ai_usage x
     set tokens = greatest(0, x.tokens + p_actual - p_reserved), requests = greatest(0, x.requests - give_back)
   where x.day = p_day;
  update public.studio_ai_user_usage y
     set tokens = greatest(0, y.tokens + p_actual - p_reserved), requests = greatest(0, y.requests - give_back)
   where y.day = p_day and y.user_id = caller;
end;
$$;

create or replace function public.studio_ai_release2(p_day date, p_tokens bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.studio_ai_usage x
     set tokens = greatest(0, x.tokens - p_tokens), requests = greatest(0, x.requests - 1)
   where x.day = p_day;
  update public.studio_ai_user_usage y
     set tokens = greatest(0, y.tokens - p_tokens), requests = greatest(0, y.requests - 1)
   where y.day = p_day and y.user_id = caller;
end;
$$;

create or replace function public.studio_ai_snapshot2(p_day date)
returns table (g_requests integer, g_tokens bigint, u_requests integer, u_tokens bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select coalesce((select x.requests from public.studio_ai_usage x where x.day = p_day), 0),
           coalesce((select x.tokens from public.studio_ai_usage x where x.day = p_day), 0),
           coalesce((select y.requests from public.studio_ai_user_usage y where y.day = p_day and y.user_id = caller), 0),
           coalesce((select y.tokens from public.studio_ai_user_usage y where y.day = p_day and y.user_id = caller), 0);
end;
$$;

create or replace function public.studio_ai_record(p_id text, p_mode text, p_kind text, p_tokens bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_id !~ '^p_[a-z0-9]{12}$' or length(coalesce(p_mode, '')) > 20 or length(coalesce(p_kind, '')) > 20 or p_tokens < 0 then
    raise exception 'bad arguments' using errcode = '22023';
  end if;
  insert into public.studio_ai_requests (id, user_id, mode, kind, tokens)
  values (p_id, caller, p_mode, p_kind, least(p_tokens, 2147483647)::integer)
  on conflict (id) do update set at = now(), mode = excluded.mode, kind = excluded.kind, tokens = excluded.tokens
  where public.studio_ai_requests.user_id = caller;
  delete from public.studio_ai_requests r where r.user_id = caller and r.at < now() - interval '30 days';
  delete from public.studio_ai_user_usage y where y.user_id = caller and y.day < current_date - 35;
end;
$$;

create or replace function public.studio_ai_attach(p_id text, p_accepted integer, p_total integer, p_pr integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.studio_ai_requests r
     set accepted = p_accepted, total = p_total, pr_number = p_pr
   where r.id = p_id and r.user_id = caller;
end;
$$;

create or replace function public.studio_ai_recent(p_limit integer)
returns table (id text, at timestamptz, mode text, kind text, tokens integer, accepted integer, total integer, pr_number integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null or not exists (select 1 from public.studio_roles r where r.user_id = caller and r.active) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select q.id, q.at, q.mode, q.kind, q.tokens, q.accepted, q.total, q.pr_number
      from public.studio_ai_requests q
     where q.user_id = caller
     order by q.at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 20);
end;
$$;

revoke all on function public.studio_ai_reserve2(date, bigint, integer, bigint, integer) from public, anon;
revoke all on function public.studio_ai_settle2(date, bigint, bigint, boolean) from public, anon;
revoke all on function public.studio_ai_release2(date, bigint) from public, anon;
revoke all on function public.studio_ai_snapshot2(date) from public, anon;
revoke all on function public.studio_ai_record(text, text, text, bigint) from public, anon;
revoke all on function public.studio_ai_attach(text, integer, integer, integer) from public, anon;
revoke all on function public.studio_ai_recent(integer) from public, anon;
grant execute on function public.studio_ai_reserve2(date, bigint, integer, bigint, integer) to authenticated;
grant execute on function public.studio_ai_settle2(date, bigint, bigint, boolean) to authenticated;
grant execute on function public.studio_ai_release2(date, bigint) to authenticated;
grant execute on function public.studio_ai_snapshot2(date) to authenticated;
grant execute on function public.studio_ai_record(text, text, text, bigint) to authenticated;
grant execute on function public.studio_ai_attach(text, integer, integer, integer) to authenticated;
grant execute on function public.studio_ai_recent(integer) to authenticated;
