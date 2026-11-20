#!/usr/bin/env node
// Tests for pipeline-power-bi: the profiler (Profile-Sources.ps1), the model generator (build-model.js) and
// the overview page (build-overview.js), on the fixtures in tests/fixtures (made by make-fixtures.py).
//
//   node .claude/skills/pipeline-power-bi/tests/run-tests.js            all 129 checks (25–30 s)
//   node .claude/skills/pipeline-power-bi/tests/run-tests.js --quick    99 checks (about 15 s): skips the drift checks that run the
//                                                                        profiler again and the Python checks
//                                                                        (model health, grounded answers)
//
// Use --quick while working; run without it before a commit. Windows only (the profiler needs Windows PowerShell 5.1). Writes only to a temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbi-test-'));
const QUICK = process.argv.includes('--quick');
let pass = 0;
const fails = [];
function check(name, ok, info) {
  if (ok) pass++; else fails.push(`${name}${info !== undefined ? ' – ' + info : ''}`);
}

// ---------- 1. profiler ----------
// The demo/business profile runs in the background at the same time as the fixtures profile (each is
// seconds of PowerShell); its checks are made at the end (section 4).
const DEMO_BIZ = path.join(SKILL, '..', '..', '..', 'demo', 'business');
const bizProfile = fs.existsSync(DEMO_BIZ)
  ? spawnAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
    '-Path', DEMO_BIZ, '-OutFile', path.join(TMP, 'profile-business.json'), '-Today', '2026-11-14'])
  : null;
// Real-looking data (full run only): a messy retail dataset (CSV, every error type) and a dummy workbook
// (Excel sheets with Danish names) are generated, profiled, drafted into a spec, built and replayed.
// Starts here in the background; checked at the end (section 4).
const realData = QUICK ? null : (async () => {
  const rd = path.join(TMP, 'real-data');
  const src = path.join(rd, 'src');
  fs.mkdirSync(src, { recursive: true });
  const ps = (file, a) => spawnAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...a]);
  const gen = await Promise.all([
    ps(path.join(SKILL, '..', 'messy-dataset', 'scripts', 'New-MessyDataset.ps1'), ['-Domain', 'retail', '-Seed', '7', '-Rows', '300',
      '-Errors', '1,2,3,4,5,6,7,8,9,10,11,12,13', '-OutDir', src, '-AnswersDir', path.join(rd, 'answers')]),
    ps(path.join(SKILL, '..', 'schema-dummy-data', 'scripts', 'New-DummyData.ps1'), ['-SchemaPath', path.join(SKILL, '..', 'schema-dummy-data', 'tests', 'fixtures', 'schema_basic.xlsx'),
      '-OutDir', src, '-Locale', 'en', '-Seed', '7', '-RowsFact', '200', '-RowsDim', '20', '-OutName', 'dummy']),
  ]);
  for (const f of fs.readdirSync(src)) if (f.endsWith('.md')) fs.rmSync(path.join(src, f));
  const run = path.join(rd, 'run');
  fs.mkdirSync(run);
  const prof = await ps(path.join(SKILL, 'scripts', 'Profile-Sources.ps1'), ['-Path', src, '-OutFile', path.join(run, 'profile.json'), '-RowsDir', path.join(run, 'rows'), '-Today', '2026-11-19']);
  return { gen, prof, run, src };
})();
const profFile = path.join(TMP, 'profile.json');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
  '-Path', FIX, '-OutFile', profFile, '-Today', '2026-11-06', '-RowsDir', path.join(TMP, 'rows')], { stdio: 'pipe' });
const prof = JSON.parse(fs.readFileSync(profFile, 'utf8').replace(/^﻿/, ''));
const T = (n) => prof.tables.find((t) => t.name === n) || { findings: [], columns: [] };
const has = (t, fix, col) => T(t).findings.some((f) => f.fix === fix && (col === undefined || f.column === col));
const find = (t, fix, col) => T(t).findings.find((f) => f.fix === fix && (col === undefined || f.column === col));

// orders.csv – a Danish-style CSV with most cleaning problems
check('csv: delimiter ;', T('orders').delimiter === ';', T('orders').delimiter);
check('csv: UTF-8 with BOM', /BOM/.test(T('orders').encoding), T('orders').encoding);
check('csv: header on line 3', T('orders').headerRow === 3, T('orders').headerRow);
check('csv: 12 data rows', T('orders').dataRows === 12, T('orders').dataRows);
for (const [fix, col] of [['F01'], ['F03'], ['F04'], ['F12'], ['F05', 'KundeID'], ['F07', 'Region'], ['F08', 'Dato'], ['F09', 'Beløb'],
  ['F10', 'Betalt'], ['F11', 'KundeID'], ['F14', 'Beløb'], ['F15', 'Dato'], ['F19', 'Note'], ['F28', 'Kanal'], ['F18', 'KundeID']]) {
  check(`orders: ${fix}${col ? ' ' + col : ''}`, has('orders', fix, col));
}
check('orders: F08 day-first', (find('orders', 'F08', 'Dato') || {}).variant === 'day-first');
check('orders: F11 target format from customers', (find('orders', 'F11', 'KundeID') || {}).variant === 'K-999', (find('orders', 'F11', 'KundeID') || {}).variant);
check('orders: F18 one orphan (K-009)', (find('orders', 'F18', 'KundeID') || {}).rows === 1);
check('orders: F12 one copy', (find('orders', 'F12') || {}).rows === 1);
check('orders: no F27 (no test rows)', !has('orders', 'F27'));
check('customers: F27 TEST ACCOUNT', has('customers', 'F27'));
check('customers: kinds', T('customers').columns.find((c) => c.name === 'KundeID').kind === 'id');
// workbook.xlsx – sheets, Excel table, modelling patterns
check('xlsx: Excel table read', T('tblContacts').kind === 'excel table');
check('xlsx: hidden sheet flagged', T('Notes').hidden === true);
check('xlsx: empty sheet flagged', T('Empty').isEmpty === true);
check('xlsx: real dates read as dates', T('Sales_2025').columns.find((c) => c.name === 'OrderDate').kind === 'date');
check('xlsx: F21 Sales_2025 + Sales_2026', (find('Sales_2025', 'F21') || {}).variant === 'Sales_2026');
check('xlsx: F22 Sheet1 copy of Products', (find('Sheet1', 'F22') || {}).variant === 'Products');
check('xlsx: F23 CategorySub', has('Products', 'F23', 'CategorySub'));
check('xlsx: F27 ZZZ-000', has('Products', 'F27'));
check('xlsx: F24 SKUs', has('Promo', 'F24', 'SKUs'));
check('xlsx: F26 Email', has('tblContacts', 'F26', 'Email'));
check('xlsx: F29 IsPrimary', has('tblContacts', 'F29', 'IsPrimary'));
check('xlsx: M02 Campaigns', (find('Campaigns', 'M02', 'CampaignName') || { examples: [] }).examples.join(',') === 'Channel,Budget');
check('xlsx: no F11 on ProductCode groups', !has('Products', 'F11'));
check('relation orders -> customers', prof.relations.some((r) => r.from === 'orders[KundeID]' && r.to === 'customers[KundeID]' && r.preferred));
check('no relation from a copied sheet', !prof.relations.some((r) => r.from.startsWith('Sheet1[')));

// ---------- 2. model generator ----------
const run = path.join(TMP, 'run');
fs.mkdirSync(run);
fs.copyFileSync(profFile, path.join(run, 'profile.json'));
const csvCols = ['Ordrenr', 'Dato', 'KundeID', 'Region', 'Beløb', 'Betalt', 'Kanal', 'Note'];
const spec = {
  name: 'Test', culture: 'en-US', cutoffDate: '2026-11-06', sourceFolder: FIX + '\\',
  staging: [
    { name: 'stg_orders', file: 'orders.csv', kind: 'csv', delimiter: ';', codePage: 65001, headerRow: 3, columns: csvCols,
      steps: [{ fix: 'F03' }, { fix: 'F04' }, { fix: 'F12' }, { fix: 'F19', columns: ['Note'] }, { fix: 'F05', columns: ['KundeID'] },
        { fix: 'F07', column: 'Region', map: { nord: 'Nord', syd: 'Syd' } }, { fix: 'F11', column: 'KundeID', prefix: 'K', separator: '-', digits: 3 },
        { fix: 'F08', column: 'Dato', dayFirst: true }, { fix: 'F09', column: 'Beløb' }, { fix: 'F10', column: 'Betalt' },
        { fix: 'F17', types: { Ordrenr: 'text', Region: 'text', Kanal: 'int' } }, { fix: 'F14', column: 'Beløb', checks: ['negative'] },
        { fix: 'F15', column: 'Dato' }, { fix: 'F28', column: 'Kanal', as: 'Channel', names: { 10: 'Web', 20: 'Store', 30: 'Phone' } }] },
    { name: 'stg_customers', file: 'customers.csv', kind: 'csv', delimiter: ',', codePage: 65001, headerRow: 1, columns: ['KundeID', 'Navn', 'Segment'],
      steps: [{ fix: 'F17', types: { KundeID: 'text', Navn: 'text', Segment: 'text' } }, { fix: 'F27', column: 'KundeID', values: ['K-100'] }] },
    { name: 'stg_products', file: 'workbook.xlsx', kind: 'sheet', item: 'Products', header: 'ProductCode', columns: ['ProductCode', 'ProductName', 'CategorySub'],
      steps: [{ fix: 'F23', column: 'CategorySub', separator: '|', names: ['Category', 'Subcategory'] }, { fix: 'F27', column: 'ProductCode', values: ['ZZZ-000'] }] },
    { name: 'stg_contacts', file: 'workbook.xlsx', kind: 'excel table', item: 'tblContacts', columns: ['CustomerID', 'ContactName', 'Email', 'IsPrimary'], steps: [] },
  ],
  tables: [
    { name: 'Customer', kind: 'dimension', from: 'stg_customers',
      ops: [{ op: 'inferMembers', key: 'KundeID', fromColumns: ['stg_orders[KundeID]'], defaults: { Navn: '"Unknown"' } },
        { op: 'inferMembers', key: 'Navn', fromColumns: ['stg_contacts[ContactName]'], defaults: { Segment: '"Unknown"' } }, { op: 'addKey', name: 'CustomerKey', sortBy: ['KundeID'] }],
      columns: [{ name: 'Customer key', from: 'CustomerKey', type: 'key', hidden: true }, { name: 'Customer ID', from: 'KundeID', type: 'text' },
        { name: 'Customer name', from: 'Navn', type: 'text' }, { name: 'Is inferred', from: 'IsInferred', type: 'bool' }] },
    { name: 'Sales', kind: 'fact', from: 'stg_orders',
      ops: [{ op: 'merge', with: 'Customer', on: ['KundeID'], withOn: ['Customer ID'], columns: ['Customer key'], as: ['CustomerKey'], ignoreCase: true }],
      columns: [{ name: 'Order ID', from: 'Ordrenr', type: 'text' }, { name: 'Order date', from: 'Dato', type: 'date' }, { name: 'Customer key', from: 'CustomerKey', type: 'key', hidden: true },
        { name: 'Amount', from: 'Beløb', type: 'number' }, { name: 'Amount issue', from: 'Beløb issue', type: 'text' }, { name: 'Paid', from: 'Betalt', type: 'bool' },
        { name: 'Channel', type: 'text' }, { name: 'Date status', from: 'Dato status', type: 'text' }] },
    { name: 'Product', kind: 'dimension', from: 'stg_products', columns: [{ name: 'Product code', from: 'ProductCode', type: 'text' }, { name: 'Category', type: 'text' }] },
    { name: 'Contact', kind: 'dimension', from: 'stg_contacts', ops: [{ op: 'filter', expr: '[IsPrimary] = true' }],
      columns: [{ name: 'Customer ID', from: 'CustomerID', type: 'int' }, { name: 'Email', type: 'text', hidden: true }] },
  ],
  date: { columns: ['Sales[Order date]'], completeMonth: 'Sales[Order date]' },
  relationships: [{ from: 'Sales[Customer key]', to: 'Customer[Customer key]' }, { from: 'Sales[Order date]', to: 'Date[Date]' }],
  measures: [{ name: 'Revenue', expr: 'CALCULATE ( SUM ( Sales[Amount] ), Sales[Amount issue] = "ok" )', format: '\\$#,0', folder: 'Sales', term: 'Revenue' },
    { name: 'Orders', expr: 'VAR n = DISTINCTCOUNT ( Sales[Order ID] )\nRETURN\n\tn', format: '#,0', folder: 'Sales' }],
  roles: [{ name: 'Test role', table: 'Customer', filter: '[Customer ID] = "K-001"' }],
};
// The two drift checks each start the profiler (seconds of PowerShell), so they run in the background,
// each in its own run folder, while the tests below run. Their results are checked at the end.
function spawnAsync(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function driftRun(name, srcFolder, extra = []) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  fs.copyFileSync(profFile, path.join(dir, 'profile.json'));
  fs.writeFileSync(path.join(dir, 'choices.json'), JSON.stringify({ build: spec }));
  const done = spawnAsync('node', [path.join(SKILL, 'scripts', 'check-drift.js'), dir, '--path', srcFolder, '--today', '2026-11-06', ...extra]);
  return done.then((r) => ({ ...r, dir }));
}
const newFix = path.join(TMP, 'newfiles');
fs.mkdirSync(newFix);
for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(newFix, f));
const csv = fs.readFileSync(path.join(newFix, 'orders.csv'), 'utf8').replace('Ordrenr;Dato;KundeID;Region;Beløb', 'Ordrenr;Dato;KundeID;Region;Belob');
fs.writeFileSync(path.join(newFix, 'orders.csv'), csv, 'utf8');
fs.rmSync(path.join(newFix, 'customers.csv'));
// unchanged files: the fixtures profile from section 1 is the new profile too (no extra profiler run);
// changed files: profiled by check-drift itself, and kept with --save-profile
const driftSame = QUICK ? null : driftRun('drift-same', FIX, ['--new-profile', profFile]);
const driftNew = QUICK ? null : driftRun('drift-new', newFix, ['--save-profile', path.join(TMP, 'drift-new-profile.json')]);

const glossary = [{ term: 'Revenue', definition: 'Order amounts without flagged anomalies.', owner: 'Finance' }];
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec, glossary, pii_not_personal: ['Customer[Customer name]'],
  design: { facts: [{ name: 'Sales', grain: 'one order' }], review: [{ point: 'history', status: 'open', note: 'region is current only' }] } }, null, 2));
const gen =(r, extra = []) => spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), r, ...extra], { encoding: 'utf8' });
let res = gen(run);
let out = {};
try { out = JSON.parse(res.stdout); } catch { /* reported below */ }
check('build: ok', res.status === 0 && out.ok, res.stdout + res.stderr);
check('build: 4 staging queries', out.staging === 4, out.staging);
check('build: 6 tables (4 + Date + _Measures)', out.tables === 6, out.tables);
check('build: all four parse functions', ['fnParseDate', 'fnParseNumber', 'fnParseBool', 'fnNormaliseId'].every((f) => (out.functions || []).includes(f)), out.functions);
const def = path.join(run, 'pbip', 'Test.SemanticModel', 'definition');
const ex = fs.existsSync(path.join(def, 'expressions.tmdl')) ? fs.readFileSync(path.join(def, 'expressions.tmdl'), 'utf8') : '';
for (const step of ['F01 Skip 2 title lines', 'F08 Parse Dato', 'F27 Remove test rows', 'F28 Channel names', 'Excel table tblContacts', 'F23 Split CategorySub']) {
  check(`build: step "${step}"`, ex.includes(step));
}
check('build: functions defined once', (ex.match(/expression fnParseDate =/g) || []).length === 1);
check('build: no tabs replaced by spaces', !/\n {2,}\S/.test(ex));
const sales = fs.existsSync(path.join(def, 'tables', 'Sales.tmdl')) ? fs.readFileSync(path.join(def, 'tables', 'Sales.tmdl'), 'utf8') : '';
check('build: Sales ends with final types', sales.includes('#"M99 Set final types"'));
check('build: hidden key column', /column 'Customer key'\n\t\tdataType: int64\n\t\tisHidden/.test(sales));
// Desktop refuses NestedJoin with key comparers ("Local evaluation … with key equality comparers is not supported")
check('build: case-insensitive merge without join comparers', !/NestedJoin\([^\n]*Comparer\./.test(sales) && /Text\.Lower\(Text\.From\(\[#"Customer ID"\]\)\)/.test(sales) && /Table\.RemoveColumns\(Table\.ExpandTableColumn/.test(sales));
const cust = fs.existsSync(path.join(def, 'tables', 'Customer.tmdl')) ? fs.readFileSync(path.join(def, 'tables', 'Customer.tmdl'), 'utf8') : '';
check('build: two inferMembers on one table share the flag column', cust.includes('#"F18 Add missing KundeID values"') && cust.includes('#"F18 Add missing Navn values"') &&
  (cust.match(/if Table\.HasColumns\([^,]+, "IsInferred"\) then/g) || []).length === 2 && (cust.match(/column 'Is inferred'/g) || []).length === 1);
check('build: date table marked', /dataCategory: Time/.test(fs.readFileSync(path.join(def, 'tables', 'Date.tmdl'), 'utf8')));
check('build: role file', fs.existsSync(path.join(def, 'roles', 'Test role.tmdl')));
check('build: model refs role', /ref role 'Test role'/.test(fs.readFileSync(path.join(def, 'model.tmdl'), 'utf8')));
check('build: multi-line measure indented', /measure Orders = \n\t\t\tVAR n/.test(fs.readFileSync(path.join(def, 'tables', '_Measures.tmdl'), 'utf8')));
const lineage = (fs.readFileSync(path.join(def, 'tables', 'Sales.tmdl'), 'utf8') + ex).match(/lineageTag: (\S+)/g) || [];
check('build: unique lineage tags', new Set(lineage).size === lineage.length);

// a spec with an error is refused and leaves the model in place
const before = fs.readFileSync(path.join(def, 'model.tmdl'), 'utf8');
const bad = JSON.parse(JSON.stringify(spec));
bad.relationships.push({ from: 'Sales[No such column]', to: 'Customer[Customer key]' });
bad.staging[0].steps.push({ fix: 'F99' });
// month names with a year column but no "year" key: every month would fall in the current year
bad.staging[0].steps.push({ fix: 'F16', keep: ['Ordrenr', 'Year'], attribute: 'month', value: 'target', period: 'monthName' });
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ build: bad }));
res = gen(run);
let badOut = {};
try { badOut = JSON.parse(res.stdout); } catch { /* reported below */ }
check('bad spec: exit code 2', res.status === 2, res.status);
check('bad spec: names all three errors', (badOut.errors || []).length === 3, JSON.stringify(badOut.errors));
check('bad spec: F16 month names without "year" stops the build', (badOut.errors || []).some((e) => /F16.*"year": "Year"/.test(e)), JSON.stringify(badOut.errors));
check('bad spec: model untouched', fs.readFileSync(path.join(def, 'model.tmdl'), 'utf8') === before);
check('bad spec: no half-written folder left', !fs.existsSync(path.join(def, '..', 'definition.new')));

// a locked model folder stops with exit code 3 and keeps the previous model (Windows only: a process
// whose working directory is inside a folder blocks renaming it, like an open MCP connection does)
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ build: spec }));
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: def, stdio: 'ignore' });
  res = gen(run);
  holder.kill();
  let lockOut = {};
  try { lockOut = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('locked folder: exit code 3', res.status === 3, res.status + ' ' + res.stderr.slice(-300));
  check('locked folder: says how to unlock', /locked/.test((lockOut.errors || [])[0] || '') && /Disconnect/.test((lockOut.errors || [])[0] || ''), JSON.stringify(lockOut.errors));
  check('locked folder: model untouched', fs.readFileSync(path.join(def, 'model.tmdl'), 'utf8') === before);
  check('locked folder: no half-written folder left', !fs.existsSync(path.join(def, '..', 'definition.new')));
}

const custTmdl = fs.readFileSync(path.join(def, 'tables', 'Customer.tmdl'), 'utf8');
check('build: pii_not_personal becomes annotation PII = not personal on that column only',
  /column 'Customer name'[\s\S]*?annotation PII = not personal/.test(custTmdl.split("column 'Is inferred'")[0]) && (custTmdl.match(/annotation PII = /g) || []).length === 1);
check('build: term annotation on the measure',/annotation Term = Revenue/.test(fs.readFileSync(path.join(def, 'tables', '_Measures.tmdl'), 'utf8')));

// ---------- 2. source-stats.js: expected values from the exported rows with the spec's steps ----------
{
  const ss = path.join(TMP, 'ss');
  fs.mkdirSync(ss);
  fs.copyFileSync(profFile, path.join(ss, 'profile.json'));
  fs.cpSync(path.join(TMP, 'rows'), path.join(ss, 'rows'), { recursive: true });
  check('profiler -RowsDir: a rows file per table', prof.tables.filter((t) => !t.isEmpty).every((t) => t.rowsFile && fs.existsSync(path.join(TMP, 'rows', t.rowsFile))));
  fs.writeFileSync(path.join(ss, 'choices.json'), JSON.stringify({ build: spec, checks: [] }));
  const qs = [
    { name: 'sales rows', table: 'Sales' },
    { name: 'all amounts', table: 'Sales', agg: 'sum', column: 'Amount' },
    { name: 'revenue', table: 'Sales', agg: 'sum', column: 'Amount', where: '[Amount issue] = "ok"', check: { dax: '[Revenue]', assumes: 'F14' } },
    { name: 'web orders', table: 'Sales', where: '[Channel] = "Web"' },
    { name: 'future dates', table: 'Sales', where: '[Date status] = "future"' },
    { name: 'last date', table: 'Sales', agg: 'max', column: 'Order date' },
    { name: 'K-009 inferred', table: 'Customer', where: '[Customer ID] = "K-009" and [Is inferred] = true' },
    { name: 'no test customer', table: 'Customer', where: '[Customer ID] = "K-100"' },
    { name: 'by customer', table: 'Sales', agg: 'sum', column: 'Amount', join: [{ table: 'Customer', on: 'Customer key', columns: ['Customer ID'] }], by: 'Customer ID' },
    { name: 'products without test row', table: 'Product', where: '[Product code] = "ZZZ-000"' },
    { name: 'primary contacts', table: 'Contact' },
  ];
  fs.writeFileSync(path.join(ss, 'q.json'), JSON.stringify(qs));
  const r = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), ss, '--queries', path.join(ss, 'q.json'), '--apply'], { encoding: 'utf8' });
  let o = { results: [] };
  try { o = JSON.parse(r.stdout); } catch { /* reported below */ }
  const v = (n) => (o.results.find((x) => x.name === n) || {});
  check('source-stats: runs without errors', r.status === 0 && o.ok, (r.stderr || r.stdout).slice(0, 600));
  check('source-stats: F03/F04/F12 leave 11 order rows', v('sales rows').value === 11, v('sales rows').value);
  check('source-stats: F09 parses 1.234,50 and -50,00 (sum 4049.7)', v('all amounts').value === 4049.7, v('all amounts').value);
  check('source-stats: F14 flag excludes the negative amount (4099.7)', v('revenue').value === 4099.7, v('revenue').value);
  check('source-stats: F17 int + F28 names (4 Web orders)', v('web orders').value === 4, v('web orders').value);
  check('source-stats: F15 future date flagged', v('future dates').value === 1, v('future dates').value);
  check('source-stats: F08 dates, max 2030-02-06', v('last date').value === '2030-02-06', v('last date').value);
  check('source-stats: inferMembers adds K-009, F27 removes K-100', v('K-009 inferred').value === 1 && v('no test customer').value === 0);
  check('source-stats: F11 + merge on the surrogate key (K-002 = 99.95 + 75.25 + 55)', Math.abs((v('by customer').values || {})['K-002'] - 230.2) < 1e-9, JSON.stringify(v('by customer').values));
  check('source-stats: Excel sheet with F27 and Excel table with a filter op', v('products without test row').value === 0 && v('primary contacts').value > 0 && !(o.tables.Contact || {}).approx);
  const cs = JSON.parse(fs.readFileSync(path.join(ss, 'choices.json'), 'utf8')).checks;
  check('source-stats --apply: check written to checks[]', cs.length === 1 && cs[0].dax === '[Revenue]' && cs[0].expected === 4099.7, JSON.stringify(cs));
  fs.writeFileSync(path.join(ss, 'qr.json'), JSON.stringify([{ name: 'raw rows', table: 'orders' }, { name: 'raw sum', table: 'orders', agg: 'sum', column: 'Beløb' }]));
  const raw = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), ss, '--raw', '--queries', path.join(ss, 'qr.json')], { encoding: 'utf8' });
  let ro = { results: [] };
  try { ro = JSON.parse(raw.stdout); } catch { /* reported below */ }
  check('source-stats --raw: profile tables, empty and total rows removed (12 rows, sum 4149.65)',
    ro.mode === 'raw' && ro.results[0].value === 12 && Math.abs(ro.results[1].value - 4149.65) < 1e-9, raw.stdout.slice(0, 400) + raw.stderr);
}

// ---------- 2b'. every fix the profiler can propose is built (build-model.js) and replayed (source-stats.js) ----------
// Guards against a fix that the profiler recommends but the build skips (F21 for CSV and F20 were such gaps).
// One spec with a staging query per fix (and variant) per source kind, one build and one source-stats run.
const tryRead = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
{
  const read = (f) => fs.readFileSync(path.join(SKILL, 'scripts', f), 'utf8');
  const caseIds = (src) => new Set([...src.matchAll(/case '(F\d\d)'/g)].map((m) => m[1]));
  const profilerIds = new Set([...read('Profile-Sources.ps1').matchAll(/'(F\d\d|M\d\d)'/g)].map((m) => m[1]));
  const bmSrc = read('build-model.js');
  const elsewhere = ((bmSrc.match(/if \((\[[^\]]*\])\.includes\(f\.fix\)\) return q; \/\/ handled elsewhere/) || [])[1] || '[]').match(/F\d\d|M\d\d/g) || [];
  // fixes with no staging step of their own, and where the test suite proves them instead
  const COVERAGE = {
    F01: 'source steps from kind/header/columns – checked below on every kind',
    F02: 'final column names in tables[] – snake-names.js tests',
    F18: 'inferMembers op on the dimension – build and source-stats tests above',
    F21: 'staging append – checked below (CSV) and here (sheet)',
    F22: 'design: the copy is left out – nothing to build',
    F26: 'design: column hidden or left out in tables[] – no staging step',
    F29: 'design: filter op on the detail table – Contact test above',
    M01: 'date.completeMonth – date table test above',
    M02: 'design: a new dimension table – no staging step',
    M03: 'design: a history table is kept whole – no staging step; profiler test below',
  };
  const K = {
    csv: { file: 'orders.csv', kind: 'csv', delimiter: ';', codePage: 65001, headerRow: 3, columns: csvCols,
      c: { text: 'Region', id: 'KundeID', date: 'Dato', num: 'Beløb', bool: 'Betalt', code: 'Kanal', empty: 'Note' } },
    sheet: { file: 'workbook.xlsx', kind: 'sheet', item: 'Sales_2025', header: 'OrderID', columns: ['OrderID', 'CustomerName', 'OrderDate', 'Amount'],
      c: { text: 'CustomerName', id: 'OrderID', date: 'OrderDate', num: 'Amount', bool: 'CustomerName', code: 'Amount', empty: 'CustomerName' } },
    'excel table': { file: 'workbook.xlsx', kind: 'excel table', item: 'tblContacts', columns: ['CustomerID', 'ContactName', 'Email', 'IsPrimary'],
      c: { text: 'ContactName', id: 'CustomerID', date: 'Email', num: 'CustomerID', bool: 'IsPrimary', code: 'CustomerID', empty: 'Email' } },
  };
  // variant -> [kinds, steps(c) (prerequisites first, the fix under test last), flag column made by the step]
  const STEPS = {
    F03: [['csv', 'sheet', 'excel table'], () => [{ fix: 'F03' }]],
    F04: [['csv', 'sheet', 'excel table'], () => [{ fix: 'F04' }]],
    F05: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F05', columns: [c.text] }]],
    F06: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F06', columns: [c.text] }]],
    F07: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F07', column: c.text, case: 'proper' }]],
    F08: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F08', column: c.date, dayFirst: true }]],
    F09: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F09', column: c.num }]],
    F10: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F10', column: c.bool }]],
    F11: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F11', column: c.id, prefix: 'K', separator: '-', digits: 3 }]],
    F12: [['csv', 'sheet', 'excel table'], () => [{ fix: 'F12' }]],
    F13: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F13', column: c.id }]],
    'F13 remove': [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F13', column: c.id, remove: ['X-1'], label: 'copies' }]],
    F14: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F09', column: c.num }, { fix: 'F14', column: c.num, checks: ['negative', 'spike'], spike: 1000 }], (c) => `${c.num} issue`],
    'F14 remove': [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F09', column: c.num }, { fix: 'F14', column: c.num, checks: ['negative'], mode: 'remove' }]],
    F15: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F08', column: c.date }, { fix: 'F15', column: c.date }], (c) => `${c.date} status`],
    'F15 remove': [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F08', column: c.date }, { fix: 'F15', column: c.date, mode: 'remove' }]],
    F16: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F16', keep: [c.id], attribute: 'Period', value: 'Value', period: 'yyyy-MM' }]],
    F17: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F17', types: { [c.text]: 'text' } }]],
    F19: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F19', columns: [c.empty] }]],
    F20: [['csv'], () => [{ fix: 'F20', column: 'Kanal' }], () => 'Row check'],
    'F20 remove': [['csv'], () => [{ fix: 'F20', column: 'Kanal', mode: 'remove' }]],
    F23: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F23', column: c.text, separator: '|', names: ['Part 1', 'Part 2'] }]],
    F24: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F24', column: c.text }]],
    F25: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F25', columns: [c.empty] }]],
    F27: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F27', column: c.id, values: ['ZZZ-000'] }]],
    'F27 flag': [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F27', column: c.id, values: ['ZZZ-000'], mode: 'flag' }], () => 'Is test row'],
    F28: [['csv', 'sheet', 'excel table'], (c) => [{ fix: 'F28', column: c.code, names: { 10: 'Web' }, as: 'Code name' }], () => 'Code name'],
  };
  const stepFixes = new Set(Object.keys(STEPS).map((k) => k.slice(0, 3)));
  const uncovered = [...profilerIds].filter((id) => !stepFixes.has(id) && !COVERAGE[id]);
  check('fix coverage: every fix the profiler can propose has a build test or a stated place', uncovered.length === 0, `no test for ${uncovered.join(', ')} – add it to STEPS or COVERAGE`);
  const silent = elsewhere.filter((id) => !COVERAGE[id]);
  check('fix coverage: build-model.js skips no fix without a stated place', silent.length === 0, `skipped by build-model.js: ${silent.join(', ')}`);
  const notReplayed = [...caseIds(bmSrc)].filter((id) => !caseIds(read('source-stats.js')).has(id));
  check('fix coverage: every step build-model.js writes is replayed by source-stats.js', notReplayed.length === 0, notReplayed.join(', '));

  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const staging = [];
  const cases = [];
  for (const [variant, [kinds, steps, flag]] of Object.entries(STEPS)) {
    for (const kind of kinds) {
      const { c, ...src } = K[kind];
      const name = `stg_${slug(variant)}_${slug(kind)}`;
      staging.push({ name, ...src, steps: steps(c) });
      cases.push({ variant, fix: variant.slice(0, 3), kind, name, flag: flag && flag(c) });
    }
  }
  // F21 on two sheets (Sales_2026 has an extra column) – the CSV form is tested in the next block
  staging.push({ name: 'stg_f21_sheet', ...(({ c, ...s }) => s)(K.sheet), append: [{ item: 'Sales_2026', columns: ['OrderID', 'CustomerName', 'OrderDate', 'Amount', 'Legacy'] }], steps: [] });
  const cr = path.join(TMP, 'fix-coverage');
  fs.mkdirSync(cr);
  fs.copyFileSync(profFile, path.join(cr, 'profile.json'));
  fs.cpSync(path.join(TMP, 'rows'), path.join(cr, 'rows'), { recursive: true });
  fs.writeFileSync(path.join(cr, 'choices.json'), JSON.stringify({ build: { name: 'Cov', culture: 'en-US', cutoffDate: '2026-11-06', sourceFolder: FIX + '\\',
    staging, tables: [], relationships: [], measures: [] } }));
  const b = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), cr], { encoding: 'utf8' });
  let bo = {};
  try { bo = JSON.parse(b.stdout); } catch { /* reported below */ }
  check(`fix coverage: ${staging.length} staging queries build`, b.status === 0 && bo.ok && bo.staging === staging.length, (b.stdout + b.stderr).slice(0, 800));
  const exprs = tryRead(path.join(cr, 'pbip', 'Cov.SemanticModel', 'definition', 'expressions.tmdl'));
  const block = (name) => (exprs.split(/\nexpression /).find((x) => x.startsWith(name + ' =')) || '');
  const noStep = cases.filter((x) => !block(x.name).includes(`#"${x.fix} `)).map((x) => `${x.variant} (${x.kind})`);
  check('fix coverage: every fix writes a step named after it, on every source kind', noStep.length === 0, noStep.join(', '));
  const noF01 = Object.keys(K).filter((kind) => !block(`stg_f03_${slug(kind)}`).includes('#"F01 '));
  check('fix coverage: F01 source steps on every kind', noF01.length === 0, noF01.join(', '));
  check('fix coverage: F21 sheet append written', block('stg_f21_sheet').includes('#"F21 Append Sales_2025 and Sales_2026"'));

  const qs = cases.map((x) => ({ name: x.name, table: x.name }));
  for (const x of cases.filter((y) => y.flag)) qs.push({ name: `${x.name} flag`, table: x.name, agg: 'count', column: x.flag });
  qs.push({ name: 'f21 sheet', table: 'stg_f21_sheet' }, { name: 'f20 short', table: 'stg_f20_csv', where: '[Row check] = "short line"' });
  fs.writeFileSync(path.join(cr, 'q.json'), JSON.stringify(qs));
  const s = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), cr, '--queries', path.join(cr, 'q.json')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let so = { results: [], tables: {} };
  try { so = JSON.parse(s.stdout); } catch { /* reported below */ }
  check('fix coverage: source-stats replays every staging query', s.status === 0 && so.ok, (s.stderr || s.stdout).slice(0, 600));
  const val = (n) => (so.results.find((x) => x.name === n) || {}).value;
  const notExact = cases.filter((x) => typeof val(x.name) !== 'number' || (so.tables[x.name] || {}).approx || ((so.tables[x.name] || {}).unsupported || []).length)
    .map((x) => `${x.variant} (${x.kind}): ${JSON.stringify((so.tables[x.name] || {}).unsupported || val(x.name))}`);
  check('fix coverage: every fix replays exactly (no approx, no unsupported step)', notExact.length === 0, notExact.join('; '));
  const noFlag = cases.filter((x) => x.flag && val(`${x.name} flag`) !== val(x.name)).map((x) => `${x.variant} (${x.kind})`);
  check('fix coverage: flag steps fill their flag column on every row', noFlag.length === 0, noFlag.join(', '));
  check('fix coverage: F20 remove keeps exactly the lines flag mode marks ok', val('stg_f20_remove_csv') === val('stg_f20_csv') - val('f20 short'),
    `${val('stg_f20_remove_csv')} vs ${val('stg_f20_csv')} - ${val('f20 short')}`);
  check('fix coverage: F21 sheet append replays both sheets (6 + 6 rows)', val('f21 sheet') === 12, val('f21 sheet'));
}

// ---------- 2b''. F21 append of CSV files (one file per year) ----------
{
  const ar = path.join(TMP, 'csv-append');
  fs.mkdirSync(ar);
  // a second CSV with the customers layout: the same exported rows under another file name
  const p = JSON.parse(JSON.stringify(prof));
  const custT = p.tables.find((t) => t.name === 'customers');
  p.tables.push({ ...custT, name: 'customers_b', file: custT.file.replace(/customers\.csv$/, 'customers_b.csv') });
  fs.writeFileSync(path.join(ar, 'profile.json'), JSON.stringify(p));
  fs.cpSync(path.join(TMP, 'rows'), path.join(ar, 'rows'), { recursive: true });
  const cols = ['KundeID', 'Navn', 'Segment'];
  const aspec = { name: 'App', culture: 'en-US', cutoffDate: '2026-11-06', sourceFolder: FIX + '\\',
    staging: [{ name: 'stg_customers', file: 'customers.csv', kind: 'csv', delimiter: ',', codePage: 65001, headerRow: 1, columns: cols,
      append: [{ file: 'customers_b.csv' }],
      steps: [{ fix: 'F17', types: { KundeID: 'text', Navn: 'text', Segment: 'text', SourceFile: 'text' } }, { fix: 'F27', column: 'KundeID', values: ['K-100'] }] }],
    tables: [{ name: 'Customer', kind: 'dimension', from: 'stg_customers',
      columns: [{ name: 'Customer ID', from: 'KundeID', type: 'text' }, { name: 'Source file', from: 'SourceFile', type: 'text' }] }],
    relationships: [], measures: [] };
  fs.writeFileSync(path.join(ar, 'choices.json'), JSON.stringify({ build: aspec }));
  const b = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), ar], { encoding: 'utf8' });
  let bo = {};
  try { bo = JSON.parse(b.stdout); } catch { /* reported below */ }
  check('csv append: builds', b.status === 0 && bo.ok, (b.stdout + b.stderr).slice(0, 600));
  const ex2 = tryRead(path.join(ar, 'pbip', 'App.SemanticModel', 'definition', 'expressions.tmdl'));
  const csvCalls = ex2.match(/Csv\.Document\(File\.Contents\(SourceFolder & "customers(_b)?\.csv"\), \[Delimiter = ",", Columns = 3, Encoding = 65001/g) || [];
  check('csv append: one Csv.Document per file, delimiter and encoding inherited', csvCalls.length === 2, csvCalls.length);
  check('csv append: parts combined with a SourceFile column named after each file',
    ex2.includes('#"F21 Append customers and customers_b"') && ex2.includes('"SourceFile", each "customers", type text') && ex2.includes('"SourceFile", each "customers_b", type text'));
  check('csv append: step names unique per part', ex2.includes('#"F01 Promote headers customers"') && ex2.includes('#"F01 Promote headers customers_b"'));
  fs.writeFileSync(path.join(ar, 'q.json'), JSON.stringify([{ name: 'rows', table: 'Customer' }, { name: 'by file', table: 'Customer', by: 'Source file' },
    { name: 'test rows', table: 'Customer', where: '[Customer ID] = "K-100"' }]));
  const s = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), ar, '--queries', path.join(ar, 'q.json')], { encoding: 'utf8' });
  let so = { results: [], tables: {} };
  try { so = JSON.parse(s.stdout); } catch { /* reported below */ }
  const v = (n) => so.results.find((x) => x.name === n) || {};
  check('csv append: source-stats reads both files exactly (2 x 4 customers after F27)', s.status === 0 && v('rows').value === 8 && !(so.tables.Customer || {}).approx, (s.stderr || JSON.stringify(v('rows'))).slice(0, 400));
  check('csv append: rows tagged per file (4 + 4) and the step runs after the append', JSON.stringify(v('by file').values) === JSON.stringify({ customers: 4, customers_b: 4 }) && v('test rows').value === 0, JSON.stringify(v('by file').values));
}

// ---------- 2a. model context, model health, drift ----------
// the bad-spec test above replaced choices.json – put the good one back
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec, glossary,
  design: { facts: [{ name: 'Sales', grain: 'one order' }], review: [{ point: 'history', status: 'open', note: 'region is current only' }] } }, null, 2));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-context.js'), run], { encoding: 'utf8' });
let ctx = {};
try { ctx = JSON.parse(res.stdout); } catch { /* reported below */ }
const ctxMd = fs.existsSync(path.join(run, 'model-context.md')) ? fs.readFileSync(path.join(run, 'model-context.md'), 'utf8') : '';
check('context: ok, no warnings', res.status === 0 && ctx.ok && ctx.warnings.length === 0, res.stdout + res.stderr);
check('context: glossary term with its measure', ctxMd.includes('**Revenue** – Order amounts without flagged anomalies. Measure: [Revenue].'));
check('context: grain, role and open review point', ctxMd.includes('one row = one order') && ctxMd.includes('**Test role**') && ctxMd.includes('history: region is current only'));

// ---------- 2a'. hand-over files from the spec (build-docs.js) ----------
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec,
  checks: [{ name: 'Rows Sales', dax: 'COUNTROWS ( Sales )', expected: 11, assumes: 'F03, F04, F12' }, { name: 'bad', expected: 1 }],
  expected_notes: '## Reconciliation\n\nThe I alt row does not match.' }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), run], { encoding: 'utf8' });
let bd = {};
try { bd = JSON.parse(res.stdout); } catch { /* reported below */ }
const rd = (f) => (fs.existsSync(path.join(run, f)) ? fs.readFileSync(path.join(run, f), 'utf8') : '');
const clog = rd('cleaning-log.md'); const cdax = rd('checks.dax'); const cev = rd('expected-values.md');
check('docs: ok, one bad check skipped with a warning', res.status === 0 && bd.ok && bd.checks.given === 1 && bd.warnings.length === 1, res.stdout + res.stderr);
check('docs: cleaning log names the real step names', clog.includes('| F08 | Dato |') && clog.includes('`F08 Parse Dato`') && clog.includes('`F28 Channel names`') && clog.includes('`F23 Split CategorySub`'), clog.slice(0, 600));
check('docs: a finding without a step is "not kept"', /\| F26 \| Email \| \d+ \| not kept \|/.test(clog) && /Not kept: F26 ContactName/.test(clog));
check('docs: a fix built in a model table is kept there', clog.includes('in Customer: `F18 Missing KundeID values`'));
check('docs: automatic orphan and test-row checks', cdax.includes('"Sales rows without Customer"') && cdax.includes('\'Customer\'[Customer ID] IN { "K-100" }') && cdax.includes('\'Product\'[Product code] IN { "ZZZ-000" }') && (bd.checks || {}).auto === 4, JSON.stringify(bd.checks));
{ // F27 values must match the column type, else Power BI: "CONTAINSROW ... Text with Integer"
  const tr = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f27type-'));
  const sp = JSON.parse(JSON.stringify(spec));
  sp.staging.find((s) => s.name === 'stg_contacts').steps = [{ fix: 'F27', column: 'CustomerID', values: ['9999', 'Export date 2023'] }];
  sp.staging.find((s) => s.name === 'stg_customers').steps.push({ fix: 'F27', column: 'CustomerKey', values: ['30---'] });
  fs.writeFileSync(path.join(tr, 'choices.json'), JSON.stringify({ run_id: 'f27', name: 'F27', build: sp }));
  const r = spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), tr], { encoding: 'utf8' });
  const d = fs.existsSync(path.join(tr, 'checks.dax')) ? fs.readFileSync(path.join(tr, 'checks.dax'), 'utf8') : '';
  check('docs: F27 on int column keeps only numbers, unquoted', d.includes("'Contact'[Customer ID] IN { 9999 }"), r.stdout + r.stderr + d.slice(0, 400));
  check('docs: F27 with only text values on a key column writes no check', !/'Customer'\[Customer key\] IN/.test(d) && d.includes('\'Customer\'[Customer ID] IN { "K-100" }'));
  fs.rmSync(tr, { recursive: true, force: true });
}
check('docs: given check in DAX and expected values', cdax.includes('( "Rows Sales", COUNTROWS ( Sales ), 11 )') && cev.includes('| Rows Sales | 11 | F03, F04, F12 | |') && cev.includes('The I alt row does not match.'));
// stale checks: a design change after the expected values were computed marks the checks that read it
const docs = (extra = []) => { const r = spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), run, ...extra], { encoding: 'utf8' }); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout + r.stderr }; } };
check('docs: checks-basis.json written on the first run', fs.existsSync(path.join(run, 'checks-basis.json')) && (bd.checks || {}).stale.length === 0);
const changed = JSON.parse(JSON.stringify(spec));
changed.tables.find((t) => t.name === 'Product').ops = [{ op: 'filter', expr: '[ProductCode] <> null' }];
changed.tables.find((t) => t.name === 'Customer').columns[2].hidden = true;
const docsChoices = (b) => fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: b,
  checks: [{ name: 'Rows Sales', dax: 'COUNTROWS ( Sales )', expected: 11 }, { name: 'Revenue', dax: '[Revenue]', expected: 100 }] }));
docsChoices(changed);
// grounded-answer questions: one filters on Product, one only reads Sales through its measure
fs.writeFileSync(path.join(run, 'questions.json'), JSON.stringify([{ question: 'Revenue in Web', measure: 'Revenue', filters: { 'Sales[Channel]': 'Web' }, expected: 1 },
  { question: 'Orders of category X', measure: 'Orders', filters: { "'Product'[Category]": 'X' }, expected: 1 }]));
let st = docs();
check('docs: a change no check reads (Product filter, a hidden column) is not a stale check', (st.checks || {}).stale.length === 0, JSON.stringify(st));
check('docs: …but makes the question that filters on Product stale', JSON.stringify((st.checks || {}).staleQuestions) === '["Orders of category X"]' && /question "Orders of category X"/.test(st.warnings.join(' ')), JSON.stringify(st));
changed.staging[0].steps.push({ fix: 'F13', columns: ['Ordrenr'] });
docsChoices(changed);
st = docs();
check('docs: a staging change marks the checks on its table and measures stale', JSON.stringify((st.checks || {}).stale) === '["Rows Sales","Revenue"]' &&
  /changed after the expected values/.test(st.warnings.join(' ')) && rd('expected-values.md').includes('| Rows Sales (stale) |') && rd('checks.dax').includes('// STALE:'), JSON.stringify(st));
st = docs(['--checks-updated']);
const st2 = docs();
check('docs: --checks-updated takes the new basis', (st.checks || {}).stale.length === 0 && (st2.checks || {}).stale.length === 0 && (st2.checks || {}).staleQuestions.length === 0 && !rd('checks.dax').includes('STALE'), JSON.stringify(st2));
check('docs: a staging change on Sales also makes its measure\'s question stale', JSON.stringify(((docsChoices(spec), docs()).checks || {}).staleQuestions || []).includes('Revenue in Web'));
fs.unlinkSync(path.join(run, 'questions.json'));
fs.unlinkSync(path.join(run, 'checks-basis.json'));

// run-summary.js: the compact summary for --resume and step 7
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', report_culture: 'en-US', currency: 'USD', fast: true, build: spec,
  status: { build: 'done' }, extras: { catalog: true, layout: false },
  tables: { orders: { include: true, table_name: 'Sales', fixes: [{ fix: 'F08', column: 'Dato', keep: true, variant: 'day-first' }, { fix: 'F14', column: 'Beløb', keep: false },
    { fix: 'F16', column: 'a, b, c, d, e', keep: true }] }, Sheet1: { include: false } },
  design: { facts: [{ name: 'Sales', grain: 'one order', sources: ['orders'] }], dimensions: [{ name: 'Customer', sources: ['customers'] }],
    left_out: [{ table: 'Sheet1', reason: 'copy' }], review: [{ point: 'Channel names', status: 'open' },
      { point: 'Discount', status: 'confirmed', note: 'gross', evidence: { value: '−$24,857 (−4.7 %)', how: 'LineTotal vs after discount' } }] } }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'run-summary.js'), run], { encoding: 'utf8' });
const sum = res.stdout || '';
check('summary: settings, schema, cleaning, model and review in one text', res.status === 0 && sum.includes('**Test** (`test`) · en-US, USD · fast mode') && sum.includes('**Star schema: 1 facts, 1 dimensions**') &&
  sum.includes('- orders → Sales: 2 steps – F08 Dato (day-first), F16 a, b … e (5 columns) · not kept: F14 Beløb') && sum.includes('(not included: Sheet1)') &&
  sum.includes('2 relationships') && sum.includes('Extras: catalog') && sum.includes('**Review points: 1 open, 1 settled**') && sum.includes('- (confirmed) Discount → gross · evidence: −$24,857 (−4.7 %)') &&
  sum.includes('(1 point(s) without measured evidence)'), sum);
// the same evidence on the overview page and in the model context
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-overview.js'), run], { encoding: 'utf8' });
check('overview: review point shows its evidence', res.status === 0 && rd('overview.html').includes('evidence: −$24,857 (−4.7 %) – LineTotal vs after discount'));
const evChoices = JSON.parse(fs.readFileSync(path.join(run, 'choices.json'), 'utf8'));
evChoices.design.review[0].evidence = { value: '4 codes, 312 rows', how: 'distinct OrderChannel' };
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify(evChoices));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-context.js'), run], { encoding: 'utf8' });
check('context: open point shows its evidence', res.status === 0 && rd('model-context.md').includes('- Open review point – Channel names:  (measured: 4 codes, 312 rows – distinct OrderChannel)'), rd('model-context.md').split('## Known limits')[1]);
res = spawnSync('node', [path.join(SKILL, 'scripts', 'run-summary.js'), run, '--json'], { encoding: 'utf8' });
let sj = {};
try { sj = JSON.parse(res.stdout); } catch { /* reported below */ }
check('summary --json: same content as data', sj.run === 'test' && sj.sources.length === 1 && sj.review.open.length === 1 && sj.measures.length === 2, res.stdout.slice(0, 300));
check('summary: without analysis it says step 2b is still to run', sum.includes('**Analysis:** not planned yet – run step 2b (analysis-planning)') && sj.analysis === null);
// analysis-planning (step 2b) writes choices.json → analysis; the summary shows it first
const anChoices = JSON.parse(fs.readFileSync(path.join(run, 'choices.json'), 'utf8'));
anChoices.analysis = { purpose: 'Monthly revenue per region', audience: 'sales managers',
  kpis: [{ name: 'Revenue', definition: 'sum of orders.amount, paid only', source: 'user' }, { name: 'Orders', source: 'drafted' }],
  dimensions: [{ column: 'customers.region', source: 'user' }], time_grain: 'month', comparisons: ['previous month'],
  questions: [{ text: 'Revenue in Nord last complete month?', source: 'user' }], tables: ['orders', 'customers'], asked: 6 };
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify(anChoices));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'run-summary.js'), run], { encoding: 'utf8' });
const asum = res.stdout || '';
check('summary: analysis shows purpose, numbers, split, time, questions and drafted count', res.status === 0 &&
  asum.includes('**Analysis:** Monthly revenue per region (for sales managers)') &&
  asum.includes('- Numbers: Revenue, Orders · split by: customers.region · time: month, previous month') &&
  asum.includes('- Questions: Revenue in Nord last complete month?') && asum.includes('(1 drafted, not asked)') &&
  asum.indexOf('**Analysis:**') < asum.indexOf('**Star schema'), asum.slice(0, 600));
check('summary: analysis without a dashboard plan asks for step 2b', asum.includes('- Dashboard plan: none yet – run step 2b (analysis-planning)'));
// the dashboard plan (analysis-planning's last part): pages with visual → KPI, the KPIs and what is left out
anChoices.analysis.dashboard_plan = { status: 'approved', template: 'adventureworks',
  pages: [{ key: 'exec', visuals: [{ visual: 'KPI tile 1 (Total Revenue)', kpi: 'Revenue' }, { visual: 'KPI tile 4 (Return Rate)', kpi: null, note: 'no returns' }] }],
  kpis: [{ name: 'Revenue', definition: 'sum of orders.amount, paid only', dax: 'SUM ( orders[amount] )', comparison: 'previous month' }],
  left_out: [{ page: 'map', reason: 'no location column' }] };
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify(anChoices));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'run-summary.js'), run], { encoding: 'utf8' });
const psum = res.stdout || '';
check('summary: dashboard plan shows template, visual → KPI, KPI definitions and left-out pages', res.status === 0 &&
  psum.includes('- Dashboard plan (approved): Generic layout – exec') &&
  psum.includes('  - exec: KPI tile 1 (Total Revenue) → Revenue · KPI tile 4 (Return Rate) → – no returns') &&
  psum.includes('  - KPI Revenue: sum of orders.amount, paid only (vs previous month)') &&
  psum.includes('  - Left out: map – no location column'), psum.slice(0, 900));
const py = process.env.PYTHON || 'python';
if (!QUICK) {
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'model_health.py'), path.join(run, 'pbip'), '--profile', profFile, '--out', run], { encoding: 'utf8' });
  let mh = {};
  try { mh = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('health: ok', res.status === 0 && mh.ok, res.stdout + res.stderr);
  const mhList = fs.existsSync(path.join(run, 'model-health.json')) ? JSON.parse(fs.readFileSync(path.join(run, 'model-health.json'), 'utf8')) : [];
  check('health: unused fact column flagged', mhList.some((f) => f.kind === 'unused column' && f.where === 'Sales[Channel]'));
  check('health: used column not flagged', !mhList.some((f) => f.where === 'Sales[Amount]'));
  check('health: visible dimension attribute not flagged', !mhList.some((f) => f.where === 'Customer[Customer name]'));
  // pbip-catalog's fast first run: only the missing descriptions, no Excel
  const catOut = path.join(TMP, 'catalog');
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, '..', 'pbip-catalog', 'scripts', 'build_catalog.py'), path.join(run, 'pbip'), '--out', catOut, '--missing-only'], { encoding: 'utf8' });
  let cm = {};
  try { cm = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('catalog --missing-only: lists missing descriptions', res.status === 0 && cm.missingOnly && cm.missingDescriptions > 0 && fs.existsSync(path.join(catOut, 'missing_descriptions.json')), res.stdout + res.stderr);
  check('catalog --missing-only: writes no Excel or catalog.json', !fs.existsSync(path.join(catOut, 'catalog.xlsx')) && !fs.existsSync(path.join(catOut, 'catalog.json')));
  // annotation PII = not personal: the parser reads it, the wiki and the catalog stop flagging the column
  const gov = path.join(SKILL, '..', 'pbip-governance', 'scripts');
  const modelJson = path.join(TMP, 'model.json');
  res = spawnSync(py, ['-X', 'utf8', path.join(gov, 'parse_pbip.py'), path.join(run, 'pbip'), '--output', modelJson], { encoding: 'utf8' });
  const pm = fs.existsSync(modelJson) ? JSON.parse(fs.readFileSync(modelJson, 'utf8')) : { model: { tables: [] } };
  const pmCust = (pm.model.tables.find((t) => t.name === 'Customer') || { columns: [] }).columns;
  check('parser --output: writes UTF-8 JSON with column annotations', res.status === 0 && ((pmCust.find((c) => c.name === 'Customer name') || {}).annotations || {}).PII === 'not personal', res.stdout + res.stderr);
  const wikiZip = path.join(TMP, 'wiki.zip');
  res = spawnSync(py, ['-X', 'utf8', path.join(gov, 'generate_azdo_wiki.py'), modelJson, '--output', wikiZip], { encoding: 'utf8' });
  const govMd = spawnSync(py, ['-X', 'utf8', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);n=[x for x in z.namelist() if x.endswith("Governance.md")][0];sys.stdout.write(z.read(n).decode("utf-8"))', wikiZip], { encoding: 'utf8' }).stdout || '';
  check('wiki: reviewed column listed as reviewed, not as potential PII', res.status === 0 && govMd.includes('Reviewed as not personal data (`annotation PII = not personal`): `Customer[Customer name]`') &&
    !/\| `Customer` \| `Customer name` \|/.test(govMd), govMd.slice(0, 900) + res.stderr);
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, '..', 'pbip-catalog', 'scripts', 'build_catalog.py'), path.join(run, 'pbip'), '--out', catOut, '--no-dbml'], { encoding: 'utf8' });
  const catJ = fs.existsSync(path.join(catOut, 'catalog.json')) ? JSON.parse(fs.readFileSync(path.join(catOut, 'catalog.json'), 'utf8')) : { columns: [] };
  const catRow = (n) => (catJ.columns || []).find((r) => r.Table === 'Customer' && r.Column === n) || {};
  check('catalog: reviewed column not flagged, a real one still is', res.status === 0 && catRow('Customer name')['Possible PII'] === 'No (reviewed: not personal)' && !catRow('Customer name').Sensitivity &&
    String(((catJ.columns || []).find((r) => r.Table === 'Contact' && r.Column === 'Email') || {})['Possible PII']).startsWith('Yes'), res.stderr.slice(-500) + JSON.stringify(catRow('Customer name')));
  // the user's own Power BI project as input: its CSV/Excel source files are found; a .pbix is refused
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'pbip_sources.py'), path.join(run, 'pbip')], { encoding: 'utf8' });
  let ps = {};
  try { ps = JSON.parse(res.stdout); } catch { /* reported below */ }
  const psNames = (ps.files || []).filter((f) => f.exists).map((f) => path.basename(f.path)).sort().join(',');
  check('own pbip: finds its three source files', res.status === 0 && psNames === 'customers.csv,orders.csv,workbook.xlsx', psNames + res.stderr);
  check('own pbip: tables named per file', ((ps.files || []).find((f) => path.basename(f.path) === 'orders.csv') || { tables: [] }).tables.includes('Sales'));
  // governance/handover.md from the model and the choices
  fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec, pii_not_personal: ['Customer[Customer name]'],
    handover_notes: ['One payment after the data date is left out.'],
    design: { facts: [{ name: 'Sales', grain: 'one order' }], review: [{ point: 'Revenue before discount', status: 'confirmed', note: 'gross', evidence: { value: '−4.7 %', how: 'after discount' } },
      { point: 'Channel names', status: 'open' }], left_out: [{ table: 'Sheet1', reason: 'copy of Products' }] } }));
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'build_handover.py'), run], { encoding: 'utf8' });
  let ho = {};
  try { ho = JSON.parse(res.stdout); } catch { /* reported below */ }
  const hmd = rd(path.join('governance', 'handover.md'));
  check('handover: ok, one role, nothing visible to review', res.status === 0 && ho.ok && ho.roles === 1 && ho.pii.visible === 0, res.stdout + res.stderr);
  check('handover: decisions, open points and notes from the choices', hmd.includes('- Revenue before discount → gross – evidence: −4.7 % – after discount (confirmed)') && hmd.includes('## Open points\n\n- Channel names\n- One payment after the data date'), hmd.slice(0, 400));
  check('handover: PII hidden and reviewed, grain, role filter, left out', hmd.includes('| Contact[Email] | hidden |') && hmd.includes('| Customer[Customer name] | visible – reviewed, not personal data |') &&
    hmd.includes('| Sales | fact | one order |') && hmd.includes('Role **Test role**') && hmd.includes('- Sheet1: copy of Products'), hmd);
  // rebuild.js: every script in order, the optional ones skipped with a reason, and a stop at the first failure
  // (extras.layout_profile names a file that is not there: a warning, not a failure)
  {
    const cf = path.join(run, 'choices.json'); const cj = JSON.parse(fs.readFileSync(cf, 'utf8'));
    cj.extras = { ...(cj.extras || {}), layout_profile: path.join(run, 'no-such-layout-profile.json') };
    fs.writeFileSync(cf, JSON.stringify(cj, null, 2));
  }
  res = spawnSync('node', [path.join(SKILL, 'scripts', 'rebuild.js'), run], { encoding: 'utf8', env: { ...process.env, PYTHON: py } });
  let rb = {};
  try { rb = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('rebuild: a missing extras.layout_profile file is a warning', (rb.warnings || []).some((w) => /extras\.layout_profile: .*no-such-layout-profile\.json does not exist/.test(w)), JSON.stringify(rb.warnings));
  {
    const cf = path.join(run, 'choices.json'); const cj = JSON.parse(fs.readFileSync(cf, 'utf8'));
    delete cj.extras.layout_profile; fs.writeFileSync(cf, JSON.stringify(cj, null, 2));
  }
  check('rebuild: all steps in order, ok', res.status === 0 && rb.ok && (rb.steps || []).map((x) => x.step).join(',') === 'build-model,descriptions,build-docs,build-context,parse-model,model-health,grounded-answers,check-results,dax-guide,handover,overview', res.stdout.slice(0, 800) + res.stderr);
  // the model is parsed once and the temp file removed afterwards
  check('rebuild: parsed model passed on and cleaned up', (rb.steps || []).some((x) => x.step === 'parse-model' && x.ok && !x.skipped)
    && !fs.readdirSync(require('os').tmpdir()).some((f) => f === `ppbi-parsed-${res.pid}.json`));
  // descriptions.py: every table, column and measure has a /// description after a rebuild, and the Excel list exists
  {
    const dr = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'descriptions.py'), path.join(run, 'pbip'), '--warn-only'], { encoding: 'utf8' });
    let dj = {};
    try { dj = JSON.parse(dr.stdout); } catch { /* reported below */ }
    check('descriptions: Date and _Measures columns described by build-model, Excel list written',
      dr.status === 0 && dj.total > 0 && !(dj.missing || []).some((k) => /^Date\[|^_Measures\[Placeholder\]$/.test(k)) && fs.existsSync(dj.xlsx || ''), dr.stdout.slice(0, 600) + dr.stderr);
  }
  // descriptions.py: --redo replaces one named measure's description (even one from the spec), the review
  // note is counted, only /// lines change, and a rebuild keeps the redone text
  {
    const dRun = path.join(TMP, 'desc-run');
    fs.cpSync(run, dRun, { recursive: true });
    const cf = path.join(dRun, 'choices.json');
    const ch = JSON.parse(fs.readFileSync(cf, 'utf8'));
    ch.build.measures[0].description = 'Spec text for Revenue.';
    fs.writeFileSync(cf, JSON.stringify(ch, null, 1));
    const bm = () => spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dRun], { encoding: 'utf8' });
    let res2 = bm();
    const dp = path.join(dRun, 'pbip');
    const docs = path.join(dp, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    const aiF = path.join(docs, 'ai_descriptions.json');
    const ai = fs.existsSync(aiF) ? JSON.parse(fs.readFileSync(aiF, 'utf8').replace(/^﻿/, '')) : {};
    ai['_Measures[Revenue]'] = 'Redone: sum of Amount on rows whose Amount issue is ok.';
    fs.writeFileSync(aiF, JSON.stringify(ai));
    fs.writeFileSync(path.join(docs, 'description_notes.json'), JSON.stringify({ review: { Revenue: 'Assumes Amount is in USD.' } }));
    const sm = fs.readdirSync(dp).find((d) => d.endsWith('.SemanticModel'));
    const tdir = path.join(dp, sm, 'definition', 'tables');
    const snap = () => Object.fromEntries(fs.readdirSync(tdir).map((f) => [f, fs.readFileSync(path.join(tdir, f), 'utf8')]));
    const strip = (s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith('///')).join('\n');
    const revDesc = (files) => { const t = Object.values(files).find((s) => /measure Revenue\b/.test(s)) || ''; const m = t.match(/\/\/\/ ([^\r\n]*)\r?\n\s*measure Revenue\b/); return m ? m[1] : ''; };
    const before = snap();
    const dr = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'descriptions.py'), dp, '--apply', '--redo', 'Revenue', '--warn-only'], { encoding: 'utf8' });
    let dj = {};
    try { dj = JSON.parse(dr.stdout); } catch { /* reported below */ }
    const after = snap();
    check('descriptions --redo: spec description replaced by the AI text, one review note',
      res2.status === 0 && revDesc(before) === 'Spec text for Revenue.' && dr.status === 0 && dj.redone === 1 && dj.toReview === 1 && revDesc(after).startsWith('Redone:'), res2.stderr + dr.stdout.slice(0, 600) + dr.stderr);
    check('descriptions --apply: only /// lines changed', Object.keys(before).every((f) => strip(before[f]) === strip(after[f])));
    const notes = JSON.parse(fs.readFileSync(path.join(docs, 'description_notes.json'), 'utf8'));
    res2 = bm();
    check('descriptions --redo: key saved in description_notes.json, a rebuild keeps the redone text',
      (notes.redo || []).includes('Revenue') && notes.review && res2.status === 0 && revDesc(snap()).startsWith('Redone:'), res2.stdout.slice(0, 300) + res2.stderr);
  }
  // filter contract, measure-test.js and the DAX rules of model health – on a copy of the run
  {
    const fRun = path.join(TMP, 'filter-run');
    fs.cpSync(run, fRun, { recursive: true });
    const cf = path.join(fRun, 'choices.json');
    const ch = JSON.parse(fs.readFileSync(cf, 'utf8'));
    ch.build.measures[0].filters = { ignore: ['Date[Month]'], keep: ['Product[Category]'], additive: true };
    ch.build.measures.push({ name: 'Revenue share', expr: 'VAR r = [Revenue]\nRETURN\n\tDIVIDE ( r, CALCULATE ( [Revenue], REMOVEFILTERS ( Product ) ) )', format: '0.0 %', folder: 'Sales' },
      { name: 'Bad', expr: 'SUM ( Sales[Amount] ) / [Orders] + [Nope] + YEAR ( TODAY () ) + 98765.43 + Sales[Ghost] // [Comment] / 2', folder: 'Sales' });
    ch.checks = [...(ch.checks || []), { name: 'Revenue total', dax: '[Revenue]', expected: 98765.43, assumes: 'test' }];
    fs.writeFileSync(cf, JSON.stringify(ch, null, 1));
    let r = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), fRun], { encoding: 'utf8' });
    const r2 = spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), fRun], { encoding: 'utf8' });
    const cdax = fs.existsSync(path.join(fRun, 'checks.dax')) ? fs.readFileSync(path.join(fRun, 'checks.dax'), 'utf8') : '';
    check('filter contract: ignore, keep and additive rows in checks.dax',
      r.status === 0 && r2.status === 0 && cdax.includes('"Revenue ignores a Date[Month] filter", ROUND ( CALCULATE ( \'_Measures\'[Revenue], FIRSTNONBLANK ( ALL ( \'Date\'[Month] )') &&
      cdax.includes('"Revenue follows a Product[Category] filter"') && cdax.includes('"Revenue adds up over Product[Category]", ROUND ( SUMX ( ALL ( \'Product\'[Category] )'), r.stderr + r2.stdout.slice(0, 400) + r2.stderr);
    // measure-test.js: DEFINE with the measure and the spec measure it uses, checks with the expected value, per-member breakdown
    r = spawnSync('node', [path.join(SKILL, 'scripts', 'measure-test.js'), fRun, 'Revenue share', '--by', 'Product[Category]'], { encoding: 'utf8' });
    let mt = {};
    try { mt = JSON.parse(r.stdout); } catch { /* reported below */ }
    const mdax = fs.existsSync(path.join(fRun, 'measure-test.dax')) ? fs.readFileSync(path.join(fRun, 'measure-test.dax'), 'utf8') : '';
    check('measure-test: DEFINE holds the measure and the measure it uses, B groups by the column',
      r.status === 0 && JSON.stringify(mt.defined) === '["Revenue","Revenue share"]' && /DEFINE\n    MEASURE '_Measures'\[Revenue\] =/.test(mdax) &&
      mdax.includes("MEASURE '_Measures'[Revenue share] =") && mdax.includes("SUMMARIZECOLUMNS ( 'Product'[Category], \"Revenue share\", '_Measures'[Revenue share] )") &&
      (mt.warnings || []).some((w) => /no expected value/.test(w)) && (mt.warnings || []).some((w) => /no filters contract/.test(w)), r.stdout.slice(0, 600) + r.stderr);
    let bd = {};
    try { bd = JSON.parse(r2.stdout); } catch { /* reported below */ }
    check('build-docs: a measure with REMOVEFILTERS and no filter contract is named, one with a contract is not',
      JSON.stringify((bd.checks || {}).missingContract) === '["Revenue share"]' && (bd.warnings || []).some((w) => /no filter contract for Revenue share/.test(w)), r2.stdout.slice(0, 600));
    r = spawnSync('node', [path.join(SKILL, 'scripts', 'measure-test.js'), fRun, 'Revenue share', '--show-vars', '--out', path.join(fRun, 'vars.dax')], { encoding: 'utf8' });
    const vdax = fs.existsSync(path.join(fRun, 'vars.dax')) ? fs.readFileSync(path.join(fRun, 'vars.dax'), 'utf8') : '';
    check('measure-test --show-vars: the scalar VARs in a ROW of their own', r.status === 0 && /EVALUATE\n    VAR r =\n        \[Revenue\]\n    RETURN\n        ROW \( "r", r \)/.test(vdax), r.stdout.slice(0, 400) + r.stderr + vdax.slice(-300));
    r = spawnSync('node', [path.join(SKILL, 'scripts', 'measure-test.js'), fRun, 'Revenue'], { encoding: 'utf8' });
    const mdax2 = fs.existsSync(path.join(fRun, 'measure-test.dax')) ? fs.readFileSync(path.join(fRun, 'measure-test.dax'), 'utf8') : '';
    check('measure-test: own expected value and filter contract in A, --by defaults to the first keep column',
      r.status === 0 && mdax2.includes('( "Revenue total", \'_Measures\'[Revenue], 98765.43 )') && mdax2.includes('"Revenue follows a Product[Category] filter"') &&
      mdax2.includes("SUMMARIZECOLUMNS ( 'Product'[Category]"), r.stdout.slice(0, 400) + r.stderr);
    // model health: the four DAX rules hit the bad measure only
    r = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'model_health.py'), path.join(fRun, 'pbip'), '--choices', cf, '--out', fRun], { encoding: 'utf8' });
    const hl = fs.existsSync(path.join(fRun, 'model-health.json')) ? JSON.parse(fs.readFileSync(path.join(fRun, 'model-health.json'), 'utf8')) : [];
    const daxKinds = ['today in measure', 'division without DIVIDE', 'unknown reference', 'hardcoded result'];
    const onBad = (k) => hl.some((f) => f.kind === k && f.where === '[Bad]');
    const unk = (hl.find((f) => f.kind === 'unknown reference' && f.where === '[Bad]') || {}).text || '';
    check('health: today, division, unknown reference and hardcoded result found in the bad measure',
      r.status === 0 && daxKinds.every(onBad) && unk.includes('[Nope]') && unk.includes('Sales[Ghost]') && !unk.includes('Comment'), r.stdout.slice(0, 400) + r.stderr + JSON.stringify(hl.filter((f) => daxKinds.includes(f.kind))));
    check('health: no DAX warning for the good measures', !hl.some((f) => daxKinds.includes(f.kind) && f.where !== '[Bad]'), JSON.stringify(hl.filter((f) => daxKinds.includes(f.kind))));
  }
  check('rebuild: grounded answers skipped without questions.json, handover run (governance folder)', ((rb.steps || []).find((x) => x.step === 'grounded-answers') || {}).skipped === 'no questions.json yet (step 8.9)' &&
    ((rb.steps || []).find((x) => x.step === 'handover') || {}).ok && !((rb.steps || []).find((x) => x.step === 'handover') || {}).skipped);
  check('rebuild: next names the TMDL validation', (rb.next || []).some((x) => /ConnectFolder/.test(x)));
  // build-dax-guide.js: the run's own guide (mandatory hand-over), its numbers from checks.dax, copied with --downloads
  {
    const gf = path.join(run, 'checks.dax_grounded-answers.dax guide.html');
    const gtxt = fs.existsSync(gf) ? fs.readFileSync(gf, 'utf8') : '';
    const nChecks = (fs.readFileSync(path.join(run, 'checks.dax'), 'utf8').match(/^\s*\(\s*"/gm) || []).length;
    check('dax guide: written by rebuild, names the run and the number of checks, no questions yet',
      gtxt.includes('<code>test</code>') && gtxt.includes(`in ${nChecks} rows`) && gtxt.includes('step 8.9'), gtxt.slice(0, 300));
    // without dax_guide.why the "why" column is written from the cleaning log: "<n> … (Fxx)" per kept fix
    // (a small run folder of its own: the test run above has no key checks)
    const wr = path.join(TMP, 'why-run'); fs.mkdirSync(wr, { recursive: true });
    fs.writeFileSync(path.join(wr, 'choices.json'), JSON.stringify({ name: 'Why', run_id: 'why', report_language: 'en',
      build: { measures: [{ name: 'revenue', expr: 'CALCULATE ( SUM ( fact_sales[amount] ), fact_sales[amount_issue] = "ok" )' }] },
      checks: [{ name: 'Revenue', dax: '[revenue]', expected: 100, assumes: 'F11, F12, F14 flag' }, { name: 'Rows fact_sales', dax: 'COUNTROWS ( fact_sales )', expected: 9, assumes: 'F12' }] }));
    fs.writeFileSync(path.join(wr, 'checks.dax'), 'EVALUATE\nDATATABLE (\n  ( "Revenue", [revenue], 100 ),\n  ( "Rows fact_sales", COUNTROWS ( fact_sales ), 9 )\n)\n');
    fs.writeFileSync(path.join(wr, 'cleaning-log.md'), ['# Cleaning log', '', '## orders.csv → staging `stg_orders` → fact_sales', '',
      '| Fix | Column | Rows | Choice | Variant | Step |', '|---|---|---|---|---|---|',
      '| F11 | customer_id | 40 | kept | C-999 | `F11 Normalise customer_id` |', '| F12 | – | 3 | kept | – | `F12 Remove exact duplicates` |',
      '| F14 | amount | 2 | kept | flag | `F14 Flag amount` |', '| F14 | amount | 1 | kept | flag | `F14 Flag amount` |', ''].join('\n'));
    spawnSync('node', [path.join(SKILL, 'scripts', 'build-dax-guide.js'), wr], { encoding: 'utf8' });
    const wtxt = (() => { try { return fs.readFileSync(path.join(wr, 'checks.dax_grounded-answers.dax guide.html'), 'utf8'); } catch { return ''; } })();
    const whys = [...wtxt.matchAll(/<tr><td>([^<]*)<\/td><td class="n">[^<]*<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
    const why = Object.fromEntries(whys);
    check('dax guide: the why comes from the cleaning log – row counts per fix, F11 only when the check uses the column, COUNTROWS finds the table',
      why.Revenue === '3 exact copies removed (F12); 3 amount values flagged and left out (negative, zero or spike) (F14).'
      && why['Rows fact_sales'] === '3 exact copies removed (F12).', JSON.stringify(whys));
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'daxguide-'));
    const gr = spawnSync('node', [path.join(SKILL, 'scripts', 'build-dax-guide.js'), run, '--lang', 'da', '--downloads', dl], { encoding: 'utf8' });
    let gj = {};
    try { gj = JSON.parse(gr.stdout); } catch { /* reported below */ }
    const dtxt = fs.existsSync(gf) ? fs.readFileSync(gf, 'utf8') : '';
    check('dax guide: --lang da --downloads copies guide + checks.dax, Danish text names the Downloads paths',
      gr.status === 0 && gj.lang === 'da' && (gj.downloads || []).some((f) => f.endsWith('checks.dax_grounded-answers.dax guide.html') && fs.existsSync(f)) &&
      fs.existsSync(path.join(dl, 'checks.dax')) && dtxt.includes('Sådan bruger du') && dtxt.includes(path.join(dl, 'checks.dax')), gr.stdout.slice(0, 400) + gr.stderr);
    fs.rmSync(dl, { recursive: true, force: true });
  }
  // record-checks.js: a pasted DAX query view table (Danish numbers) or MCP JSON fills expected-values.md and one result line
  {
    const exp = [...fs.readFileSync(path.join(run, 'checks.dax'), 'utf8').matchAll(/^\s*\(\s*"((?:[^"]|"")*)"\s*,.*,\s*(-?[0-9.]+)\s*\)\s*,?\s*$/gm)].map((m) => [m[1], Number(m[2])]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    const tsv = (wrong) => ['Check\tIn Power BI\tExpected\tDifference', ...exp.map(([n, v], i) => {
      const got = i === 0 && wrong ? v + 1 : v;
      return [n, got.toLocaleString('da-DK'), v.toLocaleString('da-DK'), String(got - v).replace('.', ',')].join('\t');
    })].join('\r\n');
    const rec = (file) => spawnSync('node', [path.join(SKILL, 'scripts', 'record-checks.js'), run, '--checks', file, '--no-overview'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(tmp, 'bad.txt'), tsv(true));
    let r1 = rec(path.join(tmp, 'bad.txt')); let j1 = {}; try { j1 = JSON.parse(r1.stdout); } catch { /* reported below */ }
    check('record-checks: a pasted table with one difference → exit 1, ❌ line names the check',
      r1.status === 1 && j1.allZero === false && (j1.checks || {}).fail.length === 1 && rd('expected-values.md').includes(`❌ **Result`) && rd('expected-values.md').includes(exp[0][0]), r1.stdout.slice(0, 500) + r1.stderr);
    fs.writeFileSync(path.join(tmp, 'ok.json'), JSON.stringify({ results: [{ tables: [{ rows: exp.map(([n, v]) => ({ '[Check]': n, '[In Power BI]': v, '[Expected]': v, '[Difference]': 0 })) }] }] }));
    const r2 = rec(path.join(tmp, 'ok.json')); let j2 = {}; try { j2 = JSON.parse(r2.stdout); } catch { /* reported below */ }
    const ev2 = rd('expected-values.md');
    check('record-checks: MCP JSON with every Difference 0 → exit 0, one ✅ line, In Power BI + Difference filled',
      r2.status === 0 && j2.allZero && (ev2.match(/Result /g) || []).length === 1 && ev2.includes(`✅ **Result`) && ev2.includes('| ✅ 0 |') && ev2.includes('| In Power BI | Difference |'), r2.stdout.slice(0, 500) + r2.stderr);
    // a rebuild writes the saved result back; a changed model marks it outdated
    const ra = spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), run], { encoding: 'utf8' });
    spawnSync('node', [path.join(SKILL, 'scripts', 'record-checks.js'), run, '--apply-only'], { encoding: 'utf8' });
    const kept = rd('expected-values.md').includes('✅ **Result');
    const def = path.join(run, 'pbip', fs.readdirSync(path.join(run, 'pbip')).find((d) => d.endsWith('.SemanticModel')), 'definition', 'model.tmdl');
    const orig = fs.readFileSync(def, 'utf8');
    fs.writeFileSync(def, orig + '\n');
    spawnSync('node', [path.join(SKILL, 'scripts', 'record-checks.js'), run, '--apply-only'], { encoding: 'utf8' });
    const outdated = rd('expected-values.md').includes('⚠️ **Result');
    fs.writeFileSync(def, orig);
    check('record-checks --apply-only: result kept after build-docs, marked outdated when the model changed', ra.status === 0 && kept && outdated, rd('expected-values.md').slice(0, 600));
    fs.rmSync(path.join(run, 'check-results.json'), { force: true });
    spawnSync('node', [path.join(SKILL, 'scripts', 'build-docs.js'), run], { encoding: 'utf8' });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // snake-names.js + naming snake_case: every table, column and measure in the model is snake_case,
  // DAX and relationships follow, a second run changes nothing, and a non-snake name stops the build
  {
    const sr = path.join(TMP, 'snake');
    fs.mkdirSync(sr);
    const ch = JSON.parse(fs.readFileSync(path.join(run, 'choices.json'), 'utf8'));
    ch.build.naming = 'snake_case';
    fs.writeFileSync(path.join(sr, 'choices.json'), JSON.stringify(ch));
    const s1 = spawnSync('node', [path.join(SKILL, 'scripts', 'snake-names.js'), sr, '--apply'], { encoding: 'utf8' });
    const s2 = spawnSync('node', [path.join(SKILL, 'scripts', 'snake-names.js'), sr], { encoding: 'utf8' });
    let j2 = {};
    try { j2 = JSON.parse(s2.stdout); } catch { /* reported below */ }
    check('snake-names: second run changes nothing', s1.status === 0 && j2.columns === 0 && !Object.keys(j2.measures || {}).length &&
      !Object.keys(j2.tables || {}).some((k) => !/^_measures$/i.test(k)), s1.stdout.slice(0, 400) + s1.stderr + s2.stdout.slice(0, 400));
    const bm = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), sr], { encoding: 'utf8' });
    const tdir = path.join(sr, 'pbip', `${ch.build.name || 'Test'}.SemanticModel`, 'definition', 'tables');
    const bad = [];
    if (fs.existsSync(tdir)) {
      for (const f of fs.readdirSync(tdir)) {
        for (const line of fs.readFileSync(path.join(tdir, f), 'utf8').split(/\r?\n/)) {
          const m = line.match(/^\s*(table|column|measure)\s+('?)([^'=\s]+)/);
          if (m && !/^_?[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(m[3])) bad.push(`${f}: ${m[1]} ${m[3]}`);
        }
      }
    }
    const tables = fs.existsSync(tdir) ? fs.readdirSync(tdir) : [];
    check('snake-names: model built, every table/column/measure snake_case, dim_/fact_ tables, dim_date, _measures',
      bm.status === 0 && !bad.length && tables.includes('dim_date.tmdl') && tables.includes('_measures.tmdl') &&
      tables.filter((f) => !/^(dim|fact|bridge|rls)_|^_measures/.test(f)).length === 0, bm.stdout.slice(0, 600) + bm.stderr + bad.slice(0, 10).join('; '));
    // parameters[] (pbip-layout's template) and the date table's week start
    {
      const pr = path.join(TMP, 'params');
      fs.mkdirSync(pr);
      const cp = JSON.parse(fs.readFileSync(path.join(sr, 'choices.json'), 'utf8'));
      const m0 = cp.build.measures[0].name;
      cp.build.parameters = [{ kind: 'whatIf', name: 'price_adjustment_pct', min: -1, max: 1, step: 0.1, default: 0 },
        { kind: 'fields', name: 'metric_selection', items: [{ label: 'First', measure: m0 }] }];
      fs.writeFileSync(path.join(pr, 'choices.json'), JSON.stringify(cp));
      const bp = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), pr], { encoding: 'utf8' });
      const td = path.join(pr, 'pbip', `${cp.build.name || 'Test'}.SemanticModel`, 'definition', 'tables');
      const rd = (f) => (fs.existsSync(path.join(td, f)) ? fs.readFileSync(path.join(td, f), 'utf8') : '');
      check('parameters: what-if table with GENERATESERIES and its _value measure, field parameter with NAMEOF and hidden _fields/_order, week_start in dim_date',
        bp.status === 0 && /GENERATESERIES\(-1, 1, 0\.1\)/.test(rd('price_adjustment_pct.tmdl')) && /measure price_adjustment_pct_value/.test(rd('price_adjustment_pct.tmdl')) &&
        new RegExp(`NAMEOF\\(_measures\\[${m0}\\]\\)`).test(rd('metric_selection.tmdl')) && /column metric_selection_fields\s+isHidden/.test(rd('metric_selection.tmdl')) &&
        /column week_start/.test(rd('dim_date.tmdl')) && /Date\.StartOfWeek/.test(rd('dim_date.tmdl')), bp.stdout.slice(0, 500) + bp.stderr);
      // integration: pbip-layout's template on this model – suggested mapping → all pages → every field exists
      {
        const LAYOUT = path.join(SKILL, '..', 'pbip-layout', 'scripts');
        const smDir = path.join(pr, 'pbip', `${cp.build.name || 'Test'}.SemanticModel`);
        const rep = path.join(pr, 'pbip', 'Test.Report');
        fs.mkdirSync(path.join(rep, 'definition', 'pages'), { recursive: true });
        fs.writeFileSync(path.join(rep, 'definition', 'pages', 'pages.json'), JSON.stringify({ pageOrder: [] }));
        fs.writeFileSync(path.join(rep, 'definition', 'report.json'), JSON.stringify({ themeCollection: { baseTheme: { name: 'CY24SU10', type: 'SharedResources' } } }));
        const cfgFile = path.join(pr, 'layout-config.json');
        fs.writeFileSync(cfgFile, JSON.stringify({ template: 'adventureworks', pages: ['exec', 'map', 'product', 'customer', 'tooltip', 'qna', 'decomp', 'influencers'] }));
        const sg = spawnSync('node', [path.join(LAYOUT, 'suggest-fields.js'), smDir, '--config', cfgFile], { encoding: 'utf8' });
        let sj = {};
        try { sj = JSON.parse(sg.stdout); } catch { /* reported below */ }
        const gr = spawnSync('node', [path.join(LAYOUT, 'gen-report.js'), rep, cfgFile], { encoding: 'utf8' });
        let gj = {};
        try { gj = JSON.parse(gr.stdout); } catch { /* reported below */ }
        const cf = spawnSync('node', [path.join(LAYOUT, 'check-fields.js'), rep, smDir], { encoding: 'utf8' });
        let cj = {};
        try { cj = JSON.parse(cf.stdout); } catch { /* reported below */ }
        check('pbip-layout template: suggest-fields maps the date table and the parameters, gen-report builds the pages, check-fields finds every field in the model',
          sg.status === 0 && /\[date\]$/.test(sj.fields && sj.fields['Calendar Lookup[Date]'] || '') && sj.fields['Price Adjustment (%)[Price Adjustment (%)]'] === 'price_adjustment_pct[price_adjustment_pct]' &&
          gr.status === 0 && gj.ok && (gj.pages || []).length > 0 && cf.status === 0 && cj.ok && cj.checked > 0,
          (sg.stdout + sg.stderr).slice(0, 300) + ' | ' + (gr.stdout + gr.stderr).slice(0, 300) + ' | ' + cf.stdout.slice(0, 300));
      }
      // integration: pbip-layout's business template (Home + Sales + Marketing) – data contract → gen-measures.js
      // writes the measures and the funnel list into the spec → build → gen-report → every field exists
      {
        const LAYOUT = path.join(SKILL, '..', 'pbip-layout', 'scripts');
        const br = path.join(TMP, 'business');
        fs.mkdirSync(br);
        const cb = JSON.parse(fs.readFileSync(path.join(sr, 'choices.json'), 'utf8'));
        const fact = (cb.build.tables || []).find((t) => t.kind === 'fact') || {};
        const col = (re) => ((fact.columns || []).find((c) => re.test(c.name)) || {}).name;
        const amount = col(/bel|amount/); const cust = col(/kunde|customer/); const stage = col(/kanal|channel|region/);
        const F = (c) => `${fact.name}[${c}]`;
        // sortBy (build-spec.md): the channel/region column sorted by the amount column of the same table
        const sortCol = (fact.columns || []).find((c) => c.name === stage);
        if (sortCol) sortCol.sortBy = amount;
        fs.writeFileSync(path.join(br, 'choices.json'), JSON.stringify(cb));
        const cfgFile = path.join(br, 'layout-config.json');
        fs.writeFileSync(cfgFile, JSON.stringify({ template: 'business', pages: ['home', 'sales', 'opportunity', 'marketing', 'campaign'], contract: {
          'Dim_Date[Date]': 'dim_date[date]', 'Dim_Date[Year]': 'dim_date[year]', 'Dim_Date[MonthLabel]': 'dim_date[month_start]', 'Dim_Date[Quarter]': 'dim_date[quarter]',
          'Fact_Opportunity[Amount]': F(amount), 'Fact_Opportunity[Stage]': F(stage), 'Fact_Opportunity[CustomerKey]': F(cust),
          'Fact_Marketing[Leads]': F(amount), 'Fact_Marketing[MQLs]': F(amount), 'Fact_Marketing[SQLs]': F(amount), 'Fact_Marketing[Conversions]': F(amount), 'Fact_Marketing[Spend]': F(amount) },
        values: { 'Fact_Opportunity[Stage]': { 'Closed Won': 'Web' } } }));
        const gm = spawnSync('node', [path.join(LAYOUT, 'gen-measures.js'), cfgFile, '--spec', path.join(br, 'choices.json'), '--write-config'], { encoding: 'utf8' });
        let gmj = {};
        try { gmj = JSON.parse(gm.stdout); } catch { /* reported below */ }
        // the rebuild path: snake-names must accept a list parameter (plain text items) before the build
        const sn2 = spawnSync('node', [path.join(SKILL, 'scripts', 'snake-names.js'), br, '--apply'], { encoding: 'utf8' });
        const bb2 = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), br], { encoding: 'utf8' });
        check('snake-names accepts a list parameter, and a column sortBy becomes sortByColumn in the TMDL',
          sn2.status === 0 && bb2.status === 0 && new RegExp(`sortByColumn: ${amount}`).test(fs.readFileSync(path.join(br, 'pbip', `${cb.build.name || 'Test'}.SemanticModel`, 'definition', 'tables', `${fact.name}.tmdl`), 'utf8')),
          (sn2.stdout + sn2.stderr).slice(0, 300) + ' | ' + (bb2.stdout + bb2.stderr).slice(0, 300));
        const smDir = path.join(br, 'pbip', `${cb.build.name || 'Test'}.SemanticModel`);
        const td = path.join(smDir, 'definition', 'tables');
        const rd = (f) => (fs.existsSync(path.join(td, f)) ? fs.readFileSync(path.join(td, f), 'utf8') : '');
        const rep = path.join(br, 'pbip', 'Test.Report');
        fs.mkdirSync(path.join(rep, 'definition', 'pages'), { recursive: true });
        fs.writeFileSync(path.join(rep, 'definition', 'pages', 'pages.json'), JSON.stringify({ pageOrder: [] }));
        fs.writeFileSync(path.join(rep, 'definition', 'report.json'), JSON.stringify({ themeCollection: { baseTheme: { name: 'CY24SU10', type: 'SharedResources' } } }));
        const gr = spawnSync('node', [path.join(LAYOUT, 'gen-report.js'), rep, cfgFile], { encoding: 'utf8' });
        let gj = {};
        try { gj = JSON.parse(gr.stdout); } catch { /* reported below */ }
        const cf = spawnSync('node', [path.join(LAYOUT, 'check-fields.js'), rep, smDir], { encoding: 'utf8' });
        let cj = {};
        try { cj = JSON.parse(cf.stdout); } catch { /* reported below */ }
        check('pbip-layout business template: gen-measures writes snake_case measures and the funnel list into the spec, the model builds, Finance is left out by itself, every field exists',
          gm.status === 0 && gmj.made > 20 && /measure closed_won_revenue_yoy_pct/.test(rd('_measures.tmdl')) && /"Web"/.test(rd('_measures.tmdl')) &&
          /\("Leads", 1\)/.test(rd('funnel_stage.tmdl')) && /sortByColumn: funnel_stage_order/.test(rd('funnel_stage.tmdl')) && bb2.status === 0 &&
          gr.status === 0 && gj.ok && (gj.pages || []).length === 5 && !(gj.modules || []).includes('finance') && gj.leftOutByModule > 0 && cf.status === 0 && cj.ok && cj.checked > 0,
          `${fact.name}: ${amount}/${cust}/${stage} | ` + (gm.stdout + gm.stderr).slice(0, 300) + ' | ' + (bb2.stdout + bb2.stderr).slice(0, 300) + ' | ' + (gr.stdout + gr.stderr).slice(0, 300) + ' | ' + cf.stdout.slice(0, 300));
      }
      cp.build.parameters = [{ kind: 'fields', name: 'bad_selection', items: [{ label: 'X', measure: 'no_such_measure' }] }];
      fs.writeFileSync(path.join(pr, 'choices.json'), JSON.stringify(cp));
      const bb = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), pr], { encoding: 'utf8' });
      check('parameters: a field parameter naming a measure that does not exist stops the build', bb.status === 2 && /no_such_measure/.test(bb.stdout), bb.stdout.slice(0, 300));
    }
    const ch2 = JSON.parse(fs.readFileSync(path.join(sr, 'choices.json'), 'utf8'));
    ch2.build.measures[0].name = 'Not Snake';
    fs.writeFileSync(path.join(sr, 'choices.json'), JSON.stringify(ch2));
    const bm2 = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), sr], { encoding: 'utf8' });
    check('snake-names: build-model refuses a non-snake name when naming is snake_case', bm2.status === 2 && /snake-names/.test(bm2.stdout), bm2.stdout.slice(0, 400));
  }
  const goodChoices = fs.readFileSync(path.join(run, 'choices.json'), 'utf8');
  const broken = JSON.parse(goodChoices);
  broken.build = JSON.parse(JSON.stringify(spec));
  broken.build.relationships.push({ from: 'Sales[No such column]', to: 'Customer[Customer key]' });
  fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify(broken));
  const ovBefore = fs.statSync(path.join(run, 'overview.html')).mtimeMs;
  res = spawnSync('node', [path.join(SKILL, 'scripts', 'rebuild.js'), run], { encoding: 'utf8', env: { ...process.env, PYTHON: py } });
  try { rb = JSON.parse(res.stdout); } catch { rb = {}; }
  check('rebuild: a bad spec stops at build-model, later steps not run', res.status === 2 && rb.failedAt === 'build-model' && rb.steps.length === 1 &&
    /No such column/.test(rb.steps[0].error || '') && fs.statSync(path.join(run, 'overview.html')).mtimeMs === ovBefore, res.stdout.slice(0, 600));
  fs.writeFileSync(path.join(run, 'choices.json'), goodChoices);
  const pbix = path.join(TMP, 'report.pbix');
  fs.writeFileSync(pbix, 'x');
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'pbip_sources.py'), pbix], { encoding: 'utf8' });
  check('own pbix: refused with "Save as .pbip" advice', res.status === 2 && /Save as/.test(res.stdout), res.status + res.stdout);
}
res = spawnSync('node', [path.join(SKILL, 'scripts', 'check-drift.js'), run, '--path', path.join(TMP, 'no-such-folder')], { encoding: 'utf8' });
check('drift: wrong --path stops instead of passing', res.status === 2, res.status);

// ---------- 2b. grounded-answer test ----------
if (!QUICK) {
  const qFile = path.join(TMP, 'questions.json');
  fs.writeFileSync(qFile, JSON.stringify([
    { question: 'Revenue in Nord', measure: 'Revenue', filters: { 'Customer[Customer ID]': 'K-001' }, expected: 1234.5, expected_how: 'test' },
    { question: 'Orders as K-001', measure: 'Orders', filters: {}, expected: 3, role: 'Test role', role_user: 'a@example.com', role_expected: 3 },
  ]));
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'grounded_answers.py'), path.join(run, 'pbip'), qFile, '--out', run], { encoding: 'utf8' });
  let ga = {};
  try { ga = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('grounded: ok', res.status === 0 && ga.ok, res.stdout + res.stderr);
  check('grounded: one role check', ga.role_checks === 1, ga.role_checks);
  check('grounded: every column traced', ga.untraced_columns === 0, ga.untraced_columns);
  const gdax = fs.existsSync(path.join(run, 'grounded-answers.dax')) ? fs.readFileSync(path.join(run, 'grounded-answers.dax'), 'utf8') : '';
  check('grounded: three rows (2 questions + 1 role)', (gdax.match(/ROW \(/g) || []).length === 3);
  check('grounded: role filter inlined', gdax.includes('FILTER ( ALL ( \'Customer\' ), [Customer ID] = "K-001" )'));
  const gmd = fs.existsSync(path.join(run, 'grounded-answers.md')) ? fs.readFileSync(path.join(run, 'grounded-answers.md'), 'utf8') : '';
  check('grounded: traced to the source file', /orders\.csv › Beløb/.test(gmd), gmd.slice(0, 300));
  fs.writeFileSync(qFile, JSON.stringify([{ question: 'x', measure: 'No such measure', expected: 1 }]));
  res = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'grounded_answers.py'), path.join(run, 'pbip'), qFile, '--out', TMP], { encoding: 'utf8' });
  check('grounded: unknown measure refused', res.status === 2, res.status);
}

// ---------- 3. overview page ----------
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec, tables: { orders: { include: true, fixes: [{ fix: 'F08', column: 'Dato', keep: true }] } } }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-overview.js'), run], { encoding: 'utf8' });
let ov = {};
try { ov = JSON.parse(res.stdout); } catch { /* reported below */ }
check('overview: built', res.status === 0 && fs.existsSync(path.join(run, 'overview.html')), res.stderr);
check('overview: publishable page without wrapper tags', fs.existsSync(path.join(run, 'overview.page.html')) && !/<html|<body|<!doctype/i.test(fs.readFileSync(path.join(run, 'overview.page.html'), 'utf8')));
check('overview: counts the model', ov.facts === 1 && ov.relationships === 2 && ov.staging === 4, JSON.stringify(ov));
check('overview: no warnings', (ov.warnings || []).length === 0, ov.warnings);
const ovHtml = fs.readFileSync(path.join(run, 'overview.html'), 'utf8');
check('overview: dark toolkit palette by default, no user colours, colour panel present', !ovHtml.includes('id="user-colors"') && /<style>\n:root\{--bg:#0f0a1e;/.test(ovHtml) && !/@media \(prefers-color-scheme/.test(ovHtml) && ovHtml.includes('id="cpanel"'));
fs.writeFileSync(path.join(run, 'overview-colors.json'), JSON.stringify({ accent: '#0f7b6c', bogus: '#fff', dark: { fact: 'red;}body{x' } }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-overview.js'), run], { encoding: 'utf8' });
try { ov = JSON.parse(res.stdout); } catch { ov = {}; }
const ovUser = fs.readFileSync(path.join(run, 'overview.html'), 'utf8').split('id="user-colors">')[1]?.split('</style>')[0] || '';
check('overview: colours file sets the palette, rejects bad keys and values', ovUser.includes('--purple:#0f7b6c') && !ovUser.includes('body{x') && (ov.warnings || []).length === 2, ov.warnings);
fs.writeFileSync(path.join(run, 'overview-colors.json'), JSON.stringify({ theme: 'light', light: { card: '#fafafa' } }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-overview.js'), run], { encoding: 'utf8' });
const ovLight = fs.readFileSync(path.join(run, 'overview.html'), 'utf8');
check('overview: theme light uses the light palette and its keys', /<style>\n:root\{--bg:#f6f4fb;/.test(ovLight) && ovLight.includes(':root{--plate:#fafafa}'));
fs.unlinkSync(path.join(run, 'overview-colors.json'));

// ---------- 4. drift checks started in the background after the profiler ----------
Promise.all([driftSame, driftNew, bizProfile, realData]).then(([same, changed, biz, real]) => {
  // real-looking data: profile -> draft-spec.js -> build-model.js -> source-stats.js, every recommended finding placed
  if (real) {
    const node = (script, a) => spawnSync('node', [path.join(SKILL, 'scripts', script), ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const js = (r) => { try { return JSON.parse(r.stdout.replace(/^[^{]+/, '')); } catch { return {}; } };
    check('real data: messy CSV and dummy Excel generated', real.gen.every((g) => g.status === 0) && fs.readdirSync(real.src).some((f) => f.endsWith('.xlsx')) && fs.readdirSync(real.src).filter((f) => f.endsWith('.csv')).length >= 5,
      real.gen.map((g) => g.stderr.slice(0, 300)).join(' | '));
    check('real data: profiled', real.prof.status === 0 && fs.existsSync(path.join(real.run, 'profile.json')), real.prof.stderr.slice(0, 400));
    const p = JSON.parse(tryRead(path.join(real.run, 'profile.json')).replace(/^﻿/, '') || '{"tables":[]}');
    check('real data: CSV and Excel sheets in the profile', p.tables.some((t) => t.kind === 'csv') && p.tables.some((t) => t.kind === 'sheet'));
    const spikes = p.tables.flatMap((t) => (t.findings || []).filter((f) => f.fix === 'F14' && /median/.test(f.detail)));   // a spikeRule finding has no median limit
    check('real data: F14 spike finding has a numeric limit and a culture-independent median (199.38, not 199,38)',
      spikes.length > 0 && spikes.every((f) => typeof f.limit === 'number' && f.limit > 0 && /\(\d+\.\d{2}\)$/.test(f.detail)), JSON.stringify(spikes.map((f) => [f.detail, f.limit])));
    const d = node('draft-spec.js', [real.run, '--write', '--name', 'Real']);
    const dOut = js(d);
    check('real data: draft-spec.js drafts a spec', d.status === 0 && dOut.ok && dOut.staging > 0, (d.stdout + d.stderr).slice(0, 500));
    const spec = (JSON.parse(tryRead(path.join(real.run, 'choices.json')) || '{}').build) || { staging: [], tables: [] };
    // every recommended finding is a step of its table's staging query, a model setting or a stated skip
    const stgOf = (name) => spec.staging.find((s) => s.name === 'stg_' + name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')) ||
      spec.staging.find((s) => (s.append || []).some((a) => (a.file || a.item) && p.tables.some((t) => t.name === name && (path.basename(t.file || '') === a.file || t.sheet === a.item))));
    const placed = (t, f) => (dOut.model || []).concat(dOut.skipped || []).some((x) => x.table === t.name && x.fix === f.fix && (x.column || null) === (f.column || null)) ||
      ((stgOf(t.name) || {}).steps || []).some((s) => s.fix === f.fix && (!f.column || s.column === f.column || (s.columns || []).includes(f.column) || f.fix === 'F16'));
    const lost = p.tables.flatMap((t) => (t.findings || []).filter((f) => f.recommended && !placed(t, f)).map((f) => `${t.name} ${f.fix} ${f.column || ''}`));
    check('real data: every recommended finding is a step, a model setting or a stated skip', lost.length === 0, lost.join('; '));
    check('real data: every skip says why', (dOut.skipped || []).every((x) => x.reason && x.reason.length > 10), JSON.stringify(dOut.skipped));
    const b = node('build-model.js', [real.run]);
    const bOut = js(b);
    check('real data: the drafted spec builds', b.status === 0 && bOut.ok && bOut.staging === dOut.staging, (b.stdout + b.stderr).slice(0, 600));
    const ex = tryRead(path.join(real.run, 'pbip', 'Real.SemanticModel', 'definition', 'expressions.tmdl'));
    const noStep = spec.staging.flatMap((s) => s.steps.filter((st) => !ex.includes(`#"${st.fix} `)).map((st) => `${s.name} ${st.fix}`));
    check('real data: every drafted step is in the model under its fix name', noStep.length === 0, noStep.join(', '));
    fs.writeFileSync(path.join(real.run, 'q.json'), JSON.stringify(spec.tables.map((t) => ({ name: t.name, table: t.name }))));
    const s = node('source-stats.js', [real.run, '--queries', path.join(real.run, 'q.json')]);
    const sOut = js(s);
    const bad = Object.entries(sOut.tables || {}).filter(([, v]) => v.approx || (v.unsupported || []).length || v.errors).map(([k, v]) => `${k}: ${JSON.stringify(v.unsupported)} errors ${v.errors}`);
    const empty = (sOut.results || []).filter((x) => !(x.value > 0)).map((x) => x.name);
    check('real data: source-stats replays every table exactly (no approx step, no type errors, no empty table)', s.status === 0 && sOut.ok && bad.length === 0 && empty.length === 0 && (sOut.results || []).length === spec.tables.length,
      (bad.join('; ') + ' empty: ' + empty.join(', ') + s.stderr).slice(0, 600));
    const sn = node('snake-names.js', [real.run, '--apply']);
    const b2 = node('build-model.js', [real.run]);
    check('real data: snake_case names (also non-ASCII like beløb) build', sn.status === 0 && b2.status === 0 && js(b2).ok, (sn.stderr + b2.stdout + b2.stderr).slice(0, 500));
    const bd = node('build-docs.js', [real.run]);
    check('real data: cleaning log written', bd.status === 0 && tryRead(path.join(real.run, 'cleaning-log.md')).length > 0, (bd.stdout + bd.stderr).slice(0, 400));
  }
  // CamelCase keys (CustomerKey) and plain integer keys under different names (CampaignKey 1..8 vs
  // OpportunityKey 1..468): the demo/business files must give exactly their 7 relationships by name
  if (biz) {
    let pb = { relations: [] };
    try { pb = JSON.parse(fs.readFileSync(path.join(TMP, 'profile-business.json'), 'utf8').replace(/^﻿/, '')); } catch { /* reported below */ }
    const rels = pb.relations.map((r) => `${r.from}->${r.to}`).sort();
    check('profiler: CamelCase Key columns are ids, and plain numbers under two key names are not related (demo/business: 7 relationships, all by name)',
      biz.status === 0 && rels.length === 7 && pb.relations.every((r) => r.matchedBy === 'name' && r.preferred) && rels.includes('opportunities[CustomerKey]->customers[CustomerKey]'), rels.join(', ') + biz.stderr.slice(0, 400));
  }
  if (!QUICK) {
    check('drift: unchanged files pass', same.status === 0, same.stdout + same.stderr);
    const driftMd = fs.existsSync(path.join(changed.dir, 'drift.md')) ? fs.readFileSync(path.join(changed.dir, 'drift.md'), 'utf8') : '';
    check('drift: breaking changes give exit 1', changed.status === 1, changed.status);
    check('drift: renamed column guessed', driftMd.includes('column "Beløb" is gone – renamed to "Belob"?'));
    check('drift: missing file found', driftMd.includes('file customers.csv not found'));
    check('drift --save-profile: the new profile is kept', fs.existsSync(path.join(TMP, 'drift-new-profile.json')));
  }

  // F14 row rules and M03 history tables: profiler → draft-spec → build-model → source-stats on a small
  // order file (one spike that the 10 x median limit misses, zeros on two statuses) and a price history.
  {
    const rr = path.join(TMP, 'rowrules'); const rs = path.join(rr, 'src'); fs.mkdirSync(rs, { recursive: true });
    const lines = ['order_id,quantity,unit_price,amount,status'];
    for (let i = 1; i <= 30; i++) lines.push(`O${i},${1 + (i % 3)},${20 + i},${(1 + (i % 3)) * (20 + i)},${i <= 22 ? 'Completed' : 'Shipped'}`);
    lines.push('O31,1,10,100,Completed');                                           // spike: 100 > 5 × 1 × 10, far below 10 × median
    lines.push('O32,2,30,0,Completed', 'O33,1,40,0,Completed');                     // zeros on the main status: anomalies
    lines.push('O34,1,25,0,Cancelled', 'O35,3,25,0,Cancelled', 'O36,2,25,0,Cancelled'); // zeros on another status: normal
    fs.writeFileSync(path.join(rs, 'orders.csv'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(rs, 'prices.csv'), ['product_id,price,valid_from,valid_to', 'P1,10,2024-01-01,2024-06-30', 'P1,12,2024-07-01,',
      'P2,20,2024-01-01,2024-03-31', 'P2,21,2024-04-01,2024-09-30', 'P2,23,2024-10-01,', 'P3,30,2024-01-01,'].join('\n') + '\n');
    const rrun = path.join(rr, 'run'); fs.mkdirSync(rrun);
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
      '-Path', rs, '-OutFile', path.join(rrun, 'profile.json'), '-RowsDir', path.join(rrun, 'rows'), '-Today', '2026-11-19'], { stdio: 'pipe' });
    const p = JSON.parse(fs.readFileSync(path.join(rrun, 'profile.json'), 'utf8').replace(/^﻿/, ''));
    const fo = (p.tables.find((t) => t.name === 'orders') || { findings: [] }).findings.filter((f) => f.fix === 'F14');
    const sp = fo.find((f) => f.spikeRule); const zs = fo.find((f) => f.zeroStatus);
    check('F14 row rule: spike = amount > 5 x quantity x unit price (1 row), no 10 x median finding',
      sp && sp.rows === 1 && sp.spikeRule.quantity === 'quantity' && sp.spikeRule.price === 'unit_price' && !fo.some((f) => /median/.test(f.detail)), JSON.stringify(fo));
    check('F14 zero on the main status: 2 rows on Completed, recommended; the plain zero finding stays not recommended',
      zs && zs.rows === 2 && zs.recommended && zs.zeroStatus.value === 'Completed' && fo.some((f) => f.detail === 'Zero values' && !f.recommended), JSON.stringify(fo));
    const m3 = (p.tables.find((t) => t.name === 'prices') || { findings: [] }).findings;
    const h = m3.find((f) => f.fix === 'M03');
    check('M03 history table: 2 product_id values with versions (3 extra rows), and no F13 keep-first on it',
      h && h.rows === 3 && /^2 product_id/.test(h.detail) && !m3.some((f) => f.fix === 'F13'), JSON.stringify(m3));
    const d = spawnSync('node', [path.join(SKILL, 'scripts', 'draft-spec.js'), rrun, '--write', '--name', 'RowRules'], { encoding: 'utf8' });
    const st = JSON.parse(fs.readFileSync(path.join(rrun, 'choices.json'), 'utf8')).build.staging.find((s) => /orders/.test(s.name));
    const f14 = (st || { steps: [] }).steps.find((s) => s.fix === 'F14') || {};
    check('draft-spec: F14 step carries spikeRule and zeroStatus; M03 is a model note', f14.spikeRule && f14.zeroStatus && f14.checks.includes('zero') && !('spike' in f14)
      && /M03/.test(d.stdout), JSON.stringify(f14) + d.stdout.slice(0, 300));
    const b = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), rrun], { encoding: 'utf8' });
    const ex = fs.readFileSync(path.join(rrun, 'pbip', 'RowRules.SemanticModel', 'definition', 'expressions.tmdl'), 'utf8');
    check('build-model: F14 M uses 5 x fnParseNumber([quantity]) x fnParseNumber([unit_price]) and the status for zeros',
      b.status === 0 && ex.includes('> 5 * fnParseNumber([quantity]) * fnParseNumber([unit_price])') && ex.includes('fnParseNumber([amount]) = 0 and [status] = "Completed"') && ex.includes('expression fnParseNumber'), b.stderr + ex.slice(0, 200));
    const tbl = JSON.parse(fs.readFileSync(path.join(rrun, 'choices.json'), 'utf8')).build.tables.find((t) => /orders/.test(t.name)).name;
    const ss = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), rrun, '--q', JSON.stringify([{ name: 'issues', table: tbl, agg: 'rows', by: 'amount issue' }])], { encoding: 'utf8' });
    const v = ((JSON.parse(ss.stdout).results || [])[0] || {}).values || {};
    check('source-stats replays the row rules: 1 spike, 2 zero, 33 ok', v.spike === 1 && v.zero === 2 && v.ok === 33, JSON.stringify(v));
  }

  // draft-spec on the demo files: F27 takes the key from the example row (K-100), F07 keeps the most common
  // spelling of each region group – both used to be skipped, so fast mode left the test row and nord/SYD in.
  {
    const dm = path.join(TMP, 'demo-draft'); const ds = path.join(dm, 'src'); fs.mkdirSync(ds, { recursive: true });
    for (const f of ['customers.csv', 'orders.csv']) fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(ds, f));
    const prof = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
      '-Path', ds, '-OutFile', path.join(dm, 'profile.json')], { encoding: 'utf8' });
    const d = spawnSync('node', [path.join(SKILL, 'scripts', 'draft-spec.js'), dm, '--write', '--name', 'Demo'], { encoding: 'utf8' });
    const out = (() => { try { return JSON.parse(d.stdout); } catch { return {}; } })();
    const spec = (() => { try { return JSON.parse(fs.readFileSync(path.join(dm, 'choices.json'), 'utf8')).build; } catch { return { staging: [] }; } })();
    const stepOf = (stg, fix) => ((spec.staging.find((s) => s.name === stg) || { steps: [] }).steps.find((s) => s.fix === fix)) || {};
    const f27 = stepOf('stg_customers', 'F27'); const f07 = stepOf('stg_orders', 'F07');
    check('draft-spec: F27 removes K-100 by KundeID from the example row', prof.status === 0 && f27.column === 'KundeID' && JSON.stringify(f27.values) === '["K-100"]' && f27.mode === 'remove', JSON.stringify(f27) + prof.stderr.slice(0, 200));
    check('draft-spec: F07 maps nord -> Nord and syd -> Syd in Region', f07.column === 'Region' && f07.map && f07.map.nord === 'Nord' && f07.map.syd === 'Syd', JSON.stringify(f07));
    check('draft-spec: demo skips only F28', (out.skipped || []).every((x) => x.fix === 'F28'), JSON.stringify(out.skipped));

    // complete-month flag: order 1010 is dated 2030 (F15 "future"); the months must end at the last valid
    // date, not in 2030. Without an F15 flag column the plain column is used.
    const ch = JSON.parse(fs.readFileSync(path.join(dm, 'choices.json'), 'utf8'));
    const fact = ch.build.tables.find((t) => t.kind === 'fact');
    const dcol = (fact.columns.find((c) => (c.from || c.name) === 'Dato') || {}).name;
    const fcol = (fact.columns.find((c) => (c.from || c.name) === 'Dato status') || {}).name;
    ch.build.date = { name: 'Date', columns: [`${fact.name}[${dcol}]`], completeMonth: `${fact.name}[${dcol}]` };
    fs.writeFileSync(path.join(dm, 'choices.json'), JSON.stringify(ch, null, 2));
    const bm = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dm], { encoding: 'utf8' });
    const dateTmdl = (() => { try { return fs.readFileSync(path.join(dm, 'pbip', 'Demo.SemanticModel', 'definition', 'tables', 'Date.tmdl'), 'utf8'); } catch { return ''; } })();
    check('build-model: complete months skip F15-flagged dates (Table.SelectRows on the flag = "ok")',
      bm.status === 0 && fcol && dateTmdl.includes(`DataEnd = List.Max(List.RemoveNulls(Table.SelectRows(${fact.name}, each [${fcol}] = "ok")[${dcol}]))`),
      `${bm.stdout.slice(0, 300)} ${(dateTmdl.match(/DataEnd = .*/) || [''])[0]}`);
    // the calendar spans only the "ok" dates too: order 1010 (2030) must not stretch it to 2030
    check('build-model: the date table spans F15 "ok" dates only',
      dateTmdl.includes(`Dates = List.RemoveNulls(List.Combine({Table.SelectRows(${fact.name}, each [${fcol}] = "ok")[${dcol}]}))`), (dateTmdl.match(/Dates = .*/) || [''])[0]);
    // without the flag column in the loaded table, the plain column is used (no reference to a missing column)
    fact.columns = fact.columns.filter((c) => c.name !== fcol);
    fs.writeFileSync(path.join(dm, 'choices.json'), JSON.stringify(ch, null, 2));
    const bm2 = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dm], { encoding: 'utf8' });
    const dateTmdl2 = (() => { try { return fs.readFileSync(path.join(dm, 'pbip', 'Demo.SemanticModel', 'definition', 'tables', 'Date.tmdl'), 'utf8'); } catch { return ''; } })();
    check('build-model: complete months use the plain column when the flag column is not loaded',
      bm2.status === 0 && dateTmdl2.includes(`DataEnd = List.Max(List.RemoveNulls(${fact.name}[${dcol}]))`), (dateTmdl2.match(/DataEnd = .*/) || [''])[0]);

    // type "key" is Int64: a text id (K-001) typed key must stop the build; the numeric Ordrenr (1001) may stay key
    const kc = (n) => fact.columns.find((c) => (c.from || c.name) === n);
    kc('KundeID').type = 'key'; kc('Ordrenr').type = 'key';
    fs.writeFileSync(path.join(dm, 'choices.json'), JSON.stringify(ch, null, 2));
    const bk = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dm], { encoding: 'utf8' });
    const bkOut = (() => { try { return JSON.parse(bk.stdout); } catch { return {}; } })();
    check('build-model: a text id typed "key" stops the build with the reason; a numeric id typed "key" does not',
      bk.status === 2 && (bkOut.errors || []).some((e) => /KundeID holds text ids such as "K-\d+"/.test(e)) && !(bkOut.errors || []).some((e) => /Ordrenr/.test(e)),
      JSON.stringify(bkOut.errors));

    // apply-design.js: the design as a JSON patch instead of a one-off script. A fresh draft first.
    spawnSync('node', [path.join(SKILL, 'scripts', 'draft-spec.js'), dm, '--write', '--name', 'Demo'], { encoding: 'utf8' });
    const ad = (patch) => { const pf = path.join(dm, 'patch.json'); fs.writeFileSync(pf, JSON.stringify(patch)); const r = spawnSync('node', [path.join(SKILL, 'scripts', 'apply-design.js'), dm, pf], { encoding: 'utf8' }); let j = {}; try { j = JSON.parse(r.stdout); } catch { /* */ } return { status: r.status, j, out: r.stdout + r.stderr }; };
    const draftTables = JSON.parse(fs.readFileSync(path.join(dm, 'choices.json'), 'utf8')).build.tables;
    const factName = draftTables.find((t) => t.kind === 'fact').name; const dimName = draftTables.find((t) => t.kind === 'dimension').name;
    const before = fs.readFileSync(path.join(dm, 'choices.json'), 'utf8');
    const bad = ad({ tables: { [factName]: { columns: [{ name: 'Order ID', from: 'NoSuchColumn' }] } }, relationships: [{ from: 'Sales[X]', to: 'Customer[Y]' }] });
    check('apply-design: an unknown query column and a broken relationship give exit 2 and change nothing',
      bad.status === 2 && bad.j.errors.some((e) => /NoSuchColumn/.test(e)) && bad.j.errors.some((e) => /no table "Sales"/.test(e)) && fs.readFileSync(path.join(dm, 'choices.json'), 'utf8') === before, bad.out.slice(0, 400));
    const dropUsed = ad({ dropStaging: [draftTables.find((t) => t.kind === 'fact').from] });
    check('apply-design: refuses to drop a staging query a table still uses', dropUsed.status === 2 && /still used by/.test(dropUsed.j.errors.join(' ')), dropUsed.out.slice(0, 300));
    const good = ad({
      build: { naming: 'snake_case' },
      tables: {
        [factName]: { rename: 'Sales', columns: [{ name: 'order_id', from: 'Ordrenr' }, { name: 'order_date', from: 'Dato' }, { name: 'customer_id', from: 'KundeID' },
          { name: 'amount', from: 'Beløb', type: 'currency' }, { name: 'order_date_status', from: 'Dato status' }] },
        [dimName]: { rename: 'Customer', columns: [{ name: 'customer_id', from: 'KundeID' }, { name: 'customer_name', from: 'Navn' }, { name: 'is_inferred', from: 'IsInferred' }] },
      },
      date: { name: 'dim_date', columns: ['Sales[order_date]'], completeMonth: 'Sales[order_date]' },
      relationships: [{ from: 'Sales[customer_id]', to: 'Customer[customer_id]' }, { from: 'Sales[order_date]', to: 'dim_date[date]' }],
      measures: [{ name: 'revenue', expr: 'SUM ( Sales[amount] )', format: '#,0' }, { name: 'orders', expr: 'DISTINCTCOUNT ( Sales[order_id] )', format: '#,0' },
        { name: 'customers', expr: 'DISTINCTCOUNT ( Sales[customer_id] )', format: '#,0' }, { name: 'revenue_previous_month', previousMonth: '[revenue]' }],
      choices: { glossary: [{ term: 'Revenue', definition: 'Sum of amounts.' }], extras: { layout_pages: ['exec'] } },
    });
    const ch2 = JSON.parse(fs.readFileSync(path.join(dm, 'choices.json'), 'utf8'));
    const sales = ch2.build.tables.find((t) => t.name === 'Sales') || { columns: [] };
    const draftOrderId = draftTables.find((t) => t.name === factName).columns.find((c) => (c.from || c.name) === 'Ordrenr');
    const pm = ch2.build.measures.find((m) => m.name === 'revenue_previous_month') || {};
    check('apply-design: renames, keeps the drafted type when the patch gives none, writes previousMonth DAX with a filter contract',
      good.status === 0 && sales.columns.find((c) => c.name === 'order_id').type === draftOrderId.type && sales.columns.find((c) => c.name === 'amount').type === 'currency'
      && /REMOVEFILTERS \( dim_date \), dim_date\[month_start\] = EDATE \( m, -1 \)/.test(pm.expr || '') && pm.filters && pm.filters.additive === true && pm.format === '#,0'
      && ch2.glossary.length === 1 && ch2.extras && ch2.extras.layout_pages[0] === 'exec', good.out.slice(0, 500));
    const sn = spawnSync('node', [path.join(SKILL, 'scripts', 'snake-names.js'), dm, '--apply'], { encoding: 'utf8' });
    const bd = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dm], { encoding: 'utf8' });
    check('apply-design: the patched spec builds (after snake-names)', sn.status === 0 && bd.status === 0, (sn.stdout + bd.stdout).slice(0, 500));

    // template-measures.js: AdventureWorks template measures from the mapped base measures; customers stands
    // in for Total Profit, so no profit target and adjusted revenue instead of adjusted profit
    const lc = path.join(dm, 'layout-config.json');
    fs.writeFileSync(lc, JSON.stringify({ template: 'adventureworks', pages: ['exec', 'product', 'customer'], fields: {
      'Measure Table[Total Revenue]': '_measures[revenue]', 'Measure Table[Total Orders]': '_measures[orders]', 'Measure Table[Total Customers]': '_measures[customers]',
      'Measure Table[Total Profit]': '_measures[customers]', 'Measure Table[Previous Month Revenue]': null, 'Measure Table[Previous Month Orders]': null,
      'Measure Table[Revenue Target]': null, 'Measure Table[Revenue Target Gap]': null, 'Measure Table[Profit Target]': null, 'Measure Table[Adjusted Profit]': null,
      'Price Adjustment (%)[Price Adjustment (%)]': null, 'Measure Table[Average Revenue per Customer]': null,
      'Customer Metric Selection[Customer Metric Selection]': null, 'Customer Metric Selection[Customer Metric Selection Fields]': null } }));
    const tm = spawnSync('node', [path.join(SKILL, 'scripts', 'template-measures.js'), dm], { encoding: 'utf8' });
    const tmo = (() => { try { return JSON.parse(tm.stdout); } catch { return {}; } })();
    const lcj = JSON.parse(fs.readFileSync(lc, 'utf8')).fields;
    const ch3 = JSON.parse(fs.readFileSync(path.join(dm, 'choices.json'), 'utf8'));
    check('template-measures: keeps the spec\'s revenue_previous_month, makes orders_previous_month, targets, adjusted revenue, revenue per customer',
      tm.status === 0 && tmo.realProfit === false && lcj['Measure Table[Previous Month Revenue]'] === '_measures[revenue_previous_month]'
      && (tmo.made || []).includes('orders_previous_month') && (tmo.made || []).includes('sales_target') && (tmo.made || []).includes('adjusted_revenue')
      && lcj['Measure Table[Profit Target]'] === null && lcj['Measure Table[Adjusted Profit]'] === '_measures[adjusted_revenue]'
      && lcj['Price Adjustment (%)[Price Adjustment (%)]'] === 'price_adjustment_pct[price_adjustment_pct]'
      && (ch3.build.parameters || []).some((p) => p.kind === 'fields' && p.name === 'customer_metric_selection'), tm.stdout.slice(0, 600) + tm.stderr.slice(0, 200));
    const decs = (() => { try { return JSON.parse(fs.readFileSync(path.join(dm, 'layout-decisions.json'), 'utf8')).map((d) => d.id); } catch { return []; } })();
    check('template-measures: asks the growth, adjusted-profit and profit-tile decisions', ['template-growth', 'adjusted-profit', 'profit-tile'].every((d) => decs.includes(d)), JSON.stringify(decs));
    const c1 = fs.readFileSync(path.join(dm, 'choices.json'), 'utf8');
    spawnSync('node', [path.join(SKILL, 'scripts', 'template-measures.js'), dm], { encoding: 'utf8' });
    const bt = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), dm], { encoding: 'utf8' });
    check('template-measures: a second run changes nothing, and the model builds', fs.readFileSync(path.join(dm, 'choices.json'), 'utf8') === c1 && bt.status === 0, bt.stdout.slice(0, 400));
  }

  // F15 without F08: dates in one format stay text until F17, so the flag must parse them (fnParseDate) –
  // a plain "[order_date] > #date(…)" fails at refresh and source-stats crashed on v.getUTCFullYear.
  {
    const fd = path.join(TMP, 'f15-text'); const fs2 = path.join(fd, 'src'); fs.mkdirSync(fs2, { recursive: true });
    const rows = ['order_id,order_date,amount'];
    for (let i = 1; i <= 20; i++) rows.push(`O${i},2025-0${1 + (i % 9)}-1${i % 9},${10 * i}`);
    rows.push('O21,2031-01-05,50');
    fs.writeFileSync(path.join(fs2, 'orders.csv'), rows.join('\n') + '\n');
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
      '-Path', fs2, '-OutFile', path.join(fd, 'profile.json'), '-RowsDir', path.join(fd, 'rows')], { encoding: 'utf8' });
    spawnSync('node', [path.join(SKILL, 'scripts', 'draft-spec.js'), fd, '--write', '--name', 'F15Text'], { encoding: 'utf8' });
    const spec = (() => { try { return JSON.parse(fs.readFileSync(path.join(fd, 'choices.json'), 'utf8')).build; } catch { return { staging: [] }; } })();
    const stg = spec.staging[0] || { steps: [] };
    const hasF15 = stg.steps.some((s) => s.fix === 'F15'); const hasF08 = stg.steps.some((s) => s.fix === 'F08');
    const b = spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), fd], { encoding: 'utf8' });
    const ex = (() => { try { return fs.readFileSync(path.join(fd, 'pbip', 'F15Text.SemanticModel', 'definition', 'expressions.tmdl'), 'utf8'); } catch { return ''; } })();
    check('build-model: F15 on a text date (no F08) parses it with fnParseDate', hasF15 && !hasF08 && b.status === 0
      && ex.includes('let d = fnParseDate([order_date], true) in if d = null') && ex.includes('expression fnParseDate'), `F15=${hasF15} F08=${hasF08} ${b.stdout.slice(0, 200)}`);
    const tbl = (spec.tables[0] || {}).name;
    const ss = spawnSync('node', [path.join(SKILL, 'scripts', 'source-stats.js'), fd, '--q', JSON.stringify([{ name: 's', table: tbl, agg: 'rows', by: 'order_date status' }])], { encoding: 'utf8' });
    const v = (() => { try { return JSON.parse(ss.stdout).results[0].values || {}; } catch { return {}; } })();
    check('source-stats: F15 on a text date flags 1 future, 20 ok', v.future === 1 && v.ok === 20, ss.stdout.slice(0, 300) + ss.stderr.slice(0, 200));
  }

  // score-run.js: without an answer key it stops with exit 2 and names what is missing (scoring itself is
  // covered by golden-run.js, which scores messy retail seed 7919 and snapshots scorecard.md).
  {
    const sr = spawnSync('node', [path.join(SKILL, 'scripts', 'score-run.js'), run, '--answers', path.join(TMP, 'no-answers')], { encoding: 'utf8' });
    check('score-run: no answer key gives exit 2', sr.status === 2 && /expected_findings\.json/.test(sr.stderr), sr.status + sr.stderr);
    check('score-run: no scorecard written without an answer key', !fs.existsSync(path.join(run, 'scorecard.md')));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${pass} passed, ${fails.length} failed` + (QUICK ? ' (quick: drift and Python checks skipped – run without --quick before a commit)' : ''));
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
});
