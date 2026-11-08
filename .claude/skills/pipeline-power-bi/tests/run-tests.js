#!/usr/bin/env node
// Tests for pipeline-power-bi: the profiler (Profile-Sources.ps1), the model generator (build-model.js) and
// the overview page (build-overview.js), on the fixtures in tests/fixtures (made by make-fixtures.py).
//
//   node .claude/skills/pipeline-power-bi/tests/run-tests.js
//
// Windows only (the profiler needs Windows PowerShell 5.1). Writes only to a temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbi-test-'));
let pass = 0;
const fails = [];
function check(name, ok, info) {
  if (ok) pass++; else fails.push(`${name}${info !== undefined ? ' – ' + info : ''}`);
}

// ---------- 1. profiler ----------
const profFile = path.join(TMP, 'profile.json');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'Profile-Sources.ps1'),
  '-Path', FIX, '-OutFile', profFile, '-Today', '2026-11-06'], { stdio: 'pipe' });
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
      ops: [{ op: 'inferMembers', key: 'KundeID', fromColumns: ['stg_orders[KundeID]'], defaults: { Navn: '"Unknown"' } }, { op: 'addKey', name: 'CustomerKey', sortBy: ['KundeID'] }],
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
  measures: [{ name: 'Revenue', expr: 'CALCULATE ( SUM ( Sales[Amount] ), Sales[Amount issue] = "ok" )', format: '\\$#,0', folder: 'Sales' },
    { name: 'Orders', expr: 'VAR n = DISTINCTCOUNT ( Sales[Order ID] )\nRETURN\n\tn', format: '#,0', folder: 'Sales' }],
  roles: [{ name: 'Test role', table: 'Customer', filter: '[Customer ID] = "K-001"' }],
};
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec }, null, 2));
const gen = (r, extra = []) => spawnSync('node', [path.join(SKILL, 'scripts', 'build-model.js'), r, ...extra], { encoding: 'utf8' });
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
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ build: bad }));
res = gen(run);
let badOut = {};
try { badOut = JSON.parse(res.stdout); } catch { /* reported below */ }
check('bad spec: exit code 2', res.status === 2, res.status);
check('bad spec: names both errors', (badOut.errors || []).length === 2, JSON.stringify(badOut.errors));
check('bad spec: model untouched', fs.readFileSync(path.join(def, 'model.tmdl'), 'utf8') === before);
check('bad spec: no half-written folder left', !fs.existsSync(path.join(def, '..', 'definition.new')));

// ---------- 2b. grounded-answer test ----------
const py = process.env.PYTHON || 'python';
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

// ---------- 3. overview page ----------
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ run_id: 'test', name: 'Test', build: spec, tables: { orders: { include: true, fixes: [{ fix: 'F08', column: 'Dato', keep: true }] } } }));
res = spawnSync('node', [path.join(SKILL, 'scripts', 'build-overview.js'), run], { encoding: 'utf8' });
let ov = {};
try { ov = JSON.parse(res.stdout); } catch { /* reported below */ }
check('overview: built', res.status === 0 && fs.existsSync(path.join(run, 'overview.html')), res.stderr);
check('overview: publishable page without wrapper tags', fs.existsSync(path.join(run, 'overview.page.html')) && !/<html|<body|<!doctype/i.test(fs.readFileSync(path.join(run, 'overview.page.html'), 'utf8')));
check('overview: counts the model', ov.facts === 1 && ov.relationships === 2 && ov.staging === 4, JSON.stringify(ov));
check('overview: no warnings', (ov.warnings || []).length === 0, ov.warnings);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);
