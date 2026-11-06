-- pipeline-data-warehouse: helpers the agents call with a plain select, so a run does not stop on
-- grant/policy statements. Same guard as mp_drop_schema: they only touch mp_<domain>_s<seed>_ objects.
-- Run once in the SQL Editor, after 0001 and 0002.

-- Read-only access for powerbi_reader on a run's gold schema (grants + RLS select policies).
create or replace function public.mp_grant_reader(p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s text := p_prefix || 'gold';
  t record;
  n int := 0;
begin
  if p_prefix is null or p_prefix !~ '^mp_[a-z]+_s[0-9]+_$' then
    raise exception 'mp_grant_reader: "%" is not a pipeline prefix (expected mp_<domain>_s<seed>_)', p_prefix;
  end if;
  if to_regnamespace(s) is null then
    raise exception 'mp_grant_reader: schema % does not exist', s;
  end if;
  execute format('grant usage on schema %I to powerbi_reader', s);
  execute format('grant select on all tables in schema %I to powerbi_reader', s);
  execute format('alter default privileges for role postgres in schema %I grant select on tables to powerbi_reader', s);
  for t in
    select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = s and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    execute format('drop policy if exists powerbi_reader_select on %I.%I', s, t.relname);
    execute format('create policy powerbi_reader_select on %I.%I for select to powerbi_reader using (true)', s, t.relname);
    n := n + 1;
  end loop;
  return format('powerbi_reader: usage + select on %I, RLS policy on %s table(s)', s, n);
end;
$$;

-- Lets pipeline_loader insert into one run's bronze.raw_lines (and read/clear it for a reload).
create or replace function public.mp_grant_loader(p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s text := p_prefix || 'bronze';
begin
  if p_prefix is null or p_prefix !~ '^mp_[a-z]+_s[0-9]+_$' then
    raise exception 'mp_grant_loader: "%" is not a pipeline prefix (expected mp_<domain>_s<seed>_)', p_prefix;
  end if;
  if to_regclass(s || '.raw_lines') is null then
    raise exception 'mp_grant_loader: table %.raw_lines does not exist', s;
  end if;
  execute format('grant usage on schema %I to pipeline_loader', s);
  execute format('grant select, insert, delete, truncate on %I.raw_lines to pipeline_loader', s);
  execute format('alter table %I.raw_lines enable row level security', s);
  execute format('drop policy if exists pipeline_loader_load on %I.raw_lines', s);
  execute format('create policy pipeline_loader_load on %I.raw_lines for all to pipeline_loader using (true) with check (true)', s);
  return format('pipeline_loader may load %I.raw_lines', s);
end;
$$;

-- Removes the load rights again after the load.
create or replace function public.mp_revoke_loader(p_prefix text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s text := p_prefix || 'bronze';
begin
  if p_prefix is null or p_prefix !~ '^mp_[a-z]+_s[0-9]+_$' then
    raise exception 'mp_revoke_loader: "%" is not a pipeline prefix (expected mp_<domain>_s<seed>_)', p_prefix;
  end if;
  if to_regclass(s || '.raw_lines') is not null then
    execute format('drop policy if exists pipeline_loader_load on %I.raw_lines', s);
    execute format('revoke all on %I.raw_lines from pipeline_loader', s);
  end if;
  if to_regnamespace(s) is not null then
    execute format('revoke usage on schema %I from pipeline_loader', s);
  end if;
  return format('pipeline_loader has no rights on %I any more', s);
end;
$$;

revoke execute on function public.mp_grant_reader(text)  from public, anon, authenticated;
revoke execute on function public.mp_grant_loader(text)  from public, anon, authenticated, pipeline_loader;
revoke execute on function public.mp_revoke_loader(text) from public, anon, authenticated, pipeline_loader;
