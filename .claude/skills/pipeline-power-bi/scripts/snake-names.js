#!/usr/bin/env node
// Renames every table, column and measure in a run's build spec to snake_case, so the Power BI model uses
// names such as dim_customer, customer_id, fact_sales and total_sales.
//
//   node snake-names.js runs/<run-id> [--apply]
//
// Tables get a prefix from their kind: dimension → dim_, fact → fact_, support → rls_ (used in a role
// filter) or bridge_ (otherwise); the calendar becomes dim_date and the measure table _measures. A name
// that already has one of these prefixes keeps it. Columns and measures: lower case, words joined by _,
// camelCase split (CustomerID → customer_id), % → pct, # → no, & → and.
//
// Rewrites, consistently: choices.json → build (tables, columns – a renamed column keeps its query column
// in `from` –, merges with loaded tables, inferMembers, date, relationships, measures + their DAX, roles),
// build.naming = "snake_case", pii_not_personal, model.relationships, glossary examples, checks[].dax;
// questions.json (measure, filters, dax); pbip/docs/ai_descriptions.json keys; checks-basis.json keys;
// the report's field references (Entity, Property, queryRef, nativeQueryRef in pbip/*.Report/definition).
// M code is not touched: it works on the query's own column names, which do not change.
// Idempotent: running it on a snake_case spec changes nothing. Without --apply it only prints the map.
// Prints JSON { ok, applied, tables: {old: new}, measures: {old: new}, columns: n, files: [...], warnings }.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = path.resolve(process.argv[2] || '');
const APPLY = process.argv.includes('--apply');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const choicesFile = path.join(runDir, 'choices.json');
if (!fs.existsSync(choicesFile)) { console.error('Usage: node snake-names.js runs/<run-id> [--apply]   (needs choices.json)'); process.exit(2); }
const choices = read(choicesFile);
const B = choices.build;
if (!B) { console.error('choices.json has no build spec'); process.exit(2); }
const warnings = [];

const FOLD = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa', ß: 'ss' };
function snake(s) {
  let x = String(s).replace(/[æøåÆØÅß]/g, (c) => FOLD[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  x = x.replace(/%/g, ' pct ').replace(/#/g, ' no ').replace(/&/g, ' and ');
  x = x.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  x = x.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!x) x = 'field';
  return /^[0-9]/.test(x) ? `n_${x}` : x;
}
const PREFIXES = ['dim_', 'fact_', 'bridge_', 'rls_'];

// ---------- name maps ----------
const roleTables = new Set((B.roles || []).flatMap((r) => [...String(r.filter || '').matchAll(/'([^']+)'\s*\[|([A-Za-z_][\w ]*?)\s*\[/g)].map((m) => (m[1] || m[2] || '').trim())));
const tableMap = {};
for (const t of B.tables || []) {
  const s = snake(t.name);
  const prefix = t.kind === 'fact' ? 'fact_' : t.kind === 'support' ? (roleTables.has(t.name) ? 'rls_' : 'bridge_') : 'dim_';
  tableMap[t.name] = PREFIXES.some((p) => s.startsWith(p)) ? s : prefix + s.replace(/^(dim|fact)_/, '');
}
const oldDate = B.date ? (B.date.name || 'Date') : null;
if (oldDate) tableMap[oldDate] = 'dim_date';
for (const m of ['_Measures', '_measures']) tableMap[m] = '_measures';
const newNames = Object.values(tableMap).filter((v, i, a) => a.indexOf(v) === i && v !== '_measures');
if (newNames.length !== new Set(Object.entries(tableMap).filter(([k]) => !/^_measures$/i.test(k)).map(([, v]) => v)).size) warnings.push('two tables map to the same snake_case name');

const DATE_COLS = ['Date', 'Year', 'Quarter', 'Month no', 'Month', 'Month start', 'Is complete month'];
const knownCols = new Set(DATE_COLS);
for (const t of B.tables || []) for (const c of t.columns || []) knownCols.add(c.name);
const measureMap = {};
for (const m of B.measures || []) measureMap[m.name] = snake(m.name);
const tbl = (n) => tableMap[n] || n;
const ref = (r) => String(r).replace(/^'?([^'\[]+?)'?\[(.+)\]$/, (all, t, c) => (tableMap[t] || t === oldDate ? `${tbl(t)}[${snake(c)}]` : all));
// "Table[Column]" references inside free text (model.relationships, notes)
const refsInText = (s) => String(s).replace(/'([^']+)'\[([^\]]+)\]|([A-Za-z_][\w ]*?)\[([^\]]+)\]/g, (all, qt, qc, t, c) => {
  const T = (qt || t || '').trim(); const C = qc || c;
  return tableMap[T] ? `${tbl(T)}[${snake(C)}]` : all;
});

// ---------- DAX ----------
function dax(s) {
  if (typeof s !== 'string') return s;
  let out = ''; let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') { let j = i + 1; while (j < s.length) { if (s[j] === '"') { if (s[j + 1] === '"') { j += 2; continue; } break; } j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    if (s.startsWith('//', i) || s.startsWith('--', i)) { const j = s.indexOf('\n', i); const e = j < 0 ? s.length : j; out += s.slice(i, e); i = e; continue; }
    if (ch === "'") {
      let j = i + 1; let name = '';
      while (j < s.length) { if (s[j] === "'") { if (s[j + 1] === "'") { name += "'"; j += 2; continue; } break; } name += s[j]; j++; }
      out += tableMap[name] ? tableMap[name] : s.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '[') {
      let j = i + 1; let name = '';
      while (j < s.length) { if (s[j] === ']') { if (s[j + 1] === ']') { name += ']'; j += 2; continue; } break; } name += s[j]; j++; }
      const n = measureMap[name] || (knownCols.has(name) ? snake(name) : null);
      out += n ? `[${n}]` : s.slice(i, j + 1); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(ch) && !/[\w.]/.test(s[i - 1] || '')) {
      const m = s.slice(i).match(/^[A-Za-z_][\w]*/)[0];
      const next = s.slice(i + m.length).match(/^\s*(.)/);
      out += tableMap[m] && !(next && next[1] === '(') ? tableMap[m] : m; i += m.length; continue;
    }
    out += ch; i++;
  }
  return out;
}

// ---------- build spec ----------
let columns = 0;
const loaded = new Set((B.tables || []).map((t) => t.name));
for (const t of B.tables || []) {
  if (loaded.has(t.from)) warnings.push(`${t.name}: built from loaded table ${t.from} – check its ops use the new column names`);
  if (loaded.has(t.from)) t.from = tbl(t.from);
  for (const o of t.ops || []) {
    if (o.op === 'merge') {
      const w = o.with;
      if (typeof w === 'string' && loaded.has(w)) {
        o.with = tbl(w);
        if (o.withOn) o.withOn = o.withOn.map(snake);
        else if (o.on) o.withOn = o.on.map(snake);
        if (o.columns) { if (!o.as) o.as = [...o.columns]; o.columns = o.columns.map(snake); }
      } else if (w && typeof w === 'object' && loaded.has(w.from)) {
        warnings.push(`${t.name}: merge with ${w.from} (filtered) – check its filter and columns use the new column names`);
        w.from = tbl(w.from);
      }
    }
    if (o.op === 'inferMembers' && o.fromColumns) o.fromColumns = o.fromColumns.map((r) => { const m = String(r).match(/^'?([^'\[]+?)'?\[(.+)\]$/); return m && loaded.has(m[1]) ? ref(r) : r; });
  }
  for (const c of t.columns || []) {
    const n = snake(c.name);
    if (n !== c.name) { if (!c.from) c.from = c.name; c.name = n; columns++; }
  }
  t.name = tbl(t.name);
}
if (B.date) {
  B.date.name = 'dim_date';
  B.date.columns = (B.date.columns || []).map(ref);
  if (B.date.completeMonth) B.date.completeMonth = ref(B.date.completeMonth);
}
B.relationships = (B.relationships || []).map((r) => {
  if (r && typeof r === 'object') return { ...r, from: ref(r.from), to: ref(r.to) };
  return String(r).split('->').map((x) => ref(x.trim())).join(' -> ');
});
for (const m of B.measures || []) { m.name = measureMap[m.name] || m.name; m.expr = dax(m.expr); }
for (const r of B.roles || []) { r.table = tbl(r.table); r.filter = dax(r.filter); }
B.naming = 'snake_case';
B.measuresTable = '_measures';

// ---------- rest of choices.json ----------
if (Array.isArray(choices.pii_not_personal)) choices.pii_not_personal = choices.pii_not_personal.map(ref);
if (choices.model && Array.isArray(choices.model.relationships)) choices.model.relationships = choices.model.relationships.map(refsInText);
for (const g of choices.glossary || []) if (Array.isArray(g.examples)) g.examples = g.examples.map((e) => measureMap[e] || e);
for (const c of choices.checks || []) if (c.dax) c.dax = dax(c.dax);

const files = [];
function save(file, obj) { files.push(path.relative(runDir, file)); if (APPLY) fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n', 'utf8'); }
save(choicesFile, choices);

// ---------- questions.json ----------
const qFile = path.join(runDir, 'questions.json');
if (fs.existsSync(qFile)) {
  const qs = read(qFile);
  const fix = (q) => {
    if (q.measure) q.measure = measureMap[q.measure] || q.measure;
    if (q.filters && typeof q.filters === 'object') q.filters = Object.fromEntries(Object.entries(q.filters).map(([k, v]) => [ref(k), v]));
    for (const k of ['dax', 'expr', 'filter']) if (typeof q[k] === 'string') q[k] = dax(q[k]);
  };
  (Array.isArray(qs) ? qs : qs.questions || []).forEach(fix);
  save(qFile, qs);
}

// ---------- AI descriptions and checks basis ----------
const aiFile = path.join(runDir, 'pbip', 'docs', 'ai_descriptions.json');
if (fs.existsSync(aiFile)) {
  const ai = read(aiFile);
  const out = {};
  for (const [k, v] of Object.entries(ai)) {
    const m = k.match(/^'?([^'\[]+?)'?\[(.+)\]$/);
    if (!m) out[tbl(k)] = v;
    else if (/^_measures$/i.test(m[1])) out[`_measures[${measureMap[m[2]] || snake(m[2])}]`] = v;
    else out[ref(k)] = v;
  }
  save(aiFile, out);
}
const basisFile = path.join(runDir, 'checks-basis.json');
if (fs.existsSync(basisFile)) {
  const bs = read(basisFile);
  if (bs.tables) bs.tables = Object.fromEntries(Object.entries(bs.tables).map(([k, v]) => [tbl(k), v]));
  if (bs.measures) bs.measures = Object.fromEntries(Object.entries(bs.measures).map(([k, v]) => [measureMap[k] || k, v]));
  save(basisFile, bs);
}

// ---------- report visuals (PBIR) ----------
// Entity / Property / queryRef / nativeQueryRef in pbip/<Name>.Report/definition/**/*.json
const pbipDir = path.join(runDir, 'pbip');
const reports = fs.existsSync(pbipDir) ? fs.readdirSync(pbipDir).filter((d) => d.endsWith('.Report')).map((d) => path.join(pbipDir, d, 'definition')) : [];
const field = (n) => measureMap[n] || (knownCols.has(n) ? snake(n) : n);
const jstr = (s) => JSON.stringify(s).slice(1, -1);
const unj = (s) => JSON.parse(`"${s}"`);
let visuals = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { walk(f); continue; }
    if (!e.name.endsWith('.json')) continue;
    const old = fs.readFileSync(f, 'utf8');
    const neu = old
      .replace(/("Entity"\s*:\s*")((?:[^"\\]|\\.)*)"/g, (all, k, v) => `${k}${jstr(tbl(unj(v)))}"`)
      .replace(/("Property"\s*:\s*")((?:[^"\\]|\\.)*)"/g, (all, k, v) => `${k}${jstr(field(unj(v)))}"`)
      .replace(/("queryRef"\s*:\s*")((?:[^"\\]|\\.)*)"/g, (all, k, v) => {
        const s = unj(v); const i = s.indexOf('.');
        return i < 0 ? all : `${k}${jstr(`${tbl(s.slice(0, i))}.${field(s.slice(i + 1))}`)}"`;
      })
      .replace(/("nativeQueryRef"\s*:\s*")((?:[^"\\]|\\.)*)"/g, (all, k, v) => `${k}${jstr(field(unj(v)))}"`);
    if (neu !== old) { visuals++; files.push(path.relative(runDir, f)); if (APPLY) fs.writeFileSync(f, neu, 'utf8'); }
  }
}
for (const r of reports) if (fs.existsSync(r)) walk(r);

const changed = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== v));
console.log(JSON.stringify({ ok: true, applied: APPLY, tables: changed(tableMap), measures: changed(measureMap), columns, files, warnings,
  reportFiles: visuals,
  next: APPLY ? ['node rebuild.js <run> --checks-updated   (values are unchanged, only names)', 'powerbi-report-author validate <Name>.Report – the visuals were renamed in place; rerun the catalog and governance skills.'] : ['Run again with --apply.'] }, null, 1));
