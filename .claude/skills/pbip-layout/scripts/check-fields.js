#!/usr/bin/env node
// Checks that every field a report uses exists in its semantic model (TMDL): tables, columns and measures
// referenced by pages, visuals and bookmarks. Run it after gen-report.js.
//
//   node check-fields.js "<Name.Report>" "<Name.SemanticModel>"
//
// Prints JSON { ok, checked, missing: [{ field, kind, files }] }; exit 1 when a field is missing.
'use strict';
const fs = require('fs');
const path = require('path');
const [rep, sm] = process.argv.slice(2);
if (!rep || !sm) { console.error('Usage: node check-fields.js <Name.Report> <Name.SemanticModel>'); process.exit(2); }

// ---------- the model ----------
const model = {}; // table → { columns:Set, measures:Set }
const unq = (s) => { s = s.trim(); return s.startsWith("'") ? s.slice(1, s.indexOf("'", 1) > 0 ? s.lastIndexOf("'") : undefined).replace(/''/g, "'") : s.split(/\s|=/)[0]; };
const tdir = path.join(sm, 'definition', 'tables');
for (const f of fs.readdirSync(tdir).filter((x) => x.endsWith('.tmdl'))) {
  let table = null;
  for (const line of fs.readFileSync(path.join(tdir, f), 'utf8').split(/\r?\n/)) {
    let m = line.match(/^table\s+(.+)$/);
    if (m) { table = unq(m[1]); model[table] = { columns: new Set(), measures: new Set() }; continue; }
    m = line.match(/^\t(column|measure)\s+('(?:[^']|'')+'|[^\s=]+)/);
    if (m && table) model[table][m[1] === 'column' ? 'columns' : 'measures'].add(unq(m[2]));
  }
}
const lc = (s) => String(s).toLowerCase(); // Power BI names are case-insensitive
const has = (t, kind, n) => {
  const tk = Object.keys(model).find((x) => lc(x) === lc(t));
  if (!tk) return false;
  const set = kind === 'Measure' ? model[tk].measures : model[tk].columns;
  return [...set].some((x) => lc(x) === lc(n)) || (kind === 'Column' && [...model[tk].measures].some((x) => lc(x) === lc(n)));
};

// ---------- the report ----------
const missing = new Map(); let checked = 0;
function walk(o, aliases, file) {
  if (Array.isArray(o)) { o.forEach((x) => walk(x, aliases, file)); return; }
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o.From)) { aliases = { ...aliases }; for (const f of o.From) if (f.Name && f.Entity) aliases[f.Name] = f.Entity; }
  for (const kind of ['Column', 'Measure']) {
    const x = o[kind];
    if (!x || !x.Expression || !x.Expression.SourceRef) continue;
    const sr = x.Expression.SourceRef; const t = sr.Entity || aliases[sr.Source];
    if (!t) continue;
    checked++;
    if (!has(t, kind, x.Property)) { const k = `${t}[${x.Property}]`; if (!missing.has(k)) missing.set(k, { field: k, kind, files: new Set() }); missing.get(k).files.add(file); }
  }
  if (o.HierarchyLevel) { checked++; const h = o.HierarchyLevel.Expression.Hierarchy; const sr = h && h.Expression.SourceRef; const k = `${sr && (sr.Entity || aliases[sr.Source])}[${h && h.Hierarchy}.${o.HierarchyLevel.Level}]`; if (!missing.has(k)) missing.set(k, { field: k, kind: 'Hierarchy', files: new Set() }); missing.get(k).files.add(file); }
  for (const v of Object.values(o)) walk(v, aliases, file);
}
const def = path.join(rep, 'definition');
(function rd(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) rd(f); else if (f.endsWith('.json')) walk(JSON.parse(fs.readFileSync(f, 'utf8')), {}, path.relative(def, f)); } })(def);
const out = [...missing.values()].map((m) => ({ ...m, files: [...m.files].slice(0, 5) }));
console.log(JSON.stringify({ ok: !out.length, checked, missing: out }, null, 1));
process.exit(out.length ? 1 : 0);
