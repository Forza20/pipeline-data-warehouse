#!/usr/bin/env node
// Runs `powerbi-report-author validate` on a report and separates the findings that come from the
// template's source report (Power BI Desktop wrote them that way) from new ones.
//
//   node validate-report.js "<Name.Report>"
//
// Prints JSON { ok, errors, warnings, known: [...], new: [{ severity, code, file, path, message }] } and
// exits 0 when nothing new is an error. Only the new findings need fixing.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const rep = process.argv[2];
if (!rep) { console.error('Usage: node validate-report.js <Name.Report>'); process.exit(2); }
const r = spawnSync('powerbi-report-author', ['validate', rep], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let j;
try { j = JSON.parse(r.stdout); } catch { console.error((r.stdout || '') + (r.stderr || '') || 'powerbi-report-author not found (npm install -g @microsoft/powerbi-report-authoring-cli)'); process.exit(2); }

// [code, test on the item] – findings of the template's source report
const KNOWN = [
  ['PBIR_FORMATTING_PROP_NESTED', (i) => /^anomalyDetection\./.test(i.path || '')],
  ['PBIR_VISUAL_TYPE_DEPRECATED', (i) => /"(map|qnaVisual)"/.test(i.message || '')],
  ['PBIR_DRILLTHROUGH_BACK_BUTTON_MISSING', () => true],
  ['PBIR_JSON_FILE_NO_SCHEMA', (i) => /\.pbip$|definition\.pbir$/.test(i.file || '')],
  ['PBIR_SCHEMA_UNREACHABLE', () => true],
  ['PBIR_FILTER_NAME_DUPLICATE_GLOBAL', () => true],
];
const known = []; const fresh = [];
for (const [code, v] of Object.entries((j.data || {}).diagnostics || {})) {
  for (const i of v.items || []) {
    const item = { severity: v.severity, code, file: i.file ? path.relative(rep, i.file) : '', path: i.path || '', message: (i.message || '').replace(/[A-Z]:\\\S*?\.Report/g, '').slice(0, 300) };
    (KNOWN.some(([c, t]) => c === code && t(i)) ? known : fresh).push(item);
  }
}
const newErrors = fresh.filter((x) => x.severity === 'error');
console.log(JSON.stringify({ ok: !newErrors.length, errors: newErrors.length, warnings: fresh.length - newErrors.length,
  known: [...new Set(known.map((k) => `${k.code}${k.path ? ' ' + k.path : ''}`))], new: fresh }, null, 1));
process.exit(newErrors.length ? 1 : 0);
