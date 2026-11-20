#!/usr/bin/env node
// Stand-alone check: copies a skill alone into an empty temp folder and runs its entry script.
//   node .claude/skills/pipeline-power-bi/tests/standalone.js
// Skills meant to run alone must work with no sibling skill. Skills with a declared dependency must fail
// with a clear message when it is missing and work when it is next to them. Writes only to a temp folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILLS = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-'));
let pass = 0;
const fails = [];
const check = (name, ok, info) => { if (ok) pass++; else fails.push(`${name}${info ? ' – ' + String(info).slice(0, 300) : ''}`); };

function install(names, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const n of names) {
    fs.cpSync(path.join(SKILLS, n), path.join(dest, n), {
      recursive: true,
      filter: (src) => !/__pycache__|[\\/]templates[\\/]|[\\/]runs[\\/]/.test(src),
    });
  }
}
const run = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, ...opts });
const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

// pbip-governance alone: its parser starts without any sibling skill.
{
  const d = path.join(TMP, 'gov'); install(['pbip-governance'], d);
  const r = run('python', ['-X', 'utf8', path.join(d, 'pbip-governance', 'scripts', 'parse_pbip.py'), '--help']);
  check('pbip-governance alone: parse_pbip.py starts', r.status === 0, out(r));
}

// messy-dataset alone: plan-only run.
{
  const d = path.join(TMP, 'messy'); install(['messy-dataset'], d);
  const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(d, 'messy-dataset', 'scripts', 'New-MessyDataset.ps1'), '-Seed', '1', '-PlanOnly']);
  check('messy-dataset alone: -PlanOnly works', r.status === 0 && /domain/i.test(out(r)), out(r));
}

// pbip-catalog: needs pbip-governance. Alone = clear message; with it = parser found.
{
  const fake = path.join(TMP, 'fake-pbip'); fs.mkdirSync(fake, { recursive: true });
  const alone = path.join(TMP, 'cat-alone'); install(['pbip-catalog'], alone);
  const r1 = run('python', ['-X', 'utf8', path.join(alone, 'pbip-catalog', 'scripts', 'build_catalog.py'), fake]);
  // the global ~/.claude install may legitimately supply the parser; only judge when it cannot
  const globalParser = fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'pbip-governance', 'scripts', 'parse_pbip.py'));
  if (!globalParser) check('pbip-catalog without pbip-governance: clear error', /pbip-governance/.test(out(r1)) && r1.status !== 0, out(r1));
  const both = path.join(TMP, 'cat-both'); install(['pbip-catalog', 'pbip-governance'], both);
  const r2 = run('python', ['-X', 'utf8', path.join(both, 'pbip-catalog', 'scripts', 'build_catalog.py'), fake]);
  check('pbip-catalog with pbip-governance: parser found', !/Could not find pbip-governance/.test(out(r2)), out(r2));
}

// pipeline-power-bi: its parser-based scripts need pbip-governance.
{
  const alone = path.join(TMP, 'ppbi-alone'); install(['pipeline-power-bi'], alone);
  const script = path.join(alone, 'pipeline-power-bi', 'scripts', 'pbip_sources.py');
  const r1 = run('python', ['-X', 'utf8', script, fake()]);
  check('pipeline-power-bi without pbip-governance: clear error', /pbip-governance skill next to this one/.test(out(r1)), out(r1));
  const both = path.join(TMP, 'ppbi-both'); install(['pipeline-power-bi', 'pbip-governance'], both);
  const r2 = run('python', ['-X', 'utf8', path.join(both, 'pipeline-power-bi', 'scripts', 'pbip_sources.py'), fake()]);
  check('pipeline-power-bi with pbip-governance: parser found', !/pbip-governance skill next to this one/.test(out(r2)), out(r2));
}
// Auto-activation: every related skill can be loaded by the Skill tool in a run (no disable-model-invocation),
// pipeline-power-bi names it as a Skill call, and it says how it runs alone.
{
  const RELATED = ['analysis-planning', 'schema-dummy-data', 'messy-dataset', 'pbip-layout', 'pbip-catalog', 'pbip-governance', 'reconcile'];
  const main = fs.readFileSync(path.join(SKILLS, 'pipeline-power-bi', 'SKILL.md'), 'utf8');
  for (const n of RELATED) {
    const f = path.join(SKILLS, n, 'SKILL.md');
    if (!fs.existsSync(f)) { check(`${n}: installed`, false, f); continue; }
    const front = (fs.readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
    check(`${n}: model can load it (no disable-model-invocation)`, !/^disable-model-invocation:\s*true/m.test(front), front.slice(0, 120));
    check(`${n}: listed as auto-loaded in pipeline-power-bi`, new RegExp('\\|\\s*`' + n + '`\\s*\\|').test(main));
  }
  check('step 6 runs layout, catalog and governance without a question', /related skills run automatically/i.test(main));
  check('a loaded skill in another language does not change the run language', /principle 7 still wins/.test(main));
}

// schema-dummy-data alone: plan-only run on its own fixture.
{
  const d = path.join(TMP, 'dummy'); install(['schema-dummy-data'], d);
  const fx = path.join(d, 'schema-dummy-data', 'tests', 'fixtures');
  const schema = fs.existsSync(fx) ? fs.readdirSync(fx).find((x) => /\.(xlsx|csv)$/i.test(x)) : null;
  if (schema) {
    const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(d, 'schema-dummy-data', 'scripts', 'New-DummyData.ps1'), '-SchemaPath', path.join(fx, schema),
      '-OutDir', path.join(d, 'out'), '-Locale', 'en', '-PlanOnly']);
    check('schema-dummy-data alone: -PlanOnly works', r.status === 0 && /"tables"|role/i.test(out(r)), out(r));
  } else check('schema-dummy-data: fixture found', false, fx);
}

function fake() { const p = path.join(TMP, 'empty-pbip'); fs.mkdirSync(path.join(p, 'X.SemanticModel', 'definition'), { recursive: true }); return p; }

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log(`${pass} passed, ${fails.length} failed`);
fails.forEach((f) => console.log('FAIL: ' + f));
process.exit(fails.length ? 1 : 0);
