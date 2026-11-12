#!/usr/bin/env node
// A compact summary of a run's saved choices, for --resume and the review before the build (step 7):
// settings, the star schema, the cleaning per source, relationships, measures, roles, extras, the review
// points and the run's status. Read-only.
//
//   node run-summary.js runs/<run-id> [--json]
//
// Prints Markdown (show it to the user as it is), or with --json the same content as data.
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = path.resolve(process.argv[2] || '');
const file = path.join(runDir, 'choices.json');
if (!fs.existsSync(file)) { console.error('Usage: node run-summary.js runs/<run-id>   (needs choices.json)'); process.exit(2); }
const c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const d = c.design || {};
const b = c.build || {};
const m = c.model || {};
const names = (xs) => (xs || []).map((x) => (typeof x === 'string' ? x : x.name || x.table)).filter(Boolean);
const short = (col) => { const p = String(col).split(/,\s*/); return p.length > 3 ? `${p.slice(0, 2).join(', ')} … ${p[p.length - 1]} (${p.length} columns)` : String(col); };
const fixLabel = (f) => `${f.fix}${f.column ? ' ' + short(f.column) : ''}${f.variant && typeof f.variant !== 'object' ? ` (${f.variant})` : ''}`;

const sources = Object.entries(c.tables || {}).filter(([, t]) => t && t.include !== false).map(([key, t]) => {
  const fixes = t.fixes || [];
  return { source: key, table: t.table_name || key, role: t.role || '', mode: t.mode || '',
    kept: fixes.filter((f) => f.keep !== false).map(fixLabel), notKept: fixes.filter((f) => f.keep === false).map(fixLabel) };
});
const skipped = Object.entries(c.tables || {}).filter(([, t]) => t && t.include === false).map(([k]) => k);
const rels = b.relationships && b.relationships.length
  ? b.relationships.map((r) => `${r.from} → ${r.to}${r.active === false ? ' (inactive)' : ''}`) : (m.relationships || []);
const measures = b.measures && b.measures.length ? b.measures.map((x) => x.name) : (m.measures || []);
const review = (d.review || []).filter((r) => r && r.point);
const S = {
  run: c.run_id || path.basename(runDir), name: c.name, culture: c.report_culture, currency: c.currency, fast: !!c.fast,
  status: c.status || {},
  design: { facts: (d.facts || []).map((f) => ({ name: f.name, grain: f.grain, sources: f.sources || [] })),
    dimensions: (d.dimensions || []).map((x) => ({ name: x.name, sources: x.sources || [] })),
    stagingOnly: d.staging_only || [], leftOut: (d.left_out || []).map((x) => (typeof x === 'string' ? { table: x } : x)), roles: names(d.roles) },
  sources, skipped, relationships: rels, measures, roles: names(b.roles && b.roles.length ? b.roles : d.roles),
  extras: c.extras || {}, review: { open: review.filter((r) => r.status === 'open'), settled: review.filter((r) => r.status !== 'open') },
};
if (process.argv.includes('--json')) { console.log(JSON.stringify(S, null, 1)); process.exit(0); }

const L = [`**${S.name || S.run}** (\`${S.run}\`) · ${S.culture || '–'}, ${S.currency || '–'}${S.fast ? ' · fast mode' : ''}`, ''];
L.push(`Status: ${Object.entries(S.status).map(([k, v]) => `${k} ${v}`).join(' · ') || '–'}`, '');
if (S.design.facts.length || S.design.dimensions.length) {
  L.push(`**Star schema: ${S.design.facts.length} facts, ${S.design.dimensions.length} dimensions**`);
  for (const f of S.design.facts) L.push(`- Fact ${f.name}: ${f.grain || '–'}${f.sources.length ? ` (from ${f.sources.join(', ')})` : ''}`);
  for (const x of S.design.dimensions) L.push(`- Dimension ${x.name}${x.sources.length ? ` (from ${x.sources.join(', ')})` : ''}`);
  if (S.design.stagingOnly.length) L.push(`- Staging only: ${S.design.stagingOnly.join(', ')}`);
  for (const x of S.design.leftOut) L.push(`- Left out: ${x.table}${x.reason ? ` – ${x.reason}` : ''}`);
  L.push('');
}
const nKept = sources.reduce((a, s) => a + s.kept.length, 0);
const nNot = sources.reduce((a, s) => a + s.notKept.length, 0);
L.push(`**Cleaning: ${sources.length} sources, ${nKept} steps kept, ${nNot} not kept**${skipped.length ? ` (not included: ${skipped.join(', ')})` : ''}`);
for (const s of sources) {
  L.push(`- ${s.source} → ${s.table}: ${s.kept.length} steps${s.kept.length ? ` – ${s.kept.join(', ')}` : ''}${s.notKept.length ? ` · not kept: ${s.notKept.join(', ')}` : ''}`);
}
L.push('');
const inactive = rels.filter((r) => /inactive/.test(r));
L.push(`**Model:** ${rels.length} relationships${inactive.length ? ` (${inactive.length} inactive)` : ''} · ${measures.length} measures${S.roles.length ? ` · roles: ${S.roles.join(', ')}` : ''}`);
if (measures.length) L.push(`Measures: ${measures.join(', ')}`);
const ex = Object.entries(S.extras).filter(([, v]) => v === true).map(([k]) => k);
L.push(`Extras: ${ex.length ? ex.join(', ') : 'none'}`, '');
if (review.length) {
  L.push(`**Review points: ${S.review.open.length} open, ${S.review.settled.length} settled**`);
  S.review.open.forEach((r, i) => L.push(`${i + 1}. ${r.point}${r.note && r.note !== 'drafted' ? ` → ${r.note}` : ''}`));
  for (const r of S.review.settled) L.push(`- (${r.status}) ${r.point}${r.note && r.note !== 'drafted' ? ` → ${r.note}` : ''}`);
  L.push('');
}
console.log(L.join('\n'));
