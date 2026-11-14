#!/usr/bin/env node
// Turns a PBIR report (a .pbix saved as .pbip in Power BI Desktop) into a pbip-layout template:
//
//   node extract-template.js "<…/Name.Report>" "<skill>/templates/<key>" [--theme <BaseTheme.json>] [--keys adventureworks|business]
//
// --keys picks the colour keys and page keys of a known source report (KEYSETS below; default adventureworks).
// - every page (page.json + visuals) and every bookmark is copied
// - theme colour references (ThemeDataColor) are resolved to hex with the report's base theme, and every
//   colour is replaced by a colour key token '{{key}}' (COLOR_KEYS below) – the generator fills them in,
//   so a colour choice changes colour values only
// - the navigation icons are copied (white = onDark, "_Blue" = accent); the logo image is not copied:
//   its visual is listed in template.json and replaced by the title (or the user's own logo)
// - template.json lists the pages, the fields every page uses (template field → pages) and the colours
// An unknown colour stops the script: add it to classify() so it gets a key.
'use strict';
const fs = require('fs');
const path = require('path');

const [src, out] = process.argv.slice(2);
const ti = process.argv.indexOf('--theme');
const ki = process.argv.indexOf('--keys');
const KEYSET = ki > 0 ? process.argv[ki + 1] : 'adventureworks';
if (!src || !out) { console.error('Usage: node extract-template.js <Name.Report> <templates/key> [--theme <BaseTheme.json>]'); process.exit(2); }
const def = path.join(src, 'definition');
const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));

// ---------- theme colours ----------
const report = readJ(path.join(def, 'report.json'));
const baseName = ((report.themeCollection || {}).baseTheme || {}).name;
const themeFile = ti > 0 ? process.argv[ti + 1] : path.join(src, 'StaticResources', 'SharedResources', 'BaseThemes', `${baseName}.json`);
const theme = readJ(themeFile);
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
function shade(hex, p) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return '#' + c.map((v) => hex2(p >= 0 ? v + (255 - v) * p : v * (1 + p))).join('');
}
// Power BI's palette: ColorId 0 = white, 1 = black, 2… = the theme's dataColors
const themeColor = (id, p) => shade(id === 0 ? '#FFFFFF' : id === 1 ? '#000000' : theme.dataColors[id - 2], p || 0);

// ---------- colour keys ----------
// default value of each key = the template's own colour, so Standard is exactly the source report.
// Each source report has its own set: colour keys, classify() (hex + where it is used → key), the page keys,
// the order of the theme's series colours, and the colours that stay as they are ('fixed', never re-branded).
const KEYSETS = {
  adventureworks: {
    colors: {
      dark: '#333333',    // tiles, navigation rail, shapes, chart series, tooltip background
      muted: '#666666',   // secondary titles
      teal: '#20E2D7',    // accent: KPI values, labels, active icons, highlights
      onDark: '#FFFFFF',  // text and icons on dark
      panel: '#FFFFFF',   // light backgrounds, low end of colour scales
      soft: '#E6E6E6',    // slicer item background
      bar: '#CCCCCC',     // data bars in tables
      axis: '#252423',    // data bar axis
      bad: '#DE6A73',     // decrease / high return rate
      badDark: '#A1343C', // returns series
      gold: '#E1C233',    // second series (donut)
    },
    classify(hex, t) {
      switch (hex) {
        case '#20E2D7': return 'teal';
        case '#333333': return 'dark';
        case '#666666': return 'muted';
        case '#E6E6E6': return 'soft';
        case '#CCCCCC': return 'bar';
        case '#252423': return 'axis';
        case '#DE6A73': return 'bad';
        case '#A1343C': return 'badDark';
        case '#E1C233': return 'gold';
        case '#FFFFFF': return /FillRule|negativeColor|[Bb]ackground/.test(t) ? 'panel' : 'onDark';
        default: return null;
      }
    },
    pages: { 'Exec Dashboard': 'exec', Map: 'map', 'Product Detail': 'product', 'Customer Detail': 'customer', 'Category Tooltip': 'tooltip',
      'Q&A': 'qna', 'Decomposition Tree': 'decomp', 'Key Influencers': 'influencers' },
    themeDataColors: ['dark', 'gold', 'teal', 'bad', 'muted', 'badDark'],
    themeRoles: { background: 'panel', foreground: 'axis', tableAccent: 'teal' },
  },
  // Power BI Template Library – Marketing, Sales, Finance (Home + three modules). Good / bad / neutral
  // (#197A4C / #C0392B / #6B7280) are status colours: fixed, never re-branded (the YoY Colour measures hold them).
  business: {
    colors: {
      primary: '#1B2A4A',   // KPI card 1, current-year series, headings, the buttons on Home
      secondary: '#1A7F7C', // KPI card 2, second series
      tertiary: '#5F6F86',  // KPI card 3, third series
      highlight: '#7FB3D9', // KPI card 4, fourth series, selected state
      prior: '#A9B4C6',     // prior-year lines and bars
      sidebar: '#12212B',   // navigation rail
      navActive: '#24475C', // the active page's button in the rail
      ink: '#12212B',       // dark text on the light KPI card
      subtle: '#475569',    // subtitles
      canvas: '#F2F5F8',    // page background
      panel: '#FFFFFF',     // card and chart backgrounds
      onDark: '#FFFFFF',    // text on dark and coloured backgrounds
      line: '#D5DCE6',      // borders
    },
    classify(hex, t) {
      switch (hex) {
        case '#1B2A4A': return 'primary';
        case '#1A7F7C': return 'secondary';
        case '#5F6F86': return 'tertiary';
        case '#7FB3D9': return 'highlight';
        case '#A9B4C6': return 'prior';
        case '#12212B': return /fill/i.test(t) ? 'sidebar' : 'ink';
        case '#24475C': return 'navActive';
        case '#475569': return 'subtle';
        case '#F2F5F8': return 'canvas';
        case '#D5DCE6': return 'line';
        case '#FFFFFF': return /[Bb]ackground|border/.test(t) ? 'panel' : 'onDark';
        case '#197A4C': case '#C0392B': case '#6B7280': return 'fixed';
        default: return null;
      }
    },
    pages: { Home: 'home', Marketing: 'marketing', 'Campaign Detail': 'campaign', Sales: 'sales', 'Opportunity Detail': 'opportunity',
      Finance: 'finance', 'P&L Detail': 'pnl' },
    themeDataColors: ['primary', 'secondary', 'tertiary', 'highlight', 'prior'],
    themeRoles: { background: 'panel', foreground: 'primary', tableAccent: 'secondary' },
    // fixes to the source report (powerbi-report-author validate): drillthrough filters marked "Drill" are
    // not drillthrough filters, and the text boxes are too low for their font with the default padding
    fix(json, kind) {
      if (kind === 'page' && json.type === 'Drillthrough') for (const fl of (json.filterConfig || {}).filters || []) if (fl.howCreated === 'Drill') fl.howCreated = 'Drillthrough';
      if (kind === 'visual' && json.visual && json.visual.visualType === 'textbox') {
        const lit = (v) => ({ expr: { Literal: { Value: v } } });
        json.visual.visualContainerObjects = { ...(json.visual.visualContainerObjects || {}), padding: [{ properties: { top: lit('0D'), bottom: lit('0D') } }] };
      }
    },
  },
};
const KS = KEYSETS[KEYSET];
if (!KS) { console.error(`--keys: unknown key set "${KEYSET}" – ${Object.keys(KEYSETS).join(', ')}`); process.exit(2); }
const COLOR_KEYS = KS.colors;
const classify = (hex, trail) => KS.classify(hex, trail.join('.'));
const unknown = new Map();
const used = {};
function tokenise(node, trail, file) {
  if (Array.isArray(node)) return node.map((x, i) => tokenise(x, trail, file));
  if (node && typeof node === 'object') {
    if (node.ThemeDataColor) {
      const hex = themeColor(node.ThemeDataColor.ColorId, node.ThemeDataColor.Percent);
      const key = classify(hex, trail);
      if (!key) { unknown.set(`${hex} ${trail.slice(-3).join('.')}`, file); return node; }
      if (key === 'fixed') return { Literal: { Value: `'${hex}'` } };
      used[key] = (used[key] || 0) + 1;
      return { Literal: { Value: `'{{${key}}}'` } };
    }
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = tokenise(v, [...trail, k], file);
    return o;
  }
  if (typeof node === 'string' && /#[0-9A-Fa-f]{6}\b/.test(node)) {
    return node.replace(/#[0-9A-Fa-f]{6}\b/g, (h) => {
      const key = classify(h.toUpperCase(), trail);
      if (!key) { unknown.set(`${h} ${trail.slice(-3).join('.')}`, file); return h; }
      if (key === 'fixed') return h;
      used[key] = (used[key] || 0) + 1;
      return `{{${key}}}`;
    });
  }
  return node;
}

// ---------- fields ----------
const fields = new Map(); // "Entity[Prop]" or "Entity[Hierarchy.Level]" → { kind, pages:Set }
function collect(node, aliases, page) {
  if (Array.isArray(node)) { node.forEach((x) => collect(x, aliases, page)); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.From)) { aliases = { ...aliases }; for (const f of node.From) if (f.Name && f.Entity) aliases[f.Name] = f.Entity; }
  for (const kind of ['Column', 'Measure', 'HierarchyLevel']) {
    const x = node[kind];
    if (!x || !x.Expression) continue;
    let ent; let prop;
    if (kind === 'HierarchyLevel') { const h = x.Expression.Hierarchy; if (!h) continue; const sr = h.Expression.SourceRef; ent = sr.Entity || aliases[sr.Source]; prop = `${h.Hierarchy}.${x.Level}`; }
    else { const sr = x.Expression.SourceRef; if (!sr) continue; ent = sr.Entity || aliases[sr.Source]; prop = x.Property; }
    if (!ent) continue;
    const key = `${ent}[${prop}]`;
    if (!fields.has(key)) fields.set(key, { kind: kind === 'HierarchyLevel' ? 'Column' : kind, hierarchy: kind === 'HierarchyLevel', pages: new Set() });
    fields.get(key).pages.add(page);
  }
  for (const v of Object.values(node)) collect(v, aliases, page);
}

// ---------- formatting bound to the source report's data values ----------
// Per-value formatting (a slice colour for "High", an AI node for one product), expanded rows ("Bikes")
// and texts that quote the source data never match another model: they are removed or made generic.
// Slice and series colours come from the theme's dataColors instead (gen-report.js).
const GENERIC_TEXTS = [
  [/^Among customers in .* drove the most revenue at .*$/, 'Show the top customer in the selected group'],
];
let stripped = 0;
function stripDataBound(node) {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const x = node[i];
      if (x && typeof x === 'object' && x.selector && x.selector.data && /"Literal":\{"Value":"'/.test(JSON.stringify(x.selector.data))) { node.splice(i, 1); stripped++; continue; }
      stripDataBound(x);
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.expansionStates)) for (const e of node.expansionStates) if (e.root && e.root.children) { delete e.root.children; stripped++; }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') { for (const [re, t] of GENERIC_TEXTS) { const m = v.match(/^'(.*)'$/s); if (m && re.test(m[1])) { node[k] = `'${t}'`; stripped++; } } }
    else stripDataBound(v);
  }
}

// ---------- pages ----------
const KEYS = KS.pages;
// only what this script writes is replaced: hand-written files (field-hints.json, modules.json, contract.json,
// measures/) stay
for (const x of ['pages', 'bookmarks', 'icons', 'template.json', 'base-theme.json', 'custom-theme.json']) fs.rmSync(path.join(out, x), { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'pages'), { recursive: true });
const pagesJson = readJ(path.join(def, 'pages', 'pages.json'));
const pages = [];
let logo = null;
for (const id of pagesJson.pageOrder) {
  const pdir = path.join(def, 'pages', id);
  const pj = readJ(path.join(pdir, 'page.json'));
  if (KS.fix) KS.fix(pj, 'page');
  const key = KEYS[pj.displayName] || pj.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const odir = path.join(out, 'pages', key);
  fs.mkdirSync(odir, { recursive: true });
  collect(pj, {}, key);
  fs.writeFileSync(path.join(odir, 'page.json'), JSON.stringify(tokenise(pj, [], `${key}/page.json`), null, 2) + '\n');
  const visuals = [];
  const vdir = path.join(pdir, 'visuals');
  for (const v of fs.existsSync(vdir) ? fs.readdirSync(vdir).sort() : []) {
    const vj = readJ(path.join(vdir, v, 'visual.json'));
    if (KS.fix) KS.fix(vj, 'visual');
    stripDataBound(vj);
    // smart narrative: keep only the values that are plain fields/measures (they can be remapped) and the
    // paragraphs that use nothing else; the AI trend sentences are bound to the source data
    const o = vj.visual && vj.visual.objects;
    if (o && Array.isArray(o.values) && o.values.length && o.general) {
      const keep = new Set(o.values.filter((x) => !/TransformTableRef|TransformOutput/.test(JSON.stringify(x))).map((x) => x.selector.id));
      o.values = o.values.filter((x) => keep.has(x.selector.id));
      const refs = (par) => [...JSON.stringify(par).matchAll(/"selector":\{"id":"([^"]+)"\}/g)].map((m) => m[1]);
      for (const g of o.general) {
        if (!g.properties || !g.properties.paragraphs) continue;
        g.properties.paragraphs = g.properties.paragraphs.filter((par) => !/"cases"/.test(JSON.stringify(par)) && refs(par).every((id) => keep.has(id)));
        while (g.properties.paragraphs.length && JSON.stringify(g.properties.paragraphs.at(-1)) === '{"textRuns":[{"value":""}]}') g.properties.paragraphs.pop();
      }
    }
    const s = JSON.stringify(vj);
    if (/AdventureWorks_Logo/.test(s)) { logo = { page: key, visual: v, position: vj.position }; }
    collect(vj, {}, key);
    fs.mkdirSync(path.join(odir, 'visuals', v), { recursive: true });
    fs.writeFileSync(path.join(odir, 'visuals', v, 'visual.json'), JSON.stringify(tokenise(vj, [], `${key}/${v}`), null, 2) + '\n');
    const vt = vj.visual ? vj.visual.visualType : vj.visualGroup ? 'group' : '?';
    const nav = (s.match(/"navigationSection":\{"expr":\{"Literal":\{"Value":"'([^']+)'/) || [])[1];
    const bm = (s.match(/"bookmark":\{"expr":\{"Literal":\{"Value":"'([^']+)'/) || [])[1];
    visuals.push({ name: v, type: vt, ...(nav ? { navigatesTo: nav } : {}), ...(bm ? { bookmark: bm } : {}), ...(vj.parentGroupName ? { group: vj.parentGroupName } : {}) });
  }
  pages.push({ key, id, displayName: pj.displayName, type: pj.type || 'Standard', hidden: pj.visibility === 'HiddenInViewMode', width: pj.width, height: pj.height, visuals });
}
// page ids → keys in the navigation
const idToKey = Object.fromEntries(pages.map((p) => [p.id, p.key]));
for (const p of pages) for (const v of p.visuals) if (v.navigatesTo) v.navigatesTo = idToKey[v.navigatesTo] || v.navigatesTo;
// the texts on each page (titles, text boxes, button texts) – exactly as written, so config.texts can replace them
for (const p of pages) {
  const texts = new Set();
  for (const v of p.visuals) {
    const vj = readJ(path.join(out, 'pages', p.key, 'visuals', v.name, 'visual.json'));
    (function walk(o, k) {
      if (Array.isArray(o)) { o.forEach((x) => walk(x, k)); return; }
      if (o && typeof o === 'object') { for (const [kk, vv] of Object.entries(o)) walk(vv, kk); return; }
      if (typeof o !== 'string') return;
      if (k === 'value' && o.trim()) texts.add(o);
      const m = o.match(/^'(.+)'$/s);
      // a text is a literal with a space or punctuation, or a capitalised word that is not a format option
      const ENUMS = /^(Basic|Canvas|Default|Normal|None|Negative|Both|Between|Average|Continuous|OutsideEnd|Inside\w*|Outside\w*|Left|Right|Center|Top|Bottom|Auto|Custom|Fixed|Solid|Dashed|Dotted)$/;
      if (m && k === 'Value' && /[A-Za-z]{3}/.test(m[1]) && !ENUMS.test(m[1]) && !/^\{\{|\.png$|^#|^(Segoe|wf_|''|Back$|PageNavigation|Bookmark|ReportSection)|^[a-z]+$|^[a-z][A-Za-z]+$/.test(m[1])) texts.add(m[1].replace(/''/g, "'"));
    })(vj, '');
  }
  p.texts = [...texts].sort();
}

// ---------- bookmarks ----------
const bookmarks = [];
const bdir = path.join(def, 'bookmarks');
if (fs.existsSync(bdir)) {
  fs.mkdirSync(path.join(out, 'bookmarks'), { recursive: true });
  for (const f of fs.readdirSync(bdir).filter((x) => x.endsWith('.bookmark.json'))) {
    const b = readJ(path.join(bdir, f));
    const pageKey = idToKey[(b.explorationState || {}).activeSection];
    collect(b, {}, pageKey);
    fs.writeFileSync(path.join(out, 'bookmarks', f), JSON.stringify(tokenise(b, [], f), null, 2) + '\n');
    bookmarks.push({ name: b.name, displayName: b.displayName, file: f, page: pageKey });
  }
  if (fs.existsSync(path.join(bdir, 'bookmarks.json'))) fs.copyFileSync(path.join(bdir, 'bookmarks.json'), path.join(out, 'bookmarks', 'bookmarks.json'));
}

// ---------- icons and theme ----------
const rr = path.join(src, 'StaticResources', 'RegisteredResources');
const icons = {};
if (fs.existsSync(rr)) {
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(rr).filter((x) => /\.png$/i.test(x) && !/Logo/i.test(x))) {
    fs.copyFileSync(path.join(rr, f), path.join(out, 'icons', f));
    icons[f] = /_Blue/i.test(f) ? 'teal' : 'onDark';
  }
}
fs.copyFileSync(themeFile, path.join(out, 'base-theme.json'));
// the source report's own custom theme (fonts, text classes, visual styles): kept, with its colours as keys
// where they have one – a colour without a key stays as it is (status colours, grid lines)
let customTheme = false;
const ctName = ((report.themeCollection || {}).customTheme || {}).name;
if (ctName && fs.existsSync(path.join(rr, ctName))) {
  const ct = readJ(path.join(rr, ctName));
  const keyOf = (k, v) => { const key = KS.classify(v.toUpperCase(), k); return key && key !== 'fixed' ? key : null; };
  const keyed = JSON.parse(JSON.stringify(ct), (k, v) => (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v) && keyOf(k, v) ? `{{${keyOf(k, v)}}}` : v));
  fs.writeFileSync(path.join(out, 'custom-theme.json'), JSON.stringify(keyed, null, 2) + '\n');
  customTheme = true;
}

if (unknown.size) {
  console.error('Colours without a key (add them to classify()):');
  for (const [k, f] of unknown) console.error(`  ${k}  (${f})`);
  process.exit(1);
}
const tpl = {
  source: path.basename(path.dirname(path.resolve(src))) + path.sep + path.basename(src),
  extracted: new Date().toISOString().slice(0, 10),
  baseTheme: baseName,
  width: pages[0].width, height: pages[0].height,
  colors: COLOR_KEYS,
  colorUse: used,
  themeDataColors: KS.themeDataColors,
  themeRoles: KS.themeRoles,
  ...(customTheme ? { customTheme: 'custom-theme.json' } : {}),
  logo,
  pages,
  bookmarks,
  icons,
  fields: Object.fromEntries([...fields].sort().map(([k, v]) => [k, { kind: v.kind, ...(v.hierarchy ? { hierarchyLevel: true } : {}), pages: [...v.pages].filter(Boolean).sort() }])),
};
fs.writeFileSync(path.join(out, 'template.json'), JSON.stringify(tpl, null, 1) + '\n');
console.log(JSON.stringify({ ok: true, pages: pages.map((p) => `${p.key} (${p.visuals.length})`), bookmarks: bookmarks.length, icons: Object.keys(icons).length, fields: fields.size, colorUse: used, strippedDataBound: stripped, logo }, null, 1));
