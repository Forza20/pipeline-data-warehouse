#!/usr/bin/env node
// Optional: writes the Obsidian note of one /messy-pipeline run and refreshes the run list in the vault.
// Usage: node tools/update-vault.js runs/<run-id> [--site <url>] [--vault <path>] [--force] [--no-pull]
// Vault: --vault, else pipeline.config.json → obsidian.vault (only when obsidian.enabled is true), else env
// OBSIDIAN_VAULT. Notes go to <vault>/<folder>/Runs/<run-id>.md and the run list to <vault>/<folder>/Pipeline.md
// (folder = obsidian.folder, default "Pipeline"); Pipeline.md is created when missing. A run note is
// (re)written only when missing or when its frontmatter says `generated: true` (hand-written notes are kept
// unless --force). If the vault is a git repository, it runs `git pull --ff-only` first (skip with --no-pull);
// committing and pushing are left to the caller. No dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const runArg = args.find((a, i) => !a.startsWith('--') && !['--site', '--vault'].includes(args[i - 1]));
const runDir = path.resolve(runArg || '');
if (!runArg || !fs.existsSync(path.join(runDir, 'run.json'))) {
  console.error('Usage: node tools/update-vault.js runs/<run-id> [--site <url>] [--vault <path>] [--force]');
  process.exit(1);
}
const root = path.resolve(runDir, '..', '..');
const read = p => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const cfg = JSON.parse(read(path.join(root, 'pipeline.config.json')) || '{}');
const ob = cfg.obsidian || {};
const vaultPath = opt('--vault') || (ob.enabled ? ob.vault : null) || process.env.OBSIDIAN_VAULT;
if (!vaultPath) {
  console.log(JSON.stringify({ skipped: 'Obsidian is not enabled (pipeline.config.json → obsidian.enabled)' }));
  process.exit(0);
}
const vault = path.resolve(vaultPath);
if (!fs.existsSync(vault)) { console.error('update-vault: vault folder not found: ' + vault); process.exit(1); }
const folder = path.join(vault, ob.folder || 'Pipeline');
const force = args.includes('--force');

let pulled = 'skipped';
if (!args.includes('--no-pull') && fs.existsSync(path.join(vault, '.git'))) {
  try { execFileSync('git', ['-C', vault, 'pull', '--ff-only', '-q'], { stdio: ['ignore', 'pipe', 'pipe'] }); pulled = 'ok'; }
  catch (e) { pulled = 'failed: ' + String(e.stderr || e.message).trim().split('\n')[0]; console.error('update-vault: git pull --ff-only ' + pulled); }
}
const strip = s => (s || '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
const mdTable = t => (t || '').split('\n').filter(l => /^\|.*\|\s*$/.test(l.trim()))
  .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())).filter(c => !c.every(x => /^:?-{2,}:?$/.test(x)));
const section = (md, re) => { if (!md) return ''; const i = md.search(re); if (i < 0) return ''; const r = md.slice(i); const n = r.slice(3).search(/\n## /); return n < 0 ? r : r.slice(0, n + 3); };
const para = (md, startRe) => { if (!md) return ''; const m = md.match(startRe); if (!m) return ''; return md.slice(m.index).split(/\r?\n\s*\r?\n/)[0].replace(/\s*\r?\n\s*/g, ' '); };
const resultOf = (md, fallback) => ((md && (md.match(/\*\*Result:\s*([^*]+?)\*\*/) || [])[1]) || fallback).replace(/[.\s]+$/, '');

const run = JSON.parse(read(path.join(runDir, 'run.json')));
const id = run.run_id;
const sc = read(path.join(runDir, 'scorecard.md'));
const result = resultOf(sc, (run.steps && run.steps.score && run.steps.score.result) || 'not scored');
const lede = strip(para(sc, /\*\*Result:/).replace(/^\*\*Result:[^*]*\*\*\.?\s*/, ''));
const types = mdTable(section(sc, /\n## 1\. /)).slice(1).filter(r => /^\d+$/.test(r[0]))
  .map(r => ({ no: +r[0], name: strip(r[1]), injected: /^yes/i.test(r[2]), found: strip(r[4]), ok: /✅/.test(r[5]) }));
const nums = mdTable(section(sc, /\n## 3\. /)).slice(1).map(r => ({ key: strip(r[0]), facit: strip(r[1]), gold: strip(r[2]), expl: strip(r[r.length - 1]) }));
const injected = types.filter(t => t.injected);
const found = injected.filter(t => t.ok).length;

// stops from runs/overview.md, if present
const ov = read(path.join(root, 'runs', 'overview.md')) || '';
const shortId = id.replace(/^\d{4}-\d{2}-\d{2}_/, '');
const ovRow = mdTable(ov).find(r => strip(r[1]) === shortId || strip(r[1]) === id);
const stops = ovRow ? strip(ovRow[9]) : '';
const stopN = parseInt(stops, 10);
const site = opt('--site') || '';

// ---------- run note ----------
const noteDir = path.join(folder, 'Runs');
const notePath = path.join(noteDir, `${id}.md`);
const existing = read(notePath);
const isGenerated = existing && /^---[\s\S]*?\ngenerated:\s*true[\s\S]*?\n---/.test(existing);
let wrote = false;
if (!existing || isGenerated || force) {
  const fm = [
    '---', 'type: run', 'generated: true', `run: ${id}`, `domain: ${run.domain}`, `seed: ${run.seed}`, `rows: ${run.rows}`,
    `error_types: [${(run.errors || []).join(', ')}]`, `found: ${found}/${injected.length}`, `stops: ${isNaN(stopN) ? '' : stopN}`,
    `result: ${result}`, site ? `project_site: ${site}` : null, `folder: ${runDir}`, 'tags: [pipeline, run]', '---'
  ].filter(x => x !== null);
  const body = [
    `# ${id}`, '',
    'Back to [[Pipeline]]' + (site ? ` · [Project site](${site})` : ` · project site: \`runs/${id}/site.html\``) + ` · scorecard: \`runs/${id}/scorecard.md\``, '',
    `**${result}.** ${lede}`, '',
    '## Error types', '',
    ...types.map(t => `- ${t.no} ${t.name}: ${t.injected ? (t.ok ? '✅ found' : '⚠️ ' + (t.found || 'see scorecard')) : 'not injected'}`), '',
    '## Key numbers vs answer key', '',
    '| Key | Answer key | Gold | Explanation |', '|---|---|---|---|',
    ...nums.map(n => `| ${n.key} | ${n.facit} | ${n.gold} | ${n.expl} |`), '',
    stops ? `## Stops for the user\n\n${stops}\n` : '',
    '## Fixes', '', '<!-- the orchestrator adds approved fixes here -->', ''
  ];
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(notePath, fm.join('\n') + '\n\n' + body.join('\n'), 'utf8');
  wrote = true;
}

// ---------- run list ----------
const mocPath = path.join(folder, 'Pipeline.md');
let moc = read(mocPath);
if (!moc) {
  moc = '# Pipeline\n\nRuns of pipeline-data-warehouse (`/messy-pipeline`).\n\n## Runs\n<!-- runs:start -->\n<!-- runs:end -->\n';
}
const runsDir = path.join(root, 'runs');
const when = d => { const rj = JSON.parse(read(path.join(runsDir, d, 'run.json'))); return (rj.steps && rj.steps.publish && (rj.steps.publish.finished || rj.steps.publish.started)) || d; };
const runIds = fs.readdirSync(runsDir).filter(d => fs.existsSync(path.join(runsDir, d, 'run.json'))).sort((a, b) => when(b).localeCompare(when(a)));
const lines = runIds.map(d => {
  const rj = JSON.parse(read(path.join(runsDir, d, 'run.json')));
  const res = resultOf(read(path.join(runsDir, d, 'scorecard.md')), (rj.steps && rj.steps.score && rj.steps.score.result) || 'running');
  const row = mdTable(ov).find(r => strip(r[1]) === d.replace(/^\d{4}-\d{2}-\d{2}_/, '') || strip(r[1]) === d);
  const st = row ? parseInt(strip(row[9]), 10) : NaN;
  return `- [[${d}]] – ${rj.domain} · ${(rj.errors || []).length} error types · ${res}${isNaN(st) ? '' : ' · ' + st + ' stops'}`;
});
const never = para(ov, /\*\*Error types never tested/).replace(/^\*\*Error types never tested[^*]*\*\*\s*/, '');
const block = `<!-- runs:start – updated by tools/update-vault.js; do not edit here -->\n${lines.join('\n')}\n` +
  (never ? `\nError types never tested at full size: ${never.trim()}\n` : '') + '<!-- runs:end -->';
const next = moc.replace(/<!-- runs:start[\s\S]*?<!-- runs:end -->/, block);
const mocUpdated = next !== read(mocPath);
if (mocUpdated) { fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(mocPath, next, 'utf8'); }

console.log(JSON.stringify({ vault, pulled, note: path.relative(vault, notePath), wrote,
  keptHandWritten: !!existing && !isGenerated && !force, mocUpdated }));
