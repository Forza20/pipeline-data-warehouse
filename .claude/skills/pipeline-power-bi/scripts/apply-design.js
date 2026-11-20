#!/usr/bin/env node
// Apply the design (step 4b), the model choices (step 5) and the extras (step 6) to choices.json from a
// declarative JSON patch – instead of a one-off script that edits choices.json by hand.
//
//   node apply-design.js runs/<run-id> <patch.json> [--dry-run]
//
// The patch (every key optional; references/build-spec.md → "Design patch" has the full format):
//   build        top-level spec keys to set: name, naming, culture, cutoffDate, measuresTable …
//   dropStaging  [staging query names] – removed; refused while a table or merge still uses one
//   tables       { "<table name in the spec>": {
//                    rename, kind, description, hidden, from,
//                    ops | prependOps | addOps   (replace / put before / put after the drafted ops)
//                    columns: [ "query column" | { name, from, type, hidden, description, format, sortBy } ]
//                  } }  – a column without `type` takes the drafted column's type; `from` defaults to `name`
//                  { "<name>": { "drop": true } } removes the table (and its relationships)
//                  { "<new name>": { "new": true, kind, from, columns, … } } adds one
//   date         replaces build.date
//   relationships  replaces build.relationships; addRelationships appends
//   measures     upsert by name. `previousMonth: "[Revenue]"` writes the previous-month DAX on the date table
//                (filter contract additive unless the base is a distinct count, ratio or average)
//   removeMeasures [names]; parameters (upsert by name); roles (replace)
//   choices      merged into the top level of choices.json (objects merge, arrays replace): glossary, design,
//                handover_notes, report_culture, currency, extras, status, dax_guide, handover_answers …
//   settleReview true – every design.review point gets status "settled" (the user confirmed them)
//
// It checks the result before writing: unknown tables, columns whose `from` the query does not have, relationship
// and date references to missing columns, duplicate names, measures a field parameter uses that do not exist.
// Exit 2 = errors, nothing written. Prints JSON { ok, changed: [...], errors, warnings }.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const runDir = args[0] && path.resolve(args[0]);
const patchFile = args[1] && path.resolve(args[1]);
const DRY = args.includes('--dry-run');
if (!runDir || !patchFile || !fs.existsSync(path.join(runDir, 'choices.json')) || !fs.existsSync(patchFile)) {
  console.error('Usage: node apply-design.js runs/<run-id> <patch.json> [--dry-run]  (needs choices.json with build – run draft-spec.js --write first)');
  process.exit(2);
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const choicesFile = path.join(runDir, 'choices.json');
const C = readJson(choicesFile);
let P;
try { P = readJson(patchFile); } catch (e) { console.log(JSON.stringify({ ok: false, errors: [`${path.basename(patchFile)} is not valid JSON: ${e.message}`] }, null, 1)); process.exit(2); }
if (!C.build) { console.error('choices.json has no build – run draft-spec.js --write first'); process.exit(2); }
const B = C.build;
const errors = []; const warnings = []; const changed = [];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const KNOWN = ['build', 'dropStaging', 'tables', 'date', 'relationships', 'addRelationships', 'measures', 'removeMeasures', 'parameters', 'roles', 'choices', 'settleReview', '_about'];
for (const k of Object.keys(P)) if (!KNOWN.includes(k)) errors.push(`patch: unknown key "${k}" (known: ${KNOWN.join(', ')})`);

// ---------- build top level ----------
if (isObj(P.build)) for (const [k, v] of Object.entries(P.build)) {
  if (['staging', 'tables', 'date', 'relationships', 'measures', 'parameters', 'roles'].includes(k)) { errors.push(`patch.build.${k}: use the patch key "${k}" instead`); continue; }
  B[k] = v; changed.push(`build.${k}`);
}

// ---------- tables ----------
B.tables = B.tables || [];
B.staging = B.staging || [];
const renames = new Map(); // old table name -> new
// the columns a table's query has before the final select: the drafted columns (by query name) + what the ops add
function queryColumns(t, drafted) {
  const set = new Set((drafted || []).map((c) => c.from || c.name));
  for (const op of t.ops || []) {
    if (op.op === 'merge') (op.columns || []).forEach((c, i) => set.add((Array.isArray(op.as) ? op.as[i] : op.as) || c));
    if (op.op === 'addColumn' || op.op === 'addKey') set.add(op.name);
    if (op.op === 'inferMembers') set.add(op.flag || 'IsInferred');
    if (op.op === 'merge' && isObj(op.with) && op.with.group) for (const a of op.with.group.aggs || []) set.add(a.name);
  }
  return set;
}
if (isObj(P.tables)) {
  for (const [name, tp] of Object.entries(P.tables)) {
    if (!isObj(tp)) { errors.push(`tables.${name}: must be an object`); continue; }
    let t = B.tables.find((x) => x.name === name);
    if (tp.drop) {
      if (!t) { errors.push(`tables.${name}: no such table to drop (tables: ${B.tables.map((x) => x.name).join(', ')})`); continue; }
      B.tables = B.tables.filter((x) => x !== t);
      renames.set(name, null); changed.push(`tables.${name}: dropped`);
      continue;
    }
    if (!t && !tp.new) { errors.push(`tables.${name}: no such table (tables: ${B.tables.map((x) => x.name).join(', ')}) – add "new": true to add one`); continue; }
    if (!t) { t = { name, kind: tp.kind || 'dimension', from: tp.from, columns: [] }; B.tables.push(t); changed.push(`tables.${name}: added`); }
    const drafted = (t.columns || []).slice();
    for (const k of ['kind', 'description', 'hidden', 'from']) if (k in tp) t[k] = tp[k];
    if (tp.ops) t.ops = tp.ops.slice();
    if (tp.prependOps) t.ops = [...tp.prependOps, ...(t.ops || [])];
    if (tp.addOps) t.ops = [...(t.ops || []), ...tp.addOps];
    if (tp.columns) {
      const have = queryColumns(t, drafted);
      const cols = [];
      for (const c of tp.columns) {
        const col = typeof c === 'string' ? { name: c } : { ...c };
        const from = col.from || col.name;
        const d = drafted.find((x) => (x.from || x.name) === from) || drafted.find((x) => x.name === from);
        if (!have.has(from) && !d) { errors.push(`tables.${name}.columns: "${from}" is not a column of the query (has: ${[...have].join(', ')})`); continue; }
        const out = { name: col.name };
        const qf = d ? d.from || d.name : from;
        if (qf !== col.name) out.from = qf;
        out.type = col.type || (d && d.type) || 'text';
        for (const k of ['hidden', 'description', 'format', 'summarize', 'sortBy']) if (k in col) out[k] = col[k]; else if (d && k in d && k !== 'description') out[k] = d[k];
        if (!col.type && !d) warnings.push(`tables.${name}.columns: "${col.name}" has no type and no drafted column – typed text`);
        cols.push(out);
      }
      const dup = cols.map((c) => c.name).filter((n, i, a) => a.indexOf(n) !== i);
      if (dup.length) errors.push(`tables.${name}.columns: duplicate names ${[...new Set(dup)].join(', ')}`);
      t.columns = cols;
    }
    if (tp.rename && tp.rename !== name) {
      if (B.tables.some((x) => x !== t && x.name === tp.rename)) errors.push(`tables.${name}.rename: "${tp.rename}" is already a table`);
      renames.set(name, tp.rename); t.name = tp.rename;
    }
    changed.push(`tables.${name}${tp.rename ? ' -> ' + tp.rename : ''}`);
  }
}
// a renamed table: follow it in tables[].from, merges, relationships, date, measures' and roles' DAX
const refTable = (ref) => { const m = /^'?(.+?)'?\[(.+)\]$/.exec(String(ref)); return m ? { table: m[1], column: m[2] } : null; };
const daxEsc = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
if (renames.size) {
  const mapRef = (ref) => { const r = refTable(ref); if (!r || !renames.has(r.table)) return ref; const n = renames.get(r.table); return n === null ? null : `${n}[${r.column}]`; };
  for (const t of B.tables) {
    if (renames.has(t.from) && renames.get(t.from)) t.from = renames.get(t.from);
    for (const op of t.ops || []) if (op.op === 'merge' && typeof op.with === 'string' && renames.get(op.with)) op.with = renames.get(op.with);
  }
  B.relationships = (B.relationships || []).map((r) => ({ ...r, from: mapRef(r.from), to: mapRef(r.to) })).filter((r) => r.from && r.to);
  if (B.date) {
    B.date.columns = (B.date.columns || []).map(mapRef).filter(Boolean);
    if (B.date.completeMonth) B.date.completeMonth = mapRef(B.date.completeMonth) || undefined;
  }
  const reDax = (s) => {
    let out = String(s);
    for (const [o, n] of renames) if (n) out = out.replace(new RegExp(`(^|[^\\w'])(${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|'${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}')\\[`, 'g'), (m, pre) => `${pre}${daxEsc(n)}[`);
    return out;
  };
  for (const m of B.measures || []) m.expr = reDax(m.expr);
  for (const r of B.roles || []) { if (renames.get(r.table)) r.table = renames.get(r.table); r.filter = reDax(r.filter); }
}

// ---------- staging ----------
for (const s of P.dropStaging || []) {
  if (!B.staging.some((x) => x.name === s)) { errors.push(`dropStaging: no staging query "${s}" (has: ${B.staging.map((x) => x.name).join(', ')})`); continue; }
  const users = B.tables.filter((t) => t.from === s || (t.ops || []).some((op) => (op.op === 'merge' && (op.with === s || (isObj(op.with) && (op.with.from === s || (op.with.group && op.with.group.from === s)))))
    || (op.op === 'inferMembers' && (op.fromColumns || []).some((r) => (refTable(r) || {}).table === s))));
  if (users.length) { errors.push(`dropStaging: ${s} is still used by ${users.map((t) => t.name).join(', ')} – drop or change those tables first`); continue; }
  B.staging = B.staging.filter((x) => x.name !== s); changed.push(`staging.${s}: dropped`);
}

// ---------- date, relationships ----------
if ('date' in P) { B.date = P.date; changed.push('date'); }
if (P.relationships) { B.relationships = P.relationships.slice(); changed.push('relationships'); }
for (const r of P.addRelationships || []) {
  if ((B.relationships || []).some((x) => x.from === r.from && x.to === r.to)) continue;
  (B.relationships = B.relationships || []).push(r); changed.push(`relationship ${r.from} -> ${r.to}`);
}

// ---------- measures, parameters, roles ----------
const SNAKE = B.naming === 'snake_case';
const dateName = (B.date && B.date.name) || (SNAKE ? 'dim_date' : 'Date');
const monthStart = /^[a-z0-9_]+$/.test(dateName) && SNAKE ? 'month_start' : 'Month start';
function previousMonth(base) {
  const d = daxEsc(dateName);
  return `VAR m = MAX ( ${d}[${monthStart}] )\nRETURN CALCULATE ( ${base}, REMOVEFILTERS ( ${d} ), ${d}[${monthStart}] = EDATE ( m, -1 ) )`;
}
B.measures = B.measures || [];
for (const n of P.removeMeasures || []) {
  if (!B.measures.some((m) => m.name === n)) { warnings.push(`removeMeasures: no measure "${n}"`); continue; }
  B.measures = B.measures.filter((m) => m.name !== n); changed.push(`measure ${n}: removed`);
}
for (const mp of P.measures || []) {
  if (!mp.name) { errors.push('measures: every measure needs a name'); continue; }
  const m = { ...mp };
  if (m.previousMonth) {
    const base = m.previousMonth; delete m.previousMonth;
    m.expr = previousMonth(base);
    const baseM = B.measures.concat(P.measures).find((x) => `[${x.name}]` === base);
    const nonAdd = baseM && /DISTINCTCOUNT|DIVIDE|AVERAGE/i.test(baseM.expr || '');
    m.filters = m.filters || { additive: !nonAdd };
    if (!m.format && baseM && baseM.format) m.format = baseM.format;
  }
  if (!m.expr) { errors.push(`measures.${m.name}: no expr (or previousMonth)`); continue; }
  const i = B.measures.findIndex((x) => x.name === m.name);
  if (i >= 0) B.measures[i] = { ...B.measures[i], ...m }; else B.measures.push(m);
  changed.push(`measure ${m.name}`);
}
if (P.parameters) for (const p of P.parameters) {
  B.parameters = B.parameters || [];
  const i = B.parameters.findIndex((x) => x.name === p.name);
  if (i >= 0) B.parameters[i] = p; else B.parameters.push(p);
  changed.push(`parameter ${p.name}`);
}
if (P.roles) { B.roles = P.roles.slice(); changed.push('roles'); }

// ---------- choices top level ----------
function merge(a, b) {
  for (const [k, v] of Object.entries(b)) a[k] = isObj(v) && isObj(a[k]) ? merge({ ...a[k] }, v) : v;
  return a;
}
if (isObj(P.choices)) {
  if ('build' in P.choices) errors.push('choices.build: use the patch keys (build, tables, measures …) instead');
  else { merge(C, P.choices); changed.push(...Object.keys(P.choices).map((k) => `choices.${k}`)); }
}
if (P.settleReview && C.design && Array.isArray(C.design.review)) {
  for (const r of C.design.review) r.status = 'settled';
  changed.push('design.review: settled');
}

// ---------- check the result ----------
const tableNames = new Set(B.tables.map((t) => t.name));
const dupT = B.tables.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupT.length) errors.push(`tables: duplicate names ${[...new Set(dupT)].join(', ')}`);
const stagingNames = new Set(B.staging.map((s) => s.name));
for (const t of B.tables) if (t.from && !stagingNames.has(t.from) && !tableNames.has(t.from)) errors.push(`tables.${t.name}.from: "${t.from}" is neither a staging query nor a table`);
const colOf = (ref) => {
  const r = refTable(ref);
  if (!r) return `"${ref}" is not Table[Column]`;
  if (B.date && r.table === dateName) return null;
  const t = B.tables.find((x) => x.name === r.table);
  if (!t) return `no table "${r.table}"`;
  if (!(t.columns || []).some((c) => c.name === r.column)) return `${r.table} has no column "${r.column}"`;
  return null;
};
for (const r of B.relationships || []) for (const side of ['from', 'to']) { const e = colOf(r[side]); if (e) errors.push(`relationship ${r.from} -> ${r.to}: ${e}`); }
if (B.date) {
  for (const c of B.date.columns || []) { const e = colOf(c); if (e) errors.push(`date.columns: ${e}`); }
  if (B.date.completeMonth) { const e = colOf(B.date.completeMonth); if (e) errors.push(`date.completeMonth: ${e}`); }
}
const dupM = B.measures.map((m) => m.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupM.length) errors.push(`measures: duplicate names ${[...new Set(dupM)].join(', ')}`);
for (const p of B.parameters || []) if (p.kind === 'fields') for (const it of p.items || []) {
  if (!B.measures.some((m) => m.name === it.measure)) errors.push(`parameters.${p.name}: measure "${it.measure}" is not in measures[]`);
}
// a measure that names a table the model does not have (a rename the patch forgot)
for (const m of B.measures) {
  for (const x of String(m.expr || '').matchAll(/(?:'((?:[^']|'')+)'|\b([A-Za-z_][A-Za-z0-9_]*))\[/g)) {
    const t = (x[1] || x[2] || '').replace(/''/g, "'");
    if (t && !tableNames.has(t) && t !== dateName && !(B.parameters || []).some((p) => p.name === t)) warnings.push(`measure ${m.name}: refers to "${t}", which is not a table in the spec`);
  }
}

const out = { ok: !errors.length, changed, errors, warnings };
if (!errors.length && !DRY) { fs.writeFileSync(choicesFile, JSON.stringify(C, null, 2)); out.written = path.relative(process.cwd(), choicesFile); }
console.log(JSON.stringify(out, null, 1));
process.exit(errors.length ? 2 : 0);
