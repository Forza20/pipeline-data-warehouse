#!/usr/bin/env node
// Proposes config.fields for the template: each template field the chosen pages use → the model's
// best match by name (templates/<key>/field-hints.json), else the fallback, else null with the measures.md
// recipe that makes it. A starting point – check the values, the meanings and the decisions it lists.
//
//   node suggest-fields.js "<Name.SemanticModel>" [--template adventureworks] [--pages exec,map,…] [--config <config.json>]
//
// --config: merge into that config (its own non-empty mappings win) and write it back.
// A template with a data contract (business): proposes config.contract instead (contract.json → names).
// Prints JSON { fields, how: { field: "name" | "fallback" | "make: <recipe>" | "none" }, decisions: [...], make: [...] }.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sm = args[0];
if (!sm || sm.startsWith('--')) { console.error('Usage: node suggest-fields.js <Name.SemanticModel> [--template key] [--pages a,b] [--config config.json]'); process.exit(2); }
const cfgPath = opt('--config');
const cfg = cfgPath && fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')) : null;
const key = opt('--template') || (cfg && cfg.template) || 'adventureworks';
const TPL = path.join(__dirname, '..', 'templates', key);
const T = JSON.parse(fs.readFileSync(path.join(TPL, 'template.json'), 'utf8'));
const H = fs.existsSync(path.join(TPL, 'field-hints.json')) ? JSON.parse(fs.readFileSync(path.join(TPL, 'field-hints.json'), 'utf8')) : {};
const pages = (opt('--pages') ? opt('--pages').split(',') : cfg && cfg.pages) || T.pages.map((p) => p.key);

// ---------- the model (TMDL) ----------
const unq = (s) => { s = s.trim(); if (s.startsWith("'")) { const e = s.indexOf("'", 1); let i = 1; let out = ''; while (i < s.length) { if (s[i] === "'") { if (s[i + 1] === "'") { out += "'"; i += 2; continue; } break; } out += s[i]; i++; } return out; } return s.split(/[\s=]/)[0]; };
const model = []; // { table, isDate, columns: [], measures: [] }
const tdir = path.join(sm, 'definition', 'tables');
for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.tmdl'))) {
  let t = null;
  for (const line of fs.readFileSync(path.join(tdir, f), 'utf8').split(/\r?\n/)) {
    let m = line.match(/^table\s+(.+)$/);
    if (m) { t = { table: unq(m[1]), isDate: false, columns: [], measures: [] }; model.push(t); continue; }
    if (!t) continue;
    if (/^\tdataCategory:\s*Time/.test(line)) t.isDate = true;
    m = line.match(/^\t(column|measure)\s+('(?:[^']|'')+'|[^\s=]+)/);
    if (m) t[m[1] === 'column' ? 'columns' : 'measures'].push(unq(m[2]));
  }
}
// no table marked as date table: the one named like a calendar
if (!model.some((t) => t.isDate)) { const c = model.find((t) => /calendar|^date|_date$|dim_?date|dato|kalender/i.test(t.table)); if (c) c.isDate = true; }
const norm = (s) => String(s).toLowerCase().replace(/[æ]/g, 'ae').replace(/[ø]/g, 'oe').replace(/[å]/g, 'aa').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const ref = (t, n) => `${t}[${n}]`;

function find(hint, kind, patterns) {
  for (const p of patterns || []) {
    const re = new RegExp(p);
    for (const t of model) {
      if (kind === 'measure') { const m = t.measures.find((x) => re.test(norm(x))); if (m) return ref(t.table, m); continue; }
      if (hint.table === 'date' ? !t.isDate : hint.table && !new RegExp(hint.table).test(norm(t.table))) continue;
      const c = t.columns.find((x) => re.test(norm(x)));
      if (c) return ref(t.table, c);
    }
  }
  return null;
}

// a template with a data contract (templates/<key>/contract.json, e.g. business): the model's columns are
// mapped to the contract (config.contract); gen-measures.js then makes the measures and config.fields
const CONTRACT = path.join(TPL, 'contract.json');
if (fs.existsSync(CONTRACT)) {
  const K = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')).columns;
  const MODS = fs.existsSync(path.join(TPL, 'modules.json')) ? JSON.parse(fs.readFileSync(path.join(TPL, 'modules.json'), 'utf8')) : { modules: {} };
  const mods = new Set(Object.entries(MODS.modules).filter(([, d]) => d.pages.some((p) => pages.includes(p))).map(([m]) => m));
  const contract = {}; const chow = {}; const missing = [];
  for (const [k, c] of Object.entries(K)) {
    if (c.module !== 'shared' && !mods.has(c.module)) continue;
    if (c.make) { chow[k] = 'made by gen-measures.js'; continue; }
    const own = cfg && cfg.contract && cfg.contract[k];
    if (own) { contract[k] = own; chow[k] = 'config'; continue; }
    const r = find(c, 'column', c.names);
    contract[k] = r; chow[k] = r ? 'name' : c.derive ? `none – derive: ${c.derive}` : 'none';
    if (!r && c.required) missing.push(k);
  }
  const out = { template: key, pages, modules: [...mods], contract, how: chow, requiredMissing: missing,
    next: [
      missing.length ? `Required and not found: ${missing.join(', ')} – map them, or leave the module out.` : null,
      'Check each mapping (meaning, values: contract.json → values; config.values when the model spells them differently), then: node gen-measures.js <config.json> --write-config [--spec choices.json | --tmdl Name.SemanticModel].',
    ].filter(Boolean) };
  if (cfgPath) {
    fs.writeFileSync(cfgPath, JSON.stringify({ ...(cfg || {}), template: key, pages, contract: { ...((cfg && cfg.contract) || {}), ...contract } }, null, 1) + '\n');
    out.written = cfgPath;
  }
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

const fields = {}; const how = {}; const decisions = []; const make = new Set();
for (const [tf, f] of Object.entries(T.fields)) {
  if (!f.pages.some((p) => pages.includes(p))) continue;
  const own = cfg && cfg.fields && cfg.fields[tf];
  if (own) { fields[tf] = own; how[tf] = 'config'; continue; }
  const hint = H[tf] || {};
  const kind = f.kind === 'Measure' ? 'measure' : 'column';
  let r = find(hint, kind, hint.names);
  if (r) { fields[tf] = r; how[tf] = 'name'; continue; }
  r = find(hint, kind, hint.fallback);
  if (r) { fields[tf] = r; how[tf] = 'fallback'; if (hint.decision) decisions.push({ field: tf, mapped: r, note: hint.decision }); continue; }
  fields[tf] = null;
  if (hint.make) { how[tf] = `make: ${hint.make}`; make.add(hint.make); } else how[tf] = 'none';
}
// the month KPI cards are filtered to complete months (gen-report.js → completeMonth)
const completeMonth = (cfg && cfg.completeMonth) || find({ table: 'date' }, 'column', ['complete_month|is_complete|hel_?maaned|fuld_?maaned|komplet']);
const out = { template: key, pages, fields, how, decisions, make: [...make], completeMonth,
  next: [
    make.size ? `Create with measures.md (${[...make].join(', ')}), then run this again.` : null,
    decisions.length ? 'Ask the decisions (SKILL.md step 7) – a fallback changed the meaning.' : null,
    completeMonth ? null : 'No complete-month column in the date table: the month KPI cards can end in an empty month – add a true/false column (e.g. is_complete_month) or accept the warning.',
    Object.values(how).includes('none') ? 'Fields with "none": pick a model field yourself or keep null (ask the user when it removes a visual).' : null,
  ].filter(Boolean) };
if (cfgPath) {
  const merged = { ...(cfg || { template: key }), pages, fields, ...(completeMonth ? { completeMonth } : {}) };
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 1) + '\n');
  out.written = cfgPath;
}
console.log(JSON.stringify(out, null, 1));
