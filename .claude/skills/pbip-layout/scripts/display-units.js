#!/usr/bin/env node
// Sets display units to "None" (1) on every visual, so numbers never show as
// "526,6tusind", "40K" or "$0.04mio." - they always use the measure's own
// format string (whole number or decimal).
//
// Used by gen-report.js on every visual it writes, and as a CLI on an existing
// report:  node display-units.js <Report folder or definition/pages folder>
'use strict';
const fs = require('fs');
const path = require('path');

const NONE = { expr: { Literal: { Value: '1D' } } };

// visualType -> [object, property][]  (the visual's own "Display units" settings)
const LABELS = [['labels', 'labelDisplayUnits']];
const AXIS = [['valueAxis', 'labelDisplayUnits'], ...LABELS];
const MAP = {
  card: LABELS,
  cardVisual: [['value', 'labelDisplayUnits', { id: 'default' }]],
  kpi: [['indicator', 'indicatorDisplayUnits']],
  gauge: [...LABELS, ['calloutValue', 'labelDisplayUnits'], ['target', 'labelDisplayUnits']],
  donutChart: LABELS,
  pieChart: LABELS,
  funnel: LABELS,
  treemap: LABELS,
  waterfallChart: AXIS,
  scatterChart: [['valueAxis', 'labelDisplayUnits'], ['categoryAxis', 'labelDisplayUnits']],
  lineClusteredColumnComboChart: [...AXIS, ['valueAxis', 'secLabelDisplayUnits']],
  lineStackedColumnComboChart: [...AXIS, ['valueAxis', 'secLabelDisplayUnits']],
};
for (const t of ['lineChart', 'areaChart', 'stackedAreaChart', 'clusteredBarChart', 'clusteredColumnChart',
  'barChart', 'columnChart', 'hundredPercentStackedBarChart', 'hundredPercentStackedColumnChart', 'ribbonChart']) MAP[t] = AXIS;

function fixVisual(json) {
  const v = json && json.visual;
  if (!v || !MAP[v.visualType]) return 0;
  v.objects = v.objects || {};
  let n = 0;
  for (const [obj, prop, selector] of MAP[v.visualType]) {
    const arr = (v.objects[obj] = v.objects[obj] || []);
    const sel = JSON.stringify(selector || null);
    let entry = arr.find((e) => JSON.stringify(e.selector || null) === sel);
    if (!entry) { entry = selector ? { properties: {}, selector } : { properties: {} }; arr.push(entry); }
    entry.properties = entry.properties || {};
    const cur = entry.properties[prop];
    if (!cur || JSON.stringify(cur) !== JSON.stringify(NONE)) { entry.properties[prop] = JSON.parse(JSON.stringify(NONE)); n++; }
  }
  return n;
}

module.exports = { fixVisual };

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: node display-units.js <Report folder | pages folder>'); process.exit(1); }
  let dir = path.resolve(arg);
  if (fs.existsSync(path.join(dir, 'definition', 'pages'))) dir = path.join(dir, 'definition', 'pages');
  let files = 0, props = 0;
  for (const page of fs.readdirSync(dir)) {
    const vdir = path.join(dir, page, 'visuals');
    if (!fs.existsSync(vdir)) continue;
    for (const id of fs.readdirSync(vdir)) {
      const f = path.join(vdir, id, 'visual.json');
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8');
      const json = JSON.parse(raw);
      const n = fixVisual(json);
      if (n) { fs.writeFileSync(f, JSON.stringify(json, null, 2) + (/\n$/.test(raw) ? '\n' : '')); files++; props += n; }
    }
  }
  console.log(`display units set to None: ${props} setting(s) in ${files} visual(s)`);
}
