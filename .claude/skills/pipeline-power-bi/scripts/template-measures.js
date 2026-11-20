#!/usr/bin/env node
// The measures and parameters pbip-layout's AdventureWorks template needs (its measures.md), written into the
// spec – instead of a one-off script per run. Run it after suggest-fields.js has filled
// runs/<run-id>/layout-config.json, then rebuild.js.
//
//   node template-measures.js runs/<run-id> [--growth 0.10] [--config <layout-config.json>] [--dry-run]
//
// From the base fields mapped in layout-config.json (Total Revenue, Total Orders, Total Profit, Total Returns,
// Total Customers) it makes, for the template fields the chosen pages use and the model lacks:
//   Previous Month Revenue/Orders/Returns  previous_month_<base> – or the spec's own <base>_previous_month
//   Revenue/Order/Profit Target (+ Gap)    last month × (1 + growth) – the template's rule (default 10 %)
//   Adjusted Profit + Price Adjustment (%) a what-if parameter; adjusted_profit with a real profit measure,
//                                          else adjusted_revenue (a decision)
//   Average Revenue per Customer           revenue_per_customer = DIVIDE ( revenue, customers )
//   Product/Customer Metric Selection      field parameters over the mapped measures
// "Real profit" = Total Profit is mapped to a measure named like profit (field-hints.json); a stand-in (a
// target %, customers) gets no profit target, gauge or adjusted profit – those fields become null.
// The measures go to choices.json → build.measures[] (folder "Template"; an earlier run of this script is
// replaced), the parameters to build.parameters[], the fields to layout-config.json (a field the config already
// maps to an existing measure is kept), and the questions to layout-decisions.json (merged by id; an answered
// decision keeps its answer). Prints JSON { ok, made, mapped, kept, nulls, decisions }.
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const runDir = args[0] && path.resolve(args[0]);
const cfgFile = path.resolve(opt('--config') || path.join(runDir || '', 'layout-config.json'));
const DRY = args.includes('--dry-run');
const growth = opt('--growth') !== null ? Number(opt('--growth')) : 0.1;
if (!runDir || !fs.existsSync(path.join(runDir, 'choices.json')) || !fs.existsSync(cfgFile) || !Number.isFinite(growth)) {
  console.error('Usage: node template-measures.js runs/<run-id> [--growth 0.10] [--config layout-config.json] [--dry-run]  (needs choices.json with build and layout-config.json from suggest-fields.js)');
  process.exit(2);
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const choicesFile = path.join(runDir, 'choices.json');
const C = readJson(choicesFile);
const B = C.build || {};
const cfg = readJson(cfgFile);
if ((cfg.template || 'adventureworks') !== 'adventureworks') { console.error(`template "${cfg.template}": use pbip-layout's gen-measures.js for it`); process.exit(2); }
const fields = cfg.fields || {};
const HINTS = (() => { try { return readJson(path.join(__dirname, '..', '..', 'pbip-layout', 'templates', 'adventureworks', 'field-hints.json')); } catch { return {}; } })();

const SNAKE = B.naming === 'snake_case';
const MT = B.measuresTable || (SNAKE ? '_measures' : '_Measures');
const snake = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const nm = (s) => (SNAKE ? snake(s) : s.replace(/(^|_)([a-z])/g, (m, p, c) => (p ? ' ' : '') + c.toUpperCase()));
B.measures = B.measures || [];
// earlier output of this script is replaced
const MADE_FOLDER = 'Template';
const ours = new Set(B.measures.filter((m) => m.folder === MADE_FOLDER).map((m) => m.name));
const own = B.measures.filter((m) => !ours.has(m.name));
const find = (name) => own.find((m) => m.name === name) || own.find((m) => snake(m.name) === snake(name));
const measureOf = (field) => {
  const v = fields[field];
  const m = v && /^'?(.+?)'?\[(.+)\]$/.exec(v);
  return m && (m[1] === MT || m[1] === '_measures' || m[1] === '_Measures') ? find(m[2]) : null;
};
const ref = (m) => `${MT}[${m.name}]`;
const has = (field) => field in fields;

const made = []; const mapped = {}; const kept = []; const nulls = {}; const decisions = [];
const dateName = (B.date && B.date.name) || (SNAKE ? 'dim_date' : 'Date');
const q = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);
const monthStart = SNAKE ? 'month_start' : 'Month start';
const add = (m) => { made.push({ folder: MADE_FOLDER, ...m }); return m; };
const setField = (field, m) => {
  if (!has(field)) return;
  const cur = measureOf(field);
  if (cur && !ours.has(cur.name)) { kept.push(field); return; }
  if (m) { fields[field] = ref(m); mapped[field] = ref(m); } else { fields[field] = null; }
};

// ---------- base measures ----------
const rev = measureOf('Measure Table[Total Revenue]');
const ord = measureOf('Measure Table[Total Orders]');
const prof = measureOf('Measure Table[Total Profit]');
const ret = measureOf('Measure Table[Total Returns]');
const cust = measureOf('Measure Table[Total Customers]');
const profitNames = ((HINTS['Measure Table[Total Profit]'] || {}).names || ['^profit$']).map((r) => new RegExp(r));
const realProfit = prof && profitNames.some((r) => r.test(snake(prof.name)));
const amountFmt = (rev && rev.format) || '\\$#,0.00';
const nonAdd = (m) => /DISTINCTCOUNT|DIVIDE|AVERAGE/i.test((m && m.expr) || '');

// ---------- previous month ----------
const prevOf = {};
function previous(base, label) {
  if (!base) return null;
  const existing = find(`${base.name}_previous_month`) || find(`previous_month_${base.name}`) || find(`${base.name} previous month`) || find(`Previous month ${base.name}`);
  if (existing) return existing;
  // the spec's own style: revenue_previous_month → returns_previous_month; else the template's previous_month_returns
  const suffix = own.some((m) => /_previous_month$/.test(snake(m.name)));
  return add({ name: nm(suffix ? `${snake(base.name)}_previous_month` : `previous_month_${snake(base.name)}`), format: base.format,
    expr: `VAR m = MAX ( ${q(dateName)}[${monthStart}] )\nRETURN CALCULATE ( [${base.name}], REMOVEFILTERS ( ${q(dateName)} ), ${q(dateName)}[${monthStart}] = EDATE ( m, -1 ) )`,
    description: `${label} in the month before the latest selected month.`, filters: { additive: !nonAdd(base) } });
}
const needPrev = (f) => has(f) && !(measureOf(f) && !ours.has(measureOf(f).name));
if (needPrev('Measure Table[Previous Month Revenue]') || has('Measure Table[Revenue Target]')) prevOf.rev = previous(rev, 'Revenue');
if (needPrev('Measure Table[Previous Month Orders]') || has('Measure Table[Order Target]')) prevOf.ord = previous(ord, 'Orders');
if (needPrev('Measure Table[Previous Month Returns]')) prevOf.ret = previous(ret, ret ? ret.name : 'Returns');
if (realProfit && has('Measure Table[Profit Target]')) prevOf.prof = previous(prof, 'Profit');
setField('Measure Table[Previous Month Revenue]', prevOf.rev);
setField('Measure Table[Previous Month Orders]', prevOf.ord);
setField('Measure Table[Previous Month Returns]', prevOf.ret);

// ---------- targets ----------
const pct = `${Math.round(growth * 1000) / 10} %`;
let usedGrowth = false;
function target(key, base, prev, label, fmt) {
  const tf = `Measure Table[${label} Target]`; const gf = `Measure Table[${label} Target Gap]`;
  if (!has(tf) && !has(gf)) return;
  if (!base || !prev) { setField(tf, null); setField(gf, null); nulls[tf] = nulls[gf] = `no ${label.toLowerCase()} measure`; return; }
  usedGrowth = true;
  const t = add({ name: nm(`${key}_target`), expr: `[${prev.name}] * ( 1 + ${growth} )`, format: fmt, description: `${label} last month plus ${pct} growth (the template's target rule).` });
  const g = add({ name: nm(`${key}_target_gap`), expr: `[${base.name}] - [${t.name}]`, format: fmt, description: `${label} minus the ${label.toLowerCase()} target.` });
  setField(tf, t); setField(gf, g);
}
target('sales', rev, prevOf.rev, 'Revenue', amountFmt);
target('order', ord, prevOf.ord, 'Order', (ord && ord.format) || '#,0');
if (realProfit) target('profit', prof, prevOf.prof, 'Profit', prof.format || amountFmt);
else if (has('Measure Table[Profit Target]') || has('Measure Table[Profit Target Gap]')) {
  setField('Measure Table[Profit Target]', null); setField('Measure Table[Profit Target Gap]', null);
  nulls['Measure Table[Profit Target]'] = nulls['Measure Table[Profit Target Gap]'] = 'no profit measure';
}
if (usedGrowth) {
  const modelTargets = own.filter((m) => /target/i.test(m.name)).map((m) => m.name);
  decisions.push({ id: 'template-growth', question: `The Product Detail gauges use last month + ${pct} as the target${modelTargets.length ? ` (the model's own ${modelTargets.join(', ')} is not set per product)` : ''}. Which growth?`,
    why: 'Template rule: last month plus a growth when the model has no targets at that level.',
    options: [{ label: `${pct} (Recommended)`, recommended: true, effect: `targets × ${1 + growth}` }, { label: '5 %', effect: 'template-measures.js --growth 0.05' }, { label: '15 %', effect: 'template-measures.js --growth 0.15' }],
    applied: `${pct} (Recommended)` });
}

// ---------- price adjustment ----------
const params = [];
if (has('Measure Table[Adjusted Profit]') || has('Price Adjustment (%)[Price Adjustment (%)]')) {
  if (rev) {
    const pname = nm('price_adjustment_pct');
    params.push({ kind: 'whatIf', name: pname, min: -1, max: 1, step: 0.1, default: 0, format: '0%' });
    const val = SNAKE ? `${pname}_value` : `${pname} Value`;
    const adjRev = add({ name: nm('adjusted_revenue'), expr: `[${rev.name}] * ( 1 + [${val}] )`, format: amountFmt, description: 'Revenue with the price adjustment slider applied.' });
    let adj = adjRev;
    if (realProfit) adj = add({ name: nm('adjusted_profit'), expr: `[${adjRev.name}] - ( [${rev.name}] - [${prof.name}] )`, format: prof.format || amountFmt, description: 'Profit with the price adjustment applied to revenue (costs unchanged).' });
    else decisions.push({ id: 'adjusted-profit', question: 'No profit in the data: the price-adjustment trend on Product Detail shows adjusted revenue instead of adjusted profit. Keep that?',
      why: 'Adjusted profit needs a cost or profit measure.', options: [{ label: 'Show adjusted revenue (Recommended)', recommended: true, effect: `Adjusted Profit -> ${adjRev.name}` }, { label: 'Leave the trend out', effect: 'Adjusted Profit -> null' }],
      applied: 'Show adjusted revenue (Recommended)' });
    setField('Measure Table[Adjusted Profit]', adj);
    if (has('Price Adjustment (%)[Price Adjustment (%)]')) { fields['Price Adjustment (%)[Price Adjustment (%)]'] = `${pname}[${pname}]`; mapped['Price Adjustment (%)[Price Adjustment (%)]'] = fields['Price Adjustment (%)[Price Adjustment (%)]']; }
  } else { setField('Measure Table[Adjusted Profit]', null); nulls['Measure Table[Adjusted Profit]'] = 'no revenue measure'; }
}

// ---------- customers ----------
let rpc = null;
if (rev && cust) rpc = find('revenue_per_customer') || find('average_revenue_per_customer') || find('sales_per_customer');
if (has('Measure Table[Average Revenue per Customer]')) {
  if (!rpc && rev && cust) rpc = add({ name: nm('revenue_per_customer'), expr: `DIVIDE ( [${rev.name}], [${cust.name}] )`, format: amountFmt, description: 'Revenue divided by customers.' });
  setField('Measure Table[Average Revenue per Customer]', rpc);
  if (!rpc) nulls['Measure Table[Average Revenue per Customer]'] = 'no revenue or customer measure';
}
if (!realProfit && prof && has('Measure Table[Total Profit]')) {
  decisions.push({ id: 'profit-tile', question: `There is no profit in the data: KPI tile 3 (Total Profit) shows ${prof.name}. Keep it?`, why: 'The template tile is Total Profit.',
    options: [{ label: `${prof.name} (Recommended)`, recommended: true, effect: `Total Profit -> ${prof.name}` }, { label: 'Leave the tile out', effect: 'Total Profit -> null' }], applied: `${prof.name} (Recommended)` });
}

// ---------- field parameters ----------
const ratioM = measureOf('Measure Table[Return Rate]');
function fieldParam(key, items) {
  const labelKey = key.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const fSlicer = `${labelKey}[${labelKey}]`; const fFields = `${labelKey}[${labelKey} Fields]`;
  if (!has(fSlicer) && !has(fFields)) return;
  const its = items.filter((x) => x.m).map((x) => ({ label: x.label, measure: x.m.name }));
  if (!its.length) { fields[fSlicer] = null; fields[fFields] = null; nulls[fSlicer] = 'no measures to choose from'; return; }
  const name = nm(key);
  params.push({ kind: 'fields', name, items: its });
  fields[fSlicer] = `${name}[${name}]`; fields[fFields] = `${name}[${SNAKE ? `${name}_fields` : `${name} Fields`}]`;
  mapped[fSlicer] = fields[fSlicer]; mapped[fFields] = fields[fFields];
}
fieldParam('product_metric_selection', [{ label: 'Orders', m: ord }, { label: 'Revenue', m: rev }, { label: 'Profit', m: realProfit ? prof : null }, { label: 'Return rate', m: ratioM }]);
fieldParam('customer_metric_selection', [{ label: 'Customers', m: cust }, { label: 'Revenue per customer', m: rpc }]);

// ---------- write ----------
const madeNames = new Set(made.map((m) => m.name));
const clash = own.filter((m) => madeNames.has(m.name)).map((m) => m.name);
if (clash.length) { console.log(JSON.stringify({ ok: false, errors: [`measures already in the spec under another folder: ${clash.join(', ')} – map them in layout-config.json instead`] }, null, 1)); process.exit(2); }
B.measures = [...own, ...made];
const paramNames = new Set(params.map((p) => p.name));
B.parameters = [...(B.parameters || []).filter((p) => !paramNames.has(p.name)), ...params];
C.build = B;
cfg.fields = fields;
const decFile = path.join(path.dirname(cfgFile), 'layout-decisions.json');
const oldDec = fs.existsSync(decFile) ? readJson(decFile) : [];
const decOut = [...oldDec];
for (const d of decisions) { const i = decOut.findIndex((x) => x.id === d.id); if (i < 0) decOut.push(d); else if (!decOut[i].applied) decOut[i] = d; }
const out = { ok: true, realProfit: !!realProfit, growth, made: made.map((m) => m.name), parameters: params.map((p) => p.name), mapped, kept, nulls, decisions: decisions.map((d) => d.id),
  next: made.length || params.length ? 'node .claude\\skills\\pipeline-power-bi\\scripts\\rebuild.js runs\\<run-id> – then suggest-fields.js again (every field should now resolve)' : null };
if (!DRY) {
  fs.writeFileSync(choicesFile, JSON.stringify(C, null, 2));
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  if (decisions.length) fs.writeFileSync(decFile, JSON.stringify(decOut, null, 2));
}
console.log(JSON.stringify(out, null, 1));
