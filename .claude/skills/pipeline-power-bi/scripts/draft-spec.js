#!/usr/bin/env node
// Draft the build spec from the profile: every recommended finding at its default variant, one loaded
// table per source ("one table per sheet"), the profile's preferred relationships and a date table.
//
//   node draft-spec.js runs/<run-id> [--write] [--name <Name>] [--tables a,b]
//
// It is the mechanical part of "Accept all recommended" (step 4, fast mode): a starting point the design
// (step 4b) then reshapes. Every recommended finding ends up in one of three places, never silently dropped:
//   steps     – a staging step (build-spec.md), or an op/column setting of the loaded table
//   model     – handled by the model, not a step (F02 names, F21 append, F22 left out, F26 hidden, M01 date)
//   skipped   – needs something the profile does not hold (F28 code names, F07 spellings …), with the reason
// Prints JSON { ok, staging, tables, relationships, steps, model[], skipped[] }. With --write it merges the
// spec into choices.json → build (other keys are kept). Without choices.json it writes a new one.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const runDir = path.resolve(args[0] || '');
const opt = (f) => { const i = args.indexOf(f); return i > 0 ? args[i + 1] : null; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
if (!args[0] || !fs.existsSync(path.join(runDir, 'profile.json'))) { console.error('Usage: node draft-spec.js runs/<run-id> [--write] [--name <Name>]'); process.exit(2); }
const P = readJson(path.join(runDir, 'profile.json'));
const choicesFile = path.join(runDir, 'choices.json');
const choices = fs.existsSync(choicesFile) ? readJson(choicesFile) : {};
const only = opt('--tables') ? opt('--tables').split(',') : null;

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 't';
const included = (t) => !t.isEmpty && (!only || only.includes(t.name)) &&
  (!choices.tables || !choices.tables[t.name] || choices.tables[t.name].include !== false);
const rec = (t) => (t.findings || []).filter((f) => f.recommended);
const F17_TYPE = { id: 'text', text: 'text', category: 'text', date: 'date', integer: 'int', decimal: 'number', bool: 'bool', empty: 'text' };
const ORDER = ['F20', 'F03', 'F04', 'F27', 'F19', 'F25', 'F23', 'F24', 'F05', 'F06', 'F07', 'F11', 'F08', 'F09', 'F10', 'F12', 'F13', 'F15', 'F14', 'F16', 'F17'];
const MODEL = { F01: 'source steps (header row)', F02: 'column names in the loaded table', F21: 'staging append', F22: 'copy left out',
  F26: 'column hidden in the loaded table', M01: 'date table: complete-month flag', F18: 'inferMembers op on the dimension',
  F29: 'design choice (step 4b): primary rows when merged', M02: 'design choice (step 4b): a new dimension' };

const tables = (P.tables || []).filter(included);
const byName = new Map(tables.map((t) => [t.name, t]));
const model = [];
const skipped = [];
const note = (list, t, f, reason) => list.push({ table: t.name, fix: f.fix, column: f.column || null, reason });

// F21: groups of same-layout tables, appended into the first; F22: copies left out
const parent = new Map();
const root = (n) => (parent.has(n) && parent.get(n) !== n ? root(parent.get(n)) : n);
const leftOut = new Set();
for (const t of tables) {
  for (const f of rec(t)) {
    if (f.fix === 'F21' && byName.has(f.variant)) { const a = root(t.name); const b = root(f.variant); if (a !== b) parent.set(b, a); note(model, t, f, `${MODEL.F21} with ${f.variant}`); }
    if (f.fix === 'F22' && byName.has(f.variant)) { leftOut.add(t.name); note(model, t, f, `${MODEL.F22} (copy of ${f.variant})`); }
  }
}
const groups = new Map();
for (const t of tables) { if (leftOut.has(t.name)) continue; const r = root(t.name); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }

const codePage = (enc) => (/1252|ANSI|Western/i.test(enc || '') ? 1252 : /UTF-16|Unicode/i.test(enc || '') ? 1200 : 65001);
const kindOf = (t, c) => ((t.columns || []).find((x) => x.name === c) || {}).kind;
// "CUST-9999" -> prefix CUST, separator -, digits 4; "K999" -> K, '', 3; plain numbers ("N", "9999") have no target format
function idFormat(v) {
  const m = /^([A-Za-z]+)([-_ /.]?)(9+)$/.exec(String(v || ''));
  return m ? { prefix: m[1], separator: m[2], digits: m[3].length } : null;
}

const staging = [];
const loaded = [];
const finalCols = new Map(); // profile table name -> { stg, table, cols: [{name, type, hidden}] }
for (const [rootName, members] of groups) {
  const t = byName.get(rootName);
  const stgName = 'stg_' + slug(t.name);
  const src = { name: stgName, file: path.basename(t.file || ''), kind: t.kind };
  if (t.kind === 'csv') Object.assign(src, { delimiter: t.delimiter === '\t' ? 'tab' : (t.delimiter || ','), codePage: codePage(t.encoding), headerRow: t.headerRow || 1 });
  else if (t.kind === 'sheet') Object.assign(src, { item: t.sheet, header: (t.headerCells || [])[0] || (t.columns[0] || {}).name });
  else src.item = t.excelTable;
  src.columns = t.columns.map((c) => c.name);
  let cols = src.columns.slice();
  const types = {};
  for (const c of t.columns) types[c.name] = F17_TYPE[c.kind] || 'text';
  if (members.length > 1) {
    src.append = members.slice(1).map((m) => (t.kind === 'csv' ? { file: path.basename(m.file || '') } : { item: m.kind === 'excel table' ? m.excelTable : m.sheet, kind: m.kind, header: (m.headerCells || [])[0], columns: m.columns.map((c) => c.name) }));
    for (const m of members.slice(1)) for (const c of m.columns) { if (!cols.includes(c.name)) { cols.push(c.name); types[c.name] = F17_TYPE[c.kind] || 'text'; } }
    src.sourceColumn = t.kind === 'csv' ? 'SourceFile' : 'SourceSheet';
    cols.push(src.sourceColumn); types[src.sourceColumn] = 'text';
  }
  const all = members.flatMap((m) => rec(m).map((f) => ({ ...f, _t: m })));
  const steps = [];
  const added = [];
  const hidden = new Set();
  const once = new Set();
  const sorted = all.slice().sort((a, b) => ORDER.indexOf(a.fix) - ORDER.indexOf(b.fix));
  for (const f of sorted) {
    const c = f.column;
    const key = `${f.fix}|${c || ''}`;
    if (once.has(key) && !['F14', 'F15'].includes(f.fix)) continue;
    once.add(key);
    switch (f.fix) {
      case 'F20':
        if (t.kind !== 'csv') { note(skipped, f._t, f, 'F20 applies to CSV files only'); break; }
        steps.push({ fix: 'F20', column: src.columns[src.columns.length - 1] }); added.push('Row check'); types['Row check'] = 'text'; break;
      case 'F03': case 'F04': case 'F12': steps.push({ fix: f.fix }); break;
      case 'F27':
        if (!c || !(f.examples || []).length) { note(skipped, f._t, f, 'the profile names the test rows but not their key column and values – ask which rows (step 4)'); break; }
        steps.push({ fix: 'F27', column: c, values: f.examples }); break;
      case 'F19': case 'F25': steps.push({ fix: f.fix, columns: [c] }); cols = cols.filter((x) => x !== c); delete types[c]; break;
      case 'F23': {
        const v = f.variant || {};
        if (!v.separator || !(v.names || []).length) { note(skipped, f._t, f, 'no separator or part names in the profile'); break; }
        steps.push({ fix: 'F23', column: c, separator: v.separator, names: v.names });
        const i = cols.indexOf(c); cols.splice(i, 1, ...v.names); delete types[c]; for (const n of v.names) types[n] = 'text'; break;
      }
      case 'F24': steps.push({ fix: 'F24', column: c }); break;
      case 'F05': steps.push({ fix: 'F05', columns: [c] }); break;
      case 'F06': steps.push({ fix: 'F06', columns: [c], tokens: (f.examples || []).length ? f.examples : undefined }); break;
      case 'F07': note(skipped, f._t, f, 'the profile shows the case variants but not which spelling is most common – choose the spelling (step 4)'); break;
      case 'F11': {
        const fmt = idFormat(f.variant);
        if (!fmt) { note(skipped, f._t, f, `target format "${f.variant}" is plain numbers – the odd ids need a decision (step 4)`); break; }
        steps.push({ fix: 'F11', column: c, ...fmt }); types[c] = 'text'; break;
      }
      case 'F08': steps.push({ fix: 'F08', column: c, dayFirst: f.variant !== 'month-first' }); types[c] = 'date'; break;
      case 'F09': steps.push({ fix: 'F09', column: c }); types[c] = 'number'; break;
      case 'F10': steps.push({ fix: 'F10', column: c }); types[c] = 'bool'; break;
      case 'F13': steps.push({ fix: 'F13', column: c }); break;
      case 'F15': if (!once.has(`F15done|${c}`)) { once.add(`F15done|${c}`); steps.push({ fix: 'F15', column: c }); added.push(`${c} status`); types[`${c} status`] = 'text'; } break;
      case 'F14': {
        let s = steps.find((x) => x.fix === 'F14' && x.column === c);
        if (!s) { s = { fix: 'F14', column: c, checks: [] }; steps.push(s); added.push(`${c} issue`); types[`${c} issue`] = 'text'; if (types[c] !== 'number' && types[c] !== 'int') types[c] = 'number'; }
        if (/negative/i.test(f.detail)) s.checks.push('negative');
        else if (/above/i.test(f.detail)) {
          const m = /\(([\d.,]+)\)/.exec(f.detail);
          const limit = typeof f.limit === 'number' ? f.limit : m && /^\d+(\.\d+)?$/.test(m[1]) ? 10 * Number(m[1]) : null;
          if (limit === null) { note(skipped, f._t, f, 'spike limit not readable in the profile – profile again with the current Profile-Sources.ps1'); break; }
          s.checks.push('spike'); s.spike = Math.round(limit * 100) / 100;
        } else if (/zero/i.test(f.detail)) s.checks.push('zero');
        break;
      }
      case 'F16': {
        const months = String(c).split(/,\s*/);
        const keep = cols.filter((x) => !months.includes(x));
        const year = keep.find((k) => /year|^år$|^aar$|^yr$/i.test(k));
        const monthNames = months.every((m) => /^[a-zæøå]{3}/i.test(m) && !/^\d/.test(m));
        steps.push({ fix: 'F16', keep, attribute: 'Period', value: 'Value', period: monthNames ? 'monthName' : 'yyyy-MM', ...(monthNames && year ? { year } : {}) });
        cols = [...keep, 'Period', 'Value'];
        for (const m of months) delete types[m];
        types.Period = monthNames ? 'text' : 'date'; types.Value = 'number';
        if (monthNames && year) { cols.push('Period start'); types['Period start'] = 'date'; }
        break;
      }
      case 'F17': break; // written last, from the final types
      case 'F28': note(skipped, f._t, f, 'code names are known only by the user – kept as codes (ask in step 4)'); break;
      case 'F26': hidden.add(c); note(model, f._t, f, MODEL.F26); break;
      case 'F18': case 'M01': case 'F21': case 'F22': break; // placed after the loop (inferMembers, date table) or above (append, left out)
      default: if (MODEL[f.fix] && f.fix !== 'F21' && f.fix !== 'F22') note(model, f._t, f, MODEL[f.fix]);
        else if (!MODEL[f.fix]) note(skipped, f._t, f, 'no drafting rule for this fix'); break;
    }
  }
  cols.push(...added.filter((a) => !cols.includes(a)));
  const fTypes = {};
  for (const c of cols) if (types[c] && !added.includes(c) && c !== 'Period start') fTypes[c] = types[c] === 'bool' ? 'bool' : types[c];
  steps.push({ fix: 'F17', types: fTypes });
  src.steps = steps;
  staging.push(src);
  const tableName = slug(t.name);
  finalCols.set(t.name, { stg: stgName, table: tableName, cols: cols.map((c) => ({ name: c, type: types[c] || 'text', hidden: hidden.has(c) })) });
  for (const m of members.slice(1)) finalCols.set(m.name, finalCols.get(t.name));
}

// roles: a table other tables point at is a dimension
const rels = (P.relations || []).filter((r) => r.preferred);
const split = (ref) => { const m = /^(.*)\[(.*)\]$/.exec(ref); return m ? { table: m[1], column: m[2] } : null; };
const pointedAt = new Set(rels.map((r) => (split(r.to) || {}).table));
for (const [name, fc] of finalCols) {
  if (loaded.some((x) => x.name === fc.table)) continue;
  const t = byName.get(name);
  loaded.push({ name: fc.table, kind: pointedAt.has(name) ? 'dimension' : 'fact', from: fc.stg, description: `Drafted from ${path.basename(t.file || '')}${t.sheet ? ' / ' + (t.excelTable || t.sheet) : ''}.`,
    columns: fc.cols.map((c) => ({ name: c.name, type: c.type, ...(c.hidden ? { hidden: true } : {}) })) });
}

// F18 keys missing in the dimension: inferMembers on the dimension, read from the fact's staging query
for (const t of tables) {
  for (const f of rec(t).filter((x) => x.fix === 'F18')) {
    const r = rels.find((x) => x.from === `${t.name}[${f.column}]`);
    const to = r && split(r.to);
    const dim = to && finalCols.get(to.table);
    const fact = finalCols.get(t.name);
    if (!dim || !fact) { note(skipped, t, f, 'no preferred relationship to the dimension in the profile'); continue; }
    const lt = loaded.find((x) => x.name === dim.table);
    lt.ops = lt.ops || [];
    lt.ops.push({ op: 'inferMembers', key: to.column, fromColumns: [`${fact.stg}[${f.column}]`] });
    if (!lt.columns.some((c) => c.name === 'IsInferred')) lt.columns.push({ name: 'IsInferred', type: 'bool' });
    note(model, t, f, `${MODEL.F18} ${dim.table}`);
  }
}

// relationships between loaded tables (many-to-one), once per pair of columns
const relationships = [];
for (const r of rels) {
  const a = split(r.from); const b = split(r.to);
  const fa = a && finalCols.get(a.table); const fb = b && finalCols.get(b.table);
  if (!fa || !fb || fa.table === fb.table) continue;
  if (!fa.cols.some((c) => c.name === a.column) || !fb.cols.some((c) => c.name === b.column)) continue;
  const rel = { from: `${fa.table}[${a.column}]`, to: `${fb.table}[${b.column}]` };
  if (relationships.some((x) => x.from === rel.from && x.to === rel.to)) continue;
  if (relationships.some((x) => x.from.startsWith(fa.table + '[') && x.to.startsWith(fb.table + '['))) continue; // one path per pair
  relationships.push(rel);
}

// date table on the facts' date columns; the first fact date relates to it
const facts = loaded.filter((x) => x.kind === 'fact');
const dateCols = facts.flatMap((x) => x.columns.filter((c) => c.type === 'date').map((c) => `${x.name}[${c.name}]`));
let date = null;
if (dateCols.length) {
  date = { name: 'Date', columns: dateCols };
  const m01 = tables.flatMap((t) => rec(t).filter((f) => f.fix === 'M01').map((f) => ({ t, f })));
  for (const { t, f } of m01) {
    const fc = finalCols.get(t.name);
    if (fc && facts.some((x) => x.name === fc.table)) { date.completeMonth = date.completeMonth || `${fc.table}[${f.column}]`; note(model, t, f, MODEL.M01); }
    else note(skipped, t, f, 'not a fact date column – no complete-month flag');
  }
  for (const fct of facts) {
    const d = fct.columns.find((c) => c.type === 'date');
    if (d) relationships.push({ from: `${fct.name}[${d.name}]`, to: 'Date[Date]' });
  }
}

const build = {
  name: opt('--name') || choices.name || 'Report', culture: choices.report_culture || 'en-US', sourceCulture: 'en-US',
  cutoffDate: P.today || new Date().toISOString().slice(0, 10),
  sourceFolder: (choices.build && choices.build.sourceFolder) || (path.dirname((tables[0] || {}).file || runDir) + '\\'),
  staging, tables: loaded, ...(date ? { date } : {}), relationships, measures: [], roles: [],
};
const out = { ok: true, staging: staging.length, tables: loaded.length, relationships: relationships.length,
  steps: staging.reduce((n, s) => n + s.steps.length, 0) + loaded.reduce((n, x) => n + (x.ops || []).length, 0), model, skipped };
if (args.includes('--write')) {
  choices.build = build;
  fs.writeFileSync(choicesFile, JSON.stringify(choices, null, 2));
  out.written = path.relative(process.cwd(), choicesFile);
}
console.log(JSON.stringify(out, null, 1));
