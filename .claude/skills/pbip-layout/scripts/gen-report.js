#!/usr/bin/env node
// Builds the chosen pages of a pbip-layout template (templates/<key>, made by extract-template.js from a
// real report) into a PBIP report and connects them to the project's own model.
//
//   node gen-report.js "<Name.Report>" "<config.json>" [--preview <out.html>]
//
// config.json (profile.md and SKILL.md describe how it is filled):
//   template   "adventureworks" (default)
//   pages      the page keys the user chose, e.g. ["exec", "map", "product", "customer", "tooltip"]
//   fields     { "<template field>": "Table[Field]" | null } for every field the chosen pages use
//              (template.json → fields); null = the model has nothing for it: visuals using it are left out
//   labels     { "<template field>": "text" } – display names (default: the model field's name, made readable)
//   texts      { "<text in the template>": "new text" } – titles and text boxes
//   title / subtitle / logo   top-left of the first page: title text, or a logo image (path to .png/.jpg)
//   colors     colour keys (template.json → colors); left out = the template's own colours
//   theme      false = do not register the template theme (other pages keep the report's theme)
//
// Never touches other pages, except: pages from an earlier run of this script (same ids) and the old
// single-page layout (8d1e4c7a2b5f9e3d6c10) are replaced, and pages.json gets the new pages first.
// A colour choice changes colour values only (tests/colors-only.test.js).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const args = process.argv.slice(2);
const pi = args.indexOf('--preview');
const PREVIEW = pi >= 0 ? args.splice(pi, 2)[1] : null;
const [reportDir, configPath] = args;
if (!reportDir || !configPath) { console.error('Usage: node gen-report.js <Name.Report> <config.json> [--preview <out.html>]'); process.exit(2); }
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const cfg = readJ(configPath);
const SKILL = path.resolve(__dirname, '..');
const TPL_DIR = path.join(SKILL, 'templates', cfg.template || 'adventureworks');
if (!fs.existsSync(path.join(TPL_DIR, 'template.json'))) { console.error(`template not found: ${TPL_DIR}`); process.exit(2); }
const T = readJ(path.join(TPL_DIR, 'template.json'));
const errors = []; const warnings = []; const notes = [];
const fail = () => { console.log(JSON.stringify({ ok: false, errors, warnings }, null, 1)); process.exit(2); };

// ---------- colours ----------
const C = { ...T.colors };
if (cfg.colors !== undefined && (cfg.colors === null || typeof cfg.colors !== 'object' || Array.isArray(cfg.colors))) errors.push('config.colors must be an object of colour keys (template.json → colors)');
for (const [k, v] of Object.entries(cfg.colors || {})) {
  if (!(k in T.colors)) errors.push(`config.colors.${k}: unknown colour key – allowed: ${Object.keys(T.colors).join(', ')}`);
  else if (!/^#[0-9A-Fa-f]{6}$/.test(String(v))) errors.push(`config.colors.${k}: "${v}" is not a hex colour #RRGGBB`);
  else C[k] = String(v).toUpperCase();
}

// ---------- pages ----------
const byKey = Object.fromEntries(T.pages.map((p) => [p.key, p]));
const chosen = T.pages.map((p) => p.key).filter((k) => (cfg.pages || []).includes(k));
for (const k of cfg.pages || []) if (!byKey[k]) errors.push(`config.pages: unknown page "${k}" – template pages: ${T.pages.map((p) => p.key).join(', ')}`);
if (!chosen.length) errors.push('config.pages: choose at least one page (ask the user – SKILL.md step 3)');
if (chosen.length && chosen.every((k) => byKey[k].type === 'Tooltip')) errors.push('config.pages: a tooltip page alone has nothing to show it');
const pageId = (key) => crypto.createHash('md5').update(`pbip-layout:${cfg.template || 'adventureworks'}:${key}`).digest('hex').slice(0, 20);
const idMap = Object.fromEntries(T.pages.map((p) => [p.id, chosen.includes(p.key) ? pageId(p.key) : null]));

// ---------- fields ----------
const fieldMap = {}; // template field → { table, name } | null
const needed = new Set();
for (const [k, f] of Object.entries(T.fields)) if (f.pages.some((p) => chosen.includes(p))) needed.add(k);
for (const k of needed) {
  if (!cfg.fields || !(k in cfg.fields)) { errors.push(`config.fields: "${k}" is missing (used on ${T.fields[k].pages.filter((p) => chosen.includes(p)).join(', ')}) – map it to Table[Field], or null to leave its visuals out`); continue; }
  const v = cfg.fields[k];
  if (v === null) { fieldMap[k] = null; continue; }
  const m = /^'?(.+?)'?\[(.+)\]$/.exec(String(v));
  if (!m) { errors.push(`config.fields["${k}"]: "${v}" – use Table[Field]`); continue; }
  fieldMap[k] = { table: m[1], name: m[2] };
}
if (errors.length) fail();
// a template table maps to the table most of its fields went to (for From entries without a field)
const tableVotes = {};
for (const [k, t] of Object.entries(fieldMap)) { if (!t) continue; const e = k.slice(0, k.indexOf('[')); (tableVotes[e] = tableVotes[e] || {})[t.table] = ((tableVotes[e] || {})[t.table] || 0) + 1; }
const tableMap = Object.fromEntries(Object.entries(tableVotes).map(([e, v]) => [e, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
const human = (s) => { const t = String(s).replace(/_/g, ' ').trim(); return t === String(s) ? t : t.charAt(0).toUpperCase() + t.slice(1); };
const label = (k) => (cfg.labels && cfg.labels[k]) || (fieldMap[k] ? human(fieldMap[k].name) : null);
const fkey = (ent, prop) => `${ent}[${prop}]`;

// queryRef-style strings: "Measure Table.Total Revenue", "Min(Product Lookup.ProductName)", "Calendar Lookup.Date Hierarchy.Year"
const refPairs = Object.keys(fieldMap).map((k) => { const i = k.indexOf('['); return [`${k.slice(0, i)}.${k.slice(i + 1, -1)}`, k]; }).sort((a, b) => b[0].length - a[0].length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refRe = refPairs.length ? new RegExp(`(${refPairs.map((p) => esc(p[0])).join('|')})(?![A-Za-z0-9 %?])`, 'g') : null;
const refLookup = Object.fromEntries(refPairs);
function rewriteString(s) {
  let out = s;
  if (refRe) out = out.replace(refRe, (m) => { const t = fieldMap[refLookup[m]]; return t ? `${t.table}.${t.name}` : m; });
  // page ids
  out = out.replace(/ReportSection[0-9a-f]*/g, (m) => (m in idMap ? (idMap[m] || m) : m));
  // colour tokens
  out = out.replace(/\{\{([A-Za-z]+)\}\}/g, (m, k) => C[k] || m);
  return out;
}

// returns the template fields a JSON node refers to
function fieldsIn(node) {
  const found = new Set();
  (function walk(o, aliases) {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, aliases)); return; }
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o.From)) { aliases = { ...aliases }; for (const f of o.From) if (f.Name && f.Entity) aliases[f.Name] = f.Entity; }
    for (const kind of ['Column', 'Measure', 'HierarchyLevel']) {
      const x = o[kind];
      if (!x || !x.Expression) continue;
      if (kind === 'HierarchyLevel') { const h = x.Expression.Hierarchy; if (h) { const sr = h.Expression.SourceRef; found.add(fkey(sr.Entity || aliases[sr.Source], `${h.Hierarchy}.${x.Level}`)); } }
      else if (x.Expression.SourceRef) { const sr = x.Expression.SourceRef; found.add(fkey(sr.Entity || aliases[sr.Source], x.Property)); }
    }
    for (const v of Object.values(o)) walk(v, aliases);
  })(node, {});
  return found;
}

// rewrites fields (structured), strings (refs, page ids, colours) and projection names in place
function rewrite(node) {
  if (Array.isArray(node)) return node.map(rewrite);
  if (typeof node === 'string') return rewriteString(node);
  if (!node || typeof node !== 'object') return node;
  // a query scope with aliases: decide each alias' table from the fields that use it
  if (Array.isArray(node.From)) {
    const aliasTable = {};
    (function scan(o, aliases) {
      if (Array.isArray(o)) { o.forEach((x) => scan(x, aliases)); return; }
      if (!o || typeof o !== 'object') return;
      for (const kind of ['Column', 'Measure', 'HierarchyLevel']) {
        const x = o[kind];
        if (!x || !x.Expression) continue;
        const sr = kind === 'HierarchyLevel' ? (x.Expression.Hierarchy || {}).Expression && x.Expression.Hierarchy.Expression.SourceRef : x.Expression.SourceRef;
        if (!sr || !sr.Source || !aliases[sr.Source]) continue;
        const k = kind === 'HierarchyLevel' ? fkey(aliases[sr.Source], `${x.Expression.Hierarchy.Hierarchy}.${x.Level}`) : fkey(aliases[sr.Source], x.Property);
        const t = fieldMap[k];
        if (t) aliasTable[sr.Source] = aliasTable[sr.Source] || t.table;
      }
      for (const v of Object.values(o)) scan(v, aliases);
    })(node, Object.fromEntries(node.From.filter((f) => f.Entity).map((f) => [f.Name, f.Entity])));
    node.__aliases = Object.fromEntries(node.From.filter((f) => f.Entity).map((f) => [f.Name, f.Entity]));
    for (const f of node.From) if (f.Entity) f.Entity = aliasTable[f.Name] || tableMap[f.Entity] || f.Entity;
  }
  const out = {};
  for (const [k0, v] of Object.entries(node)) {
    if (k0 === '__aliases') continue;
    const k = /^ReportSection/.test(k0) ? rewriteString(k0) : k0; // page ids as keys (bookmark sections)
    if ((k === 'Column' || k === 'Measure' || k === 'HierarchyLevel') && v && v.Expression) {
      const conv = convertField(k, v, node.__aliasCtx);
      if (conv) { out[conv.kind] = conv.value; continue; }
    }
    out[k] = rewrite(v);
  }
  // projections: model name as nativeQueryRef, a readable display name
  if (out.field && typeof out.queryRef === 'string') {
    const k = [...fieldsIn(node.field)][0];
    if (k && fieldMap[k]) {
      out.nativeQueryRef = fieldMap[k].name;
      const orig = k.slice(k.indexOf('[') + 1, -1).split('.').pop();
      if (!out.displayName || out.displayName === orig) out.displayName = label(k);
    }
  }
  return out;
}
// alias context: pass the alias map down so Source-based fields can be resolved
function withAliases(node, ctx) {
  if (Array.isArray(node)) { node.forEach((x) => withAliases(x, ctx)); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.From)) { ctx = { ...ctx }; for (const f of node.From) if (f.Name && f.Entity) ctx[f.Name] = f.Entity; }
  Object.defineProperty(node, '__aliasCtx', { value: ctx, enumerable: false, configurable: true });
  for (const v of Object.values(node)) withAliases(v, ctx);
}
function convertField(kind, x, ctx) {
  ctx = ctx || {};
  let ent; let prop; let src;
  if (kind === 'HierarchyLevel') { const h = x.Expression.Hierarchy; if (!h) return null; src = h.Expression.SourceRef; ent = src.Entity || ctx[src.Source]; prop = `${h.Hierarchy}.${x.Level}`; }
  else { src = x.Expression.SourceRef; if (!src) return null; ent = src.Entity || ctx[src.Source]; prop = x.Property; }
  const t = fieldMap[fkey(ent, prop)];
  if (!t) return null;
  const sourceRef = src.Source ? { Source: src.Source } : { Entity: t.table };
  // a hierarchy level becomes a plain column of the model (the model has no hierarchy)
  return { kind: kind === 'HierarchyLevel' ? 'Column' : kind, value: { Expression: { SourceRef: sourceRef }, Property: t.name } };
}

// data values of the source report in filters (a selected income level, the drillthrough product) are
// cleared – the filter stays, without a selection; "is not blank" (null) and TopN stay
function clearDataValues(node) {
  if (Array.isArray(node)) { node.forEach(clearDataValues); return; }
  if (!node || typeof node !== 'object') return;
  if (node.filter && node.type === 'Categorical' && node.filter.Where) {
    const s = JSON.stringify(node.filter.Where);
    if (/"Value":"'/.test(s)) delete node.filter; // the filter (field) stays, without a selection
  }
  for (const v of Object.values(node)) clearDataValues(v);
}

// colour scales driven by a template field in config.reverseScales run the other way: a fallback
// whose high values are good (margin %) for a template field where high was bad (return rate)
const REVERSE = new Set(cfg.reverseScales || []);
for (const k of REVERSE) if (!(k in T.fields)) errors.push(`config.reverseScales: "${k}" is not a template field`);
if (errors.length) fail();
function reverseScales(node) {
  if (!REVERSE.size) return 0;
  let n = 0;
  (function walk(o) {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== 'object') return;
    if (o.FillRule && o.Input && [...fieldsIn(o.Input)].some((k) => REVERSE.has(k))) {
      for (const g of Object.values(o.FillRule)) {
        if (g && g.min && g.max && g.min.color && g.max.color) { [g.min.color, g.max.color] = [g.max.color, g.min.color]; n++; }
      }
    }
    for (const v of Object.values(o)) walk(v);
  })(node);
  return n;
}

// ---------- build the pages in memory ----------
const pages = []; // { key, id, page, visuals: [{name, json}] }
const dropped = [];
for (const key of chosen) {
  const meta = byKey[key];
  const dir = path.join(TPL_DIR, 'pages', key);
  const page = readJ(path.join(dir, 'page.json'));
  let visuals = fs.readdirSync(path.join(dir, 'visuals')).sort().map((name) => ({ name, json: readJ(path.join(dir, 'visuals', name, 'visual.json')) }));
  // 1. fields the model does not have (null): their projections, sorts and filters go; a visual goes only
  //    when one of its roles is left empty or the field is used anywhere else in it
  const drop = new Set();
  const isNull = (node) => [...fieldsIn(node)].some((k) => k in fieldMap && fieldMap[k] === null);
  for (const v of visuals) {
    const vis = v.json.visual;
    const removed = [];
    let emptiedRole = false;
    if (vis && vis.query && vis.query.queryState) {
      for (const [role, r] of Object.entries(vis.query.queryState)) {
        if (!Array.isArray(r.projections)) continue;
        const keep = r.projections.filter((p) => !isNull(p.field));
        if (keep.length !== r.projections.length) { removed.push(...[...new Set(r.projections.filter((p) => isNull(p.field)).flatMap((p) => [...fieldsIn(p.field)]))]); r.projections = keep; }
        if (!keep.length) { delete vis.query.queryState[role]; emptiedRole = true; }
      }
      if (vis.query.sortDefinition && Array.isArray(vis.query.sortDefinition.sort)) {
        vis.query.sortDefinition.sort = vis.query.sortDefinition.sort.filter((s) => !isNull(s));
        if (!vis.query.sortDefinition.sort.length) delete vis.query.sortDefinition;
      }
    }
    if (v.json.filterConfig && Array.isArray(v.json.filterConfig.filters)) v.json.filterConfig.filters = v.json.filterConfig.filters.filter((f) => !isNull(f));
    const still = [...fieldsIn(v.json)].filter((k) => k in fieldMap && fieldMap[k] === null);
    if (emptiedRole || still.length) { drop.add(v.name); dropped.push({ page: key, visual: v.name, type: (vis || {}).visualType, because: [...new Set([...removed, ...still])] }); }
    else if (removed.length) notes.push(`${key}/${v.name} (${vis.visualType}): left out ${removed.join(', ')}`);
  }
  // 2. navigation to pages that were not chosen
  for (const v of meta.visuals) if (v.navigatesTo && !chosen.includes(v.navigatesTo)) drop.add(v.name);
  // 3. a group whose children are all gone, and the children of a dropped group
  for (const v of visuals) if (v.json.parentGroupName && drop.has(v.json.parentGroupName)) drop.add(v.name);
  visuals = visuals.filter((v) => !drop.has(v.name));
  for (const g of visuals.filter((v) => v.json.visualGroup)) if (!visuals.some((v) => v.json.parentGroupName === g.name)) drop.add(g.name);
  visuals = visuals.filter((v) => !drop.has(v.name));
  // 4. the remaining navigation buttons close up from the top, in their order
  const navGroups = new Set(meta.visuals.filter((v) => v.navigatesTo && v.group).map((v) => v.group));
  for (const g of navGroups) {
    const slots = meta.visuals.filter((v) => v.navigatesTo && v.group === g).map((v) => readJ(path.join(dir, 'visuals', v.name, 'visual.json')).position.y).sort((a, b) => a - b);
    visuals.filter((v) => v.json.parentGroupName === g && meta.visuals.find((m) => m.name === v.name && m.navigatesTo)).sort((a, b) => a.json.position.y - b.json.position.y)
      .forEach((v, i) => { v.json.position.y = slots[i]; });
  }
  // 5. the tooltip page: without it the bar chart shows the default tooltip
  if (!chosen.includes('tooltip')) {
    const tip = T.pages.find((p) => p.type === 'Tooltip');
    if (tip) for (const v of visuals) {
      const vt = v.json.visual && v.json.visual.visualContainerObjects && v.json.visual.visualContainerObjects.visualTooltip;
      if (vt) for (const e of vt) if (e.properties && e.properties.section && JSON.stringify(e.properties.section).includes(tip.id)) { delete e.properties.section; delete e.properties.type; }
    }
  }
  // 6. logo → title text (or the user's logo)
  if (T.logo && T.logo.page === key) {
    const v = visuals.find((x) => x.name === T.logo.visual);
    if (v) {
      if (cfg.logo) {
        const ext = path.extname(cfg.logo).toLowerCase();
        v.logoFile = `pbip-layout-logo${ext}`;
        v.json = JSON.parse(JSON.stringify(v.json).replace(/AdventureWorks_Logo[0-9]*\.png/g, v.logoFile));
      } else {
        const lit = (x) => ({ expr: { Literal: { Value: x } } });
        v.json = { $schema: v.json.$schema, name: v.json.name, position: v.json.position, visual: { visualType: 'textbox', objects: { general: [{ properties: { paragraphs: [
          { textRuns: [{ value: cfg.title || 'Sales overview', textStyle: { fontFamily: 'Segoe UI Bold', fontSize: '20pt', color: '{{dark}}' } }] },
          ...(cfg.subtitle ? [{ textRuns: [{ value: cfg.subtitle, textStyle: { fontFamily: 'Segoe UI', fontSize: '11pt', color: '{{muted}}' } }] }] : []),
        ] } }] }, visualContainerObjects: { background: [{ properties: { show: lit('false') } }] } } };
      }
    }
  }
  // 7. reversed colour scales (before the fields are renamed), then fields, strings, colours, page ids
  for (const v of visuals) { const r = reverseScales(v.json); if (r) notes.push(`${key}/${v.name}: colour scale reversed (${r})`); }
  page.name = idMap[meta.id];
  // page filters and the drillthrough binding on a field the model does not have go too
  if (page.filterConfig && Array.isArray(page.filterConfig.filters)) {
    const gone = page.filterConfig.filters.filter((f) => isNull(f)).map((f) => f.name);
    page.filterConfig.filters = page.filterConfig.filters.filter((f) => !isNull(f));
    if (page.pageBinding && Array.isArray(page.pageBinding.parameters)) {
      page.pageBinding.parameters = page.pageBinding.parameters.filter((x) => !gone.includes(x.boundFilter) && !isNull(x.fieldExpr));
      if (!page.pageBinding.parameters.length) { delete page.pageBinding; if (page.type === 'Drillthrough') delete page.type; notes.push(`${key}: no drillthrough – its field is not in the model`); }
    }
  }
  clearDataValues(page);
  withAliases(page, {});
  const newPage = rewrite(page);
  const newVisuals = visuals.map((v) => { clearDataValues(v.json); withAliases(v.json, {}); return { name: v.name, json: rewrite(v.json), logoFile: v.logoFile }; });
  pages.push({ key, id: idMap[meta.id], page: newPage, visuals: newVisuals });
}

// filter names unique across the report: the source report reuses a filter's name on copied visuals
{
  const seen = new Map();
  for (const p of pages) for (const v of p.visuals) for (const f of ((v.json.filterConfig || {}).filters || [])) if (f.name) seen.set(f.name, (seen.get(f.name) || 0) + 1);
  for (const p of pages) for (const v of p.visuals) for (const f of ((v.json.filterConfig || {}).filters || [])) {
    if (f.name && seen.get(f.name) > 1) f.name = 'Filter' + crypto.createHash('md5').update(`${p.key}/${v.name}/${f.name}`).digest('hex').slice(0, 20);
  }
}

// texts: titles and text boxes
if (cfg.texts) {
  const pairs = Object.entries(cfg.texts).sort((a, b) => b[0].length - a[0].length);
  const fix = (s) => { for (const [a, b] of pairs) { if (s === a) return b; if (s === `'${a}'`) return `'${String(b).replace(/'/g, "''")}'`; } return s; };
  const walk = (o) => { if (Array.isArray(o)) return o.map(walk); if (o && typeof o === 'object') { for (const k of Object.keys(o)) o[k] = walk(o[k]); return o; } return typeof o === 'string' ? fix(o) : o; };
  for (const p of pages) for (const v of p.visuals) walk(v.json);
}

// ---------- bookmarks ----------
const bookmarks = [];
for (const b of T.bookmarks || []) {
  if (!chosen.includes(b.page)) continue;
  const j = readJ(path.join(TPL_DIR, 'bookmarks', b.file));
  // only the sections of chosen pages, only visuals that still exist
  const es = j.explorationState || {};
  if (es.sections) for (const sid of Object.keys(es.sections)) {
    if (!idMap[sid]) { delete es.sections[sid]; continue; }
    const p = pages.find((x) => x.id === idMap[sid]);
    const vc = es.sections[sid].visualContainers;
    if (vc && p) for (const vn of Object.keys(vc)) if (!p.visuals.some((v) => v.name === vn)) delete vc[vn];
  }
  if (j.options && Array.isArray(j.options.targetVisualNames)) {
    const all = new Set(pages.flatMap((p) => p.visuals.map((v) => v.name)));
    j.options.targetVisualNames = j.options.targetVisualNames.filter((n) => all.has(n));
  }
  // a bookmark filter on a field the model does not have goes
  (function prune(o) {
    if (Array.isArray(o)) { for (let i = o.length - 1; i >= 0; i--) { const miss = [...fieldsIn(o[i])].some((k) => k in fieldMap && fieldMap[k] === null) && o[i] && o[i].type; if (miss) o.splice(i, 1); else prune(o[i]); } return; }
    if (o && typeof o === 'object') for (const v of Object.values(o)) prune(v);
  })(j);
  clearDataValues(j);
  withAliases(j, {});
  bookmarks.push({ file: b.file, name: j.name, json: rewrite(j) });
}

// ---------- PNG recolouring (navigation icons) ----------
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function tintPng(buf, hex) {
  let off = 8; let ihdr = null; const idat = [];
  while (off < buf.length) { const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8); const data = buf.subarray(off + 8, off + 8 + len); if (type === 'IHDR') ihdr = data; if (type === 'IDAT') idat.push(data); off += 12 + len; }
  const w = ihdr.readUInt32BE(0); const h = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) return null; // only 8-bit RGBA, not interlaced
  const raw = zlib.inflateSync(Buffer.concat(idat)); const bpp = 4; const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y ? px[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 0xff;
    }
  }
  const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = bl; }
  const out = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { out[y * (stride + 1)] = 0; px.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return Buffer.concat([buf.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(out)), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- theme ----------
// The report gets the template's base theme (the source report's, e.g. CY23SU04), so the defaults the
// template relies on are the same, and a custom theme with colours only (no other properties): the
// series and slice colours start with the template's (dark, gold, teal, bad …) and follow a colour choice.
function themeJson() {
  const base = readJ(path.join(TPL_DIR, 'base-theme.json'));
  const dc = Array.isArray(base.dataColors) ? [...base.dataColors] : [];
  [C.dark, C.gold, C.teal, C.bad, C.muted, C.badDark].forEach((c, i) => { dc[i] = c; });
  return { name: 'pbip-layout-theme.json', dataColors: dc, background: C.panel, foreground: C.axis, tableAccent: C.teal };
}

// ---------- preview (a wireframe of the chosen pages; no report files are written) ----------
if (PREVIEW) {
  const lit = (o) => { const s = JSON.stringify(o || ''); const m = s.match(/"Value":"'(#[0-9A-Fa-f]{6})'"/); return m ? m[1] : null; };
  const escH = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  let html = '';
  for (const p of pages) {
    const W = p.page.width || T.width; const H = p.page.height || T.height;
    const pbg = lit(p.page.objects && p.page.objects.background) || '#FFFFFF';
    const abs = (v) => { let x = v.json.position.x; let y = v.json.position.y; let g = v.json.parentGroupName; while (g) { const pg = p.visuals.find((q) => q.name === g); if (!pg) break; x += pg.json.position.x; y += pg.json.position.y; g = pg.json.parentGroupName; } return [x, y]; };
    let boxes = '';
    for (const v of p.visuals) {
      if (v.json.visualGroup) continue;
      const vis = v.json.visual || {}; const vc = vis.visualContainerObjects || {}; const o = vis.objects || {};
      const [x, y] = abs(v); const pos = v.json.position;
      const bg = lit(vc.background) || lit(o.fill) || lit((o.background || [])[0]) || null;
      const title = ((JSON.stringify(vc.title || '').match(/"text":\{"expr":\{"Literal":\{"Value":"'([^']*)'/) || [])[1]) || '';
      const text = vis.visualType === 'textbox' ? (JSON.stringify(o.general || '').match(/"value":"([^"]{1,60})"/) || [])[1] || '' : '';
      const fields = ((vis.query && vis.query.queryState) ? Object.values(vis.query.queryState).flatMap((r) => (r.projections || []).map((x) => x.displayName || x.nativeQueryRef)) : []).slice(0, 3).join(', ');
      let hid = !!v.json.isHidden; let gp = v.json.parentGroupName;
      while (!hid && gp) { const pg = p.visuals.find((q) => q.name === gp); if (!pg) break; hid = !!pg.json.isHidden; gp = pg.json.parentGroupName; }
      if (hid) continue; // hidden until a bookmark shows it (the slicer panel)
      const hidden = '';
      boxes += `<div class="v" style="left:${x}px;top:${y}px;width:${pos.width}px;height:${pos.height}px;z-index:${Math.round(pos.z || 0)};${bg ? `background:${bg};` : ''}${hidden}"><b>${escH(title || text)}</b><i>${escH(vis.visualType || '')}</i><small>${escH(fields)}</small></div>`;
    }
    html += `<h2>${escH(p.page.displayName)}${byKey[p.key].hidden ? ' (tooltip, hidden)' : ''}</h2><div class="frame" style="aspect-ratio:${W}/${H}"><div class="page" style="width:${W}px;height:${H}px;background:${pbg}" data-w="${W}">${boxes}</div></div>`;
  }
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Layout preview</title><style>
body{margin:0;padding:16px;background:#1b1b1f;color:#ddd;font-family:"Segoe UI",system-ui,sans-serif}h2{font-size:15px;margin:22px 0 8px}
.frame{position:relative;max-width:1280px;width:100%;overflow:hidden;border:1px solid #444}.page{position:absolute;left:0;top:0;transform-origin:0 0}
.v{position:absolute;box-sizing:border-box;border:1px dashed rgba(128,128,128,.6);border-radius:6px;overflow:hidden;padding:3px 5px;font-size:11px;color:#888;display:flex;flex-direction:column;gap:1px}
.v b{color:#444;font-weight:600}.v i{font-style:normal;opacity:.8}.v small{opacity:.7}</style></head><body>
<p>Wireframe of the chosen pages: real positions, sizes and background colours; the visuals themselves are drawn by Power BI.</p>${html}
<script>function fit(){document.querySelectorAll('.page').forEach(function(p){p.style.transform='scale('+(p.parentNode.clientWidth/+p.dataset.w)+')'})}addEventListener('resize',fit);fit();</script></body></html>`;
  fs.writeFileSync(PREVIEW, doc, 'utf8');
  console.log(JSON.stringify({ ok: true, preview: PREVIEW, pages: pages.map((p) => `${p.key} (${p.visuals.length})`), dropped, warnings }, null, 1));
  process.exit(0);
}

// ---------- write ----------
const def = path.join(reportDir, 'definition');
const pagesDir = path.join(def, 'pages');
if (!fs.existsSync(path.join(pagesDir, 'pages.json'))) { console.error(`not a PBIR report: ${pagesDir}\\pages.json missing`); process.exit(2); }
const pagesJson = readJ(path.join(pagesDir, 'pages.json'));
const ours = new Set([...T.pages.map((p) => pageId(p.key)), '8d1e4c7a2b5f9e3d6c10']);
for (const id of fs.readdirSync(pagesDir)) if (ours.has(id)) fs.rmSync(path.join(pagesDir, id), { recursive: true, force: true });
// keep the report's own $schema versions where it has them
const schemaOf = (file) => { for (const id of pagesJson.pageOrder || []) { if (ours.has(id)) continue; const d = path.join(pagesDir, id); const f = file === 'page.json' ? path.join(d, 'page.json') : null; if (f && fs.existsSync(f)) try { return readJ(f).$schema; } catch (_) { /* next */ } } return null; };
const pageSchema = schemaOf('page.json');
for (const p of pages) {
  const d = path.join(pagesDir, p.id);
  fs.mkdirSync(path.join(d, 'visuals'), { recursive: true });
  if (pageSchema && p.page.$schema && pageSchema > p.page.$schema) p.page.$schema = pageSchema;
  fs.writeFileSync(path.join(d, 'page.json'), JSON.stringify(p.page, null, 2) + '\n');
  for (const v of p.visuals) {
    fs.mkdirSync(path.join(d, 'visuals', v.name), { recursive: true });
    fs.writeFileSync(path.join(d, 'visuals', v.name, 'visual.json'), JSON.stringify(v.json, null, 2) + '\n');
  }
}
pagesJson.pageOrder = [...pages.map((p) => p.id), ...(pagesJson.pageOrder || []).filter((id) => !ours.has(id))];
pagesJson.activePageName = pages.find((p) => byKey[p.key].type !== 'Tooltip').id;
fs.writeFileSync(path.join(pagesDir, 'pages.json'), JSON.stringify(pagesJson, null, 2) + '\n');

// bookmarks
const bdir = path.join(def, 'bookmarks');
const bmIndexFile = path.join(bdir, 'bookmarks.json');
const tplNames = new Set((T.bookmarks || []).map((b) => b.name));
let bmIndex = fs.existsSync(bmIndexFile) ? readJ(bmIndexFile) : null;
if (fs.existsSync(bdir)) for (const f of fs.readdirSync(bdir)) if (f.endsWith('.bookmark.json') && tplNames.has(f.replace('.bookmark.json', ''))) fs.rmSync(path.join(bdir, f));
if (bookmarks.length) {
  fs.mkdirSync(bdir, { recursive: true });
  for (const b of bookmarks) fs.writeFileSync(path.join(bdir, `${b.name}.bookmark.json`), JSON.stringify(b.json, null, 2) + '\n');
  const tplIndex = readJ(path.join(TPL_DIR, 'bookmarks', 'bookmarks.json'));
  const keep = new Set(bookmarks.map((b) => b.name));
  const items = (bmIndex && bmIndex.items ? bmIndex.items : []).filter((i) => !tplNames.has(i.name));
  bmIndex = { ...tplIndex, items: [...items, ...(tplIndex.items || []).filter((i) => keep.has(i.name))] };
}
if (bmIndex) {
  bmIndex.items = (bmIndex.items || []).filter((i) => !tplNames.has(i.name) || bookmarks.some((b) => b.name === i.name));
  if (bmIndex.items.length) fs.writeFileSync(bmIndexFile, JSON.stringify(bmIndex, null, 2) + '\n');
  else { fs.rmSync(bmIndexFile, { force: true }); try { if (!fs.readdirSync(bdir).length) fs.rmdirSync(bdir); } catch (_) { /* keep */ } }
}

// resources: icons (recoloured when the colours differ), logo, theme
const rjPath = path.join(def, 'report.json');
const rjRaw = fs.readFileSync(rjPath, 'utf8');
const rj = JSON.parse(rjRaw.replace(/^﻿/, ''));
const rrDir = path.join(reportDir, 'StaticResources', 'RegisteredResources');
fs.mkdirSync(rrDir, { recursive: true });
const pkgs = rj.resourcePackages = rj.resourcePackages || [];
let rr = pkgs.find((p) => p.type === 'RegisteredResources');
if (!rr) { rr = { name: 'RegisteredResources', type: 'RegisteredResources', items: [] }; pkgs.push(rr); }
const ourItems = new Set([...Object.keys(T.icons || {}), 'pbip-layout-theme.json']);
rr.items = (rr.items || []).filter((i) => !ourItems.has(i.name) && !/^pbip-layout-logo\./.test(i.name));
const usedText = JSON.stringify(pages.map((p) => p.visuals.map((v) => v.json)));
for (const [icon, key] of Object.entries(T.icons || {})) {
  if (!usedText.includes(icon)) continue;
  let buf = fs.readFileSync(path.join(TPL_DIR, 'icons', icon));
  if (C[key] !== T.colors[key]) { const t = tintPng(buf, C[key]); if (t) buf = t; else warnings.push(`${icon}: not 8-bit RGBA – kept its colour`); }
  fs.writeFileSync(path.join(rrDir, icon), buf);
  rr.items.push({ name: icon, path: icon, type: 'Image' });
}
for (const p of pages) for (const v of p.visuals) if (v.logoFile) {
  fs.copyFileSync(cfg.logo, path.join(rrDir, v.logoFile));
  rr.items.push({ name: v.logoFile, path: v.logoFile, type: 'Image' });
}
// base theme = the template's
{
  const bt = readJ(path.join(TPL_DIR, 'base-theme.json'));
  const btName = T.baseTheme || bt.name;
  const sharedDir = path.join(reportDir, 'StaticResources', 'SharedResources', 'BaseThemes');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.copyFileSync(path.join(TPL_DIR, 'base-theme.json'), path.join(sharedDir, `${btName}.json`));
  let sr = pkgs.find((p) => p.type === 'SharedResources');
  if (!sr) { sr = { name: 'SharedResources', type: 'SharedResources', items: [] }; pkgs.unshift(sr); }
  const old = ((rj.themeCollection || {}).baseTheme || {}).name;
  sr.items = (sr.items || []).filter((i) => i.type !== 'BaseTheme').concat([{ name: btName, path: `BaseThemes/${btName}.json`, type: 'BaseTheme' }]);
  if (old && old !== btName) fs.rmSync(path.join(sharedDir, `${old}.json`), { force: true });
  const prev = (rj.themeCollection || {}).baseTheme || {};
  rj.themeCollection = { ...(rj.themeCollection || {}), baseTheme: { name: btName, reportVersionAtImport: prev.reportVersionAtImport || { visual: '1.8.79', report: '2.0.79', page: '1.3.79' }, type: 'SharedResources' } };
  if (old && old !== btName) notes.push(`base theme ${old} → ${btName} (the template's)`);
}
const THEME = 'pbip-layout-theme.json';
if (cfg.theme !== false) {
  fs.writeFileSync(path.join(rrDir, THEME), JSON.stringify(themeJson(), null, 2) + '\n');
  rr.items.push({ name: THEME, path: THEME, type: 'CustomTheme' });
  rr.items = rr.items.filter((i) => i.type !== 'CustomTheme' || i.name === THEME);
  const base = (rj.themeCollection || {}).baseTheme || {};
  rj.themeCollection = { ...(rj.themeCollection || {}), customTheme: { name: THEME, reportVersionAtImport: base.reportVersionAtImport, type: 'RegisteredResources' } };
} else {
  fs.rmSync(path.join(rrDir, THEME), { force: true });
  if (rj.themeCollection && rj.themeCollection.customTheme && rj.themeCollection.customTheme.name === THEME) delete rj.themeCollection.customTheme;
}
if (!rr.items.length) pkgs.splice(pkgs.indexOf(rr), 1);
fs.writeFileSync(rjPath, JSON.stringify(rj, null, 2) + (/\n$/.test(rjRaw) ? '\n' : ''));

console.log(JSON.stringify({ ok: true, pages: pages.map((p) => ({ key: p.key, id: p.id, name: p.page.displayName, visuals: p.visuals.length })),
  bookmarks: bookmarks.map((b) => b.json.displayName), dropped, notes, warnings }, null, 1));
