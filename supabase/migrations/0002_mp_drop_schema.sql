-- pipeline-data-warehouse: safety net. The only way the pipeline drops schemas.
-- Refuses every name that is not a pipeline schema (mp_<domain>_s<seed>_bronze|silver|gold), so a clean-up
-- can never touch your other data. Run once in the SQL Editor.
create or replace function public.mp_drop_schema(p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_name is null or p_name !~ '^mp_[a-z]+_s[0-9]+_(bronze|silver|gold)$' then
    raise exception 'mp_drop_schema: "%" is not a pipeline schema (expected mp_<domain>_s<seed>_bronze|silver|gold)', p_name;
  end if;
  execute format('drop schema if exists %I cascade', p_name);
end;
$$;

comment on function public.mp_drop_schema(text) is
  'Drops a pipeline-data-warehouse schema. Fails unless the name matches ^mp_[a-z]+_s[0-9]+_(bronze|silver|gold)$.';

revoke execute on function public.mp_drop_schema(text) from public, anon, authenticated;
