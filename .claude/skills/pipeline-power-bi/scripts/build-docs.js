#!/usr/bin/env node
// Writes the run's hand-over files from what is already decided, so they are not written by hand:
//   cleaning-log.md     per source: every profile finding, kept or not, its variant and the Power Query step
//                       names the model really has; then the model tables' own steps (M…, F18 …)
//   expected-values.md  the checks with their expected values and the fixes they assume, + choices.expected_notes
//   checks.dax          one EVALUATE with a row per check (In Power BI, Expected, Difference)
//
//   node build-docs.js runs/<run-id> [--checks-updated]
//
// checks-basis.json (in the run folder) remembers what the model looked like when checks[] were computed. When a
// table or measure that a given check reads has changed since, the check is marked (stale) and a warning names
// it; questions in questions.json (the grounded-answer test) are checked the same way (staleQuestions). After recomputing those values, --checks-updated takes the new model as the basis.
//
// Run it after build-model.js. Reads choices.json (build, tables, checks, expected_notes), profile.json and
// pbip/<Name>.SemanticModel/definition. The expected values are the one thing it does not compute: they come
// from the source files, in choices.json → checks[] = { name, dax, expected, assumes }. It adds three kinds of
// checks itself, all with expected 0: fact rows without a dimension row (one per active relationship), test
// rows left (one per kept F27 step) and the filter contract of measures with `filters` (build-spec.md).
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = path.resolve(process.argv[2] || '');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
if (!fs.existsSync(path.join(runDir, 'choices.json'))) {
  console.error('Usage: node build-docs.js runs/<run-id>   (needs choices.json with a build spec)');
  process.exit(2);
}
const choices = readJson(path.join(runDir, 'choices.json'));
const B = choices.build;
if (!B) { console.error('choices.json has no "build" spec – run this after build-model.js'); process.exit(2); }
const profile = fs.existsSync(path.join(runDir, 'profile.json')) ? readJson(path.join(runDir, 'profile.json')) : { tables: [] };
const NAME = B.name || choices.name || 'Model';
const RUN = choices.run_id || path.basename(runDir);
const def = path.join(runDir, 'pbip', `${NAME}.SemanticModel`, 'definition');
const warnings = [];

// ---------- step names the model really has ----------
const stepRx = /#"([FM]\d\d[^"]*)"\s*=/g;
const stepsOf = (text) => [...text.matchAll(stepRx)].map((m) => m[1]);
const querySteps = {};   // staging query → step names
const tableSteps = {};   // model table → step names
if (fs.existsSync(path.join(def, 'expressions.tmdl'))) {
  const ex = fs.readFileSync(path.join(def, 'expressions.tmdl'), 'utf8');
  for (const part of ex.split(/^expression /m).slice(1)) {
    const name = part.match(/^('(?:[^']|'')+'|[^\s=]+)/)[1].replace(/^'|'$/g, '').replace(/''/g, "'");
    querySteps[name] = stepsOf(part);
  }
} else warnings.push(`no model found in ${def} – step names are left out`);
if (fs.existsSync(path.join(def, 'tables'))) {
  for (const f of fs.readdirSync(path.join(def, 'tables'))) {
    if (f.endsWith('.tmdl')) tableSteps[f.slice(0, -5)] = stepsOf(fs.readFileSync(path.join(def, 'tables', f), 'utf8'));
  }
}

// ---------- helpers ----------
const base = (f) => path.basename(String(f || '')).toLowerCase();
const low = (s) => String(s || '').toLowerCase();
const code = (s) => '`' + s + '`';
const cell = (s) => String(s === undefined || s === null || s === '' ? '–' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const variantText = (v) => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return v.join(', ');
  if (v.separator) return `split on '${v.separator}' into ${(v.names || []).join(' and ')}`;
  return Object.entries(v).map(([k, x]) => `${k} ${Array.isArray(x) ? x.join('/') : x}`).join(', ');
};
const stepColumns = (s) => [s.column, ...(s.columns || [])].filter(Boolean).map(low);
function sourceTable(st) {
  return (profile.tables || []).find((t) => base(t.file) === base(st.file) && (
    st.kind === 'csv' ? true : st.kind === 'excel table' ? low(t.excelTable) === low(st.item) : low(t.sheet || t.name) === low(st.item)));
}
function choiceEntry(st) {
  const tabs = choices.tables || {};
  for (const [key, t] of Object.entries(tabs)) {
    const src = t.source || {};
    if (base(src.file || key) === base(st.file) && (st.kind === 'csv' || low(src.item || src.sheet || key) === low(st.item))) return t;
    if (low(key) === low(st.item) || (st.kind === 'csv' && low(key) === low(path.basename(st.file, path.extname(st.file))))) return t;
  }
  return null;
}
const usesQuery = (t, q) => t.from === q || JSON.stringify(t.ops || []).includes(`"${q}`) || JSON.stringify(t.ops || []).includes(`${q}[`);

// ---------- cleaning-log.md ----------
const log = [`# Cleaning log – ${NAME} (${RUN})`, '',
  'Every finding from the profile, what was chosen, and the Power Query step that does it. Every step can be',
  'switched off later in Power BI Desktop → Transform data → *Applied steps*. Written by `build-docs.js`.', ''];
let nFind = 0; let nKept = 0;
for (const st of B.staging || []) {
  const pt = sourceTable(st);
  const ce = choiceEntry(st);
  const users = (B.tables || []).filter((t) => usesQuery(t, st.name)).map((t) => t.name);
  const label = st.kind === 'csv' ? st.file : `${st.file} › ${st.item}`;
  log.push(`## ${label} → staging ${code(st.name)}${users.length ? ' → ' + users.join(', ') : ''}`, '');
  if (!pt) { warnings.push(`no profile table for ${label}`); log.push('No profile for this source.', ''); continue; }
  log.push('| Fix | Column | Rows | Choice | Variant | Step |', '|---|---|---|---|---|---|');
  const notKept = [];
  const qSteps = querySteps[st.name] || [];
  for (const f of pt.findings || []) {
    if (f.fix === 'M01' || f.fix === 'M02' || f.fix === 'F21' || f.fix === 'F22' || f.fix === 'F29') continue;   // model choices, not cleaning
    nFind++;
    const col = low(f.column);
    const built = (st.steps || []).filter((s) => s.fix === f.fix && (!col || !stepColumns(s).length || stepColumns(s).includes(col)));
    const chosen = ((ce && ce.fixes) || []).find((x) => x.fix === f.fix && (!x.column || low(x.column) === col));
    // the steps of this fix; filtered by column only when the fix runs on several columns of this source
    // (F08 on two date columns) – a step may be named after its result instead (F28 Kanal → "F28 Channel names")
    let names = qSteps.filter((n) => n.startsWith(f.fix + ' '));
    const fixCols = new Set((st.steps || []).filter((s) => s.fix === f.fix).flatMap(stepColumns));
    if (col && fixCols.size > 1) names = names.filter((n) => n.toLowerCase().includes(col));
    if (!names.length && f.fix !== 'F02') {
      for (const t of users) {
        const inT = (tableSteps[t] || []).filter((n) => n.startsWith(f.fix + ' '));
        if (inT.length) names.push(`in ${t}: ${inT.map(code).join(', ')}`);
      }
    } else names = names.map(code);
    let kept = chosen ? chosen.keep !== false : (built.length > 0 || names.length > 0);
    if (f.fix === 'F02') {
      const renamed = (B.tables || []).some((t) => users.includes(t.name) && (t.columns || []).some((c) => c.from && c.from !== c.name));
      kept = chosen ? chosen.keep !== false : renamed;
      if (kept) names = ['readable names in the model tables\' final columns'];
    }
    if (f.fix === 'F01' && !names.length && st.headerRow > 1) names = [code(`F01 Skip ${st.headerRow - 1} title lines`)];
    const variant = variantText((chosen && (chosen.variant || chosen.names || chosen.keys)) || (kept ? f.variant : ''));
    if (kept) nKept++; else notKept.push(`${f.fix}${f.column ? ' ' + f.column : ''} (${f.detail || ''})`.replace(/ \(\)$/, ''));
    log.push(`| ${f.fix} | ${cell(f.column)} | ${cell(f.rows)} | ${kept ? 'kept' : 'not kept'} | ${cell(variant)} | ${cell(kept ? names.join(', ') : '')} |`);
  }
  log.push('', `Not kept: ${notKept.length ? notKept.map(cell).join('; ') : 'none'}.`, '');
}
const modelRows = [];
for (const t of B.tables || []) {
  for (const n of tableSteps[t.name] || []) if (!n.startsWith('M99')) modelRows.push(`| ${t.name} | ${code(n)} |`);
}
if (modelRows.length) log.push('## Model steps', '', '| Table | Step |', '|---|---|', ...modelRows, '');
fs.writeFileSync(path.join(runDir, 'cleaning-log.md'), log.join('\n'), 'utf8');

// ---------- checks: given + automatic ----------
const q = (n) => `'${String(n).replace(/'/g, "''")}'`;
const ref = (s) => { const m = String(s).match(/^(.+?)\[(.+)\]$/); return m ? { table: m[1], column: m[2] } : null; };
const checks = [];
for (const c of choices.checks || []) {
  if (!c || !c.name || !c.dax || typeof c.expected !== 'number') { warnings.push(`check skipped (needs name, dax and a numeric expected): ${JSON.stringify(c)}`); continue; }
  checks.push({ ...c, auto: false });
}
const have = new Set(checks.map((c) => low(c.name)));
const add = (c) => { if (!have.has(low(c.name))) { have.add(low(c.name)); checks.push({ ...c, auto: true }); } };
for (const r of B.relationships || []) {
  if (r.active === false) continue;
  const from = ref(r.from); const to = ref(r.to);
  if (!from || !to) continue;
  add({ name: `${from.table} rows without ${to.table}`, dax: `COUNTROWS ( FILTER ( ${q(from.table)}, ISBLANK ( RELATED ( ${q(to.table)}[${to.column.replace(/]/g, ']]')}] ) ) ) )`,
    expected: 0, assumes: `relationship ${r.from} → ${r.to}` });
}
for (const st of B.staging || []) {
  for (const s of (st.steps || []).filter((x) => x.fix === 'F27' && x.column && (x.values || []).length)) {
    for (const t of (B.tables || []).filter((x) => x.from === st.name)) {
      const col = (t.columns || []).find((c) => (c.from || c.name) === s.column);
      if (!col) continue;
      const vals = s.values.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(', ');
      add({ name: `Test rows left in ${t.name} (${s.values.join(', ')})`, dax: `COUNTROWS ( FILTER ( ${q(t.name)}, ${q(t.name)}[${col.name}] IN { ${vals} } ) ) + 0`,
        expected: 0, assumes: 'F27' });
    }
  }
}

// filter contract per measure (build-spec.md → measures[].filters): a filter on an `ignore` column must not
// change the value, a filter on a `keep` column must; with `additive`, the values per `keep` member add up to
// the total (filter-checks.js).
const { contractChecks } = require('./filter-checks');
for (const m of B.measures || []) for (const c of contractChecks(B, m, warnings)) add(c);

// ---------- are the given checks older than the design? ----------
// checks-basis.json keeps a fingerprint per model table and per measure from the time the expected values
// were computed. A table whose spec (or a staging query or table it is built from) changed since then, or a
// measure whose formula changed, makes the given checks that read it stale. Recompute those from the source
// files, update checks[], then run with --checks-updated to take the new fingerprints.
const crypto = require('crypto');
const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);
const stagingByName = new Map((B.staging || []).map((s) => [s.name, s]));
const tableByName = new Map((B.tables || []).map((t) => [t.name, t]));
const tableHash = new Map();
function fpTable(t, seen = new Set()) {
  if (tableHash.has(t.name)) return tableHash.get(t.name);
  seen.add(t.name);
  const deps = [];
  for (const [n, s] of stagingByName) if (usesQuery(t, n)) deps.push(['staging', n, s]);
  for (const [n, o] of tableByName) if (n !== t.name && !seen.has(n) && usesQuery(t, n)) deps.push(['table', n, fpTable(o, seen)]);
  const h = hash({ from: t.from, ops: t.ops || [], columns: (t.columns || []).map((c) => [c.name, c.from || c.name, c.type]), deps });
  tableHash.set(t.name, h);
  return h;
}
const basis = { tables: {}, measures: {} };
for (const t of B.tables || []) basis.tables[t.name] = fpTable(t);
for (const m of B.measures || []) basis.measures[m.name] = hash(m.expr);
const basisFile = path.join(runDir, 'checks-basis.json');
const acceptChecks = process.argv.includes('--checks-updated');
let stale = [];
let staleQuestions = [];
let changedParts = [];
// the grounded-answer test (questions.json) has expected values computed from the source files too
const qFile = path.join(runDir, 'questions.json');
let questions = [];
try { if (fs.existsSync(qFile)) { const raw = readJson(qFile); questions = Array.isArray(raw) ? raw : (raw.questions || []); } } catch (e) { warnings.push(`questions.json could not be read: ${e.message}`); }
if (checks.some((c) => !c.auto) || questions.length) {
  const old = fs.existsSync(basisFile) ? readJson(basisFile) : null;
  if (old && !acceptChecks) {
    const changedT = Object.keys(basis.tables).filter((n) => old.tables && old.tables[n] && old.tables[n] !== basis.tables[n]);
    const changedM = new Set(Object.keys(basis.measures).filter((n) => old.measures && old.measures[n] && old.measures[n] !== basis.measures[n]));
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const readsTable = (text, n) => new RegExp(`'${esc(n.replace(/'/g, "''"))}'|(^|[^\\w'\\[])${esc(n)}\\s*[\\[),]`).test(text);
    // a measure is touched when its formula changed, or it reads a changed table or a touched measure
    const touched = new Set(changedM);
    for (let more = true; more;) {
      more = false;
      for (const m of B.measures || []) {
        if (touched.has(m.name)) continue;
        if (changedT.some((n) => readsTable(m.expr, n)) || [...touched].some((x) => m.expr.includes(`[${x}]`))) { touched.add(m.name); more = true; }
      }
    }
    changedParts = [...changedT, ...[...changedM].map((n) => `[${n}]`)];
    stale = checks.filter((c) => !c.auto && (changedT.some((n) => readsTable(c.dax, n)) || [...touched].some((x) => c.dax.includes(`[${x}]`))));
    for (const c of stale) c.stale = true;
    // a question is stale when its measure is touched, or a table it filters on (or its role's table) changed
    const roleTable = new Map((B.roles || []).map((r) => [low(r.name), r.table]));
    staleQuestions = questions.filter((x) => x && (touched.has(x.measure) ||
      Object.keys(x.filters || {}).some((f) => { const r = ref(f); return r && changedT.includes(r.table.replace(/^'|'$/g, '')); }) ||
      (x.role && changedT.includes(roleTable.get(low(x.role)))))).map((x) => x.question || x.measure);
    if (stale.length || staleQuestions.length) {
      warnings.push(`the design changed after the expected values were computed (${changedParts.join(', ')}). Recompute from the source files: ` +
        [...stale.map((c) => c.name), ...staleQuestions.map((x) => `question "${x}"`)].join('; ') + '. ' +
        'Update checks[] in choices.json and expected in questions.json (then rerun grounded_answers.py), and run build-docs.js again with --checks-updated.');
    }
  }
  // a change no given check or question reads needs no new numbers, so its fingerprint is taken at once
  if (!old || acceptChecks || (!stale.length && !staleQuestions.length)) fs.writeFileSync(basisFile, JSON.stringify({ written: new Date().toISOString().slice(0, 10), ...basis }, null, 1), 'utf8');
}

// ---------- expected-values.md ----------
const fmt = (n) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const ev = [`# Expected values – ${NAME} (${RUN})`, '',
  'Computed from the source files with the kept cleaning steps, not from the model. Fill in "In Power BI" after a',
  'refresh (run `checks.dax` in DAX query view). Rows marked (auto) are model checks added by `build-docs.js`.', '',
  ...(stale.length ? [`> **Stale:** the design changed after these values were computed (${changedParts.join(', ')}). Rows marked`,
    '> (stale) must be recomputed from the source files before the check means anything.', ''] : []),
  '| Check | Expected | Assumes | In Power BI |', '|---|---|---|---|',
  ...checks.map((c) => `| ${cell(c.name)}${c.auto ? ' (auto)' : ''}${c.stale ? ' (stale)' : ''} | ${fmt(c.expected)} | ${cell(c.assumes)} | |`), ''];
if (choices.expected_notes) ev.push(String(choices.expected_notes).trim(), '');
fs.writeFileSync(path.join(runDir, 'expected-values.md'), ev.join('\n'), 'utf8');

// ---------- checks.dax ----------
const daxStr = (s) => `"${String(s).replace(/"/g, '""')}"`;
const dax = [`// Control check for ${NAME} (${RUN}). Written by build-docs.js.`,
  '// Power BI Desktop → Refresh → DAX query view (left bar) → paste this → Run.',
  '// Every Difference should be 0. Expected values: expected-values.md (computed from the source files).',
  ...(stale.length ? [`// STALE: the design changed after the expected values were computed – recompute: ${stale.map((c) => c.name).join('; ')}`] : []), '',
  'EVALUATE', 'VAR Checks =', '    {',
  checks.map((c) => `        ( ${daxStr(c.name)}, ${c.dax}, ${c.expected} )`).join(',\n'),
  '    }', 'RETURN', '    SELECTCOLUMNS (', '        Checks,', '        "Check", [Value1],', '        "In Power BI", [Value2],',
  '        "Expected", [Value3],', '        "Difference", ROUND ( [Value2] - [Value3], 2 )', '    )', ''];
fs.writeFileSync(path.join(runDir, 'checks.dax'), dax.join('\n'), 'utf8');

console.log(JSON.stringify({ ok: true, cleaningLog: { sources: (B.staging || []).length, findings: nFind, kept: nKept, notKept: nFind - nKept },
  checks: { given: checks.filter((c) => !c.auto).length, auto: checks.filter((c) => c.auto).length, stale: stale.map((c) => c.name), staleQuestions },
  files: ['cleaning-log.md', 'expected-values.md', 'checks.dax'].map((f) => path.join(runDir, f)), warnings }, null, 1));
