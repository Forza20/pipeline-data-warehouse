#!/usr/bin/env node
// Builds the project site of one /messy-pipeline run: runs/<run-id>/site.html (8 tabs).
// Reads only files the pipeline already writes; no network, no database, no dependencies.
// Architecture and call graph come from .claude/agents, .claude/commands and the skills; lineage from
// sql_lineage.py; every page gets checks against the repo (printed as "verify" and shown on the page).
// Usage: node tools/build-site.js runs/<run-id>
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const runDir = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(runDir, 'run.json'))) {
  console.error('Usage: node tools/build-site.js runs/<run-id>  (folder with run.json)');
  process.exit(1);
}
const root = path.resolve(runDir, '..', '..');
const read = p => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const readJson = p => { const t = read(p); try { return t ? JSON.parse(t) : null; } catch { return null; } };
const ls = (p, re) => { try { return fs.readdirSync(p).filter(f => !re || re.test(f)); } catch { return []; } };
const warn = [];

const run = readJson(path.join(runDir, 'run.json'));
const id = run.run_id;
const prefix = run.schema_prefix || '';

// ---------- markdown tables ----------
function mdSection(md, startRe) {
  if (!md) return '';
  const i = md.search(startRe);
  if (i < 0) return '';
  const rest = md.slice(i);
  const next = rest.slice(3).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 3);
}
function mdTable(text) {
  const rows = (text || '').split('\n').filter(l => /^\|.*\|\s*$/.test(l.trim()));
  const cells = rows.map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  return cells.filter(c => !c.every(x => /^:?-{2,}:?$/.test(x)));
}
const strip = s => (s || '').replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();

// ---------- scorecard ----------
const sc = read(path.join(runDir, 'scorecard.md'));
const result = ((sc && (sc.match(/\*\*Result:\s*([^*]+?)\*\*/) || [])[1]) || run.steps?.score?.result || 'not scored yet').replace(/[.\s]+$/, '');
const typeRows = mdTable(mdSection(sc, /\n## 1\. /)).slice(1);
const types = typeRows.filter(r => /^\d+$/.test(r[0])).map(r => ({
  no: +r[0], name: strip(r[1]), injected: /^yes/i.test(r[2]), where: strip(r[3]), found: strip(r[4]),
  state: /❌/.test(r[5]) ? 'warn' : /⚠/.test(r[5]) ? 'care' : /^yes/i.test(r[2]) ? 'ok' : 'na'
}));
if (!types.length) warn.push('scorecard: no error-type table');
const numTable = mdTable(mdSection(sc, /\n## 3\. /));
const numbers = numTable.slice(1).map(r => ({
  key: strip(r[0]), facit: strip(r[1]), gold: strip(r[2]), diff: r.length > 4 ? strip(r[r.length - 2]) : '',
  expl: strip(r[r.length - 1])
}));
const lede = sc ? strip((sc.split('\n').find(l => l.startsWith('**Result')) || '').replace(/^\*\*Result:[^*]*\*\*\.?\s*/, '')) : '';

// ---------- quality ----------
const qr = read(path.join(runDir, 'medallion', 'docs', 'quality-results.md')) || '';
const quality = [];
for (const m of qr.matchAll(/^\|\s*(\d+)\s*\|\s*(ERR|INFO)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|/gm))
  quality.push({ no: +m[1], lvl: m[2], chk: strip(m[3]), res: strip(m[4]) });
if (!quality.length && qr) {
  // older format: two-column tables (| Check | Result |) under headings that say ERR/must be 0 or INFO
  let lvl = 'ERR', no = 0;
  for (const line of qr.split(/\r?\n/)) {
    if (/^#{1,4}\s/.test(line)) lvl = /info/i.test(line) ? 'INFO' : 'ERR';
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!m || /^:?-{2,}/.test(m[1]) || /^(check|tjek|rule|regel)$/i.test(m[1])) continue;
    quality.push({ no: ++no, lvl, chk: strip(m[1]), res: strip(m[2]) });
  }
}
const errN = quality.filter(q => q.lvl === 'ERR').length;
const errOk = quality.filter(q => q.lvl === 'ERR' && /^0$/.test(q.res)).length;
const infos = quality.filter(q => q.lvl === 'INFO' && !/^0$/.test(q.res.replace(/[.,\s]/g, '')));

// ---------- decisions ----------
const dec = read(path.join(runDir, 'medallion', 'docs', 'model-decisions.md')) || '';
const decisions = new Set([...dec.matchAll(/^\|\s*(R\d-\d+)\s*\|/gm)].map(m => m[1])).size;

// ---------- dataset ----------
const dsDir = path.join(root, run.paths?.dataset || `datasets/runs/${id}`);
const csv = ls(dsDir, /\.csv$/i).map(f => ({ file: f, rows: Math.max(0, (read(path.join(dsDir, f)) || '').split('\n').filter(Boolean).length - 1) }));
const docs = ls(dsDir, /\.md$/i);

// ---------- migrations ----------
const migDir = path.join(runDir, 'medallion', 'supabase', 'migrations');
const migFiles = ls(migDir, /\.sql$/i).sort();
const migSql = migFiles.map(f => read(path.join(migDir, f)) || '').join('\n');
const layerTables = { bronze: new Set(), silver: new Set(), gold: new Set() };
for (const m of migSql.matchAll(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${prefix}(bronze|silver|gold)\\.(\\w+)`, 'gi')))
  layerTables[m[1].toLowerCase()].add(m[2].toLowerCase());
const procs = [...new Set([...migSql.matchAll(/create\s+(?:or\s+replace\s+)?(?:procedure|function)\s+([\w.]+)/gi)].map(m => m[1].toLowerCase()))];
const tempTables = [...new Set([...migSql.matchAll(/create\s+temp(?:orary)?\s+table\s+(\w+)/gi)].map(m => m[1]))];
const rawLines = (quality.find(q => /raw_lines\s*=\s*CSV lines/i.test(q.chk)) || {}).chk;
const rawLineCount = rawLines ? (rawLines.match(/\(([\d.,]+)/) || [])[1] : null;

// ---------- Power BI ----------
const pbip = run.paths?.pbip ? path.join(root, run.paths.pbip) : null;
const pbipDir = pbip ? path.dirname(pbip) : path.join(runDir, 'pbip');
const model = pbip ? path.basename(pbip, '.pbip') : '';
const cat = readJson(path.join(pbipDir, 'docs', 'catalog.json'));
const repPages = path.join(pbipDir, `${model}.Report`, 'definition', 'pages');
const pages = ls(repPages).filter(d => fs.existsSync(path.join(repPages, d, 'page.json')))
  .map(d => ({ name: (readJson(path.join(repPages, d, 'page.json')) || {}).displayName || d, visuals: ls(path.join(repPages, d, 'visuals')).length }));
const lineageMd = read(path.join(pbipDir, 'docs', 'lineage.md')) || '';
const lineageGraphs = (lineageMd.match(/```mermaid/g) || []).length;
const culture = ((read(path.join(pbipDir, `${model}.SemanticModel`, 'definition', 'model.tmdl')) || '').match(/culture:\s*(\S+)/) || [])[1] || '';

const S = v => v == null ? '' : String(v);
const catalog = [];
if (cat) {
  for (const t of cat.tables || []) catalog.push({ k: 'Table', t: t.Table, n: '', s: S(t.Description), p: '', u: S(t['Upstream source']), slot: S(t['Dashboard (indirect)']) });
  for (const c of cat.columns || []) catalog.push({ k: 'Column', t: c.Table, n: c.Column, s: S(c.Description), p: S(c['Possible PII']), u: S(c['Upstream source']), slot: S(c['Dashboard slot']), key: `${c.Table}[${c.Column}]` });
  for (const m of cat.measures || []) catalog.push({ k: 'Measure', t: m.Table, n: m.Measure, s: S(m.Description), p: '', u: S(m.DAX), slot: S(m['Dashboard slot']) });
} else warn.push('catalog.json missing');
const missingDesc = catalog.filter(r => !r.s).length;

// tables + relationships for the model diagram
const tables = (cat?.tables || []).filter(t => t.Type !== 'Measures').map(t => ({ name: t.Table, kind: t.Type }));
const rels = (cat?.relationships || []).map(r => ({ from: r.From, to: r.To, card: r.Cardinality, active: r.Active !== 'No' }));

// pages that read each table
const pagesBy = {};
for (const c of cat?.columns || []) for (const u of S(c['Used in report']).split(';')) {
  const pg = u.split('›')[0].trim(); if (pg) (pagesBy[c.Table] = pagesBy[c.Table] || new Set()).add(pg);
}

// measures credit the tables behind them to the pages that use them
const colTable = {};
for (const c of cat?.columns || []) colTable[`${c.Table}[${c.Column}]`] = c.Table;
for (const m of cat?.measures || []) for (const u of S(m['Used in report']).split(';')) {
  const pg = u.split('›')[0].trim(); if (!pg) continue;
  for (const t of [m.Table, ...S(m['All source columns']).split(',').map(k => colTable[k.trim()]).filter(Boolean)])
    (pagesBy[t] = pagesBy[t] || new Set()).add(pg);
}

// ---------- table lineage graph (sql_lineage.py as a module) ----------
const HOME = process.env.USERPROFILE || process.env.HOME || '';
// project skills first (this repository), then the user's global skills
const skillsDir = [path.join(root, '.claude', 'skills'), path.join(HOME, '.claude', 'skills')].find(d => fs.existsSync(path.join(d, 'pbip-catalog'))) || path.join(root, '.claude', 'skills');
const catalogScripts = path.join(skillsDir, 'pbip-catalog', 'scripts');
let sqlTables = null;
if (fs.existsSync(path.join(catalogScripts, 'sql_lineage.py')) && migFiles.length) {
  const py = 'import sys, json; sys.path.insert(0, sys.argv[1]); from sql_lineage import SqlLineage\n' +
    's = SqlLineage().load([sys.argv[2]])\n' +
    'print(json.dumps({t: {"sources": sorted(i["sources"]), "csv": i.get("csv_file"), "temp": bool(i.get("temp"))} for t, i in s.tables.items()}))';
  // the Python from pipeline.config.json (tools.python); "python" on PATH as a fallback
  let pyExe = 'python';
  try { pyExe = JSON.parse(fs.readFileSync(path.join(root, 'pipeline.config.json'), 'utf8').replace(/^﻿/, '')).tools.python || pyExe; } catch { /* no config */ }
  try { sqlTables = JSON.parse(execFileSync(pyExe, ['-X', 'utf8', '-c', py, catalogScripts, migDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { warn.push('sql_lineage.py failed – table lineage left out'); }
}
const G = { nodes: {}, edges: [] };
const LAYERS = ['source (csv)', 'bronze', 'temp tables', 'silver', 'gold', 'Power BI', 'report pages'];
const layerOf = n => n.endsWith('.csv') ? 0 : n.startsWith(prefix + 'bronze.') ? 1 : !n.includes('.') ? 2
  : n.startsWith(prefix + 'silver.') ? 3 : n.startsWith(prefix + 'gold.') ? 4 : -1;
function gnode(id, label, layer) { if (!G.nodes[id]) G.nodes[id] = { id, label, layer }; return id; }
function gedge(a, b) { if (a && b && a !== b && !G.edges.some(e => e[0] === a && e[1] === b)) G.edges.push([a, b]); }
const dbNode = n => { const l = layerOf(n); return l < 0 ? null : gnode('db:' + n, n.split('.').pop(), l); };
if (sqlTables) {
  for (const [t, info] of Object.entries(sqlTables)) {
    const tid = dbNode(t); if (!tid) continue;
    for (const s of info.sources) {
      if (/\.raw_lines$/.test(s) && info.csv) gedge(gnode('csv:' + info.csv, info.csv + '.csv', 0), tid);
      else gedge(dbNode(s), tid);
    }
  }
}
for (const t of cat?.tables || []) {
  const tid = gnode('pbi:' + t.Table, t.Table, 5);
  for (const o of S(t.Kildeobjekter).split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) gedge(G.nodes['db:' + o] ? 'db:' + o : dbNode(o), tid);
  for (const q of S(t['Upstream queries']).split(',').map(x => x.trim()).filter(Boolean))
    if ((cat.tables || []).some(x => x.Table === q)) gedge('pbi:' + q, tid);
  for (const pg of pagesBy[t.Table] || []) gedge(tid, gnode('page:' + pg, pg, 6));
}
// steps inside one layer (gold.dim_* feeding gold.fact_*): longest path within the layer
const depth = {};
for (const id of Object.keys(G.nodes)) depth[id] = 0;
for (let i = 0, changed = true; changed && i < 50; i++) {
  changed = false;
  for (const [a, b] of G.edges) if (G.nodes[a].layer === G.nodes[b].layer && depth[b] < depth[a] + 1) { depth[b] = depth[a] + 1; changed = true; }
}
const colKeys = [...new Set(Object.values(G.nodes).map(n => n.layer * 100 + depth[n.id]))].sort((a, b) => a - b);
const lineage = {
  columns: colKeys.map(k => ({ title: LAYERS[Math.floor(k / 100)] + (k % 100 ? ' · step ' + (k % 100 + 1) : ''), layer: Math.floor(k / 100) })),
  nodes: Object.values(G.nodes).map(n => ({ id: n.id, label: n.label, layer: n.layer, col: colKeys.indexOf(n.layer * 100 + depth[n.id]),
    unused: n.layer < 6 && !G.edges.some(e => e[0] === n.id) })),
  edges: G.edges
};

// ---------- pipeline structure: agents, skills, calls (read from the repo, not hand-written) ----------
const agentsDir = path.join(root, '.claude', 'agents');
const cmdPath = path.join(root, '.claude', 'commands', 'messy-pipeline.md');
const skillNames = ls(skillsDir).filter(d => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
const rel = p => path.relative(root, p).replace(/\\/g, '/');
function frontmatter(t) {
  const m = (t || '').match(/^---\r?\n([\s\S]*?)\r?\n---/); const fm = {};
  if (m) for (const l of m[1].split(/\r?\n/)) { const kv = l.match(/^(\w+):\s*(.*)$/); if (kv) fm[kv[1]] = kv[2]; }
  return fm;
}
const CMD_RE = /`((?:git|psql|node|python|powerbi-report-author)\b[^`]*)`/g;
function normCmd(c) {
  if (/^git\b/.test(c)) {
    const g = c.match(/^git\s+(?:-C\s+(\S+)\s+)?([a-z][\w-]*)/);
    return g ? 'git ' + g[2] + (g[1] ? ' (' + g[1].split(/[\\/]/).pop().replace(/[<>]/g, '') + ')' : '') : null;
  }
  if (/^node\b/.test(c)) return null;                       // the script itself is listed
  const w = c.trim().split(/\s+/);
  if (w[0] === 'powerbi-report-author') return w.slice(0, 2).join(' ');
  return w.length > 1 ? c.replace(/\s+/g, ' ').slice(0, 70) : null;
}
function scanCalls(text, file, extra) {
  const calls = [], seen = new Set();
  const add = (kind, name, line) => { const key = kind + name; if (seen.has(key)) return; seen.add(key); calls.push({ kind, name, src: rel(file) + ':' + line }); };
  (text || '').split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/\b([\w-]+\.(?:py|ps1|js))\b/g)) add('script', m[1], i + 1);
    for (const m of l.matchAll(CMD_RE)) { const n = normCmd(m[1]); if (n) add('cmd', n, i + 1); }
    if (/\bpsql\b/.test(l) && !/`psql/.test(l)) add('cmd', 'psql \\copy', i + 1);
    for (const m of l.matchAll(/powerbi-report-author\s+(validate|preview|render)/g)) add('cmd', 'powerbi-report-author ' + m[1], i + 1);
    (extra || []).forEach(fn => fn(l, i + 1, add));
  });
  return calls;
}
function skillsUsed(desc, body) {
  // lines that forbid something ("Never read … the messy-dataset skill") do not count as use
  const text = desc + '\n' + body.split(/\r?\n/).filter(l => !/\b(never|not|outside|forbidden|don't)\b/i.test(l)).join('\n');
  return skillNames.filter(s => {
    const e = s.replace(/[-]/g, '\\-');
    return new RegExp(`skills[\\\\/]${e}[\\\\/](SKILL\\.md|scripts)|skill \`${e}\`|\\b(load|loads|follow|following|apply|applies|run|runs)\\b[^.\\n]{0,40}\\b${e}\\b`, 'i').test(text);
  });
}
function scriptPath(name, skills) {
  for (const s of skills) for (const d of ['scripts', '']) { const p = path.join(skillsDir, s, d, name); if (fs.existsSync(p)) return p; }
  for (const p of [path.join(root, 'tools', name)]) if (fs.existsSync(p)) return p;
  return null;
}
function mcpTools(tools) {
  const by = {};
  for (const t of (tools || '').split(',').map(x => x.trim()).filter(x => x.startsWith('mcp__'))) {
    const m = t.match(/^mcp__(.+?)__([a-z_]+)$/); if (!m) continue;
    const server = m[1].replace(/^claude_ai_/, '').replace(/^plugin_[\w-]+?_/, '');
    (by[server] = by[server] || []).push(m[2].replace(/_operations$/, ''));
  }
  return Object.entries(by).map(([server, list]) => ({ server, tools: list }));
}
const minutes = s => s && s.started && s.finished ? Math.max(0, Math.round((Date.parse(s.finished) - Date.parse(s.started)) / 60000)) : null;
const agents = ls(agentsDir, /\.md$/).map(f => {
  const file = path.join(agentsDir, f), t = read(file) || '', fm = frontmatter(t);
  const step = +((fm.description || '').match(/Step (\d+) of \/messy-pipeline/) || [])[1];
  if (!step) return null;
  const body = t.replace(/^---[\s\S]*?---/, '');
  const skills = skillsUsed(fm.description || '', body);
  const calls = scanCalls(t, file);
  // scripts the used skills document, so a call that hides behind "follow the skill" is still shown
  for (const s of skills) {
    const sf = path.join(skillsDir, s, 'SKILL.md');
    for (const c of scanCalls(read(sf), sf)) if (c.kind === 'script' && scriptPath(c.name, [s]) && !calls.some(x => x.name === c.name))
      calls.push({ ...c, src: 'skill ' + s + ' · SKILL.md:' + c.src.split(':').pop() });
  }
  for (const c of calls) if (c.kind === 'script') { const p = scriptPath(c.name, skills); c.exists = !!p; c.path = p ? (p.startsWith(root) ? rel(p) : '~/.claude/skills/' + path.relative(skillsDir, p).replace(/\\/g, '/')) : ''; }
  const stepKey = (body.match(/steps\.(\w+)\./) || [])[1] || '';
  const st = run.steps?.[stepKey] || {};
  return { name: fm.name || f.replace(/\.md$/, ''), step, model: fm.model || '', file: rel(file), skills, calls, mcp: mcpTools(fm.tools),
    procs: skills.includes('supabase-medallion-powerbi') ? procs : [], stepKey, status: st.status || 'not run', minutes: minutes(st) };
}).filter(Boolean).sort((a, b) => a.step - b.step);
const cmdText = read(cmdPath) || '';
const orchestrator = {
  file: rel(cmdPath),
  skills: skillNames.filter(s => !agents.some(a => a.skills.includes(s)) && new RegExp(`\\b${s.replace(/-/g, '\\-')}\\b`).test(cmdText)),
  calls: scanCalls(cmdText, cmdPath).filter(c => c.kind === 'cmd' || fs.existsSync(path.join(root, 'tools', c.name))),
  agentsNamed: agents.filter(a => new RegExp(`\\b${a.name}\\b`).test(cmdText)).map(a => a.name),
  status: run.steps?.score?.status || 'not run'
};
for (const c of orchestrator.calls) if (c.kind === 'script') { c.exists = fs.existsSync(path.join(root, 'tools', c.name)); c.path = 'tools/' + c.name; }

// ---------- sample values for the catalog (written by tools/sample-sql.js + Supabase) ----------
// samples.json is {"values": {...}, "rows": {...}} (older files: the values object alone)
const samplesRaw = readJson(path.join(pbipDir, 'docs', 'samples.json')) || {};
const samples = samplesRaw.values || samplesRaw;
const rowCounts = samplesRaw.rows || {};

// ---------- catalog by table and layer (bronze, silver, gold from the migrations; Power BI from catalog.json) ----------
function sqlTableColumns(sql) {
  const out = {}, re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(${prefix}(?:bronze|silver|gold))\\.(\\w+)\\s*\\(`, 'gi');
  let m;
  while ((m = re.exec(sql))) {
    let j = re.lastIndex, d = 1;
    for (; j < sql.length && d > 0; j++) { if (sql[j] === '(') d++; else if (sql[j] === ')') d--; }
    const body = sql.slice(re.lastIndex, j - 1).replace(/--[^\n]*/g, '');
    const parts = []; let dep = 0, last = 0;
    for (let k = 0; k < body.length; k++) { const ch = body[k]; if (ch === '(') dep++; else if (ch === ')') dep--; else if (ch === ',' && !dep) { parts.push(body.slice(last, k)); last = k + 1; } }
    parts.push(body.slice(last));
    const cols = [], pk = new Set();
    for (const p of parts.map(x => x.trim()).filter(Boolean)) {
      const pkm = p.match(/^(?:constraint\s+\w+\s+)?primary\s+key\s*\(([^)]*)\)/i);
      if (pkm) { pkm[1].split(',').forEach(x => pk.add(x.trim().replace(/"/g, '').toLowerCase())); continue; }
      if (/^(constraint|unique|check|foreign|exclude|like)\b/i.test(p)) continue;
      const cm = p.match(/^"?(\w+)"?\s+([\s\S]+)$/); if (!cm) continue;
      const type = cm[2].split(/\s+(?:not|null|default|primary|references|generated|check|unique|constraint|collate)\b/i)[0].trim();
      cols.push({ name: cm[1].toLowerCase(), type: type.replace(/\s+/g, ' ').toUpperCase(), key: /primary\s+key/i.test(cm[2]) ? 'PK' : /\breferences\b/i.test(cm[2]) ? 'FK' : '' });
    }
    cols.forEach(c => { if (pk.has(c.name)) c.key = 'PK'; });
    out[m[1].toLowerCase() + '.' + m[2].toLowerCase()] = cols;   // a later definition wins (migrations)
  }
  return out;
}
// called when D is assembled, after the sample helpers (sampleFor, unxml) further down exist
function buildCatLayers() {
const sqlCols = sqlTableColumns(migSql);
const descByOrigin = {}, pbiByObject = {};
for (const c of cat?.columns || []) if (S(c.Origin) && S(c.Description)) descByOrigin[S(c.Origin).toLowerCase()] = S(c.Description);
for (const t of cat?.tables || []) for (const o of S(t.Kildeobjekter).split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) pbiByObject[o] = t;
const relTo = new Set(rels.map(r => r.to)), relFrom = new Set(rels.map(r => r.from));
const typeMap = { int64: 'INTEGER', string: 'TEXT', double: 'DECIMAL', decimal: 'DECIMAL', dateTime: 'DATE', boolean: 'BOOLEAN' };
const sampleText = v => v == null ? '' : unxml(String(v)).split(' · ')[0];
const finished = (Object.values(run.steps || {}).map(s => s.finished).filter(Boolean).sort().pop() || '').slice(0, 10);
const catLayers = [];
for (const layer of ['bronze', 'silver', 'gold']) {
  const schema = prefix + layer, tablesL = [];
  const names = new Set([...Object.keys(sqlCols).filter(k => k.startsWith(schema + '.')),
    ...[...layerTables[layer]].map(n => schema + '.' + n)]);
  for (const full of [...names].sort()) {
    const short = full.split('.').pop();
    let cols = sqlCols[full] || [];
    if (!cols.length) cols = Object.keys(samples).filter(k => k.startsWith(full + '.')).map(k => ({ name: k.split('.').pop(), type: '', key: '' }));
    const pbi = pbiByObject[full], info = sqlTables?.[full] || {};
    const desc = layer === 'gold' ? S(pbi?.Description) : layer === 'bronze'
      ? (info.csv ? 'rows from ' + info.csv + '.csv, as text' : short === 'raw_lines' ? 'all CSV lines, as delivered' : '')
      : (info.sources || []).length ? 'from ' + info.sources.map(x => x.split('.').pop()).join(', ') : '';
    tablesL.push({ name: short, kind: layer === 'gold' ? S(pbi?.Type) || (/^fact_/.test(short) ? 'Fact' : /^dim_/.test(short) ? 'Dimension' : /^bridge_/.test(short) ? 'Bridge' : '') : '',
      desc, sub: pbi ? 'read by the Power BI table ' + pbi.Table : '', owner: S(pbi?.Owner), rows: rowCounts[full] ?? null, date: finished,
      cols: cols.map(c => ({ n: c.name, t: c.type, k: c.key, ex: /_bronze$|_silver$/.test(schema) && /(^|_)(name|email|phone|address)($|_)/.test(c.name) ? '' : sampleText(samples[full + '.' + c.name]),
        d: descByOrigin[full + '.' + c.name] || '' })) });
  }
  catLayers.push({ key: layer, label: layer, tables: tablesL });
}
{
  const tablesL = [];
  for (const t of cat?.tables || []) {
    const cols = (cat.columns || []).filter(c => c.Table === t.Table).map(c => {
      const k = `${c.Table}[${c.Column}]`;
      return { n: c.Column, t: typeMap[c.Datatype] || S(c.Datatype).toUpperCase(), k: relTo.has(k) ? 'PK' : relFrom.has(k) ? 'FK' : '',
        ex: c['Possible PII'] ? 'hidden (possible PII)' : sampleText(sampleFor(k)), d: S(c.Description) };
    }).concat((cat.measures || []).filter(m => m.Table === t.Table).map(m => ({ n: m.Measure, t: 'MEASURE', k: '', ex: '', d: S(m.Description), dax: S(m.DAX) })));
    const src = S(t.Kildeobjekter).split(',')[0].trim().toLowerCase();
    const pg = [...(pagesBy[t.Table] || [])];
    tablesL.push({ name: t.Table, kind: S(t.Type), desc: S(t.Description), sub: pg.length ? 'on ' + pg.length + ' report pages: ' + pg.join(', ') : '',
      owner: S(t.Owner), rows: src ? rowCounts[src] ?? null : null, date: finished, cols });
  }
  catLayers.push({ key: 'pbi', label: 'Power BI', tables: tablesL });
}
return catLayers;
}

// ---------- KPI 1 chain ----------
let kpiChain = null;
const kpiMeasure = (cat?.measures || []).find(m => /KPI 1\b/.test(S(m['Dashboard slot'])));
if (kpiMeasure) {
  const srcCols = S(kpiMeasure['All source columns']).split(',').map(s => s.trim()).filter(Boolean);
  const col = srcCols.map(k => (cat.columns || []).find(c => `${c.Table}[${c.Column}]` === k)).filter(Boolean)
    .sort((a, b) => S(b['Upstream source']).length - S(a['Upstream source']).length)[0];
  kpiChain = { slot: S(kpiMeasure['Dashboard slot']), measure: kpiMeasure.Measure, dax: S(kpiMeasure.DAX),
    column: col ? `${col.Table}[${col.Column}]` : '', upstream: col ? S(col['Upstream source']).split('←').map(s => s.trim()).filter(Boolean) : [] };
}

// ---------- runs ----------
const ov = read(path.join(root, 'runs', 'overview.md'));
let runs = [];
if (ov) {
  runs = mdTable(ov).slice(1).filter(r => r.length >= 11).map(r => ({ date: r[0], id: strip(r[1]), domain: r[2], seed: r[3], rows: r[4], types: r[5], found: r[6], unexplained: r[7], tech: r[8], stops: strip(r[9]), result: strip(r[10]) }));
}
const runsDir = path.join(root, 'runs');
for (const d of ls(runsDir).filter(d => fs.existsSync(path.join(runsDir, d, 'run.json')))) {
  const short = d.replace(/^\d{4}-\d{2}-\d{2}_/, '');
  if (runs.some(r => r.id === short || r.id === d)) continue;
  const rj = readJson(path.join(runsDir, d, 'run.json')) || {};
  runs.push({ date: d.slice(0, 10), id: short, domain: rj.domain, seed: rj.seed, rows: rj.rows, types: `${(rj.errors || []).length}: ${(rj.errors || []).join(', ')}`, found: '', unexplained: '', tech: '', stops: '', result: rj.steps?.score?.result || 'running' });
}
const neverTested = ov && (ov.match(/\*\*Error types never tested[^*]*\*\*\s*([^\n]+)/) || [])[1];

// samples on catalog rows; values of possible PII columns are never shown
// samples.json keys are gold "schema.table.column" (tools/sample-sql.js); catalog rows map through "Origin"
const originOf = {};
for (const c of cat?.columns || []) originOf[`${c.Table}[${c.Column}]`] = S(c.Origin);
// query_to_xml escapes < > & in the values
const unxml = v => v == null ? v : String(v).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const sampleFor = key => unxml(samples[originOf[key]] ?? samples[key]);
let sampled = 0;
for (const r of catalog) if (r.key && sampleFor(r.key) != null) { sampled++; r.ex = r.p ? 'hidden (possible PII)' : S(sampleFor(r.key)); }

// ---------- checks: every page against the repo ----------
const V = { architecture: [], lineage: [], callgraph: [], model: [], quality: [], catalog: [] };
const chk = (page, ok, text, src) => V[page].push({ ok, text, src: src || '' });
const tmdlDir = path.join(pbipDir, `${model}.SemanticModel`, 'definition');
const tmdlTables = ls(path.join(tmdlDir, 'tables'), /\.tmdl$/);
let tmdlCols = 0, tmdlMeasures = 0;
for (const f of tmdlTables) {
  const t = read(path.join(tmdlDir, 'tables', f)) || '';
  const c = (t.match(/^\tcolumn /gm) || []).length, m = (t.match(/^\tmeasure /gm) || []).length;
  tmdlMeasures += m; tmdlCols += (m > 0 && c === 1) ? 0 : c;   // the hidden placeholder of a measure table is not catalogued
}
const tmdlRels = ((read(path.join(tmdlDir, 'relationships.tmdl')) || '').match(/^relationship /gm) || []).length;

// architecture
chk('architecture', agents.length > 0 && agents.every(a => orchestrator.agentsNamed.includes(a.name)),
  `${agents.length} agents in .claude/agents; ${orchestrator.agentsNamed.length} of them are called from /messy-pipeline`, orchestrator.file);
chk('architecture', agents.every(a => a.skills.length && a.skills.every(s => fs.existsSync(path.join(skillsDir, s, 'SKILL.md')))),
  'every agent uses at least one skill, and every skill exists: ' + agents.map(a => a.name + ' → ' + (a.skills.join(', ') || 'none')).join('; '), '.claude/skills');
chk('architecture', Object.keys(run.steps || {}).every(k => k === 'score' || agents.some(a => a.stepKey === k)),
  'every step in run.json has an agent: ' + Object.keys(run.steps || {}).join(', '), rel(path.join(runDir, 'run.json')));
chk('architecture', csv.length > 0, `${csv.length} CSV files in the dataset`, rel(dsDir));
chk('architecture', layerTables.gold.size > 0 && [...layerTables.gold].every(g => G.nodes['db:' + prefix + 'gold.' + g] || !sqlTables),
  `layers from the migrations: bronze ${layerTables.bronze.size}, silver ${layerTables.silver.size}, gold ${layerTables.gold.size}`, rel(migDir));
// lineage
if (sqlTables) {
  const goldMissing = [...layerTables.gold].filter(g => !G.nodes['db:' + prefix + 'gold.' + g]);
  chk('lineage', !goldMissing.length, goldMissing.length ? 'gold tables without lineage: ' + goldMissing.join(', ') : `all ${layerTables.gold.size} gold tables have a node in the graph`, rel(migDir));
  const pbiNoSrc = (cat?.tables || []).filter(t => S(t.Kildeobjekter) && !G.edges.some(e => e[1] === 'pbi:' + t.Table && e[0].startsWith('db:')));
  chk('lineage', !pbiNoSrc.length, pbiNoSrc.length ? 'Power BI tables without a gold source: ' + pbiNoSrc.map(t => t.Table).join(', ') : 'every Power BI table with a source object points at a gold table', 'pbip/docs/catalog.json');
  const csvNodes = lineage.nodes.filter(n => n.layer === 0);
  const csvMissing = csvNodes.filter(n => !csv.some(c => c.file === n.label));
  chk('lineage', !csvMissing.length, csvMissing.length ? 'CSV in the lineage but not in the dataset: ' + csvMissing.map(n => n.label).join(', ') : `${csvNodes.length} CSV files in the graph all exist in the dataset`, rel(dsDir));
  const unused = lineage.nodes.filter(n => n.unused);
  chk('lineage', null, unused.length ? 'not used further: ' + unused.map(n => n.label).join(', ') : 'no tables without further use', '');
} else chk('lineage', false, 'sql_lineage.py could not run', catalogScripts);
// call graph
const allScripts = agents.flatMap(a => a.calls.filter(c => c.kind === 'script').map(c => ({ ...c, agent: a.name }))).concat(orchestrator.calls.filter(c => c.kind === 'script'));
const missingScripts = allScripts.filter(c => !c.exists);
chk('callgraph', !missingScripts.length, missingScripts.length ? 'scripts that do not exist: ' + missingScripts.map(c => c.name + ' (' + c.src + ')').join(', ') : `alle ${allScripts.length} scripts exist on disken`, '');
const calledProcs = [...new Set([...migSql.matchAll(/\bcall\s+([\w.]+)\s*\(/gi)].map(m => m[1].toLowerCase()))];
const undefinedProcs = calledProcs.filter(p => !procs.some(d => d === p || d.split('.').pop() === p.split('.').pop()));
chk('callgraph', !undefinedProcs.length, undefinedProcs.length ? 'kaldte procedurer uden definition: ' + undefinedProcs.join(', ') : `${procs.length} procedurer defineret i migrationerne${calledProcs.length ? ', alle ' + calledProcs.length + ' kald har en definition' : ''}`, rel(migDir));
chk('callgraph', agents.every(a => a.status === 'done'), 'steps run: ' + agents.map(a => a.name + ' ' + a.status + (a.minutes != null ? ' (' + a.minutes + ' min)' : '')).join(', '), rel(path.join(runDir, 'run.json')));
// model
chk('model', (cat?.tables || []).length === tmdlTables.length, `${(cat?.tables || []).length} tables on the page, ${tmdlTables.length} .tmdl files`, rel(path.join(tmdlDir, 'tables')));
chk('model', rels.length === tmdlRels, `${rels.length} relationships on the page, ${tmdlRels} in relationships.tmdl`, rel(path.join(tmdlDir, 'relationships.tmdl')));
const tableNames = new Set((cat?.tables || []).map(t => t.Table));
const badEnds = rels.filter(r => !tableNames.has(r.from.split('[')[0]) || !tableNames.has(r.to.split('[')[0]));
chk('model', !badEnds.length, badEnds.length ? 'relationships to unknown tables: ' + badEnds.map(r => r.from + ' → ' + r.to).join(', ') : 'every relationship is between known tables', '');
// quality
const qcPath = path.join(runDir, 'medallion', 'tests', 'quality_checks.sql');
const qcSql = read(qcPath) || '';
const sqlChecks = new Set([...qcSql.matchAll(/\bselect\s+(\d+)(?:\s+(?:as\s+)?\w+)?\s*,\s*'(ERR|INFO)'/gi)].map(m => +m[1]));
if (sqlChecks.size) chk('quality', sqlChecks.size === quality.length, `${quality.length} tjek i quality-results.md, ${sqlChecks.size} i quality_checks.sql`, rel(qcPath));
else chk('quality', null, 'quality_checks.sql does not use the numbered format; number of checks not compared', rel(qcPath));
chk('quality', errOk === errN, `${errOk} of ${errN} error checks return 0`, 'medallion/docs/quality-results.md');
const nums = quality.map(q => q.no), dupNums = nums.filter((n, i) => nums.indexOf(n) !== i);
chk('quality', nums.length > 0 && !dupNums.length, dupNums.length ? 'check numbers used twice: ' + [...new Set(dupNums)].join(', ') : `${nums.length} checks with unique numbers`, 'medallion/docs/quality-results.md');
// catalog
const catCols = catalog.filter(r => r.k === 'Column').length, catMeas = catalog.filter(r => r.k === 'Measure').length;
chk('catalog', catCols === tmdlCols, `${catCols} columns in the catalog, ${tmdlCols} in TMDL`, rel(path.join(tmdlDir, 'tables')));
chk('catalog', catMeas === tmdlMeasures, `${catMeas} measures i kataloget, ${tmdlMeasures} i TMDL`, rel(path.join(tmdlDir, 'tables')));
chk('catalog', missingDesc === 0, `${missingDesc} felter uden beskrivelse`, 'pbip/docs/catalog.json');
// same rule as tools/sample-sql.js: columns read straight from a gold table, possible PII left out
const sampleable = (cat?.columns || []).filter(c => !c['Possible PII'] && /^(\w+)\.(\w+)\.(\w+)$/.test(S(c.Origin)) && (!prefix || S(c.Origin).startsWith(prefix))).length;
const sampledOk = (cat?.columns || []).filter(c => !c['Possible PII'] && sampleFor(`${c.Table}[${c.Column}]`) != null).length;
chk('catalog', Object.keys(samples).length ? sampledOk === sampleable : null,
  Object.keys(samples).length ? `${sampledOk} of ${sampleable} columns from gold have sample values (calculated and possible-PII columns are not fetched)` : 'no samples.json – run tools/sample-sql.js', 'pbip/docs/samples.json');
const verifySummary = Object.fromEntries(Object.entries(V).map(([k, v]) => [k, `${v.filter(c => c.ok === true).length}/${v.filter(c => c.ok !== null).length}`]));
const verifyFailed = Object.entries(V).flatMap(([k, v]) => v.filter(c => c.ok === false).map(c => k + ': ' + c.text));

// ---------- assemble ----------
const D = {
  id, domain: run.domain, seed: run.seed, rows: run.rows, errors: run.errors || [], prefix, result, lede,
  steps: Object.fromEntries(Object.entries(run.steps || {}).map(([k, v]) => [k, v.status])),
  screenshot: run.steps?.layout?.screenshot || '', commit: run.steps?.publish?.commit || '',
  types, numbers, quality, errN, errOk, infos, decisions,
  csv, docs: docs.length, migrations: migFiles.length, layers: { bronze: layerTables.bronze.size, silver: layerTables.silver.size, gold: layerTables.gold.size },
  goldTables: [...layerTables.gold], procs, tempTables, rawLineCount,
  model, culture, pages, lineageGraphs, catalog, catLayers: buildCatLayers(), missingDesc, tables, rels, lineage, kpiChain, agents, orchestrator, verify: V,
  measures: (cat?.measures || []).length, pbiTables: (cat?.tables || []).length, runs, neverTested: neverTested || '',
  // whole run: first step started → score finished (minutes)
  runMinutes: (() => { const st = Object.values(run.steps || {}), a = st.map(s => Date.parse(s.started)).filter(Number.isFinite), b = st.map(s => Date.parse(s.finished)).filter(Number.isFinite);
    return a.length && b.length ? Math.round((Math.max(...b) - Math.min(...a)) / 60000) : null; })(),
  finishedAt: (Object.values(run.steps || {}).map(s => s.finished).filter(Boolean).sort().pop() || '').slice(0, 16).replace('T', ' '),
  built: new Date().toISOString().slice(0, 16).replace('T', ' ')
};
const tpl = read(path.join(__dirname, 'site-template.html'));
if (!tpl) { console.error('tools/site-template.html missing'); process.exit(1); }
const json = JSON.stringify(D).replace(/</g, '\\u003c');
const html = tpl.replace('__TITLE__', `Messy-pipeline ${id.replace(/^\d{4}-\d{2}-\d{2}_/, '')}`).replace('/*__DATA__*/', json);
const outFile = path.join(runDir, 'site.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log(JSON.stringify({ site: path.relative(root, outFile), kb: Math.round(html.length / 1024), types: types.length, checks: quality.length, catalog: catalog.length,
  lineage: { nodes: lineage.nodes.length, edges: lineage.edges.length }, agents: agents.length, samples: sampled, verify: verifySummary, verifyFailed, runs: runs.length, warnings: warn }));
