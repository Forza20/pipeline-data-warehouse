#!/usr/bin/env node
// Prints one SQL query that returns sample values for every catalogued Power BI column that is read
// straight from a gold table: {"table[column]": "v1 · v2 · v3", ...}. Run the query with the Supabase MCP
// (execute_sql) and save the JSON object as <pbip>/docs/samples.json; tools/build-site.js shows it in
// the catalog. Columns flagged as possible PII are left out, so their values are never fetched.
// Usage: node tools/sample-sql.js runs/<run-id>
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = path.resolve(process.argv[2] || '');
const runFile = path.join(runDir, 'run.json');
if (!process.argv[2] || !fs.existsSync(runFile)) {
  console.error('Usage: node tools/sample-sql.js runs/<run-id>  (folder with run.json)');
  process.exit(1);
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const run = readJson(runFile);
const root = path.resolve(runDir, '..', '..');
const pbipDir = run.paths?.pbip ? path.dirname(path.join(root, run.paths.pbip)) : path.join(runDir, 'pbip');
const catFile = path.join(pbipDir, 'docs', 'catalog.json');
if (!fs.existsSync(catFile)) { console.error('catalog.json missing: ' + catFile); process.exit(1); }
const cat = readJson(catFile);
const prefix = run.schema_prefix || '';

const lit = s => "'" + s.replace(/'/g, "''") + "'";
// gold columns behind the catalogued Power BI columns; possible PII is left out
const wanted = [], skipped = [];
for (const c of cat.columns || []) {
  const m = String(c.Origin || '').match(/^(\w+)\.(\w+)\.(\w+)$/);
  if (!m || (prefix && !m[1].startsWith(prefix))) continue;
  (c['Possible PII'] ? skipped : wanted).push(`${m[1]}.${m[2]}.${m[3]}`);
}
if (!wanted.length) { console.error('no columns with a gold origin'); process.exit(1); }
const gold = [...new Set(wanted.map(w => w.split('.')[0]))];
const all = [...new Set([...gold, ...gold.map(g => g.replace(/gold$/, 'silver')), ...gold.map(g => g.replace(/gold$/, 'bronze'))])].map(lit).join(', ');
const pii = [...new Set(skipped)].map(lit).join(', ');
// Bronze and silver have no PII flags, so person-like column names and whole raw CSV lines are skipped there.
const piiName = "'(^|_)(name|first_name|last_name|full_name|email|e_mail|phone|mobile|address|street|zip|postal|birth|birth_date|ssn|cpr)($|_)'";
// Result: {"values": {"schema.table.column": "v1 · v2 · v3"}, "rows": {"schema.table": n}}.
// build-site.js maps gold columns to the Power BI catalog through "Origin".
console.log(`select json_build_object(
 'values', (select json_object_agg(c.table_schema || '.' || c.table_name || '.' || c.column_name, coalesce((xpath('/row/v/text()', query_to_xml(format(
  'select string_agg(v, '' · '' order by length(v), v) as v from (select v from (select distinct left(%I::text, 40) as v from %I.%I where %I is not null) d order by length(v), v limit 3) x',
  c.column_name, c.table_schema, c.table_name, c.column_name), false, true, '')))[1]::text, '(tom)'))
  from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
  where t.table_type = 'BASE TABLE' and c.table_schema in (${all})${pii ? `\n    and c.table_schema || '.' || c.table_name || '.' || c.column_name not in (${pii})` : ''}
    and (c.table_schema not like '%\\_bronze' and c.table_schema not like '%\\_silver'
         or (c.column_name !~* ${piiName} and not (c.table_name = 'raw_lines' and c.column_name = 'line')))),
 'rows', (select json_object_agg(t.table_schema || '.' || t.table_name, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint)
  from information_schema.tables t where t.table_type = 'BASE TABLE' and t.table_schema in (${all}))
) as samples;`);
if (skipped.length) console.error(`left out as possible PII: ${skipped.join(', ')}`);
