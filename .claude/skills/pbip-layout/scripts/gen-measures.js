#!/usr/bin/env node
// Writes the measures of a template with a data contract (templates/<key>/contract.json + measures/*.tmdl,
// e.g. the business template) for the model's own tables, and the template fields they become.
//
//   node gen-measures.js "<config.json>" [--spec <runs/<id>/choices.json>] [--tmdl <Name.SemanticModel>] [--write-config]
//
// config.json (SKILL.md):
//   template       "business"
//   pages          the chosen pages – only the measures of the chosen modules are made
//   contract       { "<contract column>": "Table[Column]" | null } – contract.json → columns
//   values         { "<contract column>": { "<template value>": "<model value>" } }, e.g.
//                  { "Fact_Opportunity[Stage]": { "Closed Won": "Won", "Closed Lost": "Lost" } }
//   currencyFormat format string for amounts (default the template's "\$#,0"), e.g. "#,0 \"kr.\""
//   naming         "snake_case" (default with --spec: mqls_yoy_pct) or "template" (MQLs YoY %)
//   measureTable   the table the measures go in (default "_measures" with --spec, "_layout_measures" with --tmdl)
//
// A measure is made when every contract column it uses is mapped and every measure it uses is made; PY,
// YoY %, YoY pp, YoY Status and YoY Colour follow their base measure. The rest is listed in `skipped` with
// the reason, and its template field becomes null (gen-report.js leaves its visuals out).
//
// --spec: a pipeline-power-bi run – the measures go to choices.json → build.measures[] (folder as in the
//   template, filter contract on the PY measures) and the funnel stages to build.parameters[] (kind "list");
//   earlier measures from this script are replaced. Then run rebuild.js. Never written by hand in TMDL there.
// --tmdl: another project, Power BI Desktop closed – writes tables/<measureTable>.tmdl (+ the funnel stage
//   table) and adds them to model.tmdl.
// --write-config: config.fields gets every template field the chosen pages use (measures + contract columns);
//   the config's own non-null fields win.
// Without --spec/--tmdl nothing is written to the model: it prints what would be made.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const cfgPath = args[0];
if (!cfgPath || cfgPath.startsWith('--')) { console.error('Usage: node gen-measures.js <config.json> [--spec choices.json] [--tmdl Name.SemanticModel] [--write-config]'); process.exit(2); }
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const cfg = readJ(cfgPath);
const SPEC = opt('--spec'); const TMDL = opt('--tmdl'); const WRITE_CFG = args.includes('--write-config');
const key = cfg.template || 'business';
const TPL = path.join(__dirname, '..', 'templates', key);
if (!fs.existsSync(path.join(TPL, 'contract.json'))) { console.error(`template "${key}" has no data contract (templates/${key}/contract.json)`); process.exit(2); }
const T = readJ(path.join(TPL, 'template.json'));
const K = readJ(path.join(TPL, 'contract.json')).columns;
const MODS = fs.existsSync(path.join(TPL, 'modules.json')) ? readJ(path.join(TPL, 'modules.json')) : { modules: {} };
const errors = []; const warnings = [];

// ---------- modules ----------
const pages = (cfg.pages || []).filter((p) => T.pages.some((x) => x.key === p));
const chosenModules = new Set(Object.entries(MODS.modules).filter(([, d]) => d.pages.some((p) => pages.includes(p))).map(([m]) => m));
if (!chosenModules.size) errors.push('config.pages: no module page chosen (marketing, sales, finance)');
const tableModules = (t) => (MODS.tableModules && MODS.tableModules[t]) || Object.entries(MODS.modules).filter(([, d]) => (d.tables || []).includes(t)).map(([m]) => m);

// ---------- the contract mapping ----------
const parseRef = (r) => { const m = /^'?(.+?)'?\[(.+)\]$/.exec(String(r)); return m ? { table: m[1], name: m[2] } : null; };
const contract = {};
for (const [k, v] of Object.entries(cfg.contract || {})) {
  if (!(k in K)) { warnings.push(`config.contract: "${k}" is not a contract column (contract.json)`); continue; }
  if (v === null) { contract[k] = null; continue; }
  const r = parseRef(v);
  if (!r) errors.push(`config.contract["${k}"]: "${v}" – use Table[Column]`); else contract[k] = r;
}
for (const [k, c] of Object.entries(K)) {
  if (!c.required) continue;
  const mods = c.module === 'shared' ? [] : [c.module];
  if (mods.every((m) => chosenModules.has(m)) && !contract[k]) errors.push(`config.contract: "${k}" is required (${c.use}) – map it to Table[Column]`);
}
if (errors.length) { console.log(JSON.stringify({ ok: false, errors, warnings }, null, 1)); process.exit(2); }
// a template table → the model table most of its mapped contract columns went to
const votes = {};
for (const [k, r] of Object.entries(contract)) { if (!r) continue; const t = k.slice(0, k.indexOf('[')); (votes[t] = votes[t] || {})[r.table] = (votes[t][r.table] || 0) + 1; }
const tableMap = Object.fromEntries(Object.entries(votes).map(([t, v]) => [t, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));

// ---------- template measures ----------
const unq = (s) => (s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s);
const tm = []; // { table, name, expr, format, folder }
for (const f of fs.readdirSync(path.join(TPL, 'measures')).filter((x) => x.endsWith('.tmdl'))) {
  let table = null; let cur = null;
  for (const line of fs.readFileSync(path.join(TPL, 'measures', f), 'utf8').split(/\r?\n/)) {
    let m = line.match(/^table\s+(.+)$/);
    if (m) { table = unq(m[1].trim()); continue; }
    m = line.match(/^\tmeasure\s+('(?:[^']|'')+'|[^\s=]+)\s*=\s*(.*)$/);
    if (m) { cur = { table, name: unq(m[1]), expr: m[2].trim(), format: null, folder: null }; tm.push(cur); continue; }
    if (/^\t\S/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    if ((m = line.match(/^\t\tformatString:\s*(.*)$/))) { cur.format = m[1]; continue; }
    if ((m = line.match(/^\t\tdisplayFolder:\s*(.*)$/))) { cur.folder = m[1]; continue; }
    if (/^\t\t\t/.test(line)) cur.expr += (cur.expr ? '\n' : '') + line.slice(3);
  }
}
const byName = Object.fromEntries(tm.map((m) => [m.name, m]));
const colRe = /('(?:[^']|'')+'|\b[A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]/g;
const measRe = /(^|[^A-Za-z0-9_'\]])\[([^\]]+)\]/g;
const contractTables = [...new Set(Object.keys(K).map((k) => k.slice(0, k.indexOf('['))))];
const tblRe = new RegExp(`\\b(${contractTables.join('|')})\\b(?!\\s*\\[)`, 'g');
for (const m of tm) {
  m.cols = [...new Set([...m.expr.matchAll(colRe)].map((x) => `${unq(x[1])}[${x[2]}]`))];
  m.uses = [...new Set([...m.expr.matchAll(measRe)].map((x) => x[2]).filter((n) => byName[n]))];
  m.base = (/^(.*) (PY|YoY %|YoY pp|YoY Status|YoY Colour)$/.exec(m.name) || [])[1];
  m.modules = tableModules(m.table);
}

// ---------- names ----------
const naming = cfg.naming || (SPEC ? 'snake_case' : 'template');
const snake = (n) => String(n).replace(/YoY/g, ' yoy ').replace(/\bPY\b/g, ' py ').replace(/%/g, ' pct ').replace(/&/g, ' and ')
  .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const MT = cfg.measureTable || (SPEC ? '_measures' : '_layout_measures');
// existing measure names (never overwritten): the spec's other measures, or the model's measures
let spec = null; const existing = new Set();
if (SPEC) {
  spec = readJ(SPEC);
  if (!spec.build) { console.error(`${SPEC}: no build spec`); process.exit(2); }
  for (const m of spec.build.measures || []) if (m.origin !== `pbip-layout:${key}`) existing.add(m.name.toLowerCase());
} else if (TMDL) {
  const td = path.join(TMDL, 'definition', 'tables');
  for (const f of fs.readdirSync(td).filter((x) => x.endsWith('.tmdl') && x !== `${MT}.tmdl`)) {
    for (const mm of fs.readFileSync(path.join(td, f), 'utf8').matchAll(/^\tmeasure\s+('(?:[^']|'')+'|[^\s=]+)/gm)) existing.add(unq(mm[1]).toLowerCase());
  }
}
const newName = {};
for (const m of tm) {
  let n = naming === 'snake_case' ? snake(m.name) : m.name;
  if (existing.has(n.toLowerCase())) { const mod = m.modules[0] || 'layout'; n = naming === 'snake_case' ? `${mod}_${n}` : `${n} (${MODS.modules[mod] ? MODS.modules[mod].label : mod})`; }
  newName[m.name] = n;
}

// ---------- the funnel stages (a list the model rarely has) ----------
const FUNNEL = 'Dim_FunnelStage[Stage]';
let funnel = null;
if (chosenModules.has('marketing') && !contract[FUNNEL]) {
  const fn = naming === 'snake_case' ? 'funnel_stage' : 'Funnel stage';
  funnel = { name: fn, column: fn, order: naming === 'snake_case' ? `${fn}_order` : `${fn} Order`, items: ['Leads', 'MQLs', 'SQLs', 'Conversions'] };
  contract[FUNNEL] = { table: fn, name: fn };
  tableMap.Dim_FunnelStage = fn;
}

// ---------- decide and rewrite ----------
const made = new Map(); const skipped = [];
const q = (t) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) ? t : `'${t.replace(/'/g, "''")}'`);
function decide(m, seen = new Set()) {
  if (made.has(m.name)) return true;
  if (m.skip) return false;
  if (seen.has(m.name)) return false;
  seen.add(m.name);
  const no = (why) => { m.skip = why; skipped.push({ measure: m.name, because: why }); return false; };
  if (!m.modules.every((x) => chosenModules.has(x))) { m.skip = 'module not chosen'; return false; }
  if (m.base && byName[m.base] && !decide(byName[m.base], seen)) return no(`its base measure ${m.base} is not made`);
  const missing = m.cols.filter((c) => !contract[c]);
  if (missing.length) return no(`needs ${missing.join(', ')}`);
  for (const u of m.uses) if (!decide(byName[u], seen)) return no(`uses ${u}, which is not made`);
  made.set(m.name, rewriteMeasure(m));
  return true;
}
const CUR = cfg.currencyFormat || null;
function rewriteMeasure(m) {
  let e = m.expr;
  // string values the model spells differently
  for (const c of m.cols) for (const [a, b] of Object.entries((cfg.values || {})[c] || {})) e = e.split(JSON.stringify(a)).join(JSON.stringify(String(b)));
  e = e.replace(colRe, (all, t, c) => { const k = `${unq(t)}[${c}]`; const r = contract[k]; return r ? `${q(r.table)}[${r.name}]` : all; });
  e = e.replace(tblRe, (all, t) => (tableMap[t] ? q(tableMap[t]) : all));
  e = e.replace(measRe, (all, pre, n) => (byName[n] ? `${pre}[${newName[n]}]` : all));
  // RELATED on a column of the iterated table itself (the model has the account type on the ledger)
  e = e.replace(/SUMX\s*\(\s*('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_]*)\s*,([\s\S]*)\)\s*$/, (all, t, body) => `SUMX ( ${t},${body.replace(new RegExp(`RELATED\\s*\\(\\s*(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[[^\\]]+\\])\\s*\\)`, 'g'), '$1')})`);
  let format = m.format;
  if (CUR && format && /\\\$/.test(format)) format = CUR;
  const out = { name: newName[m.name], expr: e, ...(format ? { format } : {}), folder: m.folder || 'Template', template: `${m.table}[${m.name}]` };
  const year = contract['Dim_Date[Year]'];
  if (/REMOVEFILTERS|SAMEPERIODLASTYEAR|DATEADD/.test(e) && year) out.filters = { keep: [`${year.table}[${year.name}]`] };
  return out;
}
for (const m of tm) decide(m);
const measures = tm.filter((m) => made.has(m.name)).map((m) => made.get(m.name));
if (funnel && !made.has('Funnel value')) funnel = null; // nothing shows the stages

// ---------- template fields ----------
const needed = Object.entries(T.fields).filter(([, f]) => f.pages.some((p) => pages.includes(p))).map(([k]) => k);
const fields = {};
for (const k of needed) {
  const t = k.slice(0, k.indexOf('[')); const n = k.slice(k.indexOf('[') + 1, -1);
  if (tableModules(t).some((m) => !chosenModules.has(m)) || (K[k] && K[k].module !== 'shared' && !chosenModules.has(K[k].module))) continue; // gen-report.js leaves it out
  if (byName[n] && byName[n].table === t) fields[k] = made.has(n) ? `${MT}[${newName[n]}]` : null;
  else if (k in K) fields[k] = contract[k] ? `${contract[k].table}[${contract[k].name}]` : null;
  else { fields[k] = null; warnings.push(`${k}: neither a template measure nor a contract column`); }
}

// ---------- write ----------
const written = [];
const g = () => crypto.randomUUID();
if (SPEC) {
  const B = spec.build;
  B.measures = (B.measures || []).filter((m) => m.origin !== `pbip-layout:${key}`)
    .concat(measures.map(({ template, ...m }) => ({ ...m, origin: `pbip-layout:${key}`, description: `${template.replace(/^_\w+\[|\]$/g, '')} – from the ${key} report template (pbip-layout).` })));
  B.parameters = (B.parameters || []).filter((p) => p.origin !== `pbip-layout:${key}`);
  if (funnel) B.parameters.push({ kind: 'list', name: funnel.name, items: funnel.items, origin: `pbip-layout:${key}`, description: 'The stages of the marketing funnel, in order (Leads, MQLs, SQLs, Conversions); the funnel visual on Campaign Detail.' });
  fs.writeFileSync(SPEC, JSON.stringify(spec, null, 2) + '\n');
  written.push(SPEC);
}
if (TMDL) {
  const def = path.join(TMDL, 'definition');
  const tabs = path.join(def, 'tables');
  if (!fs.existsSync(tabs)) { console.error(`not a TMDL semantic model: ${tabs}`); process.exit(2); }
  const ind = (x) => (x.includes('\n') ? '\n' + x.split('\n').map((l) => '\t\t\t' + l).join('\n') : x);
  let s = `/// Measures of the ${key} report template (pbip-layout gen-measures.js). Made again by the script – change the contract, not this file.\ntable ${q(MT)}\n\tlineageTag: ${g()}\n\n`;
  for (const m of measures) s += `\tmeasure ${q(m.name)} = ${ind(m.expr)}\n${m.format ? `\t\tformatString: ${m.format}\n` : ''}\t\tdisplayFolder: ${m.folder}\n\t\tlineageTag: ${g()}\n\n`;
  s += `\tcolumn Placeholder\n\t\tisHidden\n\t\tlineageTag: ${g()}\n\t\tsummarizeBy: none\n\t\tisNameInferred\n\t\tsourceColumn: [Placeholder]\n\n\tpartition ${q(MT)} = calculated\n\t\tmode: import\n\t\tsource = ROW ( "Placeholder", BLANK () )\n`;
  fs.writeFileSync(path.join(tabs, `${MT}.tmdl`), s); written.push(path.join(tabs, `${MT}.tmdl`));
  const refs = [MT];
  if (funnel) {
    const rows = funnel.items.map((x, i) => `\t\t\t\t    ( ${JSON.stringify(x)}, ${i + 1} )`).join(',\n');
    const f = `/// The stages of the marketing funnel, in order; the funnel visual on Campaign Detail.\ntable ${q(funnel.name)}\n\tlineageTag: ${g()}\n\n` +
      `\tcolumn ${q(funnel.column)}\n\t\tdataType: string\n\t\tlineageTag: ${g()}\n\t\tsummarizeBy: none\n\t\tsourceColumn: [Value1]\n\t\tsortByColumn: ${q(funnel.order)}\n\n` +
      `\tcolumn ${q(funnel.order)}\n\t\tdataType: int64\n\t\tisHidden\n\t\tformatString: 0\n\t\tlineageTag: ${g()}\n\t\tsummarizeBy: none\n\t\tsourceColumn: [Value2]\n\n` +
      `\tpartition ${q(funnel.name)} = calculated\n\t\tmode: import\n\t\tsource =\n\t\t\t\t{\n${rows}\n\t\t\t\t}\n`;
    fs.writeFileSync(path.join(tabs, `${funnel.name}.tmdl`), f); written.push(path.join(tabs, `${funnel.name}.tmdl`)); refs.push(funnel.name);
  }
  const mf = path.join(def, 'model.tmdl');
  let model = fs.readFileSync(mf, 'utf8');
  for (const r of refs) if (!new RegExp(`^ref table ${q(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(model)) model = model.replace(/\s*$/, `\nref table ${q(r)}\n`);
  fs.writeFileSync(mf, model); written.push(mf);
}
if (WRITE_CFG) {
  const own = cfg.fields || {};
  cfg.fields = { ...fields, ...Object.fromEntries(Object.entries(own).filter(([, v]) => v !== null)) };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1) + '\n');
  written.push(cfgPath);
}
console.log(JSON.stringify({ ok: true, template: key, modules: [...chosenModules], measureTable: MT, naming,
  made: measures.length, skipped: skipped.filter((x) => x.because !== 'module not chosen'),
  funnel: funnel ? `${funnel.name} (${funnel.items.join(', ')})` : null,
  fieldsNull: Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k),
  written, warnings,
  next: [
    SPEC ? `Run rebuild.js for the run, then gen-report.js with the config.` : TMDL ? 'Open the model (Desktop) and check the KPI cards; then gen-report.js with the config.' : 'Dry run: add --spec (pipeline-power-bi run) or --tmdl (other project) to write the measures.',
    WRITE_CFG ? null : 'Add --write-config to put the template fields into config.json.',
  ].filter(Boolean) }, null, 1));
