#!/usr/bin/env node
// Checks scripts/gen-report.js on templates/business (Home + Marketing, Sales, Finance modules):
// - a colour choice changes colour values only; the status colours (good / bad / neutral) never change
// - modules: a module that is not chosen needs no mapping, its cards / tiles / buttons go, the rest re-flow,
//   the Home subtitle names the chosen modules
// - a drillthrough page without its overview page is refused; Home alone is refused
// - navigation targets are the new page ids, button texts stay ("Home")
//   node tests/business.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const GEN = path.join(SKILL, 'scripts', 'gen-report.js');
const T = JSON.parse(fs.readFileSync(path.join(SKILL, 'templates', 'business', 'template.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pbip-business-'));
let pass = 0; let fail = 0;
const check = (name, ok, info) => { if (ok) pass++; else { fail++; console.log(`FAIL ${name}${info ? `\n  ${String(info).slice(0, 400)}` : ''}`); } };

const identity = Object.fromEntries(Object.keys(T.fields).map((k) => [k, k]));
function build(name, cfg) {
  const rep = path.join(TMP, name, 'Test.Report');
  fs.mkdirSync(path.join(rep, 'definition', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(rep, 'definition', 'pages', 'pages.json'), JSON.stringify({ pageOrder: [] }));
  fs.writeFileSync(path.join(rep, 'definition', 'report.json'), JSON.stringify({ themeCollection: { baseTheme: { name: 'CY24SU10', type: 'SharedResources' } } }));
  const cf = path.join(TMP, `${name}.json`);
  fs.writeFileSync(cf, JSON.stringify({ template: 'business', fields: identity, ...cfg }));
  const r = spawnSync('node', [GEN, rep, cf], { encoding: 'utf8' });
  let j = {}; try { j = JSON.parse(r.stdout); } catch { j = { ok: false, raw: r.stdout + r.stderr }; }
  return { r, j, rep };
}
const readAll = (rep) => {
  const out = {}; const d = path.join(rep, 'definition', 'pages');
  for (const p of fs.readdirSync(d).filter((x) => !x.endsWith('.json'))) {
    out[`${p}/page.json`] = fs.readFileSync(path.join(d, p, 'page.json'), 'utf8');
    for (const v of fs.readdirSync(path.join(d, p, 'visuals'))) out[`${p}/${v}`] = fs.readFileSync(path.join(d, p, 'visuals', v, 'visual.json'), 'utf8');
  }
  return out;
};
const ALL = T.pages.map((p) => p.key);

// ---------- colours ----------
const std = build('std', { pages: ALL });
const brand = build('brand', { pages: ALL, colors: { primary: '#0B3D5C', secondary: '#F2A900', sidebar: '#222222', canvas: '#FAFAFA' } });
check('Standard and Brand build every page', std.j.ok && brand.j.ok && std.j.pages.length === 7 && brand.j.pages.length === 7, JSON.stringify(std.j).slice(0, 300));
const a = readAll(std.rep); const b = readAll(brand.rep);
const noHex = (s) => s.replace(/#[0-9A-Fa-f]{6}/g, '#');
check('a colour choice changes colour values only', Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => noHex(a[k]) === noHex(b[k])));
check('the chosen colours reach the pages', Object.values(b).some((s) => s.includes('#0B3D5C')) && !Object.values(b).some((s) => /#1B2A4A/i.test(s)));
const theme = JSON.parse(fs.readFileSync(path.join(brand.rep, 'StaticResources', 'RegisteredResources', 'pbip-layout-theme.json'), 'utf8'));
check('the theme keeps the template\'s styles and the fixed status colours', theme.good === '#197A4C' && theme.bad === '#C0392B' && theme.dataColors[0] === '#0B3D5C' && theme.textClasses && theme.visualStyles);
check('no colour token is left', !Object.values(b).some((s) => /\{\{\w+\}\}/.test(s)) && !/\{\{\w+\}\}/.test(JSON.stringify(theme)));
const ids = new Set(std.j.pages.map((p) => p.id));
const navs = Object.values(a).flatMap((s) => [...s.matchAll(/"navigationSection"[\s\S]*?"Value": "'([^']+)'/g)].map((m) => m[1]));
check('navigation goes to the new page ids', navs.length > 20 && navs.every((n) => ids.has(n)), navs.filter((n) => !ids.has(n)).slice(0, 5).join(', '));
check('button texts stay ("Home")', Object.values(a).some((s) => /"Value": "'Home'"/.test(s)));

// ---------- modules ----------
const salesFields = Object.fromEntries(Object.entries(identity).filter(([k]) => !/^(_Marketing|_Finance|_Home|Fact_Marketing|Fact_Finance|Dim_Account|Dim_Campaign|Dim_Channel|Dim_FunnelStage)\[/.test(k)));
const so = build('sales', { pages: ['home', 'sales', 'opportunity'], fields: salesFields });
check('Sales only: no mapping needed for the other modules', so.j.ok && so.j.modules.join() === 'sales' && so.j.leftOutByModule > 0, JSON.stringify(so.j).slice(0, 400));
const home = so.j.ok && readAll(so.rep);
const homeId = so.j.ok && so.j.pages[0].id;
const hv = home ? Object.entries(home).filter(([k]) => k.startsWith(`${homeId}/`) && !k.endsWith('page.json')).map(([, s]) => JSON.parse(s)) : [];
const card = hv.find((v) => v.name === '688149cb54280b768f4d');
check('Sales only: the closed-won card spans the KPI row', card && card.position.x === 176 && card.position.width === 1088);
check('Sales only: Finance and Marketing cards and tiles are gone', hv.every((v) => !['4aa95a5e819e7e49a062', 'f747b33d2a2a19bce519', '9d3aa4574dda9eacc469', '72b715e29d23d947051e', 'e4ccd183bfafba8d41ba'].includes(v.name)));
const tile = hv.find((v) => v.name === 'a51c3afb5bcddc0e2a5f');
check('Sales only: the sales tile takes the place of the revenue line', tile && tile.position.y === 200 && tile.position.height === 452);
check('Sales only: the Home subtitle names the chosen module', home && Object.values(home).some((s) => s.includes('Headline KPIs across sales')));
const rail = hv.filter((v) => v.visual && v.visual.visualType === 'actionButton' && v.position.x === 8).map((v) => v.position.y).sort((x, y) => x - y);
check('Sales only: the rail closes up (Home, Sales)', rail.join() === '60,106', rail.join());

// ---------- rules ----------
const dt = build('dt', { pages: ['home', 'campaign'] });
check('a drillthrough page without its overview is refused', !dt.j.ok && /campaign.*marketing/.test(JSON.stringify(dt.j)));
const ho = build('ho', { pages: ['home'] });
check('Home alone is refused', !ho.j.ok && /module page/.test(JSON.stringify(ho.j)));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
