-- REVIEW BEFORE APPLYING - applied by a human in the Supabase SQL editor; Studio code never runs it.
--
-- COVERED Studio: who may do what.  Roles: editor < approver < admin  (studio/DESIGN.md sections 7.3 and 8.3).
--
-- Design notes
--   * The Studio API never holds a service-role key. It reads the caller's own row with the CALLER'S JWT, so
--     Row Level Security is the enforcement point, not only API code.
--   * Authorisation is ONLY this table. user_metadata / app_metadata in the JWT are never used.
--   * People are invited by email (an admin inserts a row with user_id NULL). On first sign-in the API calls
--     studio_claim_role(), which binds the row to the signed-in auth user, but only when that user's email is
--     CONFIRMED and equals the invited email. Nobody can claim a role by typing someone else's email.
--   * Deactivate with active = false (the API re-reads the role on every request, cached <= 30 s).
--   * Turn OFF open sign-ups in Supabase Auth settings (invite only). This table is the second lock, not the first.
--
-- Rollback (manual):  drop function public.studio_claim_role(); drop table public.studio_audit; drop table public.studio_roles;

begin;

create table if not exists public.studio_roles (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users (id) on delete set null,
  email        text not null unique check (email = lower(email) and length(email) between 3 and 254),
  display_name text check (display_name is null or length(display_name) <= 60),
  role         text not null check (role in ('editor', 'approver', 'admin')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users (id) on delete set null
);

comment on table public.studio_roles is 'COVERED Studio people and roles. Read with the caller JWT under RLS; written by admins only.';

alter table public.studio_roles enable row level security;
alter table public.studio_roles force row level security;

revoke all on public.studio_roles from anon;
revoke all on public.studio_roles from authenticated;
grant select, insert, update on public.studio_roles to authenticated;
-- no DELETE for anyone: people are deactivated, never erased (the audit trail keeps pointing at them)

-- Is the caller an active admin?  security definer so the policy below does not recurse into itself.
create or replace function public.studio_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.studio_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin' and r.active
  );
$$;
revoke all on function public.studio_is_admin() from public, anon;
grant execute on function public.studio_is_admin() to authenticated;

-- read: your own row, or every row when you are an active admin
create policy studio_roles_select on public.studio_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or public.studio_is_admin());

-- insert / update: active admins only
create policy studio_roles_insert on public.studio_roles
  for insert to authenticated
  with check (public.studio_is_admin());

create policy studio_roles_update on public.studio_roles
  for update to authenticated
  using (public.studio_is_admin())
  with check (public.studio_is_admin());

-- Claim an invitation on first sign-in. Callable by any signed-in user, but it only ever touches the row whose email
-- equals the caller's own CONFIRMED email, and only while that row is unclaimed (or already theirs).
create or replace function public.studio_claim_role()
returns table (role text, active boolean, display_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid   uuid := (select auth.uid());
  mail  text;
  ok    boolean;
begin
  if uid is null then
    return;
  end if;
  select lower(u.email), (u.email_confirmed_at is not null)
    into mail, ok
    from auth.users u
   where u.id = uid;
  if mail is null or not ok then
    return;
  end if;
  update public.studio_roles r
     set user_id = uid
   where r.email = mail and (r.user_id is null or r.user_id = uid) and r.active;
  return query
    select r.role, r.active, r.display_name
      from public.studio_roles r
     where r.user_id = uid and r.active;
end;
$$;
revoke all on function public.studio_claim_role() from public, anon;
grant execute on function public.studio_claim_role() to authenticated;

-- Audit trail (the API also writes a console line and Git keeps commit trailers). Never values, tokens or bodies.
create table if not exists public.studio_audit (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  actor_id  uuid not null,
  action    text not null check (length(action) <= 40),
  target    jsonb not null default '{}'::jsonb,
  outcome   text not null check (outcome in ('ok', 'denied', 'invalid', 'conflict', 'error'))
);

alter table public.studio_audit enable row level security;
alter table public.studio_audit force row level security;
revoke all on public.studio_audit from anon;
revoke all on public.studio_audit from authenticated;
grant select, insert on public.studio_audit to authenticated;

create policy studio_audit_insert on public.studio_audit
  for insert to authenticated
  with check (actor_id = (select auth.uid()));

create policy studio_audit_select on public.studio_audit
  for select to authenticated
  using (public.studio_is_admin());

commit;

-- First admin (run ONCE, by hand, after reviewing; replace the address with yours, lowercase).
-- insert into public.studio_roles (email, display_name, role) values ('you@example.com', 'Teo', 'admin');
