#!/usr/bin/env node
// Project overview page for a pipeline-power-bi run: sources -> staging -> model -> report, the star
// schema, cleaning steps, measures, privacy/security and the control numbers – one self-contained HTML
// file (no external scripts). Optional: an Obsidian note.
//
//   node build-overview.js runs/<run-id> [--vault "<vault folder>" --folder Pipeline]
//
// Reads: choices.json, profile.json, cleaning-log.md, expected-values.md, pbip/<Name>.SemanticModel
// (tables, relationships, roles, expressions), pbip/docs/catalog.json and layout-config.json if present.
// Writes: runs/<run-id>/overview.html (and <vault>/<folder>/Power BI/<run-id>.md with --vault).
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
    if (name === '_Measures' || (measures.length && cols.every((c) => c.hidden))) kind = 'measures';
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
  if (!text) return '<p class="muted">Not written yet.</p>';
  const out = []; const lines = text.split(/\r?\n/); let i = 0;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]); const body = rows.slice(2).map(cells);
      out.push(`<div class="tw"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^#{1,3}\s/.test(l)) { const n = Math.min(4, l.match(/^#+/)[0].length + 1); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ''))}</h${n}>`); i++; continue; }
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
  const H = 34, gap = 14, w = 210;
  const rowsN = Math.max(F.length, D.length);
  const height = rowsN * (H + gap) + 40;
  const xF = 30, xD = 470;
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
  const box = (t) => { const p = pos[t.name]; return `<g class="ent ${t.kind}"><rect x="${p.x}" y="${p.y}" width="${w}" height="${H}" rx="8"/><text x="${p.x + 12}" y="${p.y + 21}">${esc(t.name)}</text><text class="k" x="${p.x + w - 10}" y="${p.y + 21}" text-anchor="end">${t.kind === 'fact' ? 'fact' : t.kind === 'date' ? 'date' : t.kind === 'support' ? 'support' : 'dim'}</text></g>`; };
  return `<svg viewBox="0 0 ${xD + w + 30} ${height}" role="img" aria-label="Star schema">${lines}${[...F, ...D].map(box).join('')}</svg>`;
}

// ---------- page ----------
const name = choices.name || path.basename(runDir);
const kept = srcRows.reduce((n, s) => n + s.kept.length, 0);
const included = srcRows.filter((s) => s.include).length;
const piiHidden = model.tables.flatMap((t) => t.cols.filter((c) => c.hidden && catalog && (catalog.columns || []).some((x) => x.Table === t.name && x.Column === c.name && x['Possible PII']))).length;
const kpi = (v, l) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`;
const flowCol = (title, items, cls) => `<div class="fc ${cls}"><h3>${esc(title)}</h3><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;

const head = `<title>${esc(name)} model overview</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1f2328;--muted:#5f6670;--line:#d9dbde;--accent:#2f6fdf;--fact:#b7791f;--dim:#2f6fdf;--date:#2b8a6e;--warn:#c2410c;--soft:#eef2fb;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15171a;--panel:#1d2024;--ink:#e8eaed;--muted:#9aa1ab;--line:#33373d;--accent:#7aa7ff;--fact:#e0a84b;--dim:#7aa7ff;--date:#5fc7a6;--warn:#ff8a5c;--soft:#22283a;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15171a;--panel:#1d2024;--ink:#e8eaed;--muted:#9aa1ab;--line:#33373d;--accent:#7aa7ff;--fact:#e0a84b;--dim:#7aa7ff;--date:#5fc7a6;--warn:#ff8a5c;--soft:#22283a;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding-block:24px 56px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}h1{font-size:28px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 10px}h3{font-size:15px;margin:0 0 8px}h4{margin:18px 0 6px}
.muted{color:var(--muted)}code{font:13px Consolas,monospace;background:var(--soft);padding:1px 5px;border-radius:4px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.kpi .v{font-size:26px;font-weight:600}.kpi .l{color:var(--muted);font-size:13px}
.flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.fc{background:var(--panel);border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:10px;padding:12px 14px;min-width:0}
.fc ul{margin:0;padding-left:18px;font-size:13.5px}.fc.stage{border-top-color:var(--muted)}.fc.model{border-top-color:var(--fact)}.fc.report{border-top-color:var(--date)}
@media (max-width:820px){.flow{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto}
svg{width:100%;min-width:640px;height:auto;display:block}.ent rect{fill:var(--panel);stroke:var(--line);stroke-width:1.5}.ent.fact rect{stroke:var(--fact)}.ent.dimension rect{stroke:var(--dim)}.ent.date rect{stroke:var(--date)}
.ent text{fill:var(--ink);font:600 13px "Segoe UI",sans-serif}.ent text.k{fill:var(--muted);font-weight:400;font-size:11px}.rel{fill:none;stroke:var(--muted);stroke-width:1.3}.rel.off{stroke-dasharray:5 4;opacity:.7}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px;background:var(--panel)}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}
.pill{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--soft);margin:1px 2px}.out{color:var(--warn)}
details{margin:6px 0}summary{cursor:pointer;color:var(--accent)}footer{margin-top:40px;color:var(--muted);font-size:12.5px}
</style>`;
const body = `<div class="wrap">
<h1>${esc(name)} – model overview</h1>
<div class="muted">Run <code>${esc(choices.run_id || path.basename(runDir))}</code> · source ${esc(choices.source_original || choices.source_folder || '')} · build ${esc((choices.status || {}).build || '')} · check in Power BI: ${esc((choices.status || {}).verify || 'pending')}</div>
<div class="kpis">${kpi(srcRows.length, 'source tables / sheets')}${kpi(included, 'included')}${kpi(facts.length + ' + ' + dims.length, 'facts + dimensions')}${kpi(model.rels.length, 'relationships')}${kpi(measureList.length, 'measures')}${kpi(kept, 'cleaning steps kept')}${kpi(model.roles.length ? model.roles.map((r) => r.name).join(', ') : 'none', 'security roles')}</div>

<h2>From sheet to report</h2>
<div class="flow">
${flowCol('Sources', srcRows.map((s) => `${esc(s.name)} <span class="muted">${s.rows ?? 0} rows</span>${s.include ? '' : ` <span class="out">– ${esc(s.reason || 'left out')}</span>`}`), 'src')}
${flowCol('Staging (not loaded)', model.staging.length ? model.staging.map((s) => `<code>${esc(s.name)}</code> <span class="muted">${s.steps.length} named steps</span>`) : ['<span class="muted">one query per table (no staging layer)</span>'], 'stage')}
${flowCol('Model', [...facts.map((t) => `<b>${esc(t.name)}</b> <span class="pill">fact</span>`), ...dims.map((t) => `${esc(t.name)} <span class="pill">${t.kind === 'date' ? 'date' : 'dim'}</span>`), ...others.map((t) => `${esc(t.name)} <span class="pill">${t.kind}</span>`)], 'model')}
${flowCol('Report', layout ? [`Page <b>${esc(layout.pageName || 'Dashboard')}</b> – ${esc(layout.title || '')}`, `${(layout.kpis || []).length} KPI tiles`, 'trend', `${(layout.monthly || []).length} monthly cards`, layout.bar ? 'bar chart' : '', layout.table ? 'top-10 table' : '', `${(layout.highlights || []).length} highlight tiles`].filter(Boolean) : ['<span class="muted">no dashboard layout</span>'], 'report')}
</div>

<h2>Star schema</h2>
<div class="card">${star()}<p class="muted">Solid line = active relationship, dashed = inactive (used with USERELATIONSHIP). Hover a line for its columns.</p></div>

${design ? `<h2>Design</h2><div class="tw"><table><thead><tr><th>Table</th><th>Kind</th><th>Grain / key</th><th>Built from</th></tr></thead><tbody>
${(design.facts || []).map((f) => `<tr><td><b>${esc(f.name)}</b></td><td>fact</td><td>${esc(f.grain)}</td><td>${esc((f.sources || []).join(', '))}</td></tr>`).join('')}
${(design.dimensions || []).map((d) => `<tr><td>${esc(d.name)}</td><td>dimension</td><td>${esc(d.key || '')}</td><td>${esc((d.sources || []).join(', '))}</td></tr>`).join('')}
</tbody></table></div>
<p><b>Staging only:</b> ${esc((design.staging_only || []).join(', ') || '–')}</p>
<p><b>Left out:</b> ${(design.left_out || []).map((l) => `${esc(l.table)} <span class="muted">(${esc(l.reason)})</span>`).join(' · ') || '–'}</p>
${(design.review || []).length ? `<p><b>Reviewed by a person:</b> ${design.review.map((r) => `${esc(r.point)} <span class="muted">(${esc(r.status)}${r.note ? ': ' + esc(r.note) : ''})</span>`).join(' · ')}</p>` : ''}` : ''}

<h2>Cleaning steps per source</h2>
<div class="tw"><table><thead><tr><th>Source</th><th>Findings</th><th>Steps kept</th></tr></thead><tbody>
${srcRows.map((s) => `<tr><td>${esc(s.name)}${s.include ? '' : ' <span class="out">(not included)</span>'}</td><td>${s.findings}</td><td>${s.kept.map((f) => `<span class="pill" title="${esc(f.column || '')}">${esc(f.fix)} ${esc(FIX[f.fix] || '')}${f.column ? ' · ' + esc(f.column) : ''}</span>`).join(' ') || '<span class="muted">types and names only</span>'}</td></tr>`).join('')}
</tbody></table></div>
<details><summary>Full cleaning and modelling log</summary>${md(read(path.join(runDir, 'cleaning-log.md')))}</details>

<h2>Relationships</h2>
<div class="tw"><table><thead><tr><th>From</th><th>To</th><th>State</th></tr></thead><tbody>
${model.rels.map((r) => `<tr><td>${esc(r.from)}[${esc(r.fromCol)}]</td><td>${esc(r.to)}[${esc(r.toCol)}]</td><td>${r.active ? 'active' : 'inactive'}${r.both ? ' · both directions' : ''}</td></tr>`).join('')}
</tbody></table></div>

<h2>Measures</h2>
<div class="tw"><table><thead><tr><th>Measure</th><th>Description</th><th>DAX</th></tr></thead><tbody>
${measureList.map((m) => `<tr><td>${esc(m.Measure)}</td><td>${esc(m.Description || '')}</td><td><code>${esc((m.DAX || '').replace(/\s+/g, ' ').slice(0, 160))}</code></td></tr>`).join('')}
</tbody></table></div>

<h2>Privacy and security</h2>
<ul>
<li>Hidden columns flagged as possible personal data: <b>${piiHidden}</b>${catalog ? '' : ' <span class="muted">(catalog not built)</span>'}</li>
${model.roles.map((r) => `<li>Role <b>${esc(r.name)}</b>: ${r.filters.map((f) => `${esc(f.table)} – <code>${esc(f.expr)}</code>`).join('; ')}</li>`).join('') || '<li>No row-level security role.</li>'}
</ul>

<h2>Control numbers</h2>
${md(read(path.join(runDir, 'expected-values.md')))}

<footer>Generated by pipeline-power-bi/scripts/build-overview.js · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}${warn.length ? ' · warnings: ' + esc(warn.join('; ')) : ''}</footer>
</div>`;
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
  if (open.length) lines.push('## Open review points', '', ...open.map((r) => `- ${r.point}: ${r.note || ''}`), '');
  fs.writeFileSync(note, lines.join('\n'));
}
console.log(JSON.stringify({ overview: outFile, note, tables: model.tables.length, facts: facts.length, dimensions: dims.length, relationships: model.rels.length, staging: model.staging.length, measures: measureList.length, warnings: warn }));
