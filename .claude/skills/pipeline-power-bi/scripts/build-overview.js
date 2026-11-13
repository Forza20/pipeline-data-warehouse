#!/usr/bin/env node
// Project overview page for a pipeline-power-bi run: sources -> staging -> model -> report, the star
// schema, cleaning steps, measures, privacy/security and the control numbers – one self-contained HTML
// file (no external scripts). Optional: an Obsidian note.
//
//   node build-overview.js runs/<run-id> [--colors <file.json>] [--vault "<vault folder>" --folder Pipeline]
//
// Colours: the default palette is the toolkit look (purple, gold, orange on dark). To change it, put
// overview-colors.json in the run folder (or pass --colors <file>), e.g.
//   { "accent": "#0f7b6c", "fact": "#d97706", "dark": { "background": "#0b1416" } }
// The page is dark by default; "theme": "light" or "auto" (follows the system) changes that. Flat keys apply
// to the page's theme(s); keys under "light" / "dark" to one theme only. Keys: see COLOR_KEYS.
// The page also has a Colours panel to try colours live; it shows the JSON to save as that file.
//
// Reads: choices.json, profile.json, cleaning-log.md, expected-values.md, pbip/<Name>.SemanticModel
// (tables, relationships, roles, expressions), pbip/docs/catalog.json and layout-config.json if present.
// Writes: runs/<run-id>/overview.html, overview.page.html (and <vault>/<folder>/Power BI/<run-id>.md with --vault).
'use strict';
const fs = require('fs');
const path = require('path');

const runDir = path.resolve(process.argv[2] || '');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
if (!fs.existsSync(path.join(runDir, 'choices.json'))) {
  console.error('Usage: node build-overview.js runs/<run-id> [--vault <folder> --folder Pipeline]');
  process.exit(1);
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return null; } };
const json = (p) => { const t = read(p); try { return t ? JSON.parse(t) : null; } catch { return null; } };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// a review point's measured evidence: { value, how } (or a plain string) → "value – how"
const evidenceText = (r) => { const e = r && r.evidence; if (!e) return ''; if (typeof e !== 'object') return String(e); return [e.value, e.how].filter(Boolean).join(' – '); };
const warn = [];

const choices = json(path.join(runDir, 'choices.json'));
const profile = json(path.join(runDir, 'profile.json')) || { tables: [], relations: [] };
const pbipDir = path.join(runDir, 'pbip');
const smDir = fs.existsSync(pbipDir) ? fs.readdirSync(pbipDir).find((d) => d.endsWith('.SemanticModel')) : null;
const def = smDir ? path.join(pbipDir, smDir, 'definition') : null;
if (!def) warn.push('no SemanticModel found under pbip/');
const catalog = json(path.join(pbipDir, 'docs', 'catalog.json'));
const layout = json(path.join(pbipDir, 'docs', 'layout-config.json'));

// ---------- model from TMDL ----------
const model = { tables: [], rels: [], roles: [], staging: [] };
if (def) {
  const tdir = path.join(def, 'tables');
  for (const f of fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((x) => x.endsWith('.tmdl')) : []) {
    const t = read(path.join(tdir, f));
    const name = (t.match(/^table\s+('([^']+)'|(\S+))/m) || [])[2] || (t.match(/^table\s+(\S+)/m) || [])[1];
    if (/^(LocalDateTable|DateTableTemplate)/.test(name)) continue;
    const cols = [...t.matchAll(/^\tcolumn\s+('([^']+)'|([^\s=]+))([\s\S]*?)(?=^\t(column|measure|partition)|\s*$(?![\s\S]))/gm)].map((m) => ({ name: m[2] || m[3], hidden: /\n\t\tisHidden/.test(m[4]) }));
    const measures = [...t.matchAll(/^\tmeasure\s+('([^']+)'|([^\s=]+))/gm)].map((m) => m[2] || m[3]);
    const group = (t.match(/queryGroup:\s*(\S+)/) || [])[1] || '';
    const hiddenTable = /^\tisHidden/m.test(t.split('\n\tcolumn')[0]);
    const desc = (t.match(/^\/\/\/\s*(.+)\ntable/m) || [])[1] || '';
    let kind = 'other';
    if (/^_measures$/i.test(name) || (measures.length && cols.every((c) => c.hidden))) kind = 'measures';
    else if (/dataCategory:\s*Time/.test(t)) kind = 'date';
    else if (/Fact/i.test(group)) kind = 'fact';
    else if (/Dimension/i.test(group)) kind = 'dimension';
    else if (/Support/i.test(group) || hiddenTable) kind = 'support';
    model.tables.push({ name, kind, cols, measures, group, desc });
  }
  const rt = read(path.join(def, 'relationships.tmdl')) || '';
  for (const block of rt.split(/\n(?=relationship )/)) {
    const f = (block.match(/fromColumn:\s*(.+)/) || [])[1];
    const to = (block.match(/toColumn:\s*(.+)/) || [])[1];
    if (!f || !to) continue;
    const tbl = (s) => s.trim().replace(/^'([^']+)'\..*$/, '$1').replace(/^([^.']+)\..*$/, '$1');
    const col = (s) => s.trim().replace(/^.*\.'?([^']+)'?$/, '$1');
    model.rels.push({ from: tbl(f), fromCol: col(f), to: tbl(to), toCol: col(to), active: !/isActive:\s*false/.test(block), both: /bothDirections/.test(block) });
  }
  const rdir = path.join(def, 'roles');
  for (const f of fs.existsSync(rdir) ? fs.readdirSync(rdir) : []) {
    const r = read(path.join(rdir, f));
    model.roles.push({ name: (r.match(/^role\s+'?([^'\n]+)'?/m) || [])[1], filters: [...r.matchAll(/tablePermission\s+('([^']+)'|(\S+))\s*=\s*(.+)/g)].map((m) => ({ table: m[2] || m[3], expr: m[4] })) });
  }
  const ex = read(path.join(def, 'expressions.tmdl')) || '';
  for (const m of ex.matchAll(/(?:\/\/\/\s*(.*)\n)?expression\s+('([^']+)'|([^\s=]+))\s*=([\s\S]*?)(?=\n(?:\/\/\/[^\n]*\n)?expression\s|$(?![\s\S]))/g)) {
    const body = m[5];
    if (/IsParameterQuery/.test(body) || /queryGroup:\s*Functions/.test(body) || /PBI_ResultType = Function/.test(body)) continue;
    model.staging.push({ name: m[3] || m[4], desc: m[1] || '', steps: [...body.matchAll(/#"([FM]\d\d[^"]*)"\s*=/g)].map((s) => s[1]) });
  }
}
const facts = model.tables.filter((t) => t.kind === 'fact');
const dims = model.tables.filter((t) => t.kind === 'dimension' || t.kind === 'date');
const others = model.tables.filter((t) => !['fact', 'dimension', 'date', 'measures'].includes(t.kind));
const measureList = catalog && catalog.measures ? catalog.measures : model.tables.filter((t) => t.kind === 'measures').flatMap((t) => t.measures.map((n) => ({ Measure: n })));

// ---------- sources and cleaning ----------
const FIX = {
  F01: 'Skip lines above the header', F02: 'Readable column names', F03: 'Remove empty rows', F04: 'Remove total rows', F05: 'Trim spaces',
  F06: '"No value" text to empty', F07: 'One spelling per value', F08: 'Parse dates', F09: 'Parse numbers', F10: 'Parse true/false', F11: 'One id format',
  F12: 'Remove exact duplicates', F13: 'One row per key', F14: 'Flag amount anomalies', F15: 'Flag invalid/future dates', F16: 'Unpivot period columns',
  F17: 'Data types', F18: 'Add missing members', F19: 'Remove empty columns', F20: 'Malformed lines', F21: 'Append tables', F22: 'Leave out copy',
  F23: 'Split combined column', F24: 'List to rows', F25: 'Remove technical columns', F26: 'Personal data', F27: 'Remove test rows', F28: 'Name codes',
  F29: 'Primary row only', M01: 'Incomplete last month', M02: 'Repeated attributes to dimension',
};
const srcRows = [];
for (const t of profile.tables || []) {
  const c = (choices.tables || {})[t.name] || {};
  const kept = (c.fixes || []).filter((f) => f.keep && !['F17', 'F02'].includes(f.fix));
  srcRows.push({ name: t.name, kind: t.kind || 'csv', rows: t.dataRows, cols: t.columnsCount, findings: (t.findings || []).filter((f) => !['F17', 'F02'].includes(f.fix)).length, include: c.include !== false, reason: c.reason || (c.appended_to ? 'appended to ' + c.appended_to : ''), kept });
}
const design = choices.design || null;

// ---------- markdown (tables, headings, lists) to HTML ----------
function md(text) {
  if (!text) return '<p class="dim">Not written yet.</p>';
  const out = []; const lines = text.split(/\r?\n/); let i = 0;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push(`<div class="tw"><table class="t"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^#{1,3}\s/.test(l)) { const n = Math.min(4, l.match(/^#+/)[0].length + 2); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`); i++; continue; }
    if (/^\s*-\s/.test(l)) { const items = []; while (i < lines.length && /^\s*-\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*-\s/, '')); out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue; }
    if (l.trim()) { const p = []; while (i < lines.length && lines[i].trim() && !/^(\||#|\s*-\s)/.test(lines[i])) p.push(lines[i++]); out.push(`<p>${inline(p.join(' '))}</p>`); continue; }
    i++;
  }
  return out.join('\n');
}

// ---------- star schema SVG ----------
function star() {
  const F = facts.length ? facts : model.tables.filter((t) => !['measures', 'date'].includes(t.kind)).slice(0, 1);
  const D = [...dims, ...others.filter((t) => model.rels.some((r) => r.to === t.name))];
  const H = 34, gap = 14, w = 240;
  const rowsN = Math.max(F.length, D.length);
  const height = rowsN * (H + gap) + 40;
  const xF = 20, xD = 520;
  const yOf = (list, i) => 30 + i * (H + gap) + ((rowsN - list.length) * (H + gap)) / 2;
  const pos = {};
  F.forEach((t, i) => { pos[t.name] = { x: xF, y: yOf(F, i), side: 'r' }; });
  D.forEach((t, i) => { pos[t.name] = { x: xD, y: yOf(D, i), side: 'l' }; });
  let lines = '';
  for (const r of model.rels) {
    const a = pos[r.from], b = pos[r.to];
    if (!a || !b) continue;
    const x1 = a.side === 'r' ? a.x + w : a.x, y1 = a.y + H / 2, x2 = b.side === 'l' ? b.x : b.x + w, y2 = b.y + H / 2;
    if (a.side === b.side) continue;
    lines += `<path class="rel${r.active ? '' : ' off'}" d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}"><title>${esc(r.from)}[${esc(r.fromCol)}] → ${esc(r.to)}[${esc(r.toCol)}]${r.active ? '' : ' (inactive)'}</title></path>`;
  }
  const box = (t) => { const p = pos[t.name]; return `<g class="ent ${t.kind}"><rect class="bx" x="${p.x}" y="${p.y}" width="${w}" height="${H}" rx="6"/><rect class="bar" x="${p.x}" y="${p.y}" width="4" height="${H}"/><text class="nm" x="${p.x + 16}" y="${p.y + 22}">${esc(t.name)}</text><text class="k" x="${p.x + w - 10}" y="${p.y + 22}" text-anchor="end">${t.kind === 'fact' ? 'fact' : t.kind === 'date' ? 'date' : t.kind === 'support' ? 'support' : 'dim'}</text></g>`; };
  return `<svg viewBox="0 0 ${xD + w + 20} ${height}" role="img" aria-label="Star schema">${lines}${[...F, ...D].map(box).join('')}</svg>`;
}

// ---------- colours ----------
const COLOR_KEYS = {
  accent: ['--purple', 'Accent'], accentText: ['--purple-soft', 'Keys and accent text'], fact: ['--gold', 'Fact tables'],
  dimension: ['--dimc', 'Dimension tables'], date: ['--datec', 'Date table'], lines: ['--wire', 'Relationship lines'],
  warning: ['--orange', 'Report and warnings'], alert: ['--red', 'Left out and errors'],
  background: ['--bg', 'Background'], card: ['--plate', 'Cards'], nav: ['--nav', 'Top bar'], ink: ['--ink', 'Text'],
};
const TOK_DARK = '--bg:#0f0a1e;--plate:#221a40;--nav:#0d0919;--ink:#ece7f8;--ink-2:rgba(236,231,248,.72);--line:rgba(236,231,248,.16);--line-2:rgba(236,231,248,.08);--purple:#8a63f2;--purple-soft:#c9b8ff;--gold:#ffd23f;--dimc:#ffd23f;--datec:#ffd23f;--wire:rgba(201,184,255,.36);--orange:#ffa657;--red:#ff8a73;--soft:rgba(138,99,242,.18);--paper:linear-gradient(160deg,#1b1436 0%,#110c24 100%);--paper-line:rgba(138,99,242,.28);--grid:rgba(236,231,248,.03);--shadow:0 1px 0 rgba(0,0,0,.45),0 6px 18px rgba(0,0,0,.25);color-scheme:dark';
const TOK_LIGHT = '--bg:#f6f4fb;--plate:#ffffff;--nav:#ffffff;--ink:#1d1630;--ink-2:#5d5672;--line:rgba(29,22,48,.16);--line-2:rgba(29,22,48,.08);--purple:#6b45e0;--purple-soft:#5a3bc8;--gold:#a87b00;--dimc:#a87b00;--datec:#a87b00;--wire:rgba(90,59,200,.38);--orange:#b35a00;--red:#c2412b;--soft:rgba(107,69,224,.08);--paper:linear-gradient(160deg,#ffffff 0%,#f1ecfd 100%);--paper-line:rgba(107,69,224,.22);--grid:rgba(29,22,48,.035);--shadow:0 1px 0 rgba(29,22,48,.06),0 6px 18px rgba(29,22,48,.06);color-scheme:light';
const okColor = (v) => typeof v === 'string' && /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s/]+\)|[a-z]{3,20})$/i.test(v.trim());
const colorFile = arg('--colors') ? path.resolve(arg('--colors')) : path.join(runDir, 'overview-colors.json');
let colorCfg = choices.overview_colors || null;
if (fs.existsSync(colorFile)) colorCfg = json(colorFile) || (warn.push('colours file is not valid JSON: ' + path.basename(colorFile)), null);
else if (arg('--colors')) warn.push('colours file not found: ' + colorFile);
const colorVars = (o) => Object.entries(o || {}).filter(([k, v]) => {
  if (k === 'light' || k === 'dark' || k === 'theme') return false;
  if (!COLOR_KEYS[k]) { warn.push(`colour key "${k}" unknown (use ${Object.keys(COLOR_KEYS).join(', ')})`); return false; }
  if (!okColor(v)) { warn.push(`colour ${k}: "${v}" is not a colour`); return false; }
  return true;
}).map(([k, v]) => `${COLOR_KEYS[k][0]}:${v.trim()}`);
const THEME = colorCfg && colorCfg.theme ? (['dark', 'light', 'auto'].includes(colorCfg.theme) ? colorCfg.theme : (warn.push(`theme "${colorCfg.theme}" unknown (use dark, light or auto)`), 'dark')) : 'dark';
const rootCss = THEME === 'auto'
  ? `:root{${TOK_LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${TOK_DARK}}}
:root[data-theme="dark"]{${TOK_DARK}}`
  : `:root{${THEME === 'light' ? TOK_LIGHT : TOK_DARK}}`;
let userCss = '';
if (colorCfg && typeof colorCfg === 'object') {
  const flat = colorVars(colorCfg);
  const light = [...flat, ...colorVars(colorCfg.light)].join(';');
  const dark = [...flat, ...colorVars(colorCfg.dark)].join(';');
  const css = THEME === 'auto'
    ? `${light ? `:root{${light}}` : ''}
${dark ? `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}
:root[data-theme="dark"]{${dark}}` : ''}`
    : ((v) => (v ? `:root{${v}}` : ''))(THEME === 'light' ? light : dark);
  if (css.trim()) userCss = `<style id="user-colors">\n${css}\n</style>`;
}

// ---------- page ----------
const name = choices.name || path.basename(runDir);
const kept = srcRows.reduce((n, s) => n + s.kept.length, 0);
const included = srcRows.filter((s) => s.include).length;
const piiHidden = model.tables.flatMap((t) => t.cols.filter((c) => c.hidden && catalog && (catalog.columns || []).some((x) => x.Table === t.name && x.Column === c.name && /^(Yes|Ja)\b/.test(x['Possible PII'] || '')))).length;
const runId = choices.run_id || path.basename(runDir);
const status = choices.status || {};
const built = new Date().toISOString().slice(0, 16).replace('T', ' ');
const modelTables = model.tables.filter((t) => t.kind !== 'measures');
const kindTag = (k) => `<span class="tag ${esc(k)}">${k === 'dimension' ? 'dim' : esc(k)}</span>`;
const kpi = (v, l, sub, cls) => `<div class="kpi"><div class="l">${esc(l)}</div><div class="v${cls ? ' ' + cls : ''}">${esc(v)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>`;
const arrow = '<div class="arr" aria-hidden="true"><svg viewBox="0 0 40 24"><path d="M4 12h30M26 5l8 7-8 7"/></svg></div>';
const layer = (nm, cnt, unit, items, cls) => `<div class="layer ${cls}"><div class="nm">${esc(nm)}</div><div class="cnt">${cnt}<small>${esc(unit)}</small></div><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
const sec = (id, title, one, inner) => `<section class="s" id="${id}"><h2>${title}</h2>${one ? `<p class="one">${one}</p>` : ''}<div class="vis">${inner}</div></section>`;
const navItems = [['flow', 'Flow'], ['star', 'Star schema'], ...(design ? [['design', 'Design']] : []), ['cleaning', 'Cleaning'], ['rels', 'Relationships'], ['measures', 'Measures'], ['security', 'Security'], ['control', 'Control numbers']];
const verify = status.verify || 'pending';
const MONO = `'JetBrains Mono',Consolas,monospace`;

const colorScript = `(() => {
  const K = ${JSON.stringify(COLOR_KEYS)};
  const root = document.documentElement, $ = (id) => document.getElementById(id);
  const btn = $('cbtn'), panel = $('cpanel'), rows = $('crows'), out = $('cjson');
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const FIXED = ${JSON.stringify(THEME === 'auto' ? null : THEME)};
  const mode = () => FIXED || ((root.dataset.theme === 'dark' || (root.dataset.theme !== 'light' && mq && mq.matches)) ? 'dark' : 'light');
  const KEY = 'overview-colors:' + location.pathname;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { saved = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* private window */ } };
  const cx = document.createElement('canvas').getContext('2d');
  const hex = (v) => { cx.fillStyle = '#000000'; cx.fillStyle = (v || '').trim(); const c = cx.fillStyle; if (/^#[0-9a-f]{6}$/i.test(c)) return c; const n = c.match(/\\d+/g); return n ? '#' + n.slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('') : '#000000'; };
  const apply = () => { for (const k in K) root.style.removeProperty(K[k][0]); const m = saved[mode()] || {}; for (const k in m) if (K[k]) root.style.setProperty(K[k][0], m[k]); };
  const dump = () => { const m = saved[mode()] || {}; out.value = Object.keys(m).length ? JSON.stringify({ [mode()]: m }, null, 2) : '{}  (no changes)'; };
  const render = () => {
    apply(); $('cmode').textContent = '– ' + mode() + ' theme';
    const cs = getComputedStyle(root); rows.innerHTML = '';
    for (const k in K) {
      const lab = document.createElement('label'); lab.className = 'crow2'; lab.textContent = K[k][1];
      const i = document.createElement('input'); i.type = 'color'; i.value = hex(cs.getPropertyValue(K[k][0]));
      i.addEventListener('input', () => { (saved[mode()] = saved[mode()] || {})[k] = i.value; root.style.setProperty(K[k][0], i.value); save(); dump(); });
      lab.appendChild(i); rows.appendChild(lab);
    }
    dump();
  };
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; btn.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) render(); });
  $('creset').addEventListener('click', () => { delete saved[mode()]; save(); render(); });
  $('ccopy').addEventListener('click', () => { const done = () => { $('ccopy').textContent = 'Copied'; setTimeout(() => { $('ccopy').textContent = 'Copy'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(out.value).then(done, () => out.select()); else out.select(); });
  if (mq && mq.addEventListener) mq.addEventListener('change', () => (panel.hidden ? apply() : render()));
  apply();
})();`;

const head = `<title>${esc(name)} model overview</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,600;12..96,700;12..96,800&family=JetBrains+Mono:wght@400;500;600&display=swap">
<style>
${rootCss}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background-color:var(--bg);background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:48px 48px;color:var(--ink);font:16px/1.5 'Bricolage Grotesque',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
code,.mono{font-family:${MONO};font-variant-ligatures:none}
code{font-size:.86em;color:var(--purple-soft)}
.dim{color:var(--ink-2)} .out{color:var(--red)} .orange{color:var(--orange)}
a{color:inherit;text-decoration:none}
[id]{scroll-margin-top:76px}
p,.one,.lead{text-wrap:pretty}
nav{position:sticky;top:0;z-index:10;height:60px;display:flex;align-items:center;gap:4px;padding:0 clamp(16px,4vw,48px);background:var(--nav);border-bottom:1px solid var(--line);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav .brand{font-family:${MONO};font-size:15px;margin-right:14px}
nav a.p{font-size:15px;color:var(--ink-2);padding:6px 10px;border-radius:8px}
nav a.p:hover{color:var(--ink);background:var(--soft)}
nav .built{margin-left:auto;padding-left:16px;font-family:${MONO};font-size:13.5px;color:var(--ink-2)}
main{max-width:1240px;margin:0 auto;padding:48px clamp(16px,4vw,48px) 120px}
h1{margin:0;font-size:clamp(30px,5vw,44px);font-weight:800;letter-spacing:-.02em;line-height:1.05}
.lead{margin:14px 0 0;font-size:18px;color:var(--ink-2);line-height:1.5}
.kpis{margin-top:30px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden}
.kpi{padding:18px 18px 18px 20px;border-left:1px solid var(--line);margin-left:-1px}
.kpi .l{font-size:14.5px;color:var(--ink-2)}
.kpi .v{margin-top:6px;font-size:34px;font-weight:700;line-height:1.05;letter-spacing:-.01em}
.kpi .v.sm{font-size:20px;margin-top:10px;line-height:1.25}
.kpi .sub{margin-top:6px;font-family:${MONO};font-size:12.5px;color:var(--ink-2)}
.s{margin-top:84px}
.s h2{margin:0;font-size:26px;font-weight:700;letter-spacing:-.01em;line-height:1.15}
.s .one{margin:6px 0 0;font-size:17px;color:var(--ink-2);max-width:860px}
.vis{margin-top:22px}
.layers{display:flex;align-items:stretch}
.layer{flex:1;min-width:0;border:1px solid var(--line);border-left:4px solid var(--purple);border-radius:12px;padding:16px 16px 14px;background:var(--plate);box-shadow:var(--shadow)}
.layer.stage{border-left-color:var(--ink-2)} .layer.model{border-left-color:var(--gold)} .layer.report{border-left-color:var(--orange)}
.layer .nm{font-family:${MONO};font-size:13.5px;color:var(--purple-soft)}
.layer .cnt{margin-top:8px;font-size:34px;font-weight:700;line-height:1}
.layer .cnt small{margin-left:8px;font-size:15px;font-weight:600;color:var(--ink-2)}
.layer ul{list-style:none;margin:14px 0 0;padding:0;font-size:14.5px;line-height:1.35}
.layer li{padding:6px 0;border-top:1px solid var(--line-2);overflow-wrap:anywhere}
.layer li .r{float:right;margin-left:8px;font-family:${MONO};font-size:12.5px;color:var(--ink-2)}
.layer li .why{display:block;margin-top:2px;font-size:13px;color:var(--red)}
.arr{flex:none;width:34px;align-self:center;display:flex;justify-content:center}
.arr svg{width:28px;height:20px;fill:none;stroke:var(--ink-2);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
@media (max-width:900px){.layers{flex-direction:column}.arr{width:auto;height:34px}.arr svg{transform:rotate(90deg)}}
.paper{background:var(--paper);border:1px solid var(--paper-line);border-radius:16px;padding:clamp(14px,2.5vw,28px)}
.tw{overflow-x:auto}
.er svg{display:block;width:100%;min-width:640px;height:auto}
.er .ent rect.bx{fill:var(--plate);stroke:var(--line);stroke-width:1}
.er .ent.fact rect.bx{stroke:var(--gold);stroke-width:1.5} .er .ent.support rect.bx{stroke-dasharray:5 4}
.er .ent rect.bar{stroke:none;fill:var(--dimc)} .er .ent.fact rect.bar{fill:var(--gold)} .er .ent.date rect.bar{fill:var(--datec)} .er .ent.support rect.bar{fill:var(--ink-2)}
.er .ent{filter:drop-shadow(0 1px 0 rgba(0,0,0,.35))}
.er text{font-family:${MONO};font-size:12px;fill:var(--purple-soft)} .er text.nm{font-family:'Bricolage Grotesque',system-ui,sans-serif;font-size:15px;font-weight:600;fill:var(--ink)}
.er .rel{fill:none;stroke:var(--wire);stroke-width:1.4} .er .rel.off{stroke-dasharray:5 4}
.er .rel:hover{stroke:var(--purple-soft);stroke-width:2.4}
.legend{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:16px;font-size:14px;color:var(--ink-2)}
.legend i{display:inline-block;width:14px;height:14px;border-radius:4px;border:2px solid;vertical-align:-2px;margin-right:7px}
.legend i.b{border:1px solid var(--line);border-left:4px solid;border-radius:3px}
.legend i.l{width:22px;height:0;border-width:1px 0 0;border-radius:0;vertical-align:4px} .legend i.l.off{border-top-style:dashed}
table.t{width:100%;border-collapse:collapse}
.t th{font-size:13.5px;font-weight:600;color:var(--ink-2);text-align:left;padding:0 20px 10px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.t td{padding:10px 20px 10px 0;border-bottom:1px solid var(--line-2);vertical-align:baseline;font-size:15.5px;line-height:1.4}
.t td:last-child,.t th:last-child{padding-right:0}
.t td.m{font-family:${MONO};font-size:13.5px;white-space:nowrap}
.t td.col{font-weight:600;white-space:nowrap}
.t td.dax{font-family:${MONO};font-size:12.5px;color:var(--ink-2);min-width:300px}
.t td.num{text-align:right;font-family:${MONO};font-size:14px} .t th.num{text-align:right}
.t tbody tr:hover td{background:var(--soft)}
.tag{display:inline-block;font-family:${MONO};font-size:12px;color:var(--ink-2);border:1px solid var(--line);border-radius:6px;padding:1px 8px;margin:2px 4px 2px 0;white-space:nowrap}
.tag.fact{color:var(--gold);border-color:currentColor} .tag.date{color:var(--datec);border-color:currentColor} .tag.dimension{color:var(--dimc);border-color:currentColor}
.tag b{font-weight:600;color:var(--purple-soft);margin-right:4px}
.kv{display:grid;grid-template-columns:220px minmax(0,1fr);gap:12px 24px;margin-top:24px;font-size:15.5px}
.kv .k{font-family:${MONO};font-size:13.5px;color:var(--purple-soft);padding-top:2px}
@media (max-width:640px){.kv{grid-template-columns:1fr;gap:4px}.kv .k{margin-top:10px}}
.plates{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.plate{border:1px solid var(--line);border-radius:14px;padding:20px 22px;background:var(--plate);box-shadow:var(--shadow);min-width:0}
.plate .k{font-family:${MONO};font-size:13px;color:var(--ink-2)}
.plate .v{margin-top:6px;font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
.plate .line{margin-top:10px;font-size:15px;color:var(--ink-2);overflow-wrap:anywhere}
details{margin-top:20px;border:1px solid var(--line);border-radius:12px;background:var(--plate)}
summary{cursor:pointer;padding:12px 16px;font-weight:600;color:var(--purple-soft)}
details>.prose{padding:0 16px 16px}
.prose h3{font-size:19px;margin:22px 0 8px} .prose h4{font-size:16px;margin:18px 0 6px}
.prose p,.prose ul{max-width:900px;color:var(--ink-2)} .prose .tw{margin:12px 0}
.cbtn{margin-left:12px;font:inherit;font-size:14px;color:var(--ink-2);background:none;border:1px solid var(--line);border-radius:8px;padding:5px 12px;cursor:pointer}
.cbtn:hover,.cbtn[aria-expanded="true"]{color:var(--ink);background:var(--soft)}
.cpanel{position:fixed;top:68px;right:clamp(8px,2vw,24px);z-index:20;width:min(340px,calc(100vw - 16px));max-height:calc(100vh - 84px);overflow:auto;background:var(--plate);border:1px solid var(--line);border-radius:14px;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.cpanel[hidden]{display:none}
.cpanel h3{margin:0 0 4px;font-size:17px} .cpanel p{margin:0 0 12px;font-size:13.5px;color:var(--ink-2)}
.crow2{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line-2);font-size:14.5px;cursor:pointer}
.crow2 input{width:46px;height:28px;padding:0;border:1px solid var(--line);border-radius:6px;background:none;cursor:pointer}
.cpanel textarea{width:100%;height:110px;margin-top:12px;font-family:${MONO};font-size:12px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;resize:vertical}
.cacts{display:flex;gap:8px;margin-top:10px} .cacts .cbtn{margin:0}
footer{margin-top:90px;padding-top:16px;border-top:1px solid var(--line);font-family:${MONO};font-size:12.5px;color:var(--ink-2)}
</style>
${userCss}`;

const reportItems = layout ? [`Page <b>${esc(layout.pageName || 'Dashboard')}</b>${layout.title ? ` <span class="dim">– ${esc(layout.title)}</span>` : ''}`, `${(layout.kpis || []).length} KPI tiles`, 'Trend with forecast', `${(layout.monthly || []).length} monthly cards`, layout.bar ? 'Bar chart' : '', layout.table ? 'Top-10 table' : '', `${(layout.highlights || []).length} highlight tiles`].filter(Boolean) : ['<span class="dim">no dashboard layout</span>'];

const body = `<nav><span class="brand">${esc(runId)}</span>${navItems.map(([id, t]) => `<a class="p" href="#${id}">${t}</a>`).join('')}<span class="built">built ${esc(built)}</span><button class="cbtn" id="cbtn" type="button" aria-expanded="false" aria-controls="cpanel">Colours</button></nav>
<div class="cpanel" id="cpanel" hidden><h3>Colours <span class="dim" id="cmode"></span></h3>
<p>Changes show at once and are kept in this browser only. To make them the page's own colours, save the text below as <code>overview-colors.json</code> in the run folder and build the page again.</p>
<div id="crows"></div><textarea id="cjson" readonly aria-label="Colours as JSON"></textarea>
<div class="cacts"><button class="cbtn" id="ccopy" type="button">Copy</button><button class="cbtn" id="creset" type="button">Reset</button></div></div>
<main>
<h1>${esc(name)} – model overview</h1>
<p class="lead">Source <code>${esc(choices.source_original || choices.source_folder || '')}</code> · build <b>${esc(status.build || '')}</b> · check in Power BI: <span class="${/^pending/.test(verify) ? 'orange' : ''}">${esc(verify)}</span></p>
<div class="kpis">${kpi(srcRows.length, 'Source tables', `${included} included`)}${kpi(facts.length + ' + ' + dims.length, 'Facts + dimensions')}${kpi(model.rels.length, 'Relationships', `${model.rels.filter((r) => !r.active).length} inactive`)}${kpi(measureList.length, 'Measures')}${kpi(kept, 'Cleaning steps kept')}${kpi(model.roles.length ? model.roles.map((r) => r.name).join(', ') : 'none', 'Security roles', '', 'sm')}</div>

${sec('flow', 'From sheet to report', 'Every source sheet, the staging queries that clean it (not loaded), the tables in the model and the report page built on them.', `<div class="layers">
${layer('sources', srcRows.length, 'sheets', srcRows.map((s) => `${esc(s.name)}<span class="r">${s.rows ?? 0}</span>${s.include ? '' : `<span class="why">${esc(s.reason || 'left out')}</span>`}`), 'src')}${arrow}
${layer('staging', model.staging.length, 'queries', model.staging.length ? model.staging.map((s) => `<code>${esc(s.name)}</code><span class="r">${s.steps.length} steps</span>`) : ['<span class="dim">one query per table (no staging layer)</span>'], 'stage')}${arrow}
${layer('model', modelTables.length, 'tables', [...facts.map((t) => `<b>${esc(t.name)}</b> ${kindTag('fact')}`), ...dims.map((t) => `${esc(t.name)} ${kindTag(t.kind)}`), ...others.map((t) => `${esc(t.name)} ${kindTag(t.kind)}`)], 'model')}${arrow}
${layer('report', layout ? 1 : 0, layout ? 'page' : 'pages', reportItems, 'report')}
</div>`)}

${sec('star', 'Star schema', 'Facts on the left, the dimensions they filter by on the right. Hover a line for its columns.', `<div class="paper"><div class="tw er">${star()}</div>
<div class="legend"><span><i class="b" style="border-color:var(--gold)"></i>fact</span><span><i class="b" style="border-left-color:var(--dimc)"></i>dimension</span><span><i class="b" style="border-left-color:var(--datec)"></i>date</span><span><i class="l" style="border-color:var(--wire)"></i>active</span><span><i class="l off" style="border-color:var(--wire)"></i>inactive (USERELATIONSHIP)</span></div></div>`)}

${design ? sec('design', 'Design', 'The grain of each fact, the key of each dimension and the sheets each table is built from.', `<div class="tw"><table class="t"><thead><tr><th>Table</th><th>Kind</th><th>Grain / key</th><th>Built from</th></tr></thead><tbody>
${(design.facts || []).map((f) => `<tr><td class="col">${esc(f.name)}</td><td>${kindTag('fact')}</td><td>${esc(f.grain)}</td><td class="m">${esc((f.sources || []).join(', '))}</td></tr>`).join('')}
${(design.dimensions || []).map((d) => `<tr><td class="col">${esc(d.name)}</td><td>${kindTag('dimension')}</td><td>${esc(d.key || '')}</td><td class="m">${esc((d.sources || []).join(', '))}</td></tr>`).join('')}
</tbody></table></div>
<div class="kv"><div class="k">staging only</div><div>${(design.staging_only || []).map((s) => `<span class="tag">${esc(s)}</span>`).join('') || '–'}</div>
<div class="k">left out</div><div>${(design.left_out || []).map((l) => `<div><b>${esc(l.table)}</b> <span class="dim">– ${esc(l.reason)}</span></div>`).join('') || '–'}</div>
${(design.review || []).length ? `<div class="k">reviewed by a person</div><div>${design.review.map((r) => `<div>${esc(r.point)} <span class="dim">(${esc(r.status)}${r.note ? ': ' + esc(r.note) : ''})</span>${evidenceText(r) ? `<div class="dim">evidence: ${esc(evidenceText(r))}</div>` : ''}</div>`).join('')}</div>` : ''}</div>`) : ''}

${sec('cleaning', 'Cleaning steps per source', 'Findings from the profile and the steps that were kept. Hover a step for its column.', `<div class="tw"><table class="t"><thead><tr><th>Source</th><th class="num">Findings</th><th>Steps kept</th></tr></thead><tbody>
${srcRows.map((s) => `<tr><td class="col">${esc(s.name)}${s.include ? '' : ' <span class="out">not included</span>'}</td><td class="num">${s.findings}</td><td>${s.kept.map((f) => `<span class="tag" title="${esc(f.column || '')}"><b>${esc(f.fix)}</b>${esc(FIX[f.fix] || '')}${f.column ? ' · ' + esc(f.column) : ''}</span>`).join('') || '<span class="dim">types and names only</span>'}</td></tr>`).join('')}
</tbody></table></div>
<details><summary>Full cleaning and modelling log</summary><div class="prose">${md(read(path.join(runDir, 'cleaning-log.md')))}</div></details>`)}

${sec('rels', 'Relationships', `${model.rels.length} relationships, ${model.rels.filter((r) => !r.active).length} of them inactive.`, `<div class="tw"><table class="t"><thead><tr><th>From</th><th>To</th><th>State</th></tr></thead><tbody>
${model.rels.map((r) => `<tr><td class="m">${esc(r.from)}[${esc(r.fromCol)}]</td><td class="m">${esc(r.to)}[${esc(r.toCol)}]</td><td>${r.active ? 'active' : '<span class="orange">inactive</span>'}${r.both ? ' · both directions' : ''}</td></tr>`).join('')}
</tbody></table></div>`)}

${sec('measures', 'Measures', `${measureList.length} measures with their description and DAX.`, `<div class="tw"><table class="t"><thead><tr><th>Measure</th><th>Description</th><th>DAX</th></tr></thead><tbody>
${measureList.map((m) => `<tr><td class="col">${esc(m.Measure)}</td><td>${esc(m.Description || '')}</td><td class="dax">${esc((m.DAX || '').replace(/\s+/g, ' ').slice(0, 160))}</td></tr>`).join('')}
</tbody></table></div>`)}

${sec('security', 'Privacy and security', '', `<div class="plates"><div class="plate"><div class="k">hidden columns flagged as personal data</div><div class="v">${piiHidden}</div>${catalog ? '' : '<div class="line">catalog not built</div>'}</div>
${model.roles.map((r) => `<div class="plate"><div class="k">row-level security role</div><div class="v">${esc(r.name)}</div>${r.filters.map((f) => `<div class="line">${esc(f.table)} – <code>${esc(f.expr)}</code></div>`).join('')}</div>`).join('') || '<div class="plate"><div class="k">row-level security</div><div class="v">none</div></div>'}</div>`)}

${sec('control', 'Control numbers', 'Computed from the source files; fill in the Power BI column after a refresh.', `<div class="prose">${md(read(path.join(runDir, 'expected-values.md')))}</div>`)}

<footer>Generated by pipeline-power-bi/scripts/build-overview.js · ${esc(built)}${warn.length ? ' · warnings: ' + esc(warn.join('; ')) : ''}</footer>
</main>
<script>
${colorScript}
</script>`;
// overview.html opens in any browser; overview.page.html is the same page without document wrapper tags,
// for publishing as an Artifact (the viewer adds doctype, html, head and body itself)
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}</head><body>${body}</body></html>`;
const outFile = path.join(runDir, 'overview.html');
fs.writeFileSync(outFile, html);
fs.writeFileSync(path.join(runDir, 'overview.page.html'), `${head}
${body}
`);

// ---------- Obsidian note (optional) ----------
const vault = arg('--vault');
let note = null;
if (vault) {
  const folder = path.join(vault, arg('--folder') || 'Pipeline', 'Power BI');
  fs.mkdirSync(folder, { recursive: true });
  note = path.join(folder, `${choices.run_id || path.basename(runDir)}.md`);
  const lines = [
    '---', `run: ${choices.run_id}`, `report: ${name}`, `source: "${(choices.source_original || '').replace(/\\/g, '/')}"`, 'type: pipeline-power-bi', '---', '',
    `# ${name}`, '', 'Built with [[pipeline-power-bi]] · back to [[Pipeline]].', '', `- Facts: ${facts.map((t) => t.name).join(', ') || '–'}`, `- Dimensions: ${dims.map((t) => t.name).join(', ') || '–'}`,
    `- Relationships: ${model.rels.length} · measures: ${measureList.length} · cleaning steps kept: ${kept}`,
    `- Security: ${model.roles.map((r) => r.name).join(', ') || 'none'}`, `- Check in Power BI: ${(choices.status || {}).verify || 'pending'}`, '',
    '## Files', '', `- Overview page: \`${outFile.replace(/\\/g, '/')}\``, `- Project: \`${path.join(pbipDir).replace(/\\/g, '/')}\``,
    `- Cleaning log: \`${path.join(runDir, 'cleaning-log.md').replace(/\\/g, '/')}\``, `- Expected values: \`${path.join(runDir, 'expected-values.md').replace(/\\/g, '/')}\``, '',
  ];
  if (design && design.left_out) lines.push('## Left out', '', ...design.left_out.map((l) => `- ${l.table}: ${l.reason}`), '');
  const open = ((design && design.review) || []).filter((r) => r.status === 'open');
  if (open.length) lines.push('## Open review points', '', ...open.map((r) => `- ${r.point}: ${r.note || ''}${evidenceText(r) ? ` (evidence: ${evidenceText(r)})` : ''}`), '');
  fs.writeFileSync(note, lines.join('\n'));
}
console.log(JSON.stringify({ overview: outFile, note, tables: model.tables.length, facts: facts.length, dimensions: dims.length, relationships: model.rels.length, staging: model.staging.length, measures: measureList.length, warnings: warn }));
