#!/usr/bin/env node
// Expected values and evidence from the SOURCE files, with the kept cleaning steps – never from the model.
// One call instead of a hand-written script per run (step 4b.5 evidence, step 8.2 checks[], step 8.9
// grounded questions, "Add or change a measure").
//
//   node source-stats.js runs/<run-id> [--queries <file.json> | --q '<json>'] [--raw] [--apply] [--tables a,b]
//
// Rows: the rows Profile-Sources.ps1 exported with -RowsDir (profile.json -> tables[].rowsFile, in
// runs/<run-id>/rows/). Missing: the script runs the profiler once with -RowsDir on the run's data/ folder.
//
// Tables:
//   with choices.json -> build: every staging query (stg_…) with its steps (F03–F28 as build-model.js writes
//     them) and every model table (tables[]: merge, select, distinct, filter, addKey, addColumn, transform,
//     inferMembers, then the final column names). Names are the spec's (snake_case after snake-names.js).
//   --raw (or no build spec yet, step 4b): each profile table by its profile name, only empty and total rows
//     removed; values stay text and are read as numbers/dates where a query needs it.
//
// Queries (a JSON list; without queries: rows and per-column basics of every table):
//   { "name": "Total sales", "table": "fact_sales", "agg": "sum", "column": "amount",
//     "where": "[amount_issue] = \"ok\" and [order_date] >= #date(2025, 1, 1)",      M condition (optional)
//     "join": [{ "table": "dim_customer", "on": "customer_id", "withOn": "customer_id", "columns": ["region"] }],
//     "by": "region",                                                                 one value per member (optional)
//     "check": { "dax": "[total_sales]", "assumes": "F09, F14 flag" },                with --apply: upsert into checks[]
//     "question": 2 }                                                                 with --apply: questions.json[1].expected
//   agg: rows | count (non-blank) | blank | distinct | sum | avg | min | max
//   join: left join, first match per key, case-insensitive; the joined columns are added (a name the table
//   already has gets the prefix "<table>.").
//
// M in where / filter / addColumn / transform: if-then-else, and/or/not, = <> < > <= >=, + - * / &, null,
// true/false, numbers, "text", [Column], _, #date(y,m,d), {lists} and Text.Lower/Upper/Trim/From/Start/End/
// Contains/StartsWith, Number.From/Round/Abs, Date.Year/Month/Day/StartOfMonth/From, List.Contains. Anything
// else: the step is skipped, named in `unsupported`, and the numbers of that table are marked approximate.
//
// Prints JSON: { ok, mode, tables: { name: { rows, approx, unsupported[], columns{} } }, results[], applied, warnings[] }.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const runDir = path.resolve(args[0] || '');
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i > 0 && args[i + 1] !== undefined ? args[i + 1] : null; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const tryOr = (f, d = null) => { try { return f(); } catch { return d; } };
const choicesFile = path.join(runDir, 'choices.json');
if (!args[0] || !fs.existsSync(runDir)) { console.error('Usage: node source-stats.js runs/<run-id> [--queries <file>] [--raw] [--apply]'); process.exit(2); }
const choices = fs.existsSync(choicesFile) ? readJson(choicesFile) : {};
const B = choices.build || null;
const RAW = flag('--raw') || !B;
const warnings = [];

// ---------------------------------------------------------------------------------------------------
// Rows from the profiler's export
// ---------------------------------------------------------------------------------------------------
function profileWithRows() {
  const dir = path.join(runDir, 'rows');
  const src = [path.join(runDir, 'data'), path.join(runDir, 'source'), B && B.sourceFolder, choices.source_folder]
    .filter(Boolean).map((x) => path.resolve(x)).find((x) => fs.existsSync(x));
  // a source file changed after the export: export again
  const newest = src ? Math.max(0, ...fs.readdirSync(src).map((f) => tryOr(() => fs.statSync(path.join(src, f)).mtimeMs, 0))) : 0;
  for (const pf of [path.join(runDir, 'profile.json'), path.join(dir, 'profile.rows.json')]) {
    if (!fs.existsSync(pf)) continue;
    const p = readJson(pf);
    const files = (p.tables || []).filter((t) => t.rowsFile).map((t) => path.join(dir, t.rowsFile));
    if (files.length && files.every((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= newest)) return { p, dir };
  }
  // export once: profile the run's data folder (or the build's source folder) into rows/
  if (!src) { console.error('No rows export and no data/ folder to profile'); process.exit(2); }
  const out = path.join(dir, 'profile.rows.json');
  fs.mkdirSync(dir, { recursive: true });
  const ps1 = path.join(__dirname, 'Profile-Sources.ps1');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Path', src, '-OutFile', out, '-RowsDir', dir,
    ...(B && B.cutoffDate ? ['-Today', B.cutoffDate] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error('Profile-Sources.ps1 -RowsDir failed:\n' + (r.stderr || r.stdout).slice(-1500)); process.exit(1); }
  warnings.push(`rows exported once from ${path.relative(process.cwd(), src)} to ${path.relative(process.cwd(), dir)}`);
  return { p: readJson(out), dir };
}
const { p: PROFILE, dir: ROWS_DIR } = profileWithRows();
const rowsCache = new Map();
function loadRows(t) {
  if (!rowsCache.has(t.rowsFile)) rowsCache.set(t.rowsFile, readJson(path.join(ROWS_DIR, t.rowsFile)));
  return rowsCache.get(t.rowsFile);
}
const base = (f) => path.basename(String(f || '')).toLowerCase();
function findSource(file, kind, item) {
  return (PROFILE.tables || []).find((t) => t.rowsFile && base(t.file) === base(file) && (
    kind === 'csv' || t.kind === 'csv' ? t.kind === 'csv'
      : kind === 'excel table' ? t.excelTable === item
        : t.sheet === item && !t.excelTable));
}

// ---------------------------------------------------------------------------------------------------
// Values: text | number | boolean | null | Date (UTC midnight)
// ---------------------------------------------------------------------------------------------------
const isDate = (v) => v instanceof Date;
const mkDate = (y, m, d) => {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) throw new Error('bad date');
  const x = new Date(Date.UTC(y, m - 1, d));
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== d) throw new Error('bad date');
  return x;
};
const iso = (d) => d.toISOString().slice(0, 10);
const show = (v) => (isDate(v) ? iso(v) : typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

// source-model.md – the same rules as the M functions
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, maj: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12 };
function fnParseDate(value, dayFirst = true) {
  return tryOr(() => {
    if (value === null || value === undefined) return null;
    if (isDate(value)) return value;
    if (typeof value === 'number') {
      if (!(value >= 19000101 && value < 21000101)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 864e5);
      value = String(Math.floor(value));
    }
    const t = String(value).trim();
    if (t === '') return null;
    const isNum = (x) => x !== '' && /^[0-9]+$/.test(x);
    if (isNum(t) && t.length === 8) return mkDate(+t.slice(0, 4), +t.slice(4, 6), +t.slice(6, 8));
    const parts = t.split(/[-./ ,]/).filter((x) => x !== '');
    if (parts.length < 3) return null;
    const num2 = (x) => +x.slice(0, 2).replace(/[^0-9]/g, '');
    const monthOf = (x) => MONTHS[x.slice(0, 3).toLowerCase()] || NaN;
    if (isNum(parts[0]) && parts[0].length === 4) return mkDate(+parts[0], +parts[1], num2(parts[2]));
    if (!isNum(parts[0])) return mkDate(+parts[2], monthOf(parts[0]), +parts[1]);
    if (!isNum(parts[1])) return mkDate(+parts[2], monthOf(parts[1]), +parts[0]);
    const a = +parts[0]; const b = +parts[1]; const y = +parts[2].slice(0, 4);
    const df = a > 12 ? true : b > 12 ? false : dayFirst;
    return df ? mkDate(y, b, a) : mkDate(y, a, b);
  });
}
function fnParseNumber(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || typeof value === 'boolean' || isDate(value)) return null;
  const raw = String(value).trim();
  const neg = raw.startsWith('(') && raw.endsWith(')');
  const c = raw.replace(/[^0-9.,-]/g, '');
  const lastDot = c.lastIndexOf('.'); const lastComma = c.lastIndexOf(',');
  const dots = (c.match(/\./g) || []).length; const commas = (c.match(/,/g) || []).length;
  const dec = dots > 0 && commas > 0 ? (lastDot > lastComma ? '.' : ',')
    : commas === 1 && c.length - lastComma - 1 !== 3 ? ',' : dots === 1 ? '.' : null;
  const thou = dec === '.' ? ',' : dec === ',' ? '.' : commas > 0 ? ',' : '.';
  let n = c.split(thou).join('');
  if (dec) n = n.split(dec).join('.');
  if (n === '' || n === '-' || !/^-?[0-9]*\.?[0-9]+$|^-?[0-9]+\.?$/.test(n)) return null;
  const x = Number(n);
  return Number.isFinite(x) ? (neg ? -x : x) : null;
}
function fnParseBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return null;
  const t = String(value).trim().toLowerCase();
  if (t === '') return null;
  if (['true', 'yes', 'y', 't', '1', 'ja', 'j', 'sand', 'x'].includes(t)) return true;
  if (['false', 'no', 'n', 'f', '0', 'nej', 'falsk'].includes(t)) return false;
  return null;
}
function fnNormaliseId(value, prefix, sep, digits) {
  const t = value === null || value === undefined ? '' : String(show(value)).trim();
  const num = t.replace(/[^0-9]/g, '');
  if (t === '') return null;
  if (num === '') return t;
  return prefix + sep + String(BigInt(num)).padStart(digits, '0');
}
// F17: Table.TransformColumnTypes with the source culture
function toType(v, type, culture) {
  if (v === null || v === undefined) return null;
  const da = /^(da|de|nb|nn|sv|fi|fr|es|it|nl|pt)/i.test(culture || 'en-US');
  const num = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'boolean' || isDate(x)) return null;
    let s = String(x).trim().replace(/\s/g, '');
    s = da ? s.split('.').join('').replace(',', '.') : s.split(',').join('');
    if (!/^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?%?$/.test(s)) throw new Error(`not a number: ${x}`);
    return s.endsWith('%') ? Number(s.slice(0, -1)) / 100 : Number(s);
  };
  switch (type) {
    case 'int': case 'key': { const n = num(v); return Math.round(n); }
    case 'number': case 'currency': case 'percent': return num(v);
    case 'date': case 'datetime': {
      if (isDate(v)) return v;
      if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 864e5);
      const s = String(v).trim();
      let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) return mkDate(+m[1], +m[2], +m[3]);
      m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
      if (m) return da ? mkDate(+m[3], +m[2], +m[1]) : mkDate(+m[3], +m[1], +m[2]);
      const d = fnParseDate(s, da);
      if (d) return d;
      throw new Error(`not a date: ${v}`);
    }
    case 'bool': {
      if (typeof v === 'boolean') return v;
      const t = String(v).trim().toLowerCase();
      if (t === 'true') return true; if (t === 'false') return false;
      throw new Error(`not true/false: ${v}`);
    }
    default: return isDate(v) ? iso(v) : typeof v === 'string' ? v : String(v);
  }
}

// ---------------------------------------------------------------------------------------------------
// A small M expression evaluator (the subset the specs use in filters and added columns)
// ---------------------------------------------------------------------------------------------------
class Unsupported extends Error {}
function tokenize(src) {
  const toks = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') { let s = ''; i++; while (i < src.length) { if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } break; } s += src[i++]; } i++; toks.push({ t: 'str', v: s }); continue; }
    if (c === '[') { const j = src.indexOf(']', i); if (j < 0) throw new Unsupported('['); let n = src.slice(i + 1, j).trim(); if (/^#"/.test(n)) n = n.slice(2, -1).replace(/""/g, '"'); toks.push({ t: 'col', v: n }); i = j + 1; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) { const m = src.slice(i).match(/^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/); toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    const two = src.slice(i, i + 2);
    if (['<>', '<=', '>=', '=>'].includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if ('=<>+-*/&(),{}'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    const m = src.slice(i).match(/^#?[A-Za-z_][A-Za-z0-9_.]*/);
    if (m) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    throw new Unsupported(`character ${c}`);
  }
  return toks;
}
const mEq = (a, b) => {
  if (a === null || b === null) return a === b;
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (typeof a !== typeof b) return false;
  return a === b;
};
const mCmp = (a, b) => {
  if (a === null || b === null) return null;
  const x = isDate(a) ? a.getTime() : a; const y = isDate(b) ? b.getTime() : b;
  if (typeof x !== typeof y) throw new Error('compare of different types');
  return x < y ? -1 : x > y ? 1 : 0;
};
const FUNCS = {
  'Text.Lower': (s) => (s === null ? null : String(s).toLowerCase()),
  'Text.Upper': (s) => (s === null ? null : String(s).toUpperCase()),
  'Text.Trim': (s) => (s === null ? null : String(s).trim()),
  'Text.From': (s) => (s === null ? null : isDate(s) ? iso(s) : String(s)),
  'Text.Start': (s, n) => (s === null ? null : String(s).slice(0, n)),
  'Text.End': (s, n) => (s === null ? null : String(s).slice(-n)),
  'Text.Contains': (s, x) => (s === null ? null : String(s).includes(x)),
  'Text.StartsWith': (s, x) => (s === null ? null : String(s).startsWith(x)),
  'Number.From': (s) => (s === null ? null : typeof s === 'number' ? s : typeof s === 'boolean' ? (s ? 1 : 0) : fnParseNumber(s)),
  'Number.Round': (n, d = 0) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d),
  'Number.Abs': (n) => (n === null ? null : Math.abs(n)),
  'Date.Year': (d) => (d === null ? null : d.getUTCFullYear()),
  'Date.Month': (d) => (d === null ? null : d.getUTCMonth() + 1),
  'Date.Day': (d) => (d === null ? null : d.getUTCDate()),
  'Date.StartOfMonth': (d) => (d === null ? null : mkDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
  'Date.From': (d) => (d === null ? null : isDate(d) ? d : toType(d, 'date', 'en-US')),
  '#date': (y, m, d) => mkDate(y, m, d),
  'List.Contains': (l, x) => l.some((y) => mEq(y, x)),
};
function compileM(src) {
  const toks = tokenize(src); let p = 0;
  const peek = (v) => toks[p] && (toks[p].v === v);
  const eat = (v) => { if (!peek(v)) throw new Unsupported(`expected ${v} in: ${src}`); p++; };
  const expr = () => {
    if (peek('if')) { p++; const c = expr(); eat('then'); const a = expr(); eat('else'); const b = expr(); return (r) => (c(r) === true ? a(r) : b(r)); }
    return or();
  };
  const or = () => { let l = and(); while (peek('or')) { p++; const a = l; const b = and(); l = (r) => { const x = a(r); if (x === true) return true; const y = b(r); return x === null || y === null ? (y === true ? true : null) : y; }; } return l; };
  const and = () => { let l = not(); while (peek('and')) { p++; const a = l; const b = not(); l = (r) => { const x = a(r); if (x === false) return false; const y = b(r); return x === null || y === null ? (y === false ? false : null) : y; }; } return l; };
  const not = () => { if (peek('not')) { p++; const a = not(); return (r) => { const x = a(r); return x === null ? null : !x; }; } return cmp(); };
  const cmp = () => {
    const l = add();
    const o = toks[p] && toks[p].t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(toks[p].v) ? toks[p++].v : null;
    if (!o) return l;
    const rr = add();
    return (r) => {
      const a = l(r); const b = rr(r);
      if (o === '=') return mEq(a, b);
      if (o === '<>') return !mEq(a, b);
      const c = mCmp(a, b); if (c === null) return null;
      return { '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[o];
    };
  };
  const add = () => {
    let l = mul();
    while (toks[p] && ['+', '-', '&'].includes(toks[p].v) && toks[p].t === 'op') {
      const o = toks[p++].v; const a = l; const b = mul();
      l = (r) => { const x = a(r); const y = b(r); if (x === null || y === null) return null; return o === '&' ? String(x) + String(y) : o === '+' ? x + y : x - y; };
    }
    return l;
  };
  const mul = () => {
    let l = unary();
    while (toks[p] && ['*', '/'].includes(toks[p].v) && toks[p].t === 'op') {
      const o = toks[p++].v; const a = l; const b = unary();
      l = (r) => { const x = a(r); const y = b(r); if (x === null || y === null) return null; return o === '*' ? x * y : x / y; };
    }
    return l;
  };
  const unary = () => { if (peek('-')) { p++; const a = unary(); return (r) => { const x = a(r); return x === null ? null : -x; }; } return primary(); };
  const primary = () => {
    const t = toks[p++];
    if (!t) throw new Unsupported(`unexpected end: ${src}`);
    if (t.t === 'num' || t.t === 'str') return () => t.v;
    if (t.t === 'col') return (r) => (r[t.v] === undefined ? null : r[t.v]);
    if (t.v === '(') { const e = expr(); eat(')'); return e; }
    if (t.v === '{') { const items = []; if (!peek('}')) { items.push(expr()); while (peek(',')) { p++; items.push(expr()); } } eat('}'); return (r) => items.map((f) => f(r)); }
    if (t.t === 'id') {
      if (t.v === 'null') return () => null;
      if (t.v === 'true') return () => true;
      if (t.v === 'false') return () => false;
      if (t.v === '_') return (r) => r._;
      const fn = FUNCS[t.v];
      if (!fn || !peek('(')) throw new Unsupported(t.v);
      p++; const a = []; if (!peek(')')) { a.push(expr()); while (peek(',')) { p++; a.push(expr()); } } eat(')');
      return (r) => fn(...a.map((f) => f(r)));
    }
    throw new Unsupported(String(t.v));
  };
  const e = expr();
  if (p < toks.length) throw new Unsupported(`${toks[p].v} in: ${src}`);
  return e;
}

// ---------------------------------------------------------------------------------------------------
// Tables: { columns: [names], rows: [objects], approx: bool, unsupported: [] }
// ---------------------------------------------------------------------------------------------------
const T = (columns, rows) => ({ columns, rows, approx: false, unsupported: [], errors: 0 });
function fromExport(src, cols, opts = {}) {
  const ex = loadRows(src);
  const header = ex.header;
  const isXlsx = src.kind !== 'csv';
  const idx = cols.map((c) => { let i = header.indexOf(c); if (i < 0) i = header.findIndex((h) => String(h).trim() === String(c).trim()); return i; });
  const missing = cols.filter((c, i) => idx[i] < 0);
  if (missing.length) warnings.push(`${opts.name || src.name}: column(s) not in the file: ${missing.join(', ')}`);
  // Excel cells keep the type Power Query sees: number, true/false, date (kinds from the export)
  const typed = (v, k) => {
    if (k === 'n') { const n = Number(v); return Number.isFinite(n) ? n : v; }
    if (k === 'b') return v === 'TRUE';
    if (k === 'd') { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? tryOr(() => mkDate(+m[1], +m[2], +m[3]), v) : v; }
    return v;
  };
  const rows = ex.rows.map((r, ri) => {
    const o = {};
    const kinds = ex.kinds ? ex.kinds[ri] || '' : '';
    cols.forEach((c, i) => {
      let v = idx[i] < 0 || idx[i] >= r.length ? null : r[idx[i]];
      if (isXlsx) v = v === '' ? null : typed(v, kinds[idx[i]]);
      o[c] = v;
    });
    return o;
  });
  return T([...cols], rows);
}
// F04: the first non-empty value starts with a total word
function isTotal(r, words) {
  const w = words || ['total', 'grand total', 'subtotal', 'sum', 'i alt', 'samlet', 'totalt'];
  const f = Object.values(r).find((v) => v !== null && v !== '');
  const first = String(f === undefined ? '' : show(f)).trim().toLowerCase();
  return w.some((x) => first.startsWith(x));
}
function removeEmptyAndTotals(t, words) {
  t.rows = t.rows.filter((r) => Object.values(r).some((v) => v !== null && v !== '') && !isTotal(r, words));
  return t;
}
const mapCol = (t, c, fn) => { for (const r of t.rows) if (c in r) r[c] = fn(r[c], r); };
const keyOf = (vals) => JSON.stringify(vals.map((v) => (isDate(v) ? 'D' + iso(v) : v)));

function applyStep(t, f, name) {
  const c = f.column;
  const cols = f.columns || (c ? [c] : []);
  const cleanText = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : v);
  switch (f.fix) {
    case 'F03': t.rows = t.rows.filter((r) => Object.values(r).some((v) => v !== null && v !== '')); return;
    case 'F04': t.rows = t.rows.filter((r) => !isTotal(r, f.words)); return;
    case 'F05': cols.forEach((x) => mapCol(t, x, cleanText)); return;
    case 'F06': { const tok = f.tokens || ['N/A', 'n/a', '-', 'null', 'NULL']; cols.forEach((x) => mapCol(t, x, (v) => (typeof v === 'string' && tok.includes(v.trim()) ? null : v))); return; }
    case 'F07': {
      const proper = (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
      mapCol(t, c, (v) => (typeof v !== 'string' ? v : f.map ? (Object.prototype.hasOwnProperty.call(lowerMap(f.map), v.trim().toLowerCase()) ? lowerMap(f.map)[v.trim().toLowerCase()] : v) : f.case === 'upper' ? v.toUpperCase() : proper(v)));
      return;
    }
    case 'F08': mapCol(t, c, (v) => fnParseDate(v, f.dayFirst !== false)); return;
    case 'F09': mapCol(t, c, (v) => fnParseNumber(v)); return;
    case 'F10': mapCol(t, c, (v) => fnParseBool(v)); return;
    case 'F11': mapCol(t, c, (v) => fnNormaliseId(v, f.prefix || '', f.separator || '', f.digits || 4)); return;
    case 'F12': { const seen = new Set(); t.rows = t.rows.filter((r) => { const k = keyOf(t.columns.map((x) => r[x])); if (seen.has(k)) return false; seen.add(k); return true; }); return; }
    case 'F13': {
      if (f.remove) { t.rows = t.rows.filter((r) => !f.remove.some((x) => mEq(x, r[c]))); return; }
      const seen = new Set();
      t.rows = t.rows.filter((r) => { let k = r[c]; k = isDate(k) ? iso(k) : k; if (typeof k === 'string' && f.ignoreCase !== false) k = k.toLowerCase(); k = JSON.stringify(k); if (seen.has(k)) return false; seen.add(k); return true; });
      return;
    }
    case 'F14': {
      const checks = f.checks || ['negative', 'spike'];
      const ok = (v) => v !== null && !(checks.includes('negative') && v < 0) && !(checks.includes('spike') && f.spike && v > f.spike) && !(checks.includes('zero') && v === 0);
      if (f.mode === 'remove') { t.rows = t.rows.filter((r) => ok(r[c])); return; }
      const nm = f.flagColumn || `${c} issue`;
      for (const r of t.rows) { const v = r[c]; r[nm] = v === null ? 'missing' : checks.includes('negative') && v < 0 ? 'negative' : checks.includes('spike') && f.spike && v > f.spike ? 'spike' : checks.includes('zero') && v === 0 ? 'zero' : 'ok'; }
      t.columns.push(nm); return;
    }
    case 'F15': {
      const cut = fnParseDate(f.cutoff || (B && B.cutoffDate) || new Date().toISOString().slice(0, 10));
      const st = (v) => (v === null ? 'missing or invalid' : v > cut ? 'future' : v.getUTCFullYear() < 1900 ? 'too old' : 'ok');
      if (f.mode === 'remove') { t.rows = t.rows.filter((r) => st(r[c]) === 'ok'); return; }
      const nm = f.flagColumn || `${c} status`;
      for (const r of t.rows) r[nm] = st(r[c]);
      t.columns.push(nm); return;
    }
    case 'F16': {
      const a = f.attribute || 'Period'; const val = f.value || 'Value';
      const others = t.columns.filter((x) => !f.keep.includes(x));
      const out = [];
      for (const r of t.rows) for (const o of others) { if (r[o] === null || r[o] === undefined) continue; const n = {}; f.keep.forEach((k) => { n[k] = r[k]; }); n[a] = o; n[val] = r[o]; out.push(n); }
      t.rows = out; t.columns = [...f.keep, a, val];
      const monthNo = (s) => MONTHS[String(s).toLowerCase().replace('maj', 'may').replace('okt', 'oct').slice(0, 3)];
      if (f.period === 'monthName' && f.year) { for (const r of t.rows) r[a + ' start'] = tryOr(() => mkDate(Number(fnParseNumber(r[f.year])), monthNo(r[a]), 1)); t.columns.push(a + ' start'); }
      else if (f.period === 'monthName') mapCol(t, a, (v) => tryOr(() => mkDate(new Date().getFullYear(), monthNo(v), 1)));
      else mapCol(t, a, (v) => tryOr(() => mkDate(+String(v).slice(0, 4), +String(v).slice(-2), 1)));
      return;
    }
    case 'F17': {
      for (const pc of f.periodColumns || []) mapCol(t, pc, (v) => (typeof v === 'string' ? tryOr(() => mkDate(+v.slice(0, 4), +v.slice(-2), 1)) : v));
      const types = f.types || {};
      for (const [col, ty] of Object.entries(types)) {
        mapCol(t, col, (v) => {
          if (v === '') return null;
          try { return toType(v, ty, f.culture || (B && B.sourceCulture) || 'en-US'); } catch { t.errors++; return null; }
        });
      }
      return;
    }
    case 'F19': case 'F25': { t.columns = t.columns.filter((x) => !cols.includes(x)); for (const r of t.rows) for (const x of cols) delete r[x]; return; }
    case 'F23': {
      const names = f.names || [];
      for (const r of t.rows) { const parts = r[c] === null ? [] : String(r[c]).split(f.separator); names.forEach((n, i) => { r[n] = parts[i] === undefined ? null : parts[i]; }); delete r[c]; }
      const i = t.columns.indexOf(c); t.columns.splice(i, 1, ...names); return;
    }
    case 'F24': {
      const seps = new RegExp('[' + (f.separators || ',;').replace(/[\]\\^-]/g, '\\$&') + ']');
      const out = [];
      for (const r of t.rows) {
        const v = r[c];
        const items = typeof v === 'string' ? v.split(seps).map((x) => x.trim()).filter((x) => x !== '') : [v];
        for (const it of items) out.push({ ...r, [c]: it });
      }
      t.rows = out; return;
    }
    case 'F27': {
      const has = (v) => (f.values || []).some((x) => mEq(x, v));
      if (f.mode === 'flag') { for (const r of t.rows) r['Is test row'] = has(r[c]); t.columns.push('Is test row'); return; }
      t.rows = t.rows.filter((r) => !has(r[c])); return;
    }
    case 'F28': {
      const nm = f.as || `${c} name`; const names = f.names || {};
      for (const r of t.rows) { const k = r[c] === null ? null : String(show(r[c])); r[nm] = k === null ? null : Object.prototype.hasOwnProperty.call(names, k) ? names[k] : 'Unknown ' + k; }
      t.columns.push(nm); return;
    }
    case 'M': t.unsupported.push(`${name}: M step "${f.label}"`); t.approx = true; return;
    default: return; // F01, F02, F18, F20, F21, F22, F26, F29, M01, M02: built elsewhere or no row effect here
  }
}
const lmCache = new WeakMap();
function lowerMap(m) { if (!lmCache.has(m)) { const o = {}; for (const [k, v] of Object.entries(m)) o[k.toLowerCase()] = v; lmCache.set(m, o); } return lmCache.get(m); }

function staging(s) {
  const parts = [{ item: s.item, kind: s.kind, columns: s.columns }, ...(s.append || []).map((a) => ({ kind: s.kind, ...a }))];
  let t = null;
  for (const part of parts) {
    const src = findSource(s.file, part.kind || s.kind, part.item);
    if (!src) { warnings.push(`${s.name}: no exported rows for ${s.file}${part.item ? ' / ' + part.item : ''}`); return null; }
    const pt = fromExport(src, part.columns || s.columns, { name: s.name });
    if (s.append) { const tag = s.sourceColumn || 'SourceSheet'; for (const r of pt.rows) r[tag] = part.item; if (!pt.columns.includes(tag)) pt.columns.push(tag); }
    if (!t) t = pt; else { for (const c of pt.columns) if (!t.columns.includes(c)) t.columns.push(c); t.rows.push(...pt.rows); }
  }
  for (const f of s.steps || []) applyStep(t, f, s.name);
  return t;
}

const built = new Map();
function getTable(name, stack = []) {
  if (built.has(name)) return built.get(name);
  if (stack.includes(name)) throw new Error(`circular: ${[...stack, name].join(' -> ')}`);
  let t = null;
  if (RAW) {
    const src = (PROFILE.tables || []).find((x) => x.name === name && x.rowsFile);
    if (src) { const ex = loadRows(src); t = removeEmptyAndTotals(fromExport(src, ex.header.map(String)), null); t.raw = true; }
  } else {
    const s = (B.staging || []).find((x) => x.name === name);
    const m = (B.tables || []).find((x) => x.name === name);
    if (s) t = staging(s);
    else if (m) t = modelTable(m, [...stack, name]);
  }
  if (!t) return null;
  built.set(name, t);
  return t;
}
const clone = (t) => ({ ...t, columns: [...t.columns], rows: t.rows.map((r) => ({ ...r })), unsupported: [...t.unsupported] });
const lk = (v) => (v === null || v === undefined ? null : String(show(v)).toLowerCase());

function modelTable(m, stack) {
  const from = getTable(m.from, stack);
  if (!from) { warnings.push(`${m.name}: source ${m.from} not found`); return null; }
  const t = clone(from);
  const mark = (why) => { t.unsupported.push(`${m.name}: ${why}`); t.approx = true; };
  for (const o of m.ops || []) {
    try {
      switch (o.op) {
        case 'select': t.columns = o.columns.filter((c) => t.columns.includes(c)); break;
        case 'distinct': {
          const cols = o.columns || t.columns; const seen = new Set();
          t.rows = t.rows.filter((r) => { const k = keyOf(cols.map((c) => r[c])); if (seen.has(k)) return false; seen.add(k); return true; })
            .map((r) => { if (!o.columns) return r; const n = {}; cols.forEach((c) => { n[c] = r[c]; }); return n; });
          if (o.columns) t.columns = [...cols];
          break;
        }
        case 'filter': { const fn = compileM(o.expr); t.rows = t.rows.filter((r) => tryOr(() => fn(r), null) === true); break; }
        case 'merge': {
          if (typeof o.with !== 'string' && (o.with.group || !o.with.from)) { mark(`merge with a grouped lookup (${o.label || 'merge'})`); break; }
          const w = getTable(typeof o.with === 'string' ? o.with : o.with.from, stack);
          if (!w) { mark(`merge with unknown ${JSON.stringify(o.with)}`); break; }
          let wr = w.rows;
          if (o.with.filter) { const fn = compileM(o.with.filter); wr = wr.filter((r) => tryOr(() => fn(r), null) === true); }
          const on = o.on; const won = o.withOn || o.on;
          const key = (r, cols) => JSON.stringify(cols.map((c) => (o.ignoreCase ? lk(r[c]) : (isDate(r[c]) ? iso(r[c]) : r[c]))));
          const idx = new Map();
          for (const r of wr) { const k = key(r, won); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); }
          const names = o.as || o.columns;
          const out = [];
          for (const r of t.rows) {
            const hits = (on.some((c) => r[c] === null) ? null : idx.get(key(r, on))) || [null];
            for (const h of hits) { const n = { ...r }; o.columns.forEach((c, i) => { n[names[i]] = h ? (h[c] === undefined ? null : h[c]) : null; }); out.push(n); }
          }
          t.rows = out; names.forEach((n) => { if (!t.columns.includes(n)) t.columns.push(n); });
          break;
        }
        case 'addKey': {
          const by = o.sortBy || [];
          t.rows.sort((a, b) => { for (const c of by) { const x = tryOr(() => mCmp(a[c], b[c]), 0); if (x === null) { if (a[c] === b[c]) continue; return a[c] === null ? -1 : 1; } if (x) return x; } return 0; });
          t.rows.forEach((r, i) => { r[o.name] = i + 1; }); t.columns.push(o.name);
          break;
        }
        case 'addColumn': { const fn = compileM(o.expr); for (const r of t.rows) r[o.name] = tryOr(() => fn(r)); t.columns.push(o.name); break; }
        case 'transform': { const fn = compileM(o.expr); mapCol(t, o.column, (v, r) => tryOr(() => fn({ ...r, _: v }))); break; }
        case 'inferMembers': {
          const known = new Set(t.rows.map((r) => lk(r[o.key])));
          const flagCol = o.flag || 'IsInferred';
          if (!t.columns.includes(flagCol)) { for (const r of t.rows) r[flagCol] = false; t.columns.push(flagCol); }
          const add = new Map();
          for (const ref of o.fromColumns) {
            const mm = String(ref).match(/^'?([^'\[]+)'?\[(.+)\]$/);
            const other = mm && getTable(mm[1], stack);
            if (!other) { mark(`inferMembers source ${ref} not found`); continue; }
            for (const r of other.rows) { const v = r[mm[2]]; const k = lk(v); if (k !== null && !known.has(k) && !add.has(k)) add.set(k, v); }
          }
          const defs = Object.entries(o.defaults || {}).map(([k, e]) => { try { return [k, compileM(e)]; } catch (err) { mark(`inferMembers default for ${k} (${err.message})`); return [k, () => null]; } });
          for (const v of add.values()) { const n = { [o.key]: v, [flagCol]: true }; for (const [k, fn] of defs) n[k] = tryOr(() => fn({ _: v })); t.rows.push(n); }
          break;
        }
        default: mark(`op ${o.op}${o.label ? ' (' + o.label + ')' : ''}`);
      }
    } catch (e) {
      if (e instanceof Unsupported) mark(`${o.op} – M not supported here: ${e.message}`); else throw e;
    }
  }
  // final columns: select + rename + types
  const out = T(m.columns.map((c) => c.name), t.rows.map((r) => { const n = {}; for (const c of m.columns) { const v = r[c.from || c.name]; n[c.name] = v === undefined ? null : v; } return n; }));
  for (const c of m.columns) {
    if (!t.columns.includes(c.from || c.name)) warnings.push(`${m.name}[${c.name}]: column ${c.from || c.name} not produced by the spec (approximate)`);
    if (['int', 'key', 'number', 'currency', 'percent', 'date', 'datetime', 'bool'].includes(c.type)) {
      mapCol(out, c.name, (v) => { if (v === '' || v === null) return null; try { return toType(v, c.type, 'en-US'); } catch { out.errors++; return null; } });
    }
  }
  out.approx = t.approx; out.unsupported = t.unsupported; out.errors += t.errors;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------------------------------
const asNum = (v, raw) => (typeof v === 'number' ? v : raw && typeof v === 'string' ? fnParseNumber(v) : null);
const asDate = (v, raw) => (isDate(v) ? v : raw && typeof v === 'string' && /\d/.test(v) && !/^\s*-?[\d.,\s]+\s*$/.test(v) ? fnParseDate(v) : null);
function aggregate(rows, agg, col, raw) {
  const vals = col ? rows.map((r) => (r[col] === undefined ? null : r[col])) : [];
  const nonBlank = vals.filter((v) => v !== null && v !== '');
  switch (agg) {
    case 'rows': return rows.length;
    case 'count': return nonBlank.length;
    case 'blank': return vals.length - nonBlank.length;
    case 'distinct': return new Set(nonBlank.map((v) => (isDate(v) ? iso(v) : typeof v === 'string' ? v.toLowerCase() : v))).size;
    case 'sum': case 'avg': {
      const n = nonBlank.map((v) => asNum(v, raw)).filter((v) => v !== null);
      const s = n.reduce((a, b) => a + b, 0);
      return agg === 'sum' ? (n.length ? s : null) : (n.length ? s / n.length : null);
    }
    case 'min': case 'max': {
      const d = nonBlank.map((v) => asDate(v, raw)).filter(Boolean);
      const n = nonBlank.map((v) => asNum(v, raw)).filter((v) => v !== null);
      const pick = (a, f) => a.reduce((x, y) => (f(y, x) ? y : x));
      if (d.length && d.length >= n.length) return iso(pick(d, (y, x) => (agg === 'min' ? y < x : y > x)));
      if (n.length) return pick(n, (y, x) => (agg === 'min' ? y < x : y > x));
      return nonBlank.length ? pick(nonBlank.map(String), (y, x) => (agg === 'min' ? y < x : y > x)) : null;
    }
    default: throw new Error(`unknown agg ${agg}`);
  }
}
function basics(t) {
  const cols = {};
  for (const c of t.columns) {
    const v = t.rows.map((r) => r[c]).filter((x) => x !== null && x !== undefined && x !== '');
    const kind = v.every((x) => typeof x === 'number') && v.length ? 'number' : v.every(isDate) && v.length ? 'date' : v.every((x) => typeof x === 'boolean') && v.length ? 'bool' : 'text';
    const o = { kind, nonBlank: v.length, distinct: aggregate(t.rows, 'distinct', c) };
    if (kind === 'number') { o.sum = show(aggregate(t.rows, 'sum', c)); o.min = aggregate(t.rows, 'min', c); o.max = aggregate(t.rows, 'max', c); }
    if (kind === 'date') { o.min = aggregate(t.rows, 'min', c); o.max = aggregate(t.rows, 'max', c); }
    if (kind === 'bool') o.true = v.filter((x) => x === true).length;
    cols[c] = o;
  }
  return cols;
}
function runQuery(q) {
  const t0 = getTable(q.table);
  if (!t0) throw new Error(`unknown table ${q.table}${RAW ? ' (raw mode: use the profile table name)' : ''}`);
  let rows = t0.rows; const raw = !!t0.raw;
  for (const j of q.join || []) {
    const w = getTable(j.table); if (!w) throw new Error(`unknown join table ${j.table}`);
    const idx = new Map(); for (const r of w.rows) { const k = lk(r[j.withOn || j.on]); if (k !== null && !idx.has(k)) idx.set(k, r); }
    const cols = j.columns || w.columns;
    rows = rows.map((r) => { const h = idx.get(lk(r[j.on])); const n = { ...r }; for (const c of cols) { const nm = c in r ? `${j.table}.${c}` : c; n[nm] = h ? (h[c] === undefined ? null : h[c]) : null; } return n; });
  }
  if (q.where) {
    const fn = compileM(q.where);
    const coerce = raw ? (r) => new Proxy(r, { get: (o, k) => { const v = o[k]; if (typeof v !== 'string') return v === undefined ? null : v; if (v.trim() === '') return null; const n = fnParseNumber(v); if (n !== null && /^\s*[-(]?[\d.,\s]+\)?\s*$/.test(v)) return n; const d = /\d/.test(v) && /[-/.]/.test(v) ? fnParseDate(v) : null; return d || v; } }) : (r) => r;
    rows = rows.filter((r) => tryOr(() => fn(coerce(r)), null) === true);
  }
  const agg = q.agg || 'rows';
  if (q.by) {
    const groups = new Map();
    for (const r of rows) { const k = r[q.by] === undefined || r[q.by] === null ? '(blank)' : String(show(r[q.by])); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const values = {}; for (const [k, g] of [...groups.entries()].sort()) values[k] = show(aggregate(g, agg, q.column, raw));
    return { values };
  }
  return { value: show(aggregate(rows, agg, q.column, raw)), rows: rows.length };
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------
let queries = null;
if (opt('--queries')) queries = readJson(path.resolve(opt('--queries')));
else if (opt('--q')) queries = JSON.parse(opt('--q'));
if (queries && !Array.isArray(queries)) queries = queries.queries || [queries];

const out = { ok: true, mode: RAW ? 'raw' : 'spec', tables: {}, results: [], applied: { checks: [], questions: [] }, warnings };
const names = opt('--tables') ? opt('--tables').split(',').map((s) => s.trim())
  : queries ? [...new Set(queries.flatMap((q) => [q.table, ...(q.join || []).map((j) => j.table)]))]
    : RAW ? (PROFILE.tables || []).filter((t) => t.rowsFile).map((t) => t.name)
      : [...(B.staging || []).map((s) => s.name), ...(B.tables || []).map((t) => t.name)];
for (const n of names) {
  const t = tryOr(() => getTable(n), null);
  if (!t) { warnings.push(`table ${n} not found`); continue; }
  out.tables[n] = { rows: t.rows.length, approx: !!t.approx, ...(t.unsupported.length ? { unsupported: t.unsupported } : {}), ...(t.errors ? { typeErrors: t.errors } : {}), ...(queries ? {} : { columns: basics(t) }) };
}
for (const q of queries || []) {
  try {
    const r = runQuery(q);
    const t = getTable(q.table);
    const res = { name: q.name || `${q.agg || 'rows'} ${q.table}${q.column ? '[' + q.column + ']' : ''}`, ...r, ...(t && t.approx ? { approx: true } : {}) };
    out.results.push(res);
  } catch (e) {
    out.ok = false;
    out.results.push({ name: q.name, error: e instanceof Unsupported ? `M not supported here: ${e.message}` : e.message });
  }
}

// --apply: write the values into checks[] and questions.json – only exact, single values
if (flag('--apply') && queries) {
  const how = (q) => `source-stats.js: ${q.agg || 'rows'} of ${q.table}${q.column ? '[' + q.column + ']' : ''}${q.where ? ' where ' + q.where : ''}${(q.join || []).length ? ' (joined ' + q.join.map((j) => j.table).join(', ') + ')' : ''}`;
  let qs = null; const qf = path.join(runDir, 'questions.json');
  queries.forEach((q, i) => {
    const r = out.results[i];
    if (r.error || r.values || r.approx || typeof r.value !== 'number') return;
    if (q.check) {
      choices.checks = choices.checks || [];
      const name = q.check.name || q.name;
      const c = choices.checks.find((x) => x.name === name);
      const row = { name, dax: q.check.dax, expected: r.value, assumes: q.check.assumes || '' };
      if (c) Object.assign(c, row); else choices.checks.push(row);
      out.applied.checks.push(name);
    }
    if (q.question) {
      qs = qs || (fs.existsSync(qf) ? readJson(qf) : null);
      const item = qs && qs[q.question - 1];
      if (item) { item[q.role ? 'role_expected' : 'expected'] = r.value; if (!q.role) item.expected_how = how(q); out.applied.questions.push(q.question); }
      else warnings.push(`question ${q.question} not in questions.json`);
    }
  });
  if (out.applied.checks.length) fs.writeFileSync(choicesFile, JSON.stringify(choices, null, 1), 'utf8');
  if (out.applied.questions.length) fs.writeFileSync(qf, JSON.stringify(qs, null, 1), 'utf8');
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.ok ? 0 : 1);
