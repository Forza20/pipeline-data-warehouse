#!/usr/bin/env node
// Schema drift: before a refresh with new versions of the source files, check them against what the model
// was built for (profile.json + the build spec in choices.json). Read-only on the source files.
//
//   node check-drift.js runs/<run-id> [--path <new file or folder>] [--today yyyy-MM-dd]
//
// --path defaults to choices.source_original (where the user keeps the files), else the run's data/ folder.
// Writes runs/<run-id>/drift.md and drift.json. Exit code 1 when a change breaks the refresh, else 0.
//
// Breaking: a file, sheet or Excel table that is gone; a column the staging query selects that is gone; a
// changed CSV delimiter, header row or encoding. Warnings: a column whose kind changed (number → text …),
// new problem types (fix ids) in a table, a likely rename. Info: new columns (ignored by F01), row counts.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const run = args[0];
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : undefined; };
if (!run) {
  console.error('Usage: node check-drift.js runs/<run-id> [--path <file or folder>]');
  process.exit(2);
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const choices = read(path.join(run, 'choices.json'));
const oldProf = read(path.join(run, 'profile.json'));
const staging = ((choices.build || {}).staging) || [];
if (!staging.length) {
  console.error('choices.json has no build.staging – nothing to compare');
  process.exit(2);
}
// A wrong --path must stop the check: falling back to the run's own copy would compare the old files with
// themselves and report "no breaking changes".
let src = opt('--path');
let note = '';
if (src && !fs.existsSync(src)) {
  console.error(`--path not found: ${src}`);
  process.exit(2);
}
if (!src) {
  src = choices.source_original && fs.existsSync(choices.source_original) ? choices.source_original : path.join(run, 'data');
  if (src === path.join(run, 'data')) note = 'No new files given (--path) and source_original not found – this compares the run’s own copy of the files the model was built from, so it cannot show drift.';
}

const tmp = path.join(os.tmpdir(), `drift-${process.pid}.json`);
const ps = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'Profile-Sources.ps1'), '-Path', src, '-OutFile', tmp];
if (opt('--today')) ps.push('-Today', opt('--today'));
let newProf;
try {
  execFileSync('powershell', ps, { stdio: 'pipe' });
  newProf = read(tmp);
} catch (e) {
  console.error('Profile-Sources.ps1 failed on ' + src + ':\n' + String((e.stderr || e.message || '')).slice(-800));
  process.exit(2);
} finally {
  fs.rmSync(tmp, { force: true });
}

const low = (s) => String(s || '').toLowerCase();
const base = (f) => path.basename(String(f || '')).toLowerCase();
function findTable(prof, file, kind, item) {
  return prof.tables.find((t) => base(t.file) === base(file) && (
    kind === 'csv' ? true : kind === 'excel table' ? low(t.excelTable) === low(item) : low(t.sheet || t.name) === low(item)));
}
const norm = (s) => String(s).toLowerCase().replace(/[\s_\-.]+/g, '');

const items = [];
for (const s of staging) {
  items.push({ query: s.name, file: s.file, kind: s.kind, item: s.item, columns: s.columns || [], csv: s.kind === 'csv' ? s : null });
  for (const a of s.append || []) items.push({ query: `${s.name} (append ${a.item})`, file: a.file || s.file, kind: a.kind || s.kind, item: a.item, columns: a.columns || s.columns || [] });
}

const out = [];
let breaking = 0;
for (const it of items) {
  const label = `${it.query} – ${it.file}${it.item ? ' › ' + it.item : ''}`;
  const o = findTable(oldProf, it.file, it.kind, it.item);
  const n = findTable(newProf, it.file, it.kind, it.item);
  const r = { source: label, breaking: [], warnings: [], info: [] };
  if (!n) {
    const sameFile = newProf.tables.filter((t) => base(t.file) === base(it.file));
    r.breaking.push(sameFile.length ? `${it.kind === 'excel table' ? 'Excel table' : 'sheet'} "${it.item}" is gone (the file has: ${sameFile.map((t) => t.excelTable || t.sheet || t.name).join(', ')})`
      : `file ${it.file} not found in ${src}`);
    out.push(r); breaking += r.breaking.length; continue;
  }
  const newCols = n.columns.map((c) => c.name);
  const missing = it.columns.filter((c) => !newCols.includes(c));
  const added = newCols.filter((c) => !it.columns.includes(c));
  for (const m of missing) {
    const guess = added.find((a) => norm(a) === norm(m)) ||
      (it.columns.indexOf(m) < newCols.length && added.includes(newCols[it.columns.indexOf(m)]) ? newCols[it.columns.indexOf(m)] : null);
    r.breaking.push(`column "${m}" is gone` + (guess ? ` – renamed to "${guess}"? Change it in build.staging[].columns and the steps that use it` : ''));
  }
  if (added.length) r.info.push(`new columns (not loaded until you add them): ${added.join(', ')}`);
  if (it.csv && o) {
    if (o.delimiter !== n.delimiter) r.breaking.push(`delimiter changed: "${o.delimiter}" → "${n.delimiter}"`);
    if (o.headerRow !== n.headerRow) r.breaking.push(`header row moved: line ${o.headerRow} → ${n.headerRow} (F01 skips the lines above it)`);
    if (o.codePage !== n.codePage) r.warnings.push(`encoding changed: ${o.encoding} → ${n.encoding}`);
  }
  if (o) {
    for (const c of n.columns) {
      const oc = o.columns.find((x) => x.name === c.name);
      if (oc && oc.kind !== c.kind && it.columns.includes(c.name)) r.warnings.push(`column "${c.name}" was ${oc.kind}, is now ${c.kind}`);
    }
    const oldFix = new Set(o.findings.map((f) => `${f.fix}|${f.column || ''}`));
    const fresh = n.findings.filter((f) => !oldFix.has(`${f.fix}|${f.column || ''}`) && !['F02', 'F17'].includes(f.fix));
    for (const f of fresh) r.warnings.push(`new problem ${f.fix}${f.column ? ` in "${f.column}"` : ''}${f.rows ? ` (${f.rows} rows)` : ''} – the cleaning has no step for it`);
    if (o.dataRows !== n.dataRows) r.info.push(`rows: ${o.dataRows} → ${n.dataRows}`);
  } else {
    r.info.push('not in the old profile – compared with the build spec only');
  }
  breaking += r.breaking.length;
  out.push(r);
}

const md = [`# Drift check – ${choices.name || path.basename(run)}`, '', `New files: \`${src}\` · compared with \`profile.json\` from ${oldProf.generated || 'the build'}.`, '',
  ...(note ? [`> ⚠ ${note}`, ''] : []),
  breaking ? `**${breaking} breaking change(s)** – the refresh will fail until the build spec is changed and the model rebuilt.`
    : '**No breaking changes** – the refresh will run.', ''];
for (const r of out) {
  md.push(`## ${r.source}`, '');
  for (const x of r.breaking) md.push(`- ❌ ${x}`);
  for (const x of r.warnings) md.push(`- ⚠ ${x}`);
  for (const x of r.info) md.push(`- ${x}`);
  if (!r.breaking.length && !r.warnings.length && !r.info.length) md.push('- unchanged');
  md.push('');
}
fs.writeFileSync(path.join(run, 'drift.md'), md.join('\n'), 'utf8');
fs.writeFileSync(path.join(run, 'drift.json'), JSON.stringify({ path: src, note: note || undefined, breaking, sources: out }, null, 1), 'utf8');
console.log(JSON.stringify({ ok: breaking === 0, breaking, note: note || undefined, warnings: out.reduce((a, r) => a + r.warnings.length, 0), file: path.join(run, 'drift.md') }, null, 1));
process.exit(breaking ? 1 : 0);
