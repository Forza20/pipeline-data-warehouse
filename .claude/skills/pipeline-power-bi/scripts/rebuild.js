#!/usr/bin/env node
// One command after the build spec changed (first build after the report scaffold, every --resume change):
// runs the run's scripts in order and stops at the first that fails, so none is forgotten.
//
//   node rebuild.js runs/<run-id> [--checks-updated] [--validate-report] [--vault "<vault>" --folder <folder>]
//
//   0 snake-names.js       only with build.naming = "snake_case": every table, column, measure renamed to snake_case
//   1 build-model.js      the semantic model from choices.json → build (exit 3 = folder locked: Disconnect first)
//   – descriptions.py      pbip/docs/descriptions.xlsx (name | description of every measure, column, table)
//   2 build-docs.js        cleaning log, expected values, checks.dax; stale checks and questions
//   3 build-context.js     model-context.md
//   4 model_health.py      model-health.md                           (needs profile.json)
//   5 grounded_answers.py  grounded-answers.dax / .md                 (only with questions.json)
//   6 build_handover.py    governance/handover.md                    (only when governance was chosen)
//   7 build-overview.js    overview.html (+ Obsidian note with --vault)
//   – powerbi-report-author validate <Name>.Report                  (only with --validate-report)
//
// Prints JSON: { ok, failedAt, steps: [{ step, ok, skipped, ms, warnings, error }], warnings, stale, staleQuestions, next }.
// It does not validate the TMDL (powerbi-modeling-mcp ConnectFolder → Disconnect) and does not rerun the
// catalog or the governance wiki: those go through their skills – `next` lists what is left.
// Python: $PYTHON, else `python`, else `py -3`.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const runDir = path.resolve(args[0] || '');
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i > 0 && args[i + 1] ? args[i + 1] : null; };
const choicesFile = path.join(runDir, 'choices.json');
if (!fs.existsSync(choicesFile)) { console.error('Usage: node rebuild.js runs/<run-id>   (needs choices.json)'); process.exit(2); }
const choices = JSON.parse(fs.readFileSync(choicesFile, 'utf8').replace(/^﻿/, ''));
if (!choices.build) { console.error('choices.json has no build spec – the "keep my model" mode has nothing to rebuild'); process.exit(2); }
const NAME = choices.build.name || choices.name || 'Model';
const S = __dirname;
const pbip = path.join(runDir, 'pbip');

function python() {
  if (process.env.PYTHON) return [process.env.PYTHON];
  for (const p of [['python'], ['py', '-3']]) {
    const r = spawnSync(p[0], [...p.slice(1), '--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3/.test(r.stdout + r.stderr)) return p;
  }
  return null;
}
const PY = python();

const steps = [
  // build.naming = "snake_case": rename the spec first (idempotent), so every name in the model is snake_case
  ...(choices.build.naming === 'snake_case' ? [{ step: 'snake-names', cmd: ['node', path.join(S, 'snake-names.js'), runDir, '--apply'] }] : []),
  { step: 'build-model', cmd: ['node', path.join(S, 'build-model.js'), runDir] },
  { step: 'descriptions', py: [path.join(S, 'descriptions.py'), pbip, '--warn-only'] },
  { step: 'build-docs', cmd: ['node', path.join(S, 'build-docs.js'), runDir, ...(flag('--checks-updated') ? ['--checks-updated'] : [])] },
  { step: 'build-context', cmd: ['node', path.join(S, 'build-context.js'), runDir] },
  { step: 'model-health', py: [path.join(S, 'model_health.py'), pbip, '--profile', path.join(runDir, 'profile.json')],
    skip: !fs.existsSync(path.join(runDir, 'profile.json')) && 'no profile.json' },
  { step: 'grounded-answers', py: [path.join(S, 'grounded_answers.py'), pbip, path.join(runDir, 'questions.json'), '--out', runDir],
    skip: !fs.existsSync(path.join(runDir, 'questions.json')) && 'no questions.json yet (step 8.9)' },
  { step: 'handover', py: [path.join(S, 'build_handover.py'), runDir],
    skip: !((choices.extras || {}).governance || fs.existsSync(path.join(runDir, 'governance'))) && 'governance not chosen' },
  { step: 'overview', cmd: ['node', path.join(S, 'build-overview.js'), runDir, ...(opt('--vault') ? ['--vault', opt('--vault'), '--folder', opt('--folder') || 'Pipeline'] : [])] },
];
if (flag('--validate-report')) {
  steps.push({ step: 'validate-report', cmd: ['powerbi-report-author', 'validate', path.join(pbip, `${NAME}.Report`)], shell: true });
}

const out = { ok: true, failedAt: null, steps: [], warnings: [], stale: [], staleQuestions: [], next: [] };
for (const s of steps) {
  const rec = { step: s.step, ok: true };
  if (s.skip) { rec.skipped = s.skip; out.steps.push(rec); continue; }
  let cmd = s.cmd;
  if (s.py) {
    if (!PY) { rec.skipped = 'Python 3 not found (set PYTHON)'; out.steps.push(rec); out.warnings.push(`${s.step}: skipped – Python 3 not found`); continue; }
    cmd = [...PY, '-X', 'utf8', ...s.py];
  }
  const t0 = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', shell: !!s.shell, maxBuffer: 64 * 1024 * 1024 });
  rec.ms = Date.now() - t0;
  let j = null;
  try { j = JSON.parse(String(r.stdout).trim()); } catch { /* not JSON */ }
  if (j && Array.isArray(j.warnings)) rec.warnings = j.warnings;
  else if (j && typeof j.warnings === 'number' && j.warnings > 0) rec.warnings = [`${j.warnings} warning(s) – see ${s.step === 'model-health' ? 'model-health.md' : 'its output file'}`];
  if (j && s.step === 'build-docs' && j.checks) { out.stale = j.checks.stale || []; out.staleQuestions = j.checks.staleQuestions || []; }
  if (r.status !== 0 || r.error) {
    rec.ok = false;
    rec.exitCode = r.status;
    rec.error = ((j && (j.errors || j.message)) ? JSON.stringify(j.errors || j.message) : (String(r.stderr || '') + String(r.stdout || '')).trim().slice(-1200)) || String(r.error);
    out.steps.push(rec);
    out.ok = false;
    out.failedAt = s.step;
    break;
  }
  for (const w of rec.warnings || []) out.warnings.push(`${s.step}: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  out.steps.push(rec);
}

if (out.ok) {
  out.next.push('Validate the TMDL: powerbi-modeling-mcp connection_operations ConnectFolder on the definition folder, then Disconnect.');
  if (!flag('--validate-report')) out.next.push(`Validate the report once: powerbi-report-author validate ${path.join(pbip, `${NAME}.Report`)} (or pass --validate-report).`);
  if ((choices.extras || {}).catalog || fs.existsSync(path.join(pbip, 'docs', 'catalog.xlsx'))) out.next.push('Rerun the catalog through the pbip-catalog skill (--missing-only, then the full run).');
  if (fs.existsSync(path.join(runDir, 'governance', `${NAME}_azdo_wiki.zip`))) out.next.push('Rerun parse_pbip.py + generate_azdo_wiki.py through the pbip-governance skill (the handover is already rebuilt).');
  if (out.stale.length || out.staleQuestions.length) out.next.unshift('Recompute the stale expected values from the source files, then: node rebuild.js <run> --checks-updated.');
} else if (out.failedAt === 'build-model' && out.steps[0].exitCode === 3) {
  out.next.push('The model folder is locked: Disconnect powerbi-modeling-mcp, close the project in Power BI Desktop, and run again from the repository root.');
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : (out.steps.find((x) => x.ok === false) || {}).exitCode || 1);
