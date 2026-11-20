#!/usr/bin/env node
// Scores a pipeline-power-bi run made on a messy dataset against its answer key, and writes scorecard.md.
// Run it only after step 9, when the user asks to score the run – the answer key must not be read before.
//
//   node score-run.js runs/<run-id> [--answers <dir>] [--out <file>] [--json]
//
// Answer key: <dir>/expected_findings.json and expected_values.json (messy-dataset's -AnswersDir; default
// runs/<run-id>_answers, next to the run folder – step 1 writes it there). It is read into memory only;
// scorecard.md holds the compared numbers, never the answer-key files.
//
// 1. Errors found – per catalogue type 1–13: injected? / what the profile found (cleaning-log.md) / kept?
//    ✅ found and kept · ⚠ found but not kept, or only partly · ❌ injected but not found ·
//    ✔ not injected and not flagged · ⚠ flagged although not injected (a remark) · – out of scope (13:
//    the skill does not read DATA_DICTIONARY.md). Types 5, 7, 11 and 12 are business rules the profiler
//    cannot see in one column; they count as found when the design review, a measure or a check names them.
// 2. Numbers – the answer key's values recomputed from the source files with THIS run's cleaning (the build
//    spec, via source-stats.js) and the reference rules (revenue statuses; F14 flag = "ok"; months only for
//    valid dates). Equal = the cleaning delivers the right base data. A difference is explained
//    automatically when a fix behind it was not kept; otherwise it is marked **?** and needs an explanation.
// 3. Result – Passed (every injected type ✅, every difference 0 or explained), Passed with remarks
//    (that, with ⚠ remarks), or Failed.
//
// Prints JSON { ok, result, found, injected, numbers: { equal, explained, unexplained }, scorecard }.
// Exit 0 = Passed or Passed with remarks, 1 = Failed, 2 = usage/missing files.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const runDir = path.resolve(args[0] || '');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const answersDir = path.resolve(opt('--answers') || `${runDir.replace(/[\\/]+$/, '')}_answers`);
const need = [path.join(runDir, 'choices.json'), path.join(runDir, 'cleaning-log.md'),
  path.join(answersDir, 'expected_findings.json'), path.join(answersDir, 'expected_values.json')];
const missing = need.filter((f) => !fs.existsSync(f));
if (!args[0] || missing.length) {
  console.error(`Usage: node score-run.js runs/<run-id> [--answers <dir>]\nmissing: ${missing.join(', ') || 'run folder'}`);
  process.exit(2);
}
const choices = readJson(need[0]);
const B = choices.build || {};
const EF = readJson(need[2]);
const EV = readJson(need[3]);
const INJ = EF.injected || {};
const domain = EF.domain || 'retail';

// Role contract (messy-dataset references/domains.md)
const ROLES = {
  retail: { fact: 'fact_orders', date: 'order_date', customer: 'dim_customers', product: 'dim_products', category: 'category', bridge: 'bridge_customer_sales_reps', wide: 'wide_monthly_targets', hist: 'hist_product_prices', second: 'erp_customers', revenue: ['Completed', 'Shipped'] },
  hotel: { fact: 'fact_bookings', date: 'stay_date', customer: 'dim_guests', product: 'dim_room_types', category: 'room_class', bridge: 'bridge_guest_agencies', wide: 'wide_occupancy_targets', hist: 'hist_room_rates', second: 'pms_guests', revenue: ['Checked-out', 'Invoiced'] },
  saas: { fact: 'fact_invoices', date: 'invoice_date', customer: 'dim_accounts', product: 'dim_plans', category: 'plan_tier', bridge: 'bridge_account_managers', wide: 'wide_mrr_targets', hist: 'hist_plan_prices', second: 'billing_accounts', revenue: ['Paid', 'Invoiced'] },
}[domain];
if (!ROLES) { console.error(`unknown domain ${domain}`); process.exit(2); }
const revenueStatuses = EV.revenue_statuses || ROLES.revenue;

// --- what the run found and kept: cleaning-log.md -------------------------------------------------
const log = {}; // source base name -> { model, rows: [{ fix, column, rows, kept, variant }] }
let cur = null;
for (const line of fs.readFileSync(need[1], 'utf8').split(/\r?\n/)) {
  const h = /^## (.+?)(?: → staging `[^`]+`)?(?: → (.+))?$/.exec(line);
  if (h) { const base = h[1].replace(/\.(csv|txt|xlsx|xlsm)$/i, '').replace(/^.*[\\/]/, '').toLowerCase(); cur = log[base] = { model: (h[2] || '').trim(), rows: [] }; continue; }
  const r = /^\| ((?:F|M)\d\d) \| ([^|]*) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|/.exec(line);
  if (r && cur) cur.rows.push({ fix: r[1], column: r[2].trim() === '–' ? null : r[2].trim(), rows: Number(r[3].replace(/[^\d]/g, '')) || 0, kept: r[4].trim() === 'kept', variant: r[5].trim() });
}
const inLog = (src, fix, col) => ((log[src] || {}).rows || []).filter((x) => x.fix === fix && (!col || x.column === col || (x.column || '').split(/,\s*/).includes(col)));
const profileFile = path.join(runDir, 'profile.json');
const profile = fs.existsSync(profileFile) ? readJson(profileFile) : { tables: [], relations: [] };
// F18 / M01 can be model choices without a staging row: take them from the profile when the log has none.
const profFind = (src, fix, col) => ((profile.tables || []).find((t) => String(t.name).toLowerCase() === src) || { findings: [] }).findings
  .filter((f) => f.fix === fix && (!col || f.column === col)).map((f) => ({ fix, column: f.column, rows: f.rows || 0, kept: modelKept(fix), variant: f.variant || '' }));
function modelKept(fix) {
  if (fix === 'F18') return (B.tables || []).some((t) => (t.ops || []).some((o) => o.op === 'inferMembers'));
  if (fix === 'M01') return !!(B.date && (B.date.cutoff || B.date.lastCompleteMonth || B.cutoffDate));
  return false;
}
// rows of the recommended findings only (a "not recommended" finding on the same column shares its log line)
const profT = (src) => (profile.tables || []).find((t) => String(t.name).toLowerCase() === src) || { findings: [] };
const recRows = (src, fix) => profT(src).findings.filter((x) => x.fix === fix && x.recommended).reduce((s, x) => s + (x.rows || 0), 0);
const keysIn = (src, fix) => { const x = profT(src).findings.find((y) => y.fix === fix); const m = x && /^(\d+)/.exec(x.detail || ''); return m ? Number(m[1]) : x ? x.rows : 0; };
const found = (src, fix, col) => { const a = inLog(src, fix, col); return a.length ? a : profFind(src, fix, col); };

// Text the run wrote about business rules: design review, handover notes, measures, checks.
const ruleText = JSON.stringify([choices.design && choices.design.review, choices.handover_notes, B.measures, choices.checks, choices.glossary]).toLowerCase();

const custCol = (INJ.orphans && INJ.orphans.column) || (((B.tables || []).find((t) => t.name.endsWith(ROLES.customer.replace(/^dim_/, ''))) || { columns: [{ name: 'customer_id' }] }).columns[0] || {}).name || 'customer_id';
const F = ROLES.fact;
const sum = (a) => a.reduce((s, x) => s + x.rows, 0);

// --- 1. Errors found -------------------------------------------------------------------------------
const TYPES = [
  [1, 'Mixed ID formats', 'id_formats', () => { const a = [...found(F, 'F11'), ...found(ROLES.bridge, 'F11'), ...found(ROLES.second, 'F11')]; return { hits: a, count: `${a.length} id columns`, want: INJ.id_formats ? `${Object.values(INJ.id_formats.tables || {}).reduce((s, t) => s + Object.keys(t).length, 0)} id columns` : null }; }],
  [2, 'Mixed date/amount/boolean formats', 'mixed_formats', () => { const a = [...found(F, 'F08'), ...found(F, 'F09'), ...found(F, 'F10')]; return { hits: a, count: `${a.length} columns`, want: INJ.mixed_formats ? `${Object.keys(INJ.mixed_formats.columns || {}).length} columns` : null }; }],
  [3, 'Duplicates without timestamp', 'duplicates', () => { const a = [...found(F, 'F12'), ...found(F, 'F13')]; return { hits: a, count: `${sum(a)} rows`, want: INJ.duplicates ? `${INJ.duplicates.extra_rows} rows` : null }; }],
  [4, 'Orphan fact keys', 'orphans', () => { const a = found(F, 'F18', custCol); const rel = (profile.relations || []).find((r) => String(r.from).toLowerCase().startsWith(`${F}[${custCol}]`) && r.orphanRows > 0); const hits = a.length ? a : rel ? [{ fix: 'F18', rows: rel.orphanRows, kept: modelKept('F18') }] : []; return { hits, count: `${sum(hits)} rows`, want: INJ.orphans ? `${INJ.orphans.rows} rows` : null }; }],
  [5, 'Many-to-many fanout', 'bridge_fanout', () => { const a = found(ROLES.bridge, 'F12'); const rule = /fan-?out|allocat|1\/n|bridge/.test(ruleText); return { hits: a, partial: a.length && !rule ? 'duplicated pairs removed; fanout not named in the review or a measure' : null, rule, count: `${sum(a)} duplicated pairs`, want: INJ.bridge_fanout ? `${INJ.bridge_fanout.duplicated_pairs} duplicated pairs` : null }; }],
  [6, 'Wide month columns with gaps', 'wide_table', () => { const a = found(ROLES.wide, 'F16'); return { hits: a, rule: true /* the table is wide by design; only the gaps are injected */, count: a.length ? 'unpivoted' : '–', want: INJ.wide_table ? `${INJ.wide_table.empty_cells} empty cells` : null }; }],
  [7, 'Revenue on non-revenue statuses', 'status_revenue', () => { const rule = /status/.test(ruleText); return { hits: rule ? [{ kept: true, rows: 0 }] : [], rule, count: rule ? 'status rule named' : '–', want: null }; }],
  [8, 'Amount anomalies', 'amount_anomalies', () => { const a = found(F, 'F14'); return { hits: a, count: `${recRows(F, 'F14')} rows flagged`, want: INJ.amount_anomalies ? `${(INJ.amount_anomalies.negative || 0) + (INJ.amount_anomalies.spike || 0) + (INJ.amount_anomalies.zero_on_status || 0)} rows` : null }; }],
  [9, 'Missing and future dates', 'bad_dates', () => { const a = found(F, 'F15'); return { hits: a, count: `${sum(a)} rows`, want: INJ.bad_dates ? `${(INJ.bad_dates.missing || 0) + (INJ.bad_dates.future || 0)} rows` : null }; }],
  [10, 'Incomplete last month', 'incomplete_month', () => { const a = found(F, 'M01'); return { hits: a, count: a.length ? 'flagged' : '–', want: INJ.incomplete_month ? `last date ${INJ.incomplete_month.last_date}` : null }; }],
  [11, 'Versioned prices (SCD)', 'scd_prices', () => {
    // M03 = the profiler's history-table finding; kept unless an F13 step deduplicated the history away
    const dedup = inLog(ROLES.hist, 'F13').some((x) => x.kept);
    const a = profFind(ROLES.hist, 'M03').map((x) => ({ ...x, kept: !dedup })); const rule = /price (history|version)|scd|valid_from|versioned/.test(ruleText); return { hits: rule ? [...a, { kept: true, rows: 0 }] : a, rule, count: a.length ? `${keysIn(ROLES.hist, 'M03')} products` : rule ? 'named' : '–', want: INJ.scd_prices ? `${INJ.scd_prices.products_with_changes} products` : null }; }],
  [12, 'Conflicting source attribute', 'source_conflict', () => { const rule = /conflict|disagree|two sources|second source/.test(ruleText); return { hits: rule ? [{ kept: true, rows: 0 }] : [], rule, count: rule ? 'named' : '–', want: INJ.source_conflict ? `${INJ.source_conflict.conflicts} customers` : null }; }],
  [13, 'Data dictionary lies', 'lying_docs', null],
];
const rowsOut = [];
let injectedN = 0, foundN = 0, remarks = [], failures = [];
for (const [n, name, key, fn] of TYPES) {
  const injected = !!INJ[key];
  if (!fn) { rowsOut.push([n, name, injected ? 'yes' : 'no', '–', '–', '– out of scope (the skill does not read DATA_DICTIONARY.md)']); continue; }
  const r = fn();
  const hit = r.hits.length > 0;
  const kept = r.hits.some((x) => x.kept);
  let verdict;
  if (injected) {
    injectedN++;
    if (!hit) { verdict = '❌ missed'; failures.push(`type ${n} ${name} not found`); }
    else if (!kept) { verdict = '⚠ found, not kept'; remarks.push(`type ${n}: found but the fix was not kept`); foundN++; }
    else if (r.partial) { verdict = `⚠ partly – ${r.partial}`; remarks.push(`type ${n}: ${r.partial}`); foundN++; }
    else { verdict = '✅ found'; foundN++; }
  } else if (hit && !r.rule) { verdict = '⚠ flagged although not injected'; remarks.push(`type ${n}: flagged although not injected – check it is real`); }
  else verdict = '✔ not applicable – checked';
  rowsOut.push([n, name, injected ? 'yes' : 'no', [...new Set(r.hits.map((x) => x.fix).filter(Boolean))].join(', ') || (r.rule ? 'review/measures' : '–'), injected ? `${r.count} / ${r.want || '–'}` : r.count, verdict]);
}

// --- 2. Numbers ------------------------------------------------------------------------------------
const tables = (B.tables || []).map((t) => t.name);
const pick = (base) => tables.find((t) => t === base) || tables.find((t) => t.endsWith(base.replace(/^(fact|dim|bridge|wide|hist)_/, '')));
const T = { fact: pick(F), customer: pick(ROLES.customer), product: pick(ROLES.product), wide: pick(ROLES.wide) };
const factSpec = (B.tables || []).find((t) => t.name === T.fact) || { columns: [] };
const factCols = new Set((factSpec.columns || []).map((c) => c.name));
const flagCol = [...factCols].find((c) => /amount_issue|amount status|amount_status/i.test(c));
const q = (s) => JSON.stringify(s);
const cleanWhere = [`List.Contains({${revenueStatuses.map(q).join(', ')}}, [status])`, flagCol ? `[${flagCol}] = "ok"` : null].filter(Boolean).join(' and ');
const queries = [];
const addQ = (key, query, related) => queries.push({ key, related, query: { name: key, ...query } });
if (T.fact) {
  addQ('fact_rows_after_dedupe', { table: T.fact, agg: 'rows' }, ['F12', 'F13']);
  addQ('clean_rows', { table: T.fact, agg: 'rows', where: cleanWhere }, ['F12', 'F13', 'F14']);
  addQ('clean_revenue', { table: T.fact, agg: 'sum', column: 'amount', where: cleanWhere }, ['F09', 'F12', 'F13', 'F14']);
  addQ('unique_customers', { table: T.fact, agg: 'distinct', column: custCol, where: cleanWhere }, ['F11', 'F12', 'F13', 'F14']);
  if (T.product && EV.revenue_by_category) addQ('revenue_by_category', { table: T.fact, agg: 'sum', column: 'amount', where: cleanWhere, by: ROLES.category, join: [{ table: T.product, on: (((B.tables.find((t) => t.name === T.product) || {}).columns || [])[0] || {}).name || 'product_id', columns: [ROLES.category] }] }, ['F09', 'F11', 'F12', 'F13', 'F14']);
  for (const m of Object.keys(EV.revenue_by_month || {})) {
    const [y, mo] = m.split('-').map(Number); const ny = mo === 12 ? y + 1 : y; const nm = mo === 12 ? 1 : mo + 1;
    addQ(`revenue_by_month.${m}`, { table: T.fact, agg: 'sum', column: 'amount', where: `${cleanWhere} and [${ROLES.date}] >= #date(${y}, ${mo}, 1) and [${ROLES.date}] < #date(${ny}, ${nm}, 1)` }, ['F08', 'F09', 'F12', 'F13', 'F14', 'F15']);
  }
}
if (T.customer) addQ('customers_in_dimension', { table: T.customer, agg: 'rows' }, ['F18']);
if (T.wide && EV.wide_long_rows !== undefined) addQ('wide_long_rows', { table: T.wide, agg: 'rows' }, ['F16']);

let stats = { results: [] };
if (queries.length) {
  const qf = path.join(require('os').tmpdir(), `score-queries-${process.pid}.json`);
  fs.writeFileSync(qf, JSON.stringify(queries.map((x) => x.query)));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'source-stats.js'), runDir, '--queries', qf], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  fs.rmSync(qf, { force: true });
  try { stats = JSON.parse(r.stdout); } catch { console.error(`source-stats.js failed: ${(r.stderr || r.stdout).slice(0, 1000)}`); process.exit(2); }
}
const res = Object.fromEntries(stats.results.map((r) => [r.name, r]));
const notKept = (fixes) => fixes.filter((f) => { const a = ((log[F] || {}).rows || []).filter((x) => x.fix === f); return a.length && a.every((x) => !x.kept); });
const num = (v) => (typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v));
const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;
const fmt = (v) => (v === null || v === undefined ? '–' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v));
const numRows = [];
let equal = 0, explained = 0, unexplained = 0;
function compare(key, want, got, related, approx) {
  const w = num(want), g = num(got);
  if (same(w, g)) { equal++; numRows.push([key, fmt(w), fmt(g), '0', '–']); return; }
  const nk = notKept(related || []);
  const why = g === null ? 'not computed' : nk.length ? `fix not kept: ${nk.join(', ')}` : approx ? 'approximate – an M step source-stats cannot replay' : '**?**';
  if (why === '**?**' || g === null) { unexplained++; failures.push(`${key}: ${fmt(w)} expected, ${fmt(g)} in the run`); } else explained++;
  numRows.push([key, fmt(w), fmt(g), g === null || w === null ? '–' : `${g - w >= 0 ? '+' : ''}${fmt(Math.round((g - w) * 100) / 100)}`, why]);
}
const monthRows = [];
for (const x of queries) {
  const r = res[x.key] || {};
  if (x.key === 'revenue_by_category') {
    const vals = r.values || {}; const want = EV.revenue_by_category;
    const bad = Object.keys(want).filter((k) => !same(num(want[k]), num(vals[k])));
    if (!bad.length) { equal += Object.keys(want).length; numRows.push([x.key, `${Object.keys(want).length} values`, `all ${Object.keys(want).length} equal`, '0', '–']); }
    else for (const k of Object.keys(want)) compare(`${x.key}.${k}`, want[k], vals[k] === undefined ? null : vals[k], x.related, r.approx);
    continue;
  }
  if (x.key.startsWith('revenue_by_month.')) { monthRows.push([x, r]); continue; }
  compare(x.key, EV[x.key], r.error ? null : r.value, x.related, r.approx);
}
if (monthRows.length) {
  const bad = monthRows.filter(([x, r]) => !same(num(EV.revenue_by_month[x.key.split('.')[1]]), num(r.value)));
  if (!bad.length) { equal += monthRows.length; numRows.push(['revenue_by_month', `${monthRows.length} months`, `all ${monthRows.length} equal`, '0', '–']); }
  else for (const [x, r] of monthRows) compare(x.key, EV.revenue_by_month[x.key.split('.')[1]], r.error ? null : r.value, x.related, r.approx);
}

// --- 3. Result and scorecard -----------------------------------------------------------------------
const result = failures.length ? 'Failed' : remarks.length || explained ? 'Passed with remarks' : 'Passed';
const md = [
  `# Scorecard – ${B.name || path.basename(runDir)}`,
  '',
  `**Result: ${result}** – ${foundN}/${injectedN} injected error types found; ${equal} numbers equal, ${explained} explained, ${unexplained} unexplained.`,
  '',
  `Dataset: ${domain}, seed ${EF.seed}, ${EF.rows} rows, error types ${(EF.errors || []).join(', ')}. Scored by \`score-run.js\` against the answer key in \`${path.basename(answersDir)}\`; numbers recomputed from the source files with this run's cleaning (source-stats.js).`,
  '',
  '## 1. Errors found',
  '',
  '| # | Type | Injected? | Fix | Found / answer key | Verdict |',
  '|---|---|---|---|---|---|',
  ...rowsOut.map((r) => `| ${r.join(' | ')} |`),
  '',
  '## 2. Numbers',
  '',
  `Reference rules: revenue statuses ${revenueStatuses.join(', ')}${flagCol ? `; \`${flagCol}\` = "ok"` : '; no amount flag column in the fact'}; months only for valid dates.`,
  '',
  '| Key | Answer key | This run | Difference | Explanation |',
  '|---|---|---|---|---|',
  ...numRows.map((r) => `| ${r.join(' | ')} |`),
  '',
  '## 3. Result',
  '',
  `**${result}**`,
  '',
  ...(failures.length ? ['Errors:', ...failures.map((f) => `- ${f}`), ''] : []),
  ...(remarks.length ? ['Remarks:', ...remarks.map((f) => `- ${f}`), ''] : []),
  'A **?** needs an explanation from a logged decision (answers-format.md → "Typical explained deviations") or a fix; follow the reconcile skill for one you cannot explain at once.',
  '',
].join('\n');
const out = path.resolve(opt('--out') || path.join(runDir, 'scorecard.md'));
fs.writeFileSync(out, md);
console.log(JSON.stringify({ ok: !failures.length, result, found: foundN, injected: injectedN, numbers: { equal, explained, unexplained }, failures, remarks, scorecard: out }, null, 1));
process.exit(failures.length ? 1 : 0);
