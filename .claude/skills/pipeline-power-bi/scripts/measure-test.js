#!/usr/bin/env node
// A DAX query that tests a new or changed measure against the model as it is now, before it is saved.
//
//   node measure-test.js runs/<run-id> "<measure>" [--by "Table[Column]"] [--show-vars] [--out <file>]
//
// The measure must already be in choices.json → build.measures[] (name, expr, optional filters), and its
// expected value, when there is one, in checks[] with dax "[<measure>]" (computed from the source files).
// Writes runs/<run-id>/measure-test.dax (or --out):
//   DEFINE   the measure and every spec measure it uses, as query measures (the spec's version wins over a
//            measure of the same name in the model, so a changed measure is tested as changed)
//   EVALUATE A  one row per check: the measure's own checks (Expected, Difference) and its filter contract
//   EVALUATE B  the measure per member of --by (default: its first `keep` column, else the first text column
//               of the first dimension)
//   EVALUATE C  with --show-vars: the measure's scalar VARs as one row (e.g. the first and last day of a
//               period window), so the user sees which dates or thresholds it really uses. Table VARs
//               (FILTER, VALUES, DATESBETWEEN …) are defined but not shown.
// Each measure is self-contained: everything it uses is a model object or another spec measure, never
// something that only exists in this query – so the same formulas work once saved. After the rebuild the
// same checks run in checks.dax without DEFINE, which proves the saved measure.
// Prints JSON { ok, file, measure, defined: [...], checks: n, by, warnings }.
'use strict';
const fs = require('fs');
const path = require('path');
const { contractChecks, mref, ref, cref } = require('./filter-checks');

const runDir = path.resolve(process.argv[2] || '');
const name = process.argv[3];
const opt = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const choicesFile = path.join(runDir, 'choices.json');
if (!name || !fs.existsSync(choicesFile)) {
  console.error('Usage: node measure-test.js runs/<run-id> "<measure>" [--by "Table[Column]"] [--out <file>]');
  process.exit(2);
}
const choices = JSON.parse(fs.readFileSync(choicesFile, 'utf8').replace(/^﻿/, ''));
const B = choices.build || {};
const all = B.measures || [];
const m = all.find((x) => x.name === name) || all.find((x) => x.name.toLowerCase() === name.toLowerCase());
if (!m) { console.error(`measure "${name}" is not in choices.json → build.measures[] – add it there first`); process.exit(2); }
const warnings = [];
if (B.naming === 'snake_case' && !/^[a-z0-9_]+$/.test(m.name)) {
  warnings.push(`the model uses snake_case names but "${m.name}" is not – run snake-names.js --apply first, so the names in the formula match the model`);
}

// the measure and every spec measure it uses (recursively)
const byName = new Map(all.map((x) => [x.name, x]));
const used = [];
(function walk(x) {
  if (used.includes(x)) return;
  used.push(x);
  for (const r of String(x.expr).matchAll(/\[([^\]]+)\]/g)) if (byName.has(r[1]) && byName.get(r[1]) !== x) walk(byName.get(r[1]));
})(m);
const defined = used.reverse();

// checks: the measure's own (from checks[]) + its filter contract
const M = mref(B, m.name);
const own = (choices.checks || []).filter((c) => c && typeof c.expected === 'number' &&
  [`[${m.name}]`, M].includes(String(c.dax).replace(/\s+/g, ' ').trim()));
if (!own.length) warnings.push(`no expected value for ${m.name} in checks[] – compute it from the source files and add { name, dax: "[${m.name}]", expected }`);
const checks = [...own.map((c) => ({ name: c.name, dax: M, expected: c.expected })), ...contractChecks(B, m, warnings)];
if (!m.filters) warnings.push(`${m.name} has no filters contract – say which filters it must ignore and keep (build-spec.md → filters)`);

// the column for the breakdown
let by = opt('--by') || ((m.filters && m.filters.keep) || [])[0];
if (!by) {
  const dim = (B.tables || []).find((t) => t.kind === 'dimension' && (t.columns || []).some((c) => c.type === 'text' && !c.hidden));
  const col = dim && dim.columns.find((c) => c.type === 'text' && !c.hidden);
  if (col) by = `${dim.name}[${col.name}]`;
}
const byRef = by ? ref(by) : null;

// the measure's top-level VARs (--show-vars)
const TABLE_FN = /^(?:FILTER|ALL\w*|VALUES|DISTINCT|SUMMARIZE\w*|ADDCOLUMNS|SELECTCOLUMNS|CALCULATETABLE|DATES\w+|TOPN|GENERATE\w*|UNION|INTERSECT|EXCEPT|TREATAS|CROSSJOIN|DATATABLE|GENERATESERIES|CALENDAR\w*|RELATEDTABLE|KEEPFILTERS|REMOVEFILTERS)\s*\(|^\{/i;
let vars = [];
if (process.argv.includes('--show-vars')) {
  // comments out, strings kept as they are
  const body = String(m.expr).replace(/("(?:[^"]|"")*")|\/\*[\s\S]*?\*\/|(?:\/\/|--)[^\n]*/g, (all, str) => str || '');
  vars = [...body.matchAll(/\bVAR\s+([A-Za-z_]\w*)\s*=\s*([\s\S]*?)(?=\bVAR\s+[A-Za-z_]\w*\s*=|\bRETURN\b)/gi)].map((x) => ({ name: x[1], expr: x[2].trim() }));
  if (!vars.length) warnings.push(`--show-vars: ${m.name} has no VARs to show`);
}
const shown = vars.filter((v) => !TABLE_FN.test(v.expr));

const ind = (s, pad) => String(s).split('\n').map((l, i) => (i ? pad : '') + l).join('\n');
const daxStr = (s) => `"${String(s).replace(/"/g, '""')}"`;
const out = [
  `// Test of ${m.name} before it is saved. Written by measure-test.js.`,
  '// Power BI Desktop (the model open and refreshed) → DAX query view → paste this → Run.',
  '// A: every Difference should be 0. B: the measure per member – check that the split looks right.',
  '// Then save it the pipeline way: the measure is already in the build spec, so close Desktop and run',
  '// rebuild.js (not "Update model with changes" – a rebuild would overwrite that). After the refresh,',
  '// checks.dax runs the same checks against the saved measure, without DEFINE.',
  ...warnings.map((w) => `// NOTE: ${w}`), '',
  'DEFINE',
  ...defined.map((x) => `    MEASURE ${mref(B, x.name)} =\n        ${ind(x.expr, '        ')}`), '',
  '// A – checks',
  'EVALUATE',
  checks.length ? [
    '    VAR Checks =', '        {',
    checks.map((c) => `            ( ${daxStr(c.name)}, ${c.dax}, ${c.expected} )`).join(',\n'),
    '        }', '    RETURN', '        SELECTCOLUMNS (', '            Checks,', '            "Check", [Value1],',
    '            "In Power BI", [Value2],', '            "Expected", [Value3],', '            "Difference", ROUND ( [Value2] - [Value3], 2 )', '        )',
  ].join('\n') : `    ROW ( ${daxStr(m.name)}, ${M} )`, '',
  ...(byRef ? ['// B – per member', 'EVALUATE', `    SUMMARIZECOLUMNS ( ${cref(byRef)}, ${daxStr(m.name)}, ${M} )`, `    ORDER BY ${cref(byRef)}`, ''] : []),
  ...(shown.length ? ['// C – the values the measure works with (its VARs, without any filter)', 'EVALUATE',
    ...vars.map((v) => `    VAR ${v.name} =\n        ${ind(v.expr, '        ')}`), '    RETURN',
    `        ROW ( ${shown.map((v) => `${daxStr(v.name)}, ${v.name}`).join(', ')} )`, ''] : []),
];
const file = opt('--out') ? path.resolve(opt('--out')) : path.join(runDir, 'measure-test.dax');
fs.writeFileSync(file, out.join('\n'), 'utf8');
console.log(JSON.stringify({ ok: true, file, measure: m.name, defined: defined.map((x) => x.name), checks: checks.length, by: by || null, vars: shown.map((v) => v.name), warnings }, null, 1));
