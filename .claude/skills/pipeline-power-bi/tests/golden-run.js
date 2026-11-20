#!/usr/bin/env node
// Golden-run test for pipeline-power-bi: runs the whole headless chain on fixed inputs and compares what it
// writes with the snapshots in tests/golden/<case>/. Unit tests check each script; this catches a change in
// the generated model, the cleaning log or the expected numbers that no unit test looks at.
//
//   node .claude/skills/pipeline-power-bi/tests/golden-run.js            compare (exit 1 on any difference)
//   node .claude/skills/pipeline-power-bi/tests/golden-run.js --update   rewrite the snapshots after an intended change
//   node .claude/skills/pipeline-power-bi/tests/golden-run.js --case demo   one case only
//
// The chain per case is "Accept all recommended" without the questions:
//   Profile-Sources.ps1 (-Today fixed) → draft-spec.js --write → snake_case names (snake-names.js --apply)
//   → source-stats.js --apply (rows per table and the sum of every number column, as checks[]) → rebuild.js
// Cases: demo (demo/*.csv) and messy-retail-7919 (messy-dataset retail, seed 7919 – a seed no scored run uses, 2000 rows, end month 2026-09;
// its answer key is written to the temp folder and never read).
// Snapshots: the TMDL files, cleaning-log.md, expected-values.md, checks.dax, model-context.md,
// model-health.md and summary.json (findings, draft result, expected values). GUIDs, temp paths and
// timestamps are replaced by placeholders. Windows only (Windows PowerShell 5.1); needs Node and Python + openpyxl.
// Writes only to a temp folder and – with --update – to tests/golden/.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const REPO = path.resolve(SKILL, '..', '..', '..');
const S = path.join(SKILL, 'scripts');
const GOLDEN = path.join(__dirname, 'golden');
const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const onlyCase = (() => { const i = args.indexOf('--case'); return i >= 0 ? args[i + 1] : null; })();
const TODAY = '2026-11-19';
const py = process.env.PYTHON || 'python';

const CASES = [
  { name: 'demo', model: 'Demo', source: () => path.join(REPO, 'demo'), files: ['orders.csv', 'customers.csv'] },
  {
    name: 'messy-retail-7919', model: 'Retail',
    source: (tmp) => {
      const out = path.join(tmp, 'source');
      run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(REPO, '.claude', 'skills', 'messy-dataset', 'scripts', 'New-MessyDataset.ps1'),
        '-Domain', 'retail', '-Seed', '7919', '-Rows', '2000', '-EndMonth', '2026-09',
        '-OutDir', out, '-AnswersDir', path.join(tmp, 'answers'), '-RunId', 'golden'], 'messy-dataset');
      return out;
    },
  },
];

function run(cmd, a, label) {
  const r = spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHON: py } });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}):\n${(r.stderr || r.stdout || String(r.error)).slice(0, 2000)}`);
  return r.stdout;
}
const json = (s) => JSON.parse(s.replace(/^﻿/, ''));
const readJson = (f) => json(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n');

function buildCase(c) {
  // realpath: os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1\…) while the scripts write the long one.
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `golden-${c.name}-`)));
  const runDir = path.join(tmp, 'run');
  fs.mkdirSync(runDir);
  const src = c.source(tmp);
  const srcPath = c.files ? c.files.map((f) => path.join(src, f)).join(',') : src;

  run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(S, 'Profile-Sources.ps1'),
    '-Path', srcPath, '-OutFile', path.join(runDir, 'profile.json'), '-RowsDir', path.join(runDir, 'rows'), '-Today', TODAY], 'profiler');
  const draft = json(run('node', [path.join(S, 'draft-spec.js'), runDir, '--write', '--name', c.model], 'draft-spec'));

  const cf = path.join(runDir, 'choices.json');
  const choices = readJson(cf);
  choices.build.naming = 'snake_case';
  writeJson(cf, choices);
  run('node', [path.join(S, 'snake-names.js'), runDir, '--apply'], 'snake-names');

  // Expected values from the source files: rows per model table, sum of each number column.
  const spec = readJson(cf).build;
  const queries = [];
  for (const t of spec.tables) {
    queries.push({ name: `${t.name} rows`, table: t.name, agg: 'rows', check: { dax: `COUNTROWS ( '${t.name}' )` } });
    for (const col of t.columns || []) {
      if (['number', 'decimal', 'currency', 'int'].includes(col.type) && !/(^|_)(id|key|code|no)$/.test(col.name)) {
        queries.push({ name: `${t.name} sum of ${col.name}`, table: t.name, agg: 'sum', column: col.name,
          check: { dax: `SUM ( '${t.name}'[${col.name}] )` } });
      }
    }
  }
  const qf = path.join(runDir, 'golden-queries.json');
  writeJson(qf, queries);
  const stats = json(run('node', [path.join(S, 'source-stats.js'), runDir, '--queries', qf, '--apply'], 'source-stats'));

  const rb = json(run('node', [path.join(S, 'rebuild.js'), runDir], 'rebuild'));
  if (!rb.ok) throw new Error(`rebuild failed at ${rb.failedAt}: ${JSON.stringify(rb.steps.find((s) => !s.ok))}`);

  // A messy dataset has an answer key: score the run (exit 1 = Failed is a result, not an error here).
  const answers = path.join(tmp, 'answers');
  if (fs.existsSync(answers)) {
    const sr = spawnSync('node', [path.join(S, 'score-run.js'), runDir, '--answers', answers], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (sr.status > 1) throw new Error(`score-run failed (exit ${sr.status}):\n${(sr.stderr || sr.stdout).slice(0, 2000)}`);
    // the run gets its row in runs/overview.md (here: the temp folder's overview.md), once, after a second scoring too
    spawnSync('node', [path.join(S, 'score-run.js'), runDir, '--answers', answers], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ov = fs.existsSync(path.join(path.dirname(runDir), 'overview.md')) ? fs.readFileSync(path.join(path.dirname(runDir), 'overview.md'), 'utf8') : '';
    const runRows = ov.split(/\r?\n/).filter((l) => l.includes(`[${path.basename(runDir)}](`));
    if (runRows.length !== 1 || !/\| \d+\/\d+ \|/.test(runRows[0])) throw new Error(`score-run: expected one overview.md row for the run, got ${runRows.length}:\n${ov.slice(0, 800)}`);
  }

  const profile = readJson(path.join(runDir, 'profile.json'));
  const summary = {
    tables: profile.tables.map((t) => ({
      name: t.name, kind: t.kind, dataRows: t.dataRows, columns: (t.columns || []).length,
      findings: (t.findings || []).map((f) => `${f.fix} ${f.column || '-'} rows=${f.rows} rec=${f.recommended} ${f.variant || ''}`.trim()),
    })),
    relations: (profile.relations || []).map((r) => `${r.from} -> ${r.to} ${r.cardinality} by ${r.matchedBy} preferred=${r.preferred} matched=${r.matchedIds} orphanRows=${r.orphanRows}`),
    draft: { staging: draft.staging, tables: draft.tables, relationships: draft.relationships, steps: draft.steps,
      model: draft.model.map((m) => `${m.table} ${m.fix} ${m.column || '-'}`), skipped: draft.skipped.map((m) => `${m.table} ${m.fix} ${m.column || '-'}: ${m.reason}`) },
    expected: stats.results.map((r) => ({ name: r.name, value: r.value, approx: !!r.approx })),
    rebuildSteps: rb.steps.map((s) => `${s.step} ${s.ok ? 'ok' : 'FAILED'}${s.skipped ? ' (skipped)' : ''}`),
  };

  const files = { 'summary.json': JSON.stringify(summary, null, 1) + '\n' };
  for (const f of ['cleaning-log.md', 'expected-values.md', 'checks.dax', 'model-context.md', 'model-health.md', 'scorecard.md']) {
    const p = path.join(runDir, f);
    if (fs.existsSync(p)) files[f] = fs.readFileSync(p, 'utf8');
  }
  const def = path.join(runDir, 'pbip', `${c.model}.SemanticModel`, 'definition');
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith('.tmdl')) files[`tmdl/${r}`] = fs.readFileSync(path.join(d, e.name), 'utf8');
    }
  };
  walk(def);

  const norm = normalizer([[runDir, '<RUN>'], [src, '<SRC>'], [tmp, '<TMP>']]);
  for (const k of Object.keys(files)) files[k] = norm(files[k]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return files;
}

function normalizer(pairs) {
  const variants = [];
  for (const [p, tag] of pairs) {
    const fwd = p.replace(/\\/g, '/');
    const back = p.replace(/\//g, '\\');
    for (const v of new Set([p, fwd, back, back.replace(/\\/g, '\\\\'), JSON.stringify(back).slice(1, -1)])) variants.push([v, tag]);
  }
  variants.sort((a, b) => b[0].length - a[0].length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (text) => {
    let t = text.replace(/\r\n/g, '\n');
    for (const [v, tag] of variants) t = t.replace(new RegExp(esc(v), 'gi'), tag);
    return t
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
      .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<timestamp>')
      .replace(/golden-[a-z0-9-]+-[A-Za-z0-9]{6}/g, '<TMP>');
  };
}

function firstDiff(a, b) {
  const x = a.split('\n'); const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}\n    snapshot: ${JSON.stringify(x[i] ?? '<end of file>')}\n    now:      ${JSON.stringify(y[i] ?? '<end of file>')}`;
  }
  return '';
}

let failed = 0;
for (const c of CASES.filter((x) => !onlyCase || x.name === onlyCase)) {
  const t0 = Date.now();
  let files;
  try { files = buildCase(c); } catch (e) { console.log(`FAIL ${c.name}: ${e.message}`); failed++; continue; }
  const dir = path.join(GOLDEN, c.name);
  if (UPDATE) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(files)) { const p = path.join(dir, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, v); }
    console.log(`updated ${c.name}: ${Object.keys(files).length} files (${Date.now() - t0} ms)`);
    continue;
  }
  const want = new Set();
  const walk = (d, rel = '') => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else want.add(r); } };
  walk(dir);
  const problems = [];
  if (!want.size) problems.push(`no snapshot in tests/golden/${c.name} – run with --update once`);
  for (const k of want) if (!(k in files)) problems.push(`${k}: no longer written`);
  for (const [k, v] of Object.entries(files)) {
    if (!want.has(k)) { problems.push(`${k}: new file, not in the snapshot`); continue; }
    const old = fs.readFileSync(path.join(dir, k), 'utf8').replace(/\r\n/g, '\n');
    if (old !== v) problems.push(`${k}: differs at ${firstDiff(old, v)}`);
  }
  if (problems.length) { failed++; console.log(`FAIL ${c.name}\n  ${problems.join('\n  ')}`); }
  else console.log(`ok   ${c.name}: ${Object.keys(files).length} files match (${Date.now() - t0} ms)`);
}
if (failed && !UPDATE) console.log('\nIntended change? Rerun with --update and review the snapshot diff in git before committing.');
process.exit(failed ? 1 : 0);
