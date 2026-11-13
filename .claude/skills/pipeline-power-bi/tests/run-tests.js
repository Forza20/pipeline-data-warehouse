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
function driftRun(name, srcFolder) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir);
  fs.copyFileSync(profFile, path.join(dir, 'profile.json'));
  fs.writeFileSync(path.join(dir, 'choices.json'), JSON.stringify({ build: spec }));
  const done = spawnAsync('node', [path.join(SKILL, 'scripts', 'check-drift.js'), dir, '--path', srcFolder, '--today', '2026-11-06']);
  return done.then((r) => ({ ...r, dir }));
}
const newFix = path.join(TMP, 'newfiles');
fs.mkdirSync(newFix);
for (const f of fs.readdirSync(FIX)) fs.copyFileSync(path.join(FIX, f), path.join(newFix, f));
const csv = fs.readFileSync(path.join(newFix, 'orders.csv'), 'utf8').replace('Ordrenr;Dato;KundeID;Region;Beløb', 'Ordrenr;Dato;KundeID;Region;Belob');
fs.writeFileSync(path.join(newFix, 'orders.csv'), csv, 'utf8');
fs.rmSync(path.join(newFix, 'customers.csv'));
const driftSame = QUICK ? null : driftRun('drift-same', FIX);
const driftNew = QUICK ? null : driftRun('drift-new', newFix);

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
fs.writeFileSync(path.join(run, 'choices.json'), JSON.stringify({ build: bad }));
res = gen(run);
let badOut = {};
try { badOut = JSON.parse(res.stdout); } catch { /* reported below */ }
check('bad spec: exit code 2', res.status === 2, res.status);
check('bad spec: names both errors', (badOut.errors || []).length === 2, JSON.stringify(badOut.errors));
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
  res = spawnSync('node', [path.join(SKILL, 'scripts', 'rebuild.js'), run], { encoding: 'utf8', env: { ...process.env, PYTHON: py } });
  let rb = {};
  try { rb = JSON.parse(res.stdout); } catch { /* reported below */ }
  check('rebuild: all steps in order, ok', res.status === 0 && rb.ok && (rb.steps || []).map((x) => x.step).join(',') === 'build-model,descriptions,build-docs,build-context,model-health,grounded-answers,handover,overview', res.stdout.slice(0, 800) + res.stderr);
  // descriptions.py: every table, column and measure has a /// description after a rebuild, and the Excel list exists
  {
    const dr = spawnSync(py, ['-X', 'utf8', path.join(SKILL, 'scripts', 'descriptions.py'), path.join(run, 'pbip'), '--warn-only'], { encoding: 'utf8' });
    let dj = {};
    try { dj = JSON.parse(dr.stdout); } catch { /* reported below */ }
    check('descriptions: Date and _Measures columns described by build-model, Excel list written',
      dr.status === 0 && dj.total > 0 && !(dj.missing || []).some((k) => /^Date\[|^_Measures\[Placeholder\]$/.test(k)) && fs.existsSync(dj.xlsx || ''), dr.stdout.slice(0, 600) + dr.stderr);
  }
  check('rebuild: grounded answers skipped without questions.json, handover run (governance folder)', ((rb.steps || []).find((x) => x.step === 'grounded-answers') || {}).skipped === 'no questions.json yet (step 8.9)' &&
    ((rb.steps || []).find((x) => x.step === 'handover') || {}).ok && !((rb.steps || []).find((x) => x.step === 'handover') || {}).skipped);
  check('rebuild: next names the TMDL validation', (rb.next || []).some((x) => /ConnectFolder/.test(x)));
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
Promise.all([driftSame, driftNew]).then(([same, changed]) => {
  if (!QUICK) {
    check('drift: unchanged files pass', same.status === 0, same.stdout + same.stderr);
    const driftMd = fs.existsSync(path.join(changed.dir, 'drift.md')) ? fs.readFileSync(path.join(changed.dir, 'drift.md'), 'utf8') : '';
    check('drift: breaking changes give exit 1', changed.status === 1, changed.status);
    check('drift: renamed column guessed', driftMd.includes('column "Beløb" is gone – renamed to "Belob"?'));
    check('drift: missing file found', driftMd.includes('file customers.csv not found'));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`${pass} passed, ${fails.length} failed` + (QUICK ? ' (quick: drift and Python checks skipped – run without --quick before a commit)' : ''));
  for (const f of fails) console.log('  FAIL ' + f);
  process.exit(fails.length ? 1 : 0);
});
