-- REVIEW BEFORE APPLYING - applied by a human in the Supabase SQL editor; Studio code never runs it.
--
-- OPTIONAL. Studio's AI help counts its daily allowance in memory, once per running copy of the API. On a host that starts
-- several copies (serverless) every copy counts alone, so the real ceiling is the limit times the number of copies. If you
-- want ONE shared daily allowance, apply this file and wire a Supabase-backed budget store (the four methods in
-- studio/api/ai/budget.js: reserve, settle, release, snapshot). Nothing in Studio does that by default.
--
-- What it creates:
--   studio_ai_usage        one row per UTC day: how many AI requests and how many tokens were used. No instruction text,
--                          no page content, no names: counters only. Row level security is on and there are NO direct
--                          policies, so nobody can read or write the table except through the two functions below.
--   studio_ai_reserve      adds a request and an estimated token count for a day, but only if both stay under the caps.
--   studio_ai_settle       corrects the estimate to the real usage afterwards (can be negative).
-- Both functions run as their owner (security definer), are callable by signed-in people only, and refuse people who do not
-- have an active row in studio_roles (see 001_studio_roles.sql).

create table if not exists public.studio_ai_usage (
  day      date primary key,
  requests integer not null default 0 check (requests >= 0),
  tokens   bigint  not null default 0 check (tokens >= 0)
);

alter table public.studio_ai_usage enable row level security;
-- deliberately no policies: the table is closed to direct access
revoke all on public.studio_ai_usage from anon, authenticated;

create or replace function public.studio_ai_reserve(p_day date, p_tokens bigint, p_max_requests integer, p_max_tokens bigint)
returns table (ok boolean, requests integer, tokens bigint)
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
  if p_tokens < 0 or p_max_requests < 1 or p_max_tokens < 1 then
    raise exception 'bad arguments' using errcode = '22023';
  end if;
  insert into public.studio_ai_usage (day) values (p_day) on conflict (day) do nothing;
  return query
    with bumped as (
      update public.studio_ai_usage u
         set requests = u.requests + 1, tokens = u.tokens + p_tokens
       where u.day = p_day and u.requests + 1 <= p_max_requests and u.tokens + p_tokens <= p_max_tokens
       returning u.requests, u.tokens
    )
    select true, b.requests, b.tokens from bumped b
    union all
    select false, u.requests, u.tokens from public.studio_ai_usage u
     where u.day = p_day and not exists (select 1 from bumped);
end;
$$;

create or replace function public.studio_ai_settle(p_day date, p_delta bigint)
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
  update public.studio_ai_usage u set tokens = greatest(0, u.tokens + p_delta) where u.day = p_day;
end;
$$;

revoke all on function public.studio_ai_reserve(date, bigint, integer, bigint) from public, anon;
revoke all on function public.studio_ai_settle(date, bigint) from public, anon;
grant execute on function public.studio_ai_reserve(date, bigint, integer, bigint) to authenticated;
grant execute on function public.studio_ai_settle(date, bigint) to authenticated;
