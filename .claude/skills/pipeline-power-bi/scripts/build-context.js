#!/usr/bin/env node
// Writes model-context.md: the model's meaning in one file for an AI assistant (Copilot, Claude, an agent)
// that answers questions on the report – tables and grain, relationships, measures with their business
// term and formula, the glossary, access rules and known limits. Read-only on the run folder.
//
//   node build-context.js runs/<run-id>
//
// Reads choices.json (build, design, glossary, review). Writes runs/<run-id>/model-context.md.
'use strict';
const fs = require('fs');
const path = require('path');

const run = process.argv[2];
if (!run) {
  console.error('Usage: node build-context.js runs/<run-id>');
  process.exit(1);
}
const choices = JSON.parse(fs.readFileSync(path.join(run, 'choices.json'), 'utf8').replace(/^\uFEFF/, ''));
const b = choices.build;
if (!b) {
  console.error('choices.json has no build spec – run the build first');
  process.exit(2);
}
const design = choices.design || {};
const glossary = (choices.glossary || []).filter((g) => g && g.term);
const terms = new Map(glossary.map((g) => [g.term.toLowerCase(), g]));
const warnings = [];
const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const L = [`# ${b.name} – model context for AI assistants`, '',
  'Use this file as the definition of the model. Answer with the measures below – never re-derive a number from',
  'raw columns when a measure exists. If a question uses a term from the glossary, use its measure. If a question',
  'needs something the model does not hold, say so instead of guessing. Every number is subject to the access',
  'rules: a user sees only the rows their role allows.', ''];

// glossary
L.push('## Glossary', '');
if (glossary.length) {
  for (const g of glossary) {
    const ms = (b.measures || []).filter((m) => (m.term || '').toLowerCase() === g.term.toLowerCase()).map((m) => m.name);
    L.push(`- **${g.term}** – ${one(g.definition)}` + (ms.length ? ` Measure: ${ms.map((x) => `[${x}]`).join(', ')}.` : '')
      + (g.owner ? ` Owner: ${g.owner}.` : '') + (g.examples ? ` Example: ${one(g.examples)}.` : ''));
    if (!ms.length) warnings.push(`term "${g.term}" has no measure`);
  }
} else {
  L.push('_No glossary yet – the measures below carry their own descriptions._');
}
L.push('');

// tables
const grainOf = new Map((design.facts || []).map((f) => [f.name, f.grain]));
L.push('## Tables', '');
for (const t of b.tables || []) {
  if (t.hidden) continue;
  const grain = grainOf.get(t.name);
  L.push(`### ${t.name} (${t.kind}${grain ? `, one row = ${one(grain)}` : ''})`);
  if (t.description) L.push(one(t.description));
  const cols = (t.columns || []).filter((c) => !c.hidden);
  L.push('', '| Column | Type | Meaning |', '|---|---|---|');
  for (const c of cols) L.push(`| ${c.name} | ${c.type} | ${one(c.description) || '–'} |`);
  L.push('');
}
if (b.date) L.push(`### ${b.date.name || 'Date'} (calendar)`, `Whole years covering ${(b.date.columns || []).join(', ')}.`
  + (b.date.completeMonth ? ' `Is complete month` marks months with data up to their last day.' : ''), '');

// relationships
L.push('## Relationships', '', 'All many-to-one, filtering from the one side (dimension) to the many side (fact).', '');
for (const r of b.relationships || []) L.push(`- ${r.from} → ${r.to}${r.active === false ? ' (inactive – use USERELATIONSHIP)' : ''}`);
L.push('');

// measures
L.push('## Measures', '', '| Measure | Term | Meaning | Format | DAX |', '|---|---|---|---|---|');
for (const m of b.measures || []) {
  if (m.term && !terms.has(m.term.toLowerCase())) warnings.push(`measure "${m.name}" refers to unknown term "${m.term}"`);
  L.push(`| ${m.name} | ${m.term || '–'} | ${one(m.description) || '–'} | \`${m.format || ''}\` | \`${one(m.expr).replace(/\|/g, '\\|')}\` |`);
}
L.push('');

// access
L.push('## Access rules', '');
if ((b.roles || []).length) {
  for (const r of b.roles) L.push(`- **${r.name}**: rows of ${r.table} where \`${one(r.filter)}\`. A user without a mapping sees no rows.`);
} else {
  L.push('- No row-level security: every viewer sees all rows.');
}
L.push('');

// limits
const open = (design.review || []).filter((r) => r.status === 'open');
const left = design.left_out || [];
L.push('## Known limits', '');
for (const r of open) L.push(`- Open review point – ${r.point}: ${one(r.note)}`);
for (const l of left) L.push(`- Not in the model: ${l.table} (${one(l.reason)})`);
if (!open.length && !left.length) L.push('- None recorded.');
L.push('', '## Source', '', `Files: ${choices.source_original || b.sourceFolder || '–'} (folder parameter \`SourceFolder\`).`,
  'Cleaning steps per source are named after their fix (F01 …) in Power Query; see cleaning-log.md.', '');

fs.writeFileSync(path.join(run, 'model-context.md'), L.join('\n'), 'utf8');
console.log(JSON.stringify({ ok: true, file: path.join(run, 'model-context.md'), terms: glossary.length,
  measures: (b.measures || []).length, measuresWithTerm: (b.measures || []).filter((m) => m.term).length, warnings }, null, 1));
