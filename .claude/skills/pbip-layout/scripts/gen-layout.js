// Generates the "Sales overview" dashboard page (PBIR) into a PBIP report folder.
// Usage: node gen-layout.js "<path to .Report folder>" "<path to config.json>" [--preview <out.html>]
// --preview writes an HTML mock-up of the same page (same positions and colours, placeholder
// numbers) and leaves the report untouched; the report folder may then be "-".
// Field references in config use DAX notation: "Table[Field]".
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const pi = args.indexOf('--preview');
const PREVIEW = pi >= 0 ? args.splice(pi, 2)[1] : null;
const [reportDir, configPath] = args;
if (!reportDir || !configPath || (pi >= 0 && !PREVIEW)) throw new Error('Usage: node gen-layout.js <ReportFolder> <config.json> [--preview <out.html>]');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));

const PAGE_ID = cfg.pageId || '8d1e4c7a2b5f9e3d6c10';
const pagesDir = path.join(reportDir, 'definition', 'pages');

// Reuse $schema versions from the existing report (never guess them).
function findSchema(fileName, fallback) {
  if (!fs.existsSync(pagesDir)) return fallback;
  const stack = [pagesDir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!p.includes(PAGE_ID)) stack.push(p); }
      else if (e.name === fileName) {
        try { const s = JSON.parse(fs.readFileSync(p, 'utf8')).$schema; if (s) return s; } catch (_) {}
      }
    }
  }
  return fallback;
}
const SCHEMA_VISUAL = findSchema('visual.json', 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.9.0/schema.json');
const SCHEMA_PAGE = findSchema('page.json', 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json');

// Every colour on the page. Keys and meaning: colors.md. Older configs only set the first ten;
// the rest default to the values the page always had.
const C = Object.assign({
  dark: '#333333', teal: '#1FC8C0', ink: '#252423', sub: '#605E5C',
  border: '#C8C6C4', white: '#FFFFFF', spark: '#E1DFDD', bar: '#C8C6C4',
  gradLow: '#E36C78', gradHigh: '#FDEDEF',
  navBtn: '#4A4A4A', navHover: '#5C5C5C', grid: '#E1DFDD', trendLine: '#A19F9D',
  band: '#C8C6C4', negative: '#D64550', axis: '#999999',
}, cfg.colors || {});
C.page = C.page || C.white;     // page background
C.panel = C.panel || C.white;   // background of chart, tile and table boxes
C.onDark = C.onDark || C.white; // text and icons on the dark rail and KPI tiles

// ---------- helpers ----------
const lit = v => ({ expr: { Literal: { Value: v } } });
const str = s => lit(`'${String(s).replace(/'/g, "''")}'`);
const num = n => lit(`${n}D`);
const int = n => lit(`${n}L`);
const bool = b => lit(b ? 'true' : 'false');
const color = hex => ({ solid: { color: lit(`'${hex}'`) } });
const def = { id: 'default' };

function ref(s) {
  const m = /^'?(.+?)'?\[(.+)\]$/.exec(s);
  if (!m) throw new Error(`Bad field reference "${s}" – use Table[Field]`);
  return { table: m[1], name: m[2] };
}
const measureField = s => { const r = ref(s); return { Measure: { Expression: { SourceRef: { Entity: r.table } }, Property: r.name } }; };
const columnField = s => { const r = ref(s); return { Column: { Expression: { SourceRef: { Entity: r.table } }, Property: r.name } }; };
const qref = s => { const r = ref(s); return `${r.table}.${r.name}`; };
const projM = (s, displayName) => { const r = ref(s); const p = { field: measureField(s), queryRef: qref(s), nativeQueryRef: r.name }; if (displayName) p.displayName = displayName; return p; };
const projC = (s, displayName) => { const r = ref(s); const p = { field: columnField(s), queryRef: qref(s), nativeQueryRef: r.name }; if (displayName) p.displayName = displayName; return p; };

let seq = 0;
const vid = () => { seq += 1; return ('d5b0a1' + seq.toString(16).padStart(4, '0') + 'c3e7f9a2b4').slice(0, 20); };
const visuals = [];
function add(v, pos, z) {
  const { filterConfig, ...visual } = v;
  const c = { $schema: SCHEMA_VISUAL, name: vid(), position: { x: pos[0], y: pos[1], z, height: pos[3], width: pos[2], tabOrder: z }, visual };
  if (filterConfig) c.filterConfig = filterConfig;
  visuals.push(c);
}
function vco({ bg = null, radius = 0, borderColor = null, title = null, titleSize = 12, pad = 8 } = {}) {
  return {
    background: bg ? [{ properties: { show: bool(true), color: color(bg), transparency: num(0) } }] : [{ properties: { show: bool(false) } }],
    border: (borderColor || bg)
      ? [{ properties: { show: bool(true), color: color(borderColor || bg), radius: num(radius), width: num(1) } }]
      : [{ properties: { show: bool(false) } }],
    padding: [{ properties: { top: num(pad), bottom: num(pad), left: num(pad), right: num(pad) } }],
    visualHeader: [{ properties: { show: bool(false) } }],
    dropShadow: [{ properties: { show: bool(false) } }],
    title: title
      ? [{ properties: { show: bool(true), text: str(title), fontSize: num(titleSize), alignment: str('center'), fontColor: color(C.ink), bold: bool(false) } }]
      : [{ properties: { show: bool(false) } }],
  };
}
// Whole numbers everywhere (no K/M display units).
const WHOLE = { labelDisplayUnits: str('1') };

// ---------- 1. navigation rail ----------
add({
  visualType: 'shape',
  objects: {
    shape: [{ properties: { tileShape: str('rectangle') } }],
    fill: [{ properties: { fillColor: color(C.dark), transparency: num(0) }, selector: def }],
    outline: [{ properties: { show: bool(false) }, selector: def }],
  },
  visualContainerObjects: vco({ pad: 0 }),
}, [0, 0, 80, 1080], 0);

function navButton({ y, label, icon, link }) {
  add({
    visualType: 'actionButton',
    objects: {
      text: label
        ? [{ properties: { show: bool(true) } }, { properties: { text: str(label), fontSize: num(10), fontColor: color(C.onDark), horizontalAlignment: str('center') }, selector: def }]
        : [{ properties: { show: bool(false) } }],
      icon: [{ properties: { show: bool(!!icon) } },
             { properties: { shapeType: str(icon || 'blank'), placement: str('left'), lineColor: color(C.onDark), iconSize: num(22) }, selector: def }],
      fill: [{ properties: { show: bool(!icon) } },
             { properties: { fillColor: color(C.navBtn), transparency: num(0) }, selector: def },
             { properties: { fillColor: color(C.navHover), transparency: num(0) }, selector: { id: 'hover' } }],
      outline: [{ properties: { show: bool(false) } }],
      shape: [{ properties: { tileShape: str('rectangleRounded'), roundEdge: int(6) } }, { properties: { tileShape: str('rectangleRounded') }, selector: def }],
    },
    visualContainerObjects: { background: [{ properties: { show: bool(false) } }], border: [{ properties: { show: bool(false) } }], visualLink: [{ properties: link }] },
    drillFilterOtherVisuals: true,
  }, [8, y, 64, 44], 10 + y);
}
navButton({ y: 16, icon: 'back', link: { show: bool(true), type: str('Back'), tooltip: str('Back') } });
// Nav buttons to the other pages (max 3), bottom-up.
const otherPages = [];
const pagesJsonPath = path.join(pagesDir, 'pages.json');
// a preview without a report ("-") just has no buttons to other pages
const pagesJson = PREVIEW && !fs.existsSync(pagesJsonPath) ? { pageOrder: [] } : JSON.parse(fs.readFileSync(pagesJsonPath, 'utf8'));
for (const id of pagesJson.pageOrder.filter(p => p !== PAGE_ID)) {
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(pagesDir, id, 'page.json'), 'utf8'));
    otherPages.push({ id, name: pj.displayName || id });
  } catch (_) {}
}
otherPages.slice(0, 3).forEach((p, i, arr) => {
  const short = (cfg.navLabels && cfg.navLabels[p.name]) || (p.name.length > 9 ? p.name.slice(0, 8) + '…' : p.name);
  navButton({ y: 1020 - (arr.length - i) * 56, label: short,
    link: { show: bool(true), type: str('PageNavigation'), navigationSection: str(p.id), tooltip: str(p.name) } });
});

// ---------- 2. title ----------
add({
  visualType: 'textbox',
  objects: { general: [{ properties: { paragraphs: [
    { textRuns: [{ value: cfg.title || 'Sales overview', textStyle: { fontFamily: 'Segoe UI Bold', fontSize: '32px', color: C.ink } }], horizontalTextAlignment: 'left' },
    { textRuns: [{ value: cfg.subtitle || '', textStyle: { fontFamily: 'Segoe UI', fontSize: '15px', color: C.sub } }], horizontalTextAlignment: 'left' },
  ] } }] },
  visualContainerObjects: vco({ pad: 0 }),
}, [104, 52, 256, 96], 1000);

// ---------- 3. KPI tiles ----------
function card({ x, y, w, h, measure, label, valueSize = 40, labelSize = 16, valueColor = C.teal, bg = C.dark, colorMeasure = null, pad = 8 }) {
  const value = { show: bool(true), fontSize: num(valueSize), bold: bool(valueSize >= 20), horizontalAlignment: str('center'), ...WHOLE,
    fontColor: colorMeasure ? { solid: { color: { expr: measureField(colorMeasure) } } } : color(valueColor) };
  add({
    visualType: 'cardVisual',
    query: { queryState: { Data: { projections: [projM(measure)] } } },
    objects: {
      value: [{ properties: value, selector: def }],
      label: [{ properties: label
        ? { show: bool(true), text: str(label), fontSize: num(labelSize), fontColor: color(C.onDark), horizontalAlignment: str('center'), position: str('belowValue') }
        : { show: bool(false) }, selector: def }],
      outline: [{ properties: { show: bool(false) }, selector: def }],
      // cardVisual draws its own inner tile (white by default) over the container background
      fillCustom: [{ properties: { transparency: num(100) }, selector: def }],
      padding: [{ properties: { paddingUniform: num(8) }, selector: def }],
      // "Multi-card layout → Background": the card's own white tile; off so the dark container shows
      layout: [{ properties: { paddingUniform: num(0), backgroundShow: bool(false) }, selector: def }],
      spacing: [{ properties: { verticalSpacing: num(2) }, selector: def }],
    },
    visualContainerObjects: vco({ bg, radius: 16, pad }),
    drillFilterOtherVisuals: true,
  }, [x, y, w, h], 1100 + x + y);
}
// 1–4 tiles spread evenly over the row x 376–1904 with 24 px gaps (4 tiles = the original 364 px each)
const kpis = (cfg.kpis || []).filter(k => k && k.measure);
if (!kpis.length) throw new Error('config.kpis: at least one KPI with a measure is required');
if (kpis.length > 4) console.warn(`config.kpis has ${kpis.length} entries; only the first 4 fit on the page`);
const kn = Math.min(4, kpis.length), kw = Math.floor((1528 - (kn - 1) * 24) / kn);
kpis.slice(0, kn).forEach((k, i) => card({ x: 376 + i * (kw + 24), y: 20, w: kw, h: 148, measure: k.measure, label: k.label }));

// ---------- sections: which parts are shown (config "sections"); the rest takes the room ----------
// Default (no "sections"): everything, at the original positions.
const sec = cfg.sections || {};
const monthlyList = (cfg.monthly || []).filter(Boolean).slice(0, sec.monthly ?? 3);
const highlightList = (cfg.highlights || []).filter(Boolean).slice(0, sec.highlights ?? 2);
const showBar = sec.bar !== false && !!cfg.bar, showTable = sec.table !== false && !!cfg.table;
const rightCol = showBar || showTable;                       // bar + table column, x 1072–1904
const BOTTOM = 1056;
const trendW = rightCol ? 952 : 1808;
const trendH = monthlyList.length || (!rightCol && highlightList.length) ? 548 : BOTTOM - 200;
const monthlyRight = rightCol || highlightList.length ? 1048 : 1904;
const rightBottom = highlightList.length ? 884 : BOTTOM;
const spread = (x0, x1, n, gap) => { const w = Math.floor((x1 - x0 - (n - 1) * gap) / n); return Array.from({ length: n }, (_, i) => [x0 + i * (w + gap), w]); };

// ---------- 4. trend line ----------
const t = cfg.trend;
add({
  visualType: 'lineChart',
  query: { queryState: {
    Category: { projections: [projC(t.monthColumn, 'Month')] },
    Y: { projections: [projM(t.measure, t.label || null)] },
  } },
  objects: {
    categoryAxis: [{ properties: { show: bool(true), axisType: str('Scalar'), showAxisTitle: bool(false), gridlineShow: bool(true), gridlineStyle: str('dotted'), gridlineColor: color(C.grid), labelColor: color(C.sub) } }],
    valueAxis: [{ properties: { show: bool(true), showAxisTitle: bool(true), labelDisplayUnits: str('1'), gridlineShow: bool(true), gridlineStyle: str('dotted'), gridlineColor: color(C.grid), labelColor: color(C.sub), titleColor: color(C.sub) } }],
    dataPoint: [{ properties: { defaultColor: color(C.ink) } }],
    lineStyles: [{ properties: { strokeWidth: num(3), showMarker: bool(false) } }],
    legend: [{ properties: { show: bool(false) } }],
    trend: [{ properties: { show: bool(true), lineColor: color(C.trendLine), style: str('dashed'), width: num(2), transparency: num(0), displayName: str('Trend') } }],
    forecast: [{ properties: { show: bool(true), lineColor: color(C.ink), width: num(1), bandAreaShow: bool(true), bandAreaColor: color(C.band), bandAreaTransparency: num(50), displayName: str('Forecast') } }],
    zoom: [{ properties: { show: bool(true), showOnCategoryAxis: bool(true), showLabels: bool(false) } }],
  },
  visualContainerObjects: vco({ bg: C.panel, radius: 8, borderColor: C.border, title: t.title, titleSize: 13 }),
  drillFilterOtherVisuals: true,
}, [96, 200, trendW, trendH], 1200);

// ---------- 5. monthly tiles (0–3, spread over the bottom-left row; 3 tiles = 300 px each) ----------
spread(96, monthlyRight, monthlyList.length || 1, 26).slice(0, monthlyList.length).forEach(([x, w], i) => {
  const m = monthlyList[i];
  const y = 772, h = 284;
  // show:false alone still renders axis titles ("month_start", clipped value title)
  const hidden = extra => [{ properties: { show: bool(false), showAxisTitle: bool(false), gridlineShow: bool(false), ...extra } }];
  add({
    visualType: 'areaChart',
    query: { queryState: { Category: { projections: [projC(t.monthColumn)] }, Y: { projections: [projM(m.sparkMeasure)] } } },
    objects: {
      categoryAxis: hidden({ axisType: str('Scalar') }), valueAxis: hidden(),
      legend: [{ properties: { show: bool(false) } }], labels: [{ properties: { show: bool(false) } }],
      dataPoint: [{ properties: { defaultColor: color(C.spark) } }],
      lineStyles: [{ properties: { strokeWidth: num(1), showMarker: bool(false) } }],
    },
    visualContainerObjects: vco({ bg: C.panel, radius: 8, borderColor: C.border, title: m.title, titleSize: 12, pad: 6 }),
    drillFilterOtherVisuals: true,
  }, [x, y, w, h], 1300 + x);
  card({ x: x + 12, y: y + 64, w: w - 24, h: 92, measure: m.currentMeasure, label: null, bg: null, colorMeasure: m.colorMeasure, pad: 4 });
  card({ x: x + 12, y: y + 160, w: w - 24, h: 52, measure: m.labelMeasure, label: null, bg: null, valueSize: 12, valueColor: C.sub, pad: 2 });
});

// ---------- 6. bar chart (optional) ----------
// bar and table share the right column; alone, one takes all of it (both: 320 + 24 + 340 px)
const rightH = rightBottom - 200, barH = showTable ? Math.round((rightH - 24) * 320 / 660) : rightH;
const b = cfg.bar;
if (showBar) add({
  visualType: 'clusteredBarChart',
  query: {
    queryState: {
      Category: { projections: [projC(b.categoryColumn, b.categoryLabel || null)] },
      Y: { projections: [projM(b.measure, b.measureLabel || null)] },
    },
    sortDefinition: { sort: [{ field: measureField(b.measure), direction: 'Descending' }], isDefaultSort: true },
  },
  objects: {
    categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontSize: num(11), labelColor: color(C.sub) } }],
    valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false), gridlineShow: bool(false) } }],
    dataPoint: [{ properties: { defaultColor: color(C.ink) } }],
    labels: [{ properties: { show: bool(true), fontSize: num(10), color: color(C.sub), labelDisplayUnits: str('1') } }],
    legend: [{ properties: { show: bool(false) } }],
  },
  visualContainerObjects: vco({ bg: C.panel, radius: 8, borderColor: C.border, title: b.title, titleSize: 13 }),
  filterConfig: { filters: [{
    name: 'f0a1b2c3d4e5f6a7b8c9d0e1',
    field: columnField(b.categoryColumn),
    type: 'Categorical',
    filter: { Version: 2, From: [{ Name: 'd', Entity: ref(b.categoryColumn).table, Type: 0 }],
      Where: [{ Condition: { Not: { Expression: { In: {
        Expressions: [{ Column: { Expression: { SourceRef: { Source: 'd' } }, Property: ref(b.categoryColumn).name } }],
        Values: [[{ Literal: { Value: 'null' } }]] } } } } }] },
    howCreated: 'User',
  }] },
  drillFilterOtherVisuals: true,
}, [1072, 200, 832, barH], 1600);

// ---------- 7. top-N table (optional) ----------
const tb = cfg.table;
if (showTable) {
const tableVisual = {
  visualType: 'tableEx',
  query: {
    queryState: { Values: { projections: [projC(tb.rowColumn, tb.title), ...tb.columns.map(c => projM(c.measure, c.label))] } },
    sortDefinition: { sort: [{ field: measureField(tb.sortMeasure), direction: 'Descending' }], isDefaultSort: true },
  },
  objects: {
    columnHeaders: [{ properties: { columnAdjustment: str('growToFit'), autoSizeColumnWidth: bool(true), bold: bool(true), fontSize: num(11), fontColor: color(C.ink), backColor: color(C.panel) } }],
    values: [{ properties: { fontSize: num(11), fontColorPrimary: color(C.ink), fontColorSecondary: color(C.ink), backColorPrimary: color(C.panel), backColorSecondary: color(C.panel) } }],
    total: [{ properties: { totals: bool(false) } }],
  },
  visualContainerObjects: { ...vco({ bg: C.panel, radius: 8, borderColor: C.border }), stylePreset: [{ properties: { name: str('None') } }] },
  drillFilterOtherVisuals: true,
};
if (tb.gradientMeasure) {
  tableVisual.objects.values.push({
    properties: { backColor: { solid: { color: { expr: { FillRule: {
      Input: measureField(tb.gradientMeasure),
      FillRule: { linearGradient2: {
        min: { color: { Literal: { Value: `'${tb.gradientHigherIsWorse ? C.gradHigh : C.gradLow}'` } } },
        max: { color: { Literal: { Value: `'${tb.gradientHigherIsWorse ? C.gradLow : C.gradHigh}'` } } },
        nullColoringStrategy: { strategy: { Literal: { Value: "'noColor'" } } },
      } } } } } } } },
    selector: { data: [{ dataViewWildcard: { matchingOption: 1 } }], metadata: qref(tb.gradientMeasure) },
  });
}
if (tb.dataBarMeasure) {
  tableVisual.objects.columnFormatting = [{
    properties: { dataBars: { positiveColor: color(C.bar), negativeColor: color(C.negative), axisColor: color(C.axis), reverseDirection: bool(false), hideText: bool(false) } },
    selector: { metadata: qref(tb.dataBarMeasure) },
  }];
}
if (tb.topN) {
  const row = ref(tb.rowColumn), ob = ref(tb.topN.orderByColumn);
  tableVisual.filterConfig = { filters: [{
    name: 'f1b2c3d4e5f6a7b8c9d0e1f2',
    field: columnField(tb.rowColumn),
    type: 'TopN',
    filter: {
      Version: 2,
      From: [
        { Name: 'subquery', Expression: { Subquery: { Query: {
          Version: 2,
          From: [{ Name: 'p', Entity: row.table, Type: 0 }, { Name: 'f', Entity: ob.table, Type: 0 }],
          Select: [{ Column: { Expression: { SourceRef: { Source: 'p' } }, Property: row.name }, Name: 'field' }],
          OrderBy: [{ Direction: 2, Expression: { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: 'f' } }, Property: ob.name } }, Function: tb.topN.function } } }],
          Top: tb.topN.count || 10,
        } } }, Type: 2 },
        { Name: 'p', Entity: row.table, Type: 0 },
      ],
      Where: [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 'p' } }, Property: row.name } }], Table: { SourceRef: { Source: 'subquery' } } } } }],
    },
    howCreated: 'User',
  }] };
}
const tableY = showBar ? 200 + barH + 24 : 200;
add(tableVisual, [1072, tableY, 832, rightBottom - tableY], 1700);
}

// ---------- 8. highlight tiles (0–2, spread over the bottom-right row; 2 tiles = 404 px each) ----------
spread(1072, 1904, highlightList.length || 1, 24).slice(0, highlightList.length).forEach(([x, w], i) => {
  const h = highlightList[i];
  add({
    visualType: 'textbox',
    objects: { general: [{ properties: { paragraphs: [
      { textRuns: [{ value: h.header, textStyle: { fontFamily: 'Segoe UI Semibold', fontSize: '15px', color: C.ink } }], horizontalTextAlignment: 'center' },
    ] } }] },
    visualContainerObjects: vco({ pad: 0 }),
  }, [x, 904, w, 32], 1800 + x);
  card({ x, y: 944, w, h: 112, measure: h.measure, label: null, valueSize: 28 });
});

// ---------- preview (HTML mock-up of exactly these visuals; no report files are written) ----------
function writePreview(out) {
  const L = o => { const v = o && o.solid && o.solid.color && o.solid.color.expr && o.solid.color.expr.Literal; return v ? v.Value.replace(/^'|'$/g, '') : null; };
  const P = (arr, i = 0) => (arr && arr[i] && arr[i].properties) || {};
  const val = p => p && p.expr && p.expr.Literal ? p.expr.Literal.Value.replace(/^'|'$/g, '').replace(/[DL]$/, '') : null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const hash = s => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const sampleNum = s => (hash(s) % 900000 + 10000).toLocaleString('en-US');
  const seriesPts = (seed, n) => Array.from({ length: n }, (_, i) => 0.45 + 0.25 * Math.sin(i / 1.7 + seed % 7) + 0.12 * ((hash(seed + ':' + i) % 100) / 100));
  const svgLine = (w, h, seed, opts) => {
    const n = 18, pts = seriesPts(seed, n).map((y, i) => [12 + i * (w - 24) / (n - 1), h - 16 - y * (h - 40)]);
    let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    if (opts.grid) for (let g = 1; g <= 4; g++) s += `<line x1="12" x2="${w - 12}" y1="${g * h / 5}" y2="${g * h / 5}" stroke="${opts.grid}" stroke-dasharray="2 3"/>`;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (opts.area) s += `<path d="${d} L${pts[n - 1][0]} ${h - 8} L${pts[0][0]} ${h - 8} Z" fill="${opts.area}"/>`;
    else s += `<path d="${d}" fill="none" stroke="${opts.line}" stroke-width="3"/>`;
    if (opts.trend) s += `<line x1="${pts[0][0]}" y1="${pts[0][1]}" x2="${pts[n - 1][0]}" y2="${pts[n - 1][1] - 10}" stroke="${opts.trend}" stroke-width="2" stroke-dasharray="7 5"/>`;
    if (opts.band) { const x = pts[n - 1][0]; s += `<path d="M${x} ${pts[n - 1][1]} L${w - 4} ${pts[n - 1][1] - 40} L${w - 4} ${pts[n - 1][1] + 30} Z" fill="${opts.band}" opacity=".5"/>`; }
    return s + '</svg>';
  };
  let html = '';
  for (const v of visuals) {
    const p = v.position, vis = v.visual, o = vis.objects || {}, vc = vis.visualContainerObjects || {};
    const bgP = P(vc.background), bdP = P(vc.border), tP = P(vc.title);
    const bg = val(bgP.show) === 'true' ? L(bgP.color) : null, bd = val(bdP.show) === 'true' ? L(bdP.color) : null;
    let style = `left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px;z-index:${p.z};`;
    if (bg) style += `background:${bg};`; if (bd) style += `border:1px solid ${bd};`; if (bdP.radius) style += `border-radius:${val(bdP.radius)}px;`;
    let inner = val(tP.show) === 'true' ? `<div class="t" style="color:${L(tP.fontColor) || C.ink};font-size:${val(tP.fontSize) || 12}px">${esc(val(tP.text))}</div>` : '';
    const proj = role => ((vis.query && vis.query.queryState && vis.query.queryState[role] && vis.query.queryState[role].projections) || []);
    const w = p.width, h = p.height - (inner ? 30 : 8);
    switch (vis.visualType) {
      case 'shape': style += `background:${L(P(o.fill).fillColor)};`; break;
      case 'actionButton': {
        const label = val(P(o.text, 1).text), fill = L(P(o.fill, 1).fillColor);
        inner = `<div class="btn" style="background:${label ? fill : 'transparent'};color:${L(P(o.text, 1).fontColor) || L(P(o.icon, 1).lineColor)}">${label ? esc(label) : '&#8592;'}</div>`; break;
      }
      case 'textbox':
        inner = (P(o.general).paragraphs || []).map(par => `<div style="text-align:${par.horizontalTextAlignment || 'left'}">` + par.textRuns.map(r => `<span style="color:${r.textStyle.color};font-size:${r.textStyle.fontSize};font-weight:${/Bold|Semibold/.test(r.textStyle.fontFamily) ? 600 : 400}">${esc(r.value)}</span>`).join('') + '</div>').join(''); break;
      case 'cardVisual': {
        const vp = P(o.value), lp = P(o.label), size = +val(vp.fontSize) || 40, m = (proj('Data')[0] || {}).queryRef || '';
        const colr = L(vp.fontColor) || (vp.fontColor ? C.teal : C.ink);
        const txt = size <= 14 ? 'Previous month ' + sampleNum(m + 'p') + ' · +4.2%' : sampleNum(m);
        inner = `<div class="card"><div style="color:${colr};font-size:${size}px;font-weight:${size >= 20 ? 600 : 400}">${txt}</div>` +
          (val(lp.show) === 'true' ? `<div style="color:${L(lp.fontColor)};font-size:${val(lp.fontSize)}px">${esc(val(lp.text))}</div>` : '') + '</div>'; break;
      }
      case 'lineChart': inner += svgLine(w, h, 'trend', { grid: C.grid, line: L(P(o.dataPoint).defaultColor), trend: C.trendLine, band: C.band }); break;
      case 'areaChart': inner += svgLine(w, h - 40, (proj('Y')[0] || {}).queryRef || 'a', { area: L(P(o.dataPoint).defaultColor) }); break;
      case 'clusteredBarChart': {
        const n = 6, bh = Math.min(30, (h - 12) / n - 8);
        inner += '<div class="bars">' + Array.from({ length: n }, (_, i) => { const f = 1 - i * 0.13;
          return `<div class="bar"><span style="color:${C.sub}">Category ${i + 1}</span><i style="width:${(f * 70).toFixed(0)}%;height:${bh}px;background:${L(P(o.dataPoint).defaultColor)}"></i><b style="color:${C.sub}">${sampleNum('b' + i)}</b></div>`; }).join('') + '</div>'; break;
      }
      case 'tableEx': {
        const cols = proj('Values').map(c => c.displayName || c.nativeQueryRef), hp = P(o.columnHeaders), rows = 8;
        const grad = (vis.objects.values || []).some(x => x.properties && x.properties.backColor), bars = !!o.columnFormatting;
        inner += `<table style="color:${L(P(o.values).fontColorPrimary)}"><tr>${cols.map(c => `<th style="background:${L(hp.backColor)};color:${L(hp.fontColor)}">${esc(c)}</th>`).join('')}</tr>` +
          Array.from({ length: rows }, (_, r) => '<tr>' + cols.map((c, ci) => {
            if (!ci) return `<td>Row ${r + 1}</td>`;
            const t = r / (rows - 1), cell = sampleNum(c + r);
            if (grad && ci === cols.length - 1) return `<td style="background:color-mix(in srgb, ${C.gradLow} ${Math.round((1 - t) * 100)}%, ${C.gradHigh})">${cell}</td>`;
            if (bars && ci === 1) return `<td><i class="db" style="width:${Math.round(90 - t * 60)}%;background:${C.bar}"></i>${cell}</td>`;
            return `<td>${cell}</td>`; }).join('') + '</tr>').join('') + '</table>'; break;
      }
      default: break;
    }
    html += `<div class="v" style="${style}">${inner}</div>`;
  }
  const doc = `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.title || 'Sales overview')} – layout preview</title>
<style>
  body { margin: 0; background: #1b1b1f; color: #ddd; font-family: "Segoe UI", system-ui, sans-serif; padding: 16px; }
  .note { font-size: 13px; margin: 0 0 10px; color: #aaa; }
  .frame { position: relative; width: 100%; max-width: 1600px; aspect-ratio: 16 / 9; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  .page { position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; transform-origin: 0 0; background: ${C.page}; }
  .v { position: absolute; box-sizing: border-box; overflow: hidden; }
  .t { text-align: center; padding: 6px 8px 0; height: 24px; }
  .btn { margin: 0; height: 100%; border-radius: 6px; display: grid; place-items: center; font-size: 13px; }
  .card { height: 100%; display: grid; place-content: center; text-align: center; gap: 2px; }
  .bars { padding: 8px 14px; display: grid; gap: 8px; }
  .bar { display: grid; grid-template-columns: 110px 1fr 70px; align-items: center; gap: 8px; font-size: 12px; }
  .bar i { display: block; border-radius: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; } td { position: relative; }
  .db { position: absolute; left: 4px; top: 6px; bottom: 6px; opacity: .55; z-index: 0; border-radius: 2px; }
</style></head><body>
<p class="note">Preview of the dashboard page with the colours from the config. The positions are the same as in Power BI; the numbers are placeholders.</p>
<div class="frame" id="f"><div class="page" id="p">${html}</div></div>
<script>function fit(){var f=document.getElementById('f');document.getElementById('p').style.transform='scale('+(f.clientWidth/1920)+')';}addEventListener('resize',fit);fit();</script>
</body></html>`;
  fs.writeFileSync(out, doc, 'utf8');
  console.log(`Wrote preview with ${visuals.length} visuals to ${out}`);
}
if (PREVIEW) { writePreview(PREVIEW); process.exit(0); }

// ---------- write ----------
const pageDir = path.join(pagesDir, PAGE_ID);
fs.rmSync(pageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(pageDir, 'visuals'), { recursive: true });
fs.writeFileSync(path.join(pageDir, 'page.json'), JSON.stringify({
  $schema: SCHEMA_PAGE, name: PAGE_ID, displayName: cfg.pageName || 'Dashboard', displayOption: 'FitToPage', height: 1080, width: 1920,
  objects: { background: [{ properties: { color: color(C.page), transparency: num(0) } }] },
}, null, 2));
for (const v of visuals) {
  const d = path.join(pageDir, 'visuals', v.name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'visual.json'), JSON.stringify(v, null, 2));
}
// ---------- report theme: the same colours on every page (only when colours were chosen) ----------
// Registered as a custom theme next to the base theme. Without "colors" (or with "theme": false)
// a theme written by an earlier run is removed again, so Standard leaves the report as it was.
(function theme() {
  // The validator wants the file name, the theme's "name" and the reference in report.json to be equal.
  const NAME = 'pbip-layout-theme.json', REF = NAME;
  const rjPath = path.join(reportDir, 'definition', 'report.json');
  if (!fs.existsSync(rjPath)) return;
  const rjRaw = fs.readFileSync(rjPath, 'utf8');
  const rj = JSON.parse(rjRaw.replace(/^\uFEFF/, ''));
  const rrDir = path.join(reportDir, 'StaticResources', 'RegisteredResources');
  const pkgs = rj.resourcePackages = rj.resourcePackages || [];
  let rr = pkgs.find(p => p.type === 'RegisteredResources');
  const want = !!cfg.colors && cfg.theme !== false;
  if (want) {
    const th = {
      name: REF,
      dataColors: [C.teal, C.dark, C.gradLow, C.sub, C.navBtn, C.bar, C.trendLine, C.border],
      background: C.panel, foreground: C.ink, tableAccent: C.teal,
      textClasses: { title: { color: C.ink }, header: { color: C.ink }, label: { color: C.sub }, callout: { color: C.ink } },
      visualStyles: {
        page: { '*': { background: [{ color: { solid: { color: C.page } }, transparency: 0 }] } },
        '*': { '*': {
          background: [{ show: true, color: { solid: { color: C.panel } }, transparency: 0 }],
          border: [{ color: { solid: { color: C.border } } }],
          title: [{ fontColor: { solid: { color: C.ink } } }],
        } },
      },
    };
    fs.mkdirSync(rrDir, { recursive: true });
    fs.writeFileSync(path.join(rrDir, NAME), JSON.stringify(th, null, 2));
    if (!rr) { rr = { name: 'RegisteredResources', type: 'RegisteredResources', items: [] }; pkgs.push(rr); }
    rr.items = (rr.items || []).filter(i => i.name !== REF && i.type !== 'CustomTheme').concat([{ name: REF, path: NAME, type: 'CustomTheme' }]);
    const base = (rj.themeCollection || {}).baseTheme || {};
    rj.themeCollection = { ...(rj.themeCollection || {}), customTheme: { name: REF, reportVersionAtImport: base.reportVersionAtImport, type: 'RegisteredResources' } };
  } else if (rj.themeCollection && rj.themeCollection.customTheme && rj.themeCollection.customTheme.name === REF) {
    delete rj.themeCollection.customTheme;
    if (rr) { rr.items = (rr.items || []).filter(i => i.name !== REF); if (!rr.items.length) pkgs.splice(pkgs.indexOf(rr), 1); }
    fs.rmSync(path.join(rrDir, NAME), { force: true });
    try { if (!fs.readdirSync(rrDir).length) fs.rmdirSync(rrDir); } catch (_) {}
  } else return;
  fs.writeFileSync(rjPath, JSON.stringify(rj, null, 2) + (/\n$/.test(rjRaw) ? '\n' : ''));
  console.log(want ? `Theme ${NAME} registered (all pages)` : `Theme ${NAME} removed`);
})();

pagesJson.pageOrder = [PAGE_ID, ...pagesJson.pageOrder.filter(p => p !== PAGE_ID)];
pagesJson.activePageName = PAGE_ID;
fs.writeFileSync(pagesJsonPath, JSON.stringify(pagesJson, null, 2));
console.log(`Wrote ${visuals.length} visuals to ${pageDir}`);
