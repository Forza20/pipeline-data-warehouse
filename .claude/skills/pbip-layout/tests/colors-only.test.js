#!/usr/bin/env node
// Checks scripts/gen-report.js on the template in templates/adventureworks:
// - a colour choice changes colours only: Standard (no `colors`), hex codes (Dark, Brand, every key) and
//   the palette scripts/palette.ps1 measures in a screenshot build the same pages – visuals, positions,
//   sizes, fields, fonts, number formats, texts, bookmarks – once every #RRGGBB value is masked
// - Standard is the template: its colours are exactly the template's colour keys
// - display units are None on every visual, so numbers keep the measure's own format
// - completeMonth filters the month KPI cards to complete months; left out = a warning
// - every chosen colour reaches the pages, the icons are recoloured, the theme holds colours only
// - pages: only the chosen ones are built; navigation to a page that was left out goes
// - fields: a missing mapping stops the build; null leaves the field (or its visual) out
// - an unknown colour key or a bad hex code stops the build
//
//   node tests/colors-only.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SKILL = path.resolve(__dirname, '..');
const GEN = path.join(SKILL, 'scripts', 'gen-report.js');
const TPL = JSON.parse(fs.readFileSync(path.join(SKILL, 'templates', 'adventureworks', 'template.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pbip-layout-colors-'));
let failed = 0; let passed = 0;
const check = (name, ok, info) => { if (ok) passed++; else { failed++; console.log(`  FAIL ${name}${info ? ' – ' + String(info).slice(0, 700) : ''}`); } };

// every template field mapped to itself (hierarchy levels → plain date columns)
const identity = Object.fromEntries(Object.keys(TPL.fields).map((k) => { const m = /^(.+)\[Date Hierarchy\.(.+)\]$/.exec(k); return [k, m ? `${m[1]}[${m[2]}]` : k]; }));
const ALL = TPL.pages.map((p) => p.key);

function makeReport(dir) {
  const def = path.join(dir, 'definition');
  fs.mkdirSync(path.join(def, 'pages', 'own0000000000000001'), { recursive: true });
  fs.writeFileSync(path.join(def, 'pages', 'pages.json'), JSON.stringify({ pageOrder: ['own0000000000000001'], activePageName: 'own0000000000000001' }));
  fs.writeFileSync(path.join(def, 'pages', 'own0000000000000001', 'page.json'), JSON.stringify({ name: 'own0000000000000001', displayName: 'My page', width: 1280, height: 720 }));
  fs.writeFileSync(path.join(def, 'report.json'), JSON.stringify({ themeCollection: { baseTheme: { name: 'CY24SU10', reportVersionAtImport: { visual: '1.8.79', report: '2.0.79', page: '1.3.79' }, type: 'SharedResources' } } }));
}
function build(name, extra) {
  const dir = path.join(TMP, name, 'Test.Report');
  makeReport(dir);
  const cfg = { template: 'adventureworks', pages: ALL, fields: identity, title: 'Sales overview', ...extra };
  const cfgFile = path.join(TMP, name, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const r = spawnSync('node', [GEN, dir, cfgFile], { encoding: 'utf8' });
  let out = {};
  try { out = JSON.parse(r.stdout); } catch { /* reported by the checks */ }
  return { dir, r, out };
}
const mask = (s) => s.replace(/#[0-9A-Fa-f]{6}\b/g, '#COLOUR');
function files(dir, sub) {
  const root = path.join(dir, sub);
  const out = {};
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(root, f)] = fs.readFileSync(f, /\.png$/.test(f) ? null : 'utf8'); } };
  walk(root);
  return out;
}
const textFiles = (dir) => Object.fromEntries(Object.entries({ ...files(dir, 'definition') }).filter(([k]) => !k.endsWith('report.json')));
const coloursIn = (fs_) => new Set(Object.values(fs_).filter((v) => typeof v === 'string').flatMap((s) => s.match(/#[0-9A-Fa-f]{6}\b/g) || []).map((x) => x.toUpperCase()));

// ---------- Standard ----------
const std = build('standard', {});
check('Standard builds', std.r.status === 0 && std.out.ok, std.r.stdout.slice(0, 400) + std.r.stderr);
const stdText = textFiles(std.dir);
const pageDirs = fs.readdirSync(path.join(std.dir, 'definition', 'pages')).filter((d) => d !== 'pages.json');
check('Standard: all 8 template pages and the own page', pageDirs.length === 9 && fs.existsSync(path.join(std.dir, 'definition', 'pages', 'own0000000000000001', 'page.json')), pageDirs.join(','));
check('Standard: no colour token left', !Object.values(stdText).some((s) => /\{\{[A-Za-z]+\}\}/.test(s)));
const stdColours = coloursIn(stdText);
const tplColours = new Set(Object.values(TPL.colors).map((c) => c.toUpperCase()));
check('Standard: the pages use exactly the template colours', [...stdColours].every((c) => tplColours.has(c)), [...stdColours].filter((c) => !tplColours.has(c)).join(','));
const pj = JSON.parse(fs.readFileSync(path.join(std.dir, 'definition', 'pages', 'pages.json'), 'utf8'));
check('Standard: template pages first, the own page kept last', pj.pageOrder.length === 9 && pj.pageOrder[8] === 'own0000000000000001');
const rj = JSON.parse(fs.readFileSync(path.join(std.dir, 'definition', 'report.json'), 'utf8'));
const units = Object.values(stdText).flatMap((t) => [...t.matchAll(/"\w*[dD]isplayUnits": \{\s*"expr": \{\s*"Literal": \{\s*"Value": "([^"]+)"/g)].map((m) => m[1]));
check('Standard: display units are None (1D) everywhere – never "tusind", K or mio.', units.length > 20 && units.every((u) => u === '1D'), units.filter((u) => u !== '1D').join(','));
check('Standard without completeMonth: a warning, no filter', (std.out.warnings || []).some((w) => /completeMonth/.test(w)) && !Object.values(stdText).some((s) => /FilterCompleteMonth/.test(s)));
const cm = build('completemonth', { completeMonth: 'Calendar Lookup[Is Complete Month]' });
const kpis = Object.entries(textFiles(cm.dir)).filter(([k]) => k.endsWith("visual.json")).map(([, s]) => s).filter((s) => /"visualType": "kpi"/.test(s));
check('completeMonth: every month KPI card is filtered to complete months', cm.r.status === 0 && kpis.length === 3 &&
  kpis.every((s) => /"name": "FilterCompleteMonth"/.test(s) && /"Property": "Is Complete Month"/.test(s)) && !(cm.out.warnings || []).some((w) => /completeMonth/.test(w)), `kpis=${kpis.length} filtered=${kpis.filter((s) => /FilterCompleteMonth/.test(s)).length} ${JSON.stringify(cm.out.warnings)}`);
const bad3 = build('badcomplete', { completeMonth: 'is_complete_month' });
check('completeMonth that is not Table[Column] stops the build', bad3.r.status === 2 && /completeMonth/.test(bad3.r.stdout));
check('Standard: base theme is the template\'s', rj.themeCollection.baseTheme.name === TPL.baseTheme);
check('Standard: no data of the source report left (names, products, selections)', !Object.values(stdText).some((s) => /Ruben Suarez|Water Bottle|'Bikes'|'Very High'|AdventureWorks_Logo/.test(s)));

// ---------- colour variants ----------
const variants = {
  dark: { dark: '#111116', muted: '#A8A8B3', teal: '#1FC8C0', onDark: '#F2F2F5', panel: '#2A2A33', soft: '#3A3A45', bar: '#4A4A57', axis: '#F2F2F5' },
  brand: { dark: '#0B3D5C', teal: '#F2A900', gold: '#1C5A80' },
  allKeys: { dark: '#16213E', muted: '#4E4E6A', teal: '#F2A900', onDark: '#F5F5F5', panel: '#FFFDF8', soft: '#ECE6DA', bar: '#D8CFC0', axis: '#1A1A2E', bad: '#C0392B', badDark: '#8E2B20', gold: '#2E86AB' },
};
if (process.platform === 'win32') {
  const png = path.join(TMP, 'brand.png');
  const ps = `Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 320,200; $g = [System.Drawing.Graphics]::FromImage($b);
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#F4F6F8'));
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0B3D5C'))), 0, 0, 320, 40);
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#E85D2A'))), 30, 120, 90, 30);
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#2A9D8F'))), 150, 120, 60, 30);
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1F2933'))), 30, 70, 200, 12);
$b.Save('${png.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`;
  const mk = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  const pal = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(SKILL, 'scripts', 'palette.ps1'), '-Path', png], { encoding: 'utf8' });
  let sug = null;
  try { sug = JSON.parse(pal.stdout).suggestion; } catch { /* reported below */ }
  check('palette.ps1 suggests every template colour key', mk.status === 0 && sug && Object.keys(TPL.colors).every((k) => /^#[0-9A-F]{6}$/i.test(sug[k] || '')), mk.stderr + pal.stdout.slice(0, 400) + pal.stderr);
  if (sug) variants.screenshot = sug;
}
for (const [name, colors] of Object.entries(variants)) {
  const v = build(name, { colors });
  check(`${name}: builds`, v.r.status === 0 && v.out.ok, v.r.stdout.slice(0, 300) + v.r.stderr);
  const t = textFiles(v.dir);
  const same = Object.keys(t).sort().join() === Object.keys(stdText).sort().join();
  const diff = Object.keys(stdText).filter((k) => mask(t[k] || '') !== mask(stdText[k]));
  check(`${name}: same pages, visuals, positions, fields, fonts, formats, texts and bookmarks as Standard – only colours differ`, same && !diff.length, `differ: ${diff.slice(0, 5).join(', ')}`);
  const used = coloursIn(t);
  const missing = Object.entries(colors).filter(([, hex]) => !used.has(String(hex).toUpperCase()));
  // a key the pages do not use directly (e.g. only in the theme) is fine when it is in the theme
  const th = fs.readFileSync(path.join(v.dir, 'StaticResources', 'RegisteredResources', 'pbip-layout-theme.json'), 'utf8');
  check(`${name}: every chosen colour is used (pages or theme)`, missing.every(([, hex]) => th.toUpperCase().includes(String(hex).toUpperCase())), JSON.stringify(missing));
  const thStd = fs.readFileSync(path.join(std.dir, 'StaticResources', 'RegisteredResources', 'pbip-layout-theme.json'), 'utf8');
  check(`${name}: the theme differs from Standard's in colour values only`, mask(th) === mask(thStd) && !/"show"|font|textClasses|visualStyles/i.test(th));
  // icons: same files, recoloured where their key changed
  const icS = files(std.dir, 'StaticResources/RegisteredResources'); const icV = files(v.dir, 'StaticResources/RegisteredResources');
  const pngs = Object.keys(icS).filter((k) => k.endsWith('.png'));
  const recol = pngs.filter((k) => !icS[k].equals(icV[k]));
  const shouldChange = pngs.filter((k) => colors[TPL.icons[k]] && colors[TPL.icons[k]].toUpperCase() !== TPL.colors[TPL.icons[k]].toUpperCase());
  check(`${name}: icons recoloured exactly where their colour changed`, pngs.length > 0 && recol.sort().join() === shouldChange.sort().join(), `changed ${recol.length}, expected ${shouldChange.length}`);
}

// ---------- pages and fields ----------
const few = build('fewpages', { pages: ['exec', 'customer'] });
const fewDirs = fs.readdirSync(path.join(few.dir, 'definition', 'pages')).filter((d) => d !== 'pages.json');
check('only the chosen pages are built (+ the own page)', few.r.status === 0 && fewDirs.length === 3, fewDirs.join(','));
const fewText = Object.values(textFiles(few.dir)).join('\n');
const otherIds = (few.out.pages || []).map((p) => p.id);
check('no reference to a template page id is left', !/'ReportSection[0-9a-f]*'/.test(fewText) && (few.out.pages || []).length === 2, otherIds.join(','));
const navTargets = [...fewText.matchAll(/"navigationSection":\s*\{\s*"expr":\s*\{\s*"Literal":\s*\{\s*"Value":\s*"'([^']+)'/g)].map((m) => m[1]);
check('every navigation button goes to a chosen page', navTargets.length > 0 && navTargets.every((id) => otherIds.includes(id)), navTargets.join(','));
const nf = { ...identity }; delete nf['Measure Table[Total Orders]'];
const miss = build('missingfield', { fields: nf });
check('a field without a mapping stops the build', miss.r.status === 2 && /Total Orders/.test(miss.r.stdout));
const nulls = { ...identity, 'Customer Lookup[MaritalStatus]': null, 'Territory Lookup[Country]': null };
const nl = build('nullfield', { fields: nulls, pages: ['exec', 'map', 'influencers'] });
const nlText = Object.values(textFiles(nl.dir)).join('\n');
check('null: the field is left out of a visual that has more fields, a visual it needs goes', nl.r.status === 0 && !/MaritalStatus|"Property": "Country"/.test(nlText) &&
  (nl.out.dropped || []).some((d) => d.type === 'map') && !(nl.out.dropped || []).some((d) => d.type === 'keyDriversVisual'), JSON.stringify(nl.out.dropped || nl.r.stdout).slice(0, 400));

// ---------- a reversed colour scale (decision: a fallback where high is good) ----------
const rev = build('reverse', { reverseScales: ['Measure Table[Return Rate]'] });
const revText = textFiles(rev.dir);
const revDiff = Object.keys(stdText).filter((k) => revText[k] !== stdText[k]);
check('reverseScales: only the scales driven by that field change, and only their colours', rev.r.status === 0 &&
  (rev.out.notes || []).some((n) => /colour scale reversed/.test(n)) && revDiff.length > 0 && revDiff.every((k) => mask(revText[k]) === mask(stdText[k])), revDiff.join(','));

// ---------- bad colours ----------
const bad1 = build('badkey', { colors: { primary: '#112233' } });
check('unknown colour key stops the build', bad1.r.status === 2 && /unknown colour key/.test(bad1.r.stdout), bad1.r.stdout.slice(0, 300));
const bad2 = build('badhex', { colors: { teal: 'teal' } });
check('a colour that is not #RRGGBB stops the build', bad2.r.status === 2 && /not a hex colour/.test(bad2.r.stdout), bad2.r.stdout.slice(0, 300));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
