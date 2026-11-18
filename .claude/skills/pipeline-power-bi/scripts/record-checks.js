#!/usr/bin/env node
// record-checks.js – writes the result of checks.dax and grounded-answers.dax into the run's files, so nobody
// fills in "In Power BI" by hand, and says in one line whether every Difference is 0 (step 9).
//
//   node record-checks.js runs/<run-id> --checks <file|-> [--grounded <file|->] [--no-overview]
//   node record-checks.js runs/<run-id> --apply-only        (rebuild.js: write the saved result again)
//
// Input, per file – either way works:
//   A  JSON from powerbi-modeling-mcp dax_query_operations (Claude saves the tool result to a file): any JSON
//      holding an array of row objects; keys may be bracketed ("[Check]", "Checks[Difference]").
//   B  The result copied from DAX query view (right-click the result → Copy table) and pasted into a file:
//      tab-separated, header row first. Danish or English number format.
// Pass: a check passes when |Difference| < 0.005 (checks.dax rounds to 2 decimals); a question when
// |Difference| < 0.005, or < 0.00001 for an expected value below 1 (a percentage). A blank value fails.
//
// Writes check-results.json (with a fingerprint of the semantic model), the "In Power BI" and "Difference"
// columns and a result line in expected-values.md, the "In Power BI" lines and a result line in
// grounded-answers.md, then overview.html (build-overview.js) unless --no-overview. A later rebuild that
// changes the model marks the saved result as outdated ("run the checks again").
// Prints JSON: { ok, allZero, outdated, checks: { total, pass, fail[], missing[] }, questions: {…}, line }.
// Exit 0 = every Difference 0, 1 = a difference, a blank or a missing row, 2 = usage / no input.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--') && a !== '-');
const opt = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && (args[i + 1] === '-' || !args[i + 1].startsWith('--')) ? args[i + 1] : null; };
const usage = () => { console.error('usage: node record-checks.js runs/<run-id> --checks <file|-> [--grounded <file|->] [--no-overview] | --apply-only'); process.exit(2); };
if (!runDir || !fs.existsSync(path.join(runDir, 'choices.json'))) usage();
const applyOnly = args.includes('--apply-only');
const resultsFile = path.join(runDir, 'check-results.json');
const rd = (f) => { try { return fs.readFileSync(path.join(runDir, f), 'utf8'); } catch { return null; } };

// ---------- model fingerprint: every file of the semantic model's definition
function fingerprint() {
  const h = crypto.createHash('sha1');
  const pb = path.join(runDir, 'pbip');
  const sm = fs.existsSync(pb) ? fs.readdirSync(pb).find((d) => d.endsWith('.SemanticModel')) : null;
  if (!sm) return null;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else { h.update(path.relative(pb, p)); h.update(fs.readFileSync(p)); }
  });
  const def = path.join(pb, sm, 'definition');
  if (!fs.existsSync(def)) return null;
  walk(def);
  return h.digest('hex').slice(0, 16);
}

// ---------- reading a result (JSON from the MCP, or a pasted table)
const readInput = (f) => (f === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(f, 'utf8')).replace(/^﻿/, '');
const normKey = (k) => String(k).replace(/^.*\[/, '').replace(/\]$/, '').trim().toLowerCase();
function findRows(j) {
  const isRow = (r) => r && typeof r === 'object' && !Array.isArray(r) && Object.values(r).some((v) => v === null || typeof v !== 'object');
  if (Array.isArray(j) && j.length && j.every(isRow)) return j;
  if (Array.isArray(j)) { for (const x of j) { const r = findRows(x); if (r) return r; } return null; }
  if (j && typeof j === 'object') {
    // a table given as { columns: [...], rows: [[...]] }
    if (Array.isArray(j.columns) && Array.isArray(j.rows) && j.rows.every(Array.isArray)) {
      const cols = j.columns.map((c) => (typeof c === 'string' ? c : c.name || c.Name));
      return j.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
    }
    for (const v of Object.values(j)) { const r = findRows(v); if (r) return r; }
  }
  if (typeof j === 'string') { try { return findRows(JSON.parse(j)); } catch { return null; } }
  return null;
}
function parseTable(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l) => (l.includes('\t') ? l.split('\t') : l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')).map((c) => c.trim());
  const head = split(lines[0]);
  return lines.slice(1).filter((l) => !/^\s*\|?\s*-{3}/.test(l)).map((l) => { const c = split(l); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); });
}
function rowsOf(text) {
  const t = text.trim();
  if (/^[[{]/.test(t)) { try { const r = findRows(JSON.parse(t)); if (r) return r; } catch { /* not JSON – a pasted table */ } }
  return parseTable(t);
}
const get = (row, ...names) => { for (const [k, v] of Object.entries(row)) if (names.includes(normKey(k))) return v; return undefined; };

// a number in either format; with a known expected value and difference, the reading that agrees wins
function candidates(v) {
  if (v === null || v === undefined) return [];
  if (typeof v === 'number') return [v];
  if (typeof v === 'boolean') return [v ? 1 : 0];
  let s = String(v).trim().replace(/[\s %]/g, '').replace(/^−/, '-').replace(/^\((.*)\)$/, '-$1');
  if (!s || /^(blank|null|\(blank\))$/i.test(s)) return [];
  if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s) && !/^-?\d{1,3}(\.\d{3})+$/.test(s)) return [Number(s)];
  const en = Number(s.replace(/,/g, ''));
  const da = Number(s.replace(/\./g, '').replace(',', '.'));
  return [...new Set([en, da].filter((n) => Number.isFinite(n)))];
}
function pickValue(v, expected, diff) {
  const c = candidates(v);
  if (c.length < 2) return c[0];
  const d = candidates(diff);
  if (d.length) for (const x of c) for (const y of d) if (Math.abs((x - expected) - y) < 0.01) return x;
  return c.reduce((a, b) => (Math.abs(b - expected) < Math.abs(a - expected) ? b : a));
}

// ---------- what was expected: checks.dax and questions.json
const expChecks = [];
for (const line of (rd('checks.dax') || '').split(/\r?\n/)) {
  const m = line.match(/^\s*\(\s*"((?:[^"]|"")*)"\s*,.*,\s*(-?[0-9.]+(?:[eE][-+]?\d+)?)\s*\)\s*,?\s*$/);
  if (m) expChecks.push({ name: m[1].replace(/""/g, '"'), expected: Number(m[2]) });
}
let qs = []; try { const j = JSON.parse(rd('questions.json') || '[]'); qs = Array.isArray(j) ? j : j.questions || []; } catch { qs = []; }
const expQ = [];
qs.forEach((x, i) => {
  expQ.push({ no: i + 1, key: `${i + 1}`, question: x.question, expected: Number(x.expected) });
  if (x.role) expQ.push({ no: i + 1, key: `${i + 1} as ${x.role}`, role: x.role, question: `${x.question} – as ${x.role} (${x.role_user || ''})`, expected: Number(x.role_expected || 0) });
});

const tolCheck = () => 0.005;
const tolQ = (e) => (Math.abs(e) < 1 ? 0.00001 : 0.005);

function judge(list, rows, kind) {
  const out = [];
  for (const e of list) {
    let row;
    if (kind === 'check') row = rows.find((r) => String(get(r, 'check') ?? '').trim() === e.name);
    else row = rows.find((r) => Number(String(get(r, 'no') ?? '').trim()) === e.no &&
      (/ – as /.test(String(get(r, 'question') ?? '')) === !!e.role));
    if (!row) { out.push({ ...e, status: 'missing' }); continue; }
    const rawV = get(row, 'in power bi', 'value');
    const rawD = get(row, 'difference');
    const value = pickValue(rawV, e.expected, rawD);
    if (value === undefined) { out.push({ ...e, value: null, status: 'blank' }); continue; }
    const difference = Math.round((value - e.expected) * 1e6) / 1e6;
    const tol = kind === 'check' ? tolCheck() : tolQ(e.expected);
    out.push({ ...e, value, difference, status: Math.abs(difference) < tol ? 'pass' : 'fail' });
  }
  return out;
}

// ---------- record (or reload)
let saved;
if (applyOnly) {
  if (!fs.existsSync(resultsFile)) { console.log(JSON.stringify({ ok: true, skipped: 'no check-results.json yet' })); process.exit(0); }
  saved = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
} else {
  const cf = opt('--checks'); const gf = opt('--grounded');
  if (!cf && !gf) usage();
  const prev = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};
  saved = { recorded: new Date().toISOString().slice(0, 10), model: fingerprint(),
    checks: cf ? judge(expChecks, rowsOf(readInput(cf)), 'check') : (prev.model === fingerprint() ? prev.checks : null),
    questions: gf ? judge(expQ, rowsOf(readInput(gf)), 'question') : (prev.model === fingerprint() ? prev.questions : null) };
  fs.writeFileSync(resultsFile, JSON.stringify(saved, null, 1), 'utf8');
}

// a saved value whose expected number changed since, or a model changed since, is outdated
const outdated = saved.model !== fingerprint();
const reconcileExpected = (list, exp, keyOf) => (list || []).map((r) => {
  const e = exp.find((x) => keyOf(x) === keyOf(r));
  return e && e.expected !== r.expected ? { ...r, expected: e.expected, status: 'outdated' } : r;
});
const checks = reconcileExpected(saved.checks, expChecks, (x) => x.name);
const questions = reconcileExpected(saved.questions, expQ, (x) => x.key);
const sum = (list) => list && ({ total: list.length, pass: list.filter((x) => x.status === 'pass').length,
  fail: list.filter((x) => x.status !== 'pass').map((x) => `${x.name || `question ${x.key}`}: ${x.status}${x.status === 'fail' ? ` (Difference ${x.difference})` : ''}`) });
const C = sum(saved.checks ? checks : null); const Q = sum(saved.questions ? questions : null);
const allZero = !outdated && !!C && C.pass === C.total && C.total > 0 && (!Q || Q.pass === Q.total);
const parts = [C && `${C.pass}/${C.total} checks`, Q && `${Q.pass}/${Q.total} grounded answers`].filter(Boolean).join(' and ');
const line = outdated
  ? `> ⚠️ **Result ${saved.recorded} is outdated:** the model changed after the check. Refresh in Power BI Desktop and run the checks again.`
  : allZero ? `> ✅ **Result ${saved.recorded}:** ${parts}: Difference 0 – no errors.`
    : `> ❌ **Result ${saved.recorded}:** ${parts} pass. Not 0: ${[...(C ? C.fail : []), ...(Q ? Q.fail : [])].join('; ')}.`;

// ---------- write into the Markdown files
const fmt = (n) => (n === null || n === undefined ? '' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 6 }));
const mark = (r) => ({ pass: '✅ 0', fail: `❌ ${fmt(r.difference)}`, blank: '❌ blank', missing: '❌ not in result', outdated: '⚠️ expected changed' }[r.status] || '');
const qmark = (r) => mark(r).replace(/^(✅|❌) (?=[-\d])/, '$1 Difference ');
const setResultLine = (text, before) => {
  const lines = text.split('\n').filter((l) => !/^> (✅|❌|⚠️) \*\*Result/.test(l));
  const i = lines.findIndex(before);
  if (i < 0) return lines.join('\n');
  const add = lines[i - 1] === '' ? [line, ''] : ['', line, ''];
  lines.splice(i, 0, ...add);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
};
const files = [];
const ev = rd('expected-values.md');
if (ev && saved.checks) {
  let t = ev.split('\n').map((l) => {
    if (/^\| Check \| Expected \| Assumes \| In Power BI \|/.test(l)) return '| Check | Expected | Assumes | In Power BI | Difference |';
    if (/^\|---\|---\|---\|---\|/.test(l)) return '|---|---|---|---|---|';
    const m = l.match(/^\| (.*?) \| (.*?) \| (.*?) \|/);
    if (!m || m[1] === 'Check') return l;
    const name = m[1].replace(/ \((auto|stale)\)/g, '');
    const r = checks.find((x) => x.name === name);
    if (!r) return l;
    return `| ${m[1]} | ${m[2]} | ${m[3]} | ${fmt(r.value)} | ${outdated ? '⚠️ ' : ''}${mark(r)} |`;
  }).join('\n');
  t = setResultLine(t, (l) => /^\| Check \|/.test(l));
  fs.writeFileSync(path.join(runDir, 'expected-values.md'), t, 'utf8'); files.push('expected-values.md');
}
const ga = rd('grounded-answers.md');
if (ga && saved.questions) {
  let no = 0;
  let t = ga.split('\n').map((l) => {
    const h = l.match(/^## (\d+)\. /); if (h) no = Number(h[1]);
    if (/^- \*\*In Power BI( as .*)?:\*\*/.test(l) && no) {
      const r = questions.find((x) => x.no === no && !x.role);
      return r ? `- **In Power BI:** ${fmt(r.value)} – ${outdated ? '⚠️ ' : ''}${qmark(r)}` : l;
    }
    return l;
  }).join('\n');
  // the role row's result goes on its own line after the role rule (replaced on every run)
  t = t.split('\n').reduce((acc, l) => {
    if (/^- \*\*Role result:\*\*/.test(l)) return acc;
    acc.push(l);
    const h = l.match(/^## (\d+)\. /); if (h) acc.no = Number(h[1]);
    if (/^  Check in Desktop: Modeling → View as/.test(l)) {
      const r = questions.find((x) => x.no === acc.no && x.role);
      if (r) acc.push(`- **Role result:** ${fmt(r.value)} – ${outdated ? '⚠️ ' : ''}${qmark(r)} (DAX simulation; confirm with View as)`);
    }
    return acc;
  }, Object.assign([], { no: 0 })).join('\n');
  t = setResultLine(t, (l) => /^## 1\. /.test(l));
  fs.writeFileSync(path.join(runDir, 'grounded-answers.md'), t, 'utf8'); files.push('grounded-answers.md');
}

if (!applyOnly && !args.includes('--no-overview') && fs.existsSync(path.join(__dirname, 'build-overview.js'))) {
  const r = spawnSync('node', [path.join(__dirname, 'build-overview.js'), runDir], { encoding: 'utf8' });
  if (r.status === 0) files.push('overview.html');
}

console.log(JSON.stringify({ ok: true, allZero, outdated, recorded: saved.recorded, checks: C, questions: Q, line: line.replace(/^> /, ''), files }, null, 1));
process.exit(applyOnly ? 0 : allZero ? 0 : 1);
