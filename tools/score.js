#!/usr/bin/env node
// Compares the gold numbers of a run (runs/<id>/medallion/docs/expected-values.json, written by
// medallion-builder) with the answer key, and prints the "Numbers" table for the scorecard (Markdown) plus a
// one-line JSON summary on stderr. The answer key is read with `git show` into memory only and is never
// written to disk. Run `git -C datasets fetch origin` first.
// Usage: node tools/score.js runs/<run-id>
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const runDir = path.resolve(process.argv[2] || '');
const runFile = path.join(runDir, 'run.json');
if (!process.argv[2] || !fs.existsSync(runFile)) {
  console.error('Usage: node tools/score.js runs/<run-id>  (folder with run.json)');
  process.exit(1);
}
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const run = readJson(runFile);
const root = path.resolve(runDir, '..', '..');
const cfgFile = path.join(root, 'pipeline.config.json');
const cfg = fs.existsSync(cfgFile) ? readJson(cfgFile) : {};
const culture = run.culture || (cfg.locale && cfg.locale.culture) || 'en-US';
const goldFile = path.join(runDir, 'medallion', 'docs', 'expected-values.json');
if (!fs.existsSync(goldFile)) { console.error('missing: ' + goldFile); process.exit(1); }
const gold = readJson(goldFile);

let facit;
try {
  facit = JSON.parse(execFileSync('git', ['-C', path.join(root, 'datasets'), 'show',
    `origin/main:answers/${run.run_id}/expected_values.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
} catch { console.error('answer key not found on origin/main for ' + run.run_id); process.exit(1); }

const SKIP = new Set(['run_id', 'domain', 'seed', 'reference_rules', 'revenue_statuses']);
const isNum = v => typeof v === 'number';
let loc = culture;
try { (1).toLocaleString(loc); } catch { loc = 'en-US'; }
const fmt = v => v === undefined || v === null ? '–'
  : isNum(v) ? v.toLocaleString(loc, { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })
  : String(v);
const same = (a, b) => isNum(a) && isNum(b) ? Math.abs(a - b) < 0.005 : String(a) === String(b);
const diff = (a, b) => isNum(a) && isNum(b) ? (b - a >= 0 ? '+' : '') + fmt(Math.round((b - a) * 100) / 100) : 'differs';

const rows = [], diffs = [];
let equal = 0;
function cmp(key, f, g) {
  if (same(f, g)) { equal++; rows.push([key, fmt(f), fmt(g), '0', '–']); return; }
  diffs.push(key);
  rows.push([key, fmt(f), fmt(g), g === undefined ? 'missing in gold' : diff(f, g), '**?**']);
}
for (const [key, f] of Object.entries(facit)) {
  if (SKIP.has(key)) continue;
  const g = gold[key];
  if (f && typeof f === 'object' && !Array.isArray(f)) {
    const subs = Object.keys(f);
    const bad = subs.filter(s => !same(f[s], g && g[s]));
    if (!bad.length) {
      // all equal: one row for the group
      equal += subs.length;
      rows.push([key, `${subs.length} values`, `all ${subs.length} equal`, '0', '–']);
    } else if (key === 'revenue_by_month' && bad.length > 3) {
      // many months: one summary row instead of one per month
      const sum = bad.reduce((t, s) => t + (((g && g[s]) || 0) - f[s]), 0);
      equal += subs.length - bad.length;
      diffs.push(...bad.map(s => key + '.' + s));
      rows.push([key, `${subs.length} months`, `${subs.length - bad.length} equal`,
        `${bad.length} differ, total ${diff(0, Math.round(sum * 100) / 100)} (e.g. ${bad[0]}: ${fmt(f[bad[0]])} → ${fmt(g && g[bad[0]])})`, '**?**']);
    } else for (const s of subs) cmp(`${key}.${s}`, f[s], g && g[s]);
  } else cmp(key, f, g);
}

const esc = s => String(s).replace(/\|/g, '\\|');
console.log('| Key | Answer key | Gold | Difference | Explanation |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log('| ' + r.map(esc).join(' | ') + ' |');
const months = diffs.filter(d => d.startsWith('revenue_by_month.')).length;
const shortDiffs = diffs.filter(d => !d.startsWith('revenue_by_month.')).concat(months ? [`revenue_by_month (${months})`] : []);
console.error(JSON.stringify({ keys: equal + diffs.length, equal, diffs: shortDiffs }));
