-- pipeline-data-warehouse: the two login roles the pipeline uses.
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor). Safe to run again.
--
--   powerbi_reader   Power BI reads the gold schemas of each run with it (select only, through RLS policies).
--   pipeline_loader  psql \copy loads raw CSV lines into one run's bronze table with it, and nothing else.
--
-- Neither role gets a password here. Choose them yourself afterwards (see the end of this file); they are
-- never written to a file in this repository or pasted into the chat.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
    create role powerbi_reader login noinherit connection limit 5;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pipeline_loader') then
    create role pipeline_loader login noinherit connection limit 3;
  end if;
end $$;

alter role pipeline_loader set statement_timeout = '10min';
alter role pipeline_loader set search_path = '';
alter role powerbi_reader  set statement_timeout = '5min';

-- Afterwards, in the SQL Editor, one statement per role with your own passwords:
--   alter role pipeline_loader with password '<loader password>';
--   alter role powerbi_reader  with password '<reader password>';
--
-- Then add one line for the loader to your pgpass file, so psql can log in without asking
-- (Windows: %APPDATA%\postgresql\pgpass.conf – create the folder and file if they are missing):
--   <pooler host>:5432:postgres:pipeline_loader.<project ref>:<loader password>
-- <pooler host> is the "Session pooler" host from Dashboard → Connect, e.g. aws-0-eu-west-1.pooler.supabase.com.
-- Power BI asks for the reader login (powerbi_reader.<project ref>) the first time you refresh a report.
