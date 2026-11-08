#!/usr/bin/env node
// Builds the semantic model (TMDL) of a pipeline-power-bi run from the build spec in choices.json.
//
//   node build-model.js runs/<run-id> [--out <folder>] [--name <Name>]
//
// The spec (choices.json -> "build") is described in references/build-spec.md. In short:
//   staging[]       one query per source (CSV, sheet, Excel table), its cleaning steps by fix id – not loaded
//   tables[]        the model tables, built from staging with ops (merge, group, distinct, addKey …) and a
//                   final column list (name, type, format, hidden, description)
//   date            the calendar: which columns it spans, optional complete-month flag
//   relationships[] "Table[Column] -> Table[Column]", optional active: false
//   measures[]      name, expr (DAX), format, folder, description, term (glossary term → annotation Term)
//   roles[]         RLS: name, table, filter (DAX)
// Writes <out>/<Name>.SemanticModel (default out = runs/<run-id>/pbip) and prints a JSON summary.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const runDir = path.resolve(process.argv[2] || '');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const choices = JSON.parse(fs.readFileSync(path.join(runDir, 'choices.json'), 'utf8').replace(/^﻿/, ''));
const B = choices.build;
if (!B) { console.error('choices.json has no "build" spec – see references/build-spec.md'); process.exit(1); }
const NAME = arg('--name') || B.name || choices.name || 'Model';
const OUT = path.resolve(arg('--out') || path.join(runDir, 'pbip'));
const SKILL = path.resolve(__dirname, '..');
const errors = [];
const warnings = [];

// ---------- helpers ----------
const g = () => crypto.randomUUID();
const q = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : `'${String(n).replace(/'/g, "''")}'`);
const mid = (n) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^(let|in|each|type|if|then|else|and|or|not|true|false|null|try|otherwise|error|section|shared|meta|as|is)$/.test(n) ? n : `#"${String(n).replace(/"/g, '""')}"`);
const ms = (s) => `"${String(s).replace(/"/g, '""')}"`;
const L = (a) => '{' + a.map(ms).join(', ') + '}';
const TYPES = {
  text: ['type text', 'string', null, 'none'],
  int: ['Int64.Type', 'int64', '#,0', 'sum'],
  key: ['Int64.Type', 'int64', '0', 'none'],
  number: ['type number', 'double', '#,0.00', 'sum'],
  currency: ['Currency.Type', 'decimal', '\\$#,0.00', 'sum'],
  percent: ['type number', 'double', '0.0%', 'none'],
  date: ['type date', 'dateTime', 'yyyy-mm-dd', 'none'],
  datetime: ['type datetime', 'dateTime', 'yyyy-mm-dd hh:nn', 'none'],
  bool: ['type logical', 'boolean', null, 'none'],
};
const mType = (t) => (TYPES[t] || TYPES.text)[0];
const cutoff = (d) => { const [y, m, dd] = String(d || B.cutoffDate || new Date().toISOString().slice(0, 10)).split('-').map(Number); return `#date(${y}, ${m}, ${dd})`; };
function colRef(s) { const m = String(s).match(/^'?([^'\[]+)'?\[(.+)\]$/); if (!m) { errors.push(`bad column reference: ${s}`); return { table: s, column: '' }; } return { table: m[1], column: m[2] }; }

// A query being built: a list of [stepName, expression]; <prev> in an expression is the previous step
class Query {
  constructor() { this.steps = []; this.n = 10; }
  add(name, expr) {
    let nm = name; let i = 2;
    while (this.steps.some((s) => s[0] === nm)) nm = `${name} ${i++}`;
    this.steps.push([nm, expr.split('<prev>').join(this.prev())]);
    return this;
  }
  prev() { return this.steps.length ? (this.steps[this.steps.length - 1][0] === 'Source' ? 'Source' : mid(this.steps[this.steps.length - 1][0])) : 'Source'; }
  m(label, expr) { return this.add(`M${this.n++} ${label}`, expr); }
  text(indent) {
    const body = this.steps.map(([n, e]) => `${n === 'Source' ? 'Source' : mid(n)} = ${e.replace(/\n/g, '\n' + indent + '\t')}`).join(`,\n${indent}\t`);
    return `let\n${indent}\t${body}\n${indent}in\n${indent}\t${this.prev()}`;
  }
}

// ---------- functions used by fixes (single source: references/source-model.md) ----------
const smd = fs.readFileSync(path.join(SKILL, 'references', 'source-model.md'), 'utf8');
const fnBlocks = {};
for (const m of smd.matchAll(/```\n((?:\/\/\/[^\n]*\n)?expression (fn\w+) =[\s\S]*?)```/g)) fnBlocks[m[2]] = m[1];
const fnUsed = new Set();

// ---------- staging ----------
function sourceSteps(q, s) {
  const file = s.file;
  if (s.kind === 'csv') {
    q.add('Source', `Csv.Document(File.Contents(SourceFolder & ${ms(file)}), [Delimiter = ${ms(s.delimiter === 'tab' ? '#(tab)' : (s.delimiter || ','))}, Columns = ${s.columnsCount || s.columns.length}, Encoding = ${s.codePage || 65001}, QuoteStyle = QuoteStyle.Csv])`);
    if ((s.headerRow || 1) > 1) q.add(`F01 Skip ${s.headerRow - 1} title lines`, `Table.Skip(<prev>, ${s.headerRow - 1})`);
    q.add('F01 Promote headers', 'Table.PromoteHeaders(<prev>, [PromoteAllScalars = true])');
    q.add('F01 Keep data columns', `Table.SelectColumns(<prev>, ${L(s.columns)})`);
    return;
  }
  q.add('Source', `Excel.Workbook(File.Contents(SourceFolder & ${ms(file)}), null, true)`);
  const one = (item, kind, header, cols, suffix) => {
    const sfx = suffix ? ' ' + suffix : '';
    if (kind === 'excel table') {
      q.add(`Excel table ${item}`, `Source{[Item = ${ms(item)}, Kind = "Table"]}[Data]`);
      q.add(`F01 Keep data columns${sfx}`, `Table.SelectColumns(<prev>, ${L(cols)})`);
    } else {
      q.add(`Sheet ${item}`, `Source{[Item = ${ms(item)}, Kind = "Sheet"]}[Data]`);
      q.add(`F01 Skip to header row${sfx}`, `Table.Skip(<prev>, each not List.Contains(Record.FieldValues(_), ${ms(header)}))`);
      q.add(`F01 Promote headers${sfx}`, 'Table.PromoteHeaders(<prev>, [PromoteAllScalars = true])');
      q.add(`F01 Keep data columns${sfx}`, `Table.SelectColumns(<prev>, ${L(cols)})`);
    }
    return q.prev();
  };
  if (!s.append) { one(s.item, s.kind, s.header, s.columns); return; }
  const parts = [{ item: s.item, kind: s.kind, header: s.header, columns: s.columns }, ...s.append];
  const refs = parts.map((p) => one(p.item, p.kind || s.kind, p.header || s.header, p.columns, p.item));
  const tag = s.sourceColumn || 'SourceSheet';
  q.add(`F21 Append ${parts.map((p) => p.item).join(' and ')}`, `Table.Combine({${parts.map((p, i) => `Table.AddColumn(${refs[i]}, ${ms(tag)}, each ${ms(p.item)}, type text)`).join(', ')}})`);
}

function fixStep(q, f, s) {
  const c = f.column;
  const cols = f.columns || (c ? [c] : []);
  switch (f.fix) {
    case 'F03': return q.add('F03 Remove empty rows', 'Table.SelectRows(<prev>, each List.NonNullCount(List.ReplaceValue(Record.FieldValues(_), "", null, Replacer.ReplaceValue)) > 0)');
    case 'F04': {
      const words = f.words || ['total', 'grand total', 'subtotal', 'sum', 'i alt', 'samlet', 'totalt'];
      return q.add('F04 Remove total rows', `Table.SelectRows(<prev>, each let first = Text.Lower(Text.Trim(Text.From(List.First(List.Select(Record.FieldValues(_), each _ <> null and _ <> ""), "")))) in not List.AnyTrue(List.Transform(${L(words)}, each Text.StartsWith(first, _))))`);
    }
    case 'F05': return q.add(`F05 Trim ${cols.join(', ')}`, `Table.TransformColumns(<prev>, {${cols.map((x) => `{${ms(x)}, each if _ is text then Text.Trim(Text.Clean(_)) else _}`).join(', ')}})`);
    case 'F06': return q.add(`F06 No-value text to null in ${cols.join(', ')}`, `Table.TransformColumns(<prev>, {${cols.map((x) => `{${ms(x)}, each if _ is text and List.Contains(${L(f.tokens || ['N/A', 'n/a', '-', 'null', 'NULL'])}, Text.Trim(_)) then null else _}`).join(', ')}})`);
    case 'F07': {
      const rec = Object.entries(f.map || {}).map(([k, v]) => `${mid(k.toLowerCase())} = ${ms(v)}`).join(', ');
      const fn = f.map ? `Record.FieldOrDefault([${rec}], Text.Lower(Text.Trim(_)), _)` : f.case === 'upper' ? 'Text.Upper(_)' : 'Text.Proper(_)';
      return q.add(`F07 Unify ${c} spelling`, `Table.TransformColumns(<prev>, {{${ms(c)}, each if _ is text then ${fn} else _}})`);
    }
    case 'F08': fnUsed.add('fnParseDate'); return q.add(`F08 Parse ${c}`, `Table.TransformColumns(<prev>, {{${ms(c)}, each fnParseDate(_, ${f.dayFirst === false ? 'false' : 'true'}), type nullable date}})`);
    case 'F09': fnUsed.add('fnParseNumber'); return q.add(`F09 Parse ${c}`, `Table.TransformColumns(<prev>, {{${ms(c)}, each fnParseNumber(_), type nullable number}})`);
    case 'F10': fnUsed.add('fnParseBool'); return q.add(`F10 Parse ${c}`, `Table.TransformColumns(<prev>, {{${ms(c)}, each fnParseBool(_), type nullable logical}})`);
    case 'F11': fnUsed.add('fnNormaliseId'); return q.add(`F11 Normalise ${c}`, `Table.TransformColumns(<prev>, {{${ms(c)}, each fnNormaliseId(_, ${ms(f.prefix || '')}, ${ms(f.separator || '')}, ${f.digits || 4}), type text}})`);
    case 'F12': return q.add('F12 Remove exact duplicates', 'Table.Distinct(<prev>)');
    case 'F13':
      if (f.remove) return q.add(`F13 Remove ${f.label || 'repeated rows'}`, `Table.SelectRows(<prev>, each not List.Contains(${L(f.remove)}, [${c}]))`);
      return q.add(`F13 Keep first row per ${c}`, `Table.Distinct(Table.Buffer(<prev>), {${ms(c)}${f.ignoreCase === false ? '' : ', Comparer.OrdinalIgnoreCase'}})`);
    case 'F14': {
      const checks = f.checks || ['negative', 'spike'];
      const conds = [`if [${c}] = null then "missing"`];
      if (checks.includes('negative')) conds.push(`else if [${c}] < 0 then "negative"`);
      if (checks.includes('spike') && f.spike) conds.push(`else if [${c}] > ${f.spike} then "spike"`);
      if (checks.includes('zero')) conds.push(`else if [${c}] = 0 then "zero"`);
      const name = f.flagColumn || `${c} issue`;
      if (f.mode === 'remove') return q.add(`F14 Remove ${c} anomalies`, `Table.SelectRows(<prev>, each let v = [${c}] in v <> null${checks.includes('negative') ? ' and v >= 0' : ''}${checks.includes('spike') && f.spike ? ` and v <= ${f.spike}` : ''}${checks.includes('zero') ? ' and v <> 0' : ''})`);
      return q.add(`F14 Flag ${c}`, `Table.AddColumn(<prev>, ${ms(name)}, each ${conds.join(' ')} else "ok", type text)`);
    }
    case 'F15': {
      const cut = cutoff(f.cutoff);
      if (f.mode === 'remove') return q.add(`F15 Remove invalid ${c}`, `Table.SelectRows(<prev>, each [${c}] <> null and [${c}] <= ${cut} and Date.Year([${c}]) >= 1900)`);
      return q.add(`F15 Flag ${c}`, `Table.AddColumn(<prev>, ${ms(f.flagColumn || `${c} status`)}, each if [${c}] = null then "missing or invalid" else if [${c}] > ${cut} then "future" else if Date.Year([${c}]) < 1900 then "too old" else "ok", type text)`);
    }
    case 'F16': {
      q.add(`F16 Unpivot ${f.attribute || 'Period'}`, `Table.UnpivotOtherColumns(<prev>, ${L(f.keep)}, ${ms(f.attribute || 'Period')}, ${ms(f.value || 'Value')})`);
      const a = f.attribute || 'Period';
      // v = the M expression for the period text: `_` inside TransformColumns, `[<attribute>]` inside AddColumn
      const monthDate = (v, year) => `#date(${year}, List.PositionOf({"jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"}, Text.Lower(Text.Start(Text.Replace(Text.Replace(${v}, "maj", "may"), "okt", "oct"), 3))) + 1, 1)`;
      if (f.period === 'monthName' && f.year) {
        return q.add(`F16 ${a} as date`, `Table.AddColumn(<prev>, ${ms(a + ' start')}, each ${monthDate(`[${a}]`, `Number.From([${f.year}])`)}, type date)`);
      }
      const conv = f.period === 'monthName' ? monthDate('_', 'Date.Year(DateTime.LocalNow())') : '#date(Number.From(Text.Start(_, 4)), Number.From(Text.End(_, 2)), 1)';
      return q.add(`F16 ${a} as date`, `Table.TransformColumns(<prev>, {{${ms(a)}, each ${conv}, type date}})`);
    }
    case 'F17': {
      const t = f.types || {};
      const all = Object.keys(t);
      if (f.periodColumns) for (const p of f.periodColumns) q.add(`F17 ${p} as month date`, `Table.TransformColumns(<prev>, {{${ms(p)}, each if _ is text then #date(Number.From(Text.Start(_, 4)), Number.From(Text.End(_, 2)), 1) else _, type date}})`);
      if (!all.length) return q;
      q.add('F17 Empty text to null', `Table.TransformColumns(<prev>, List.Transform(${L(all)}, (c) => {c, each if _ = "" then null else _}))`);
      return q.add('F17 Set types', `Table.TransformColumnTypes(<prev>, {${all.map((x) => `{${ms(x)}, ${mType(t[x])}}`).join(', ')}}, ${ms(f.culture || B.sourceCulture || 'en-US')})`);
    }
    case 'F19': return q.add(`F19 Remove empty column${cols.length > 1 ? 's' : ''} ${cols.join(', ')}`, `Table.RemoveColumns(<prev>, ${L(cols)})`);
    case 'F23': return q.add(`F23 Split ${c}`, `Table.SplitColumn(<prev>, ${ms(c)}, Splitter.SplitTextByDelimiter(${ms(f.separator)}, QuoteStyle.None), ${L(f.names)})`);
    case 'F24': return q.add(`F24 Split ${c} into rows`, `Table.ExpandListColumn(Table.TransformColumns(<prev>, {{${ms(c)}, each if _ is text then List.Select(List.Transform(Text.SplitAny(_, ${ms(f.separators || ',;')}), Text.Trim), each _ <> "") else {_}}}), ${ms(c)})`);
    case 'F25': return q.add('F25 Remove technical columns', `Table.RemoveColumns(<prev>, ${L(cols)})`);
    case 'F27': {
      const vals = (f.values || []).map((v) => (typeof v === 'number' ? String(v) : ms(v)));
      if (f.mode === 'flag') return q.add('F27 Flag test rows', `Table.AddColumn(<prev>, "Is test row", each List.Contains({${vals.join(', ')}}, [${c}]), type logical)`);
      return q.add('F27 Remove test rows', `Table.SelectRows(<prev>, each not List.Contains({${vals.join(', ')}}, [${c}]))`);
    }
    case 'F28': {
      const rec = Object.entries(f.names || {}).map(([k, v]) => `${mid(String(k))} = ${ms(v)}`).join(', ');
      return q.add(`F28 ${f.as || c} names`, `Table.AddColumn(<prev>, ${ms(f.as || c + ' name')}, each Record.FieldOrDefault([${rec}], Text.From([${c}]), "Unknown " & Text.From([${c}])), type text)`);
    }
    case 'M': return q.add(f.label, f.expr);
    default:
      if (['F01', 'F02', 'F18', 'F20', 'F21', 'F22', 'F26', 'F29', 'M01', 'M02'].includes(f.fix)) return q; // handled elsewhere
      errors.push(`${s.name}: unknown step ${f.fix}`);
      return q;
  }
}

const staging = (B.staging || []).map((s) => {
  const q = new Query();
  sourceSteps(q, s);
  for (const f of s.steps || []) fixStep(q, f, s);
  return { name: s.name, from: s.from || s.item, q };
});
const stagingNames = new Set(staging.map((s) => s.name));

// ---------- model tables ----------
function other(w) {
  if (typeof w === 'string') return mid(w);
  if (w.group) {
    const aggs = w.group.aggs.map((a) => {
      const fn = { min: `List.Min([${a.column}])`, max: `List.Max([${a.column}])`, sum: `List.Sum([${a.column}])`, count: 'Table.RowCount(_)',
        maxIfAll: `if List.Contains([${a.column}], null) then null else List.Max([${a.column}])` }[a.fn];
      if (!fn) errors.push(`unknown aggregation ${a.fn}`);
      return `{${ms(a.name)}, each ${fn}, ${a.type === 'int' ? 'Int64.Type' : `type nullable ${(mType(a.type || 'number')).replace('type ', '')}`}}`;
    }).join(', ');
    return `Table.Group(${mid(w.group.from)}, ${L(w.group.by)}, {${aggs}})`;
  }
  if (w.from && w.filter) return `Table.SelectRows(${mid(w.from)}, each ${w.filter})`;
  if (w.from) return mid(w.from);
  errors.push('bad merge target'); return 'null';
}
function op(q, o, t) {
  switch (o.op) {
    case 'select': return q.m(o.label || 'Keep columns', `Table.SelectColumns(<prev>, ${L(o.columns)})`);
    case 'distinct': return q.m(o.label || 'Distinct rows', o.columns ? `Table.Distinct(Table.SelectColumns(<prev>, ${L(o.columns)}))` : 'Table.Distinct(<prev>)');
    case 'filter': return q.m(o.label || 'Filter rows', `Table.SelectRows(<prev>, each ${o.expr})`);
    case 'merge': {
      const name = 'j';
      return q.m(o.label || `Merge ${typeof o.with === 'string' ? o.with : 'lookup'}`,
        `Table.ExpandTableColumn(Table.NestedJoin(<prev>, ${L(o.on)}, ${other(o.with)}, ${L(o.withOn || o.on)}, "${name}", JoinKind.LeftOuter${o.ignoreCase ? ', Comparer.OrdinalIgnoreCase' : ''}), "${name}", ${L(o.columns)}${o.as ? ', ' + L(o.as) : ''})`);
    }
    case 'addKey': return q.m(o.label || `Add ${o.name}`, `Table.AddIndexColumn(Table.Sort(<prev>, {${o.sortBy.map((c) => `{${ms(c)}, Order.Ascending}`).join(', ')}}), ${ms(o.name)}, 1, 1, Int64.Type)`);
    case 'addColumn': return q.m(o.label || `Add ${o.name}`, `Table.AddColumn(<prev>, ${ms(o.name)}, each ${o.expr}, ${mType(o.type)})`);
    case 'transform': return q.m(o.label || `Transform ${o.column}`, `Table.TransformColumns(<prev>, {{${ms(o.column)}, each ${o.expr}, ${mType(o.type)}}})`);
    case 'inferMembers': {
      // F18: one row per key value used in other queries but missing here
      const used = o.fromColumns.map((r) => { const x = colRef(r); return `Table.Column(${mid(x.table)}, ${ms(x.column)})`; }).join(', ');
      q.add(`F18 Missing ${o.key} values`, `let\n\tKnown = List.Transform(Table.Column(<prev>, ${ms(o.key)}), each Text.Lower(Text.From(_))),\n\tUsed = List.Distinct(List.RemoveNulls(List.Combine({${used}})))\nin\n\tList.Distinct(List.Select(Used, each not List.Contains(Known, Text.Lower(Text.From(_)))), Comparer.OrdinalIgnoreCase)`);
      const missing = q.prev();
      const before = q.steps[q.steps.length - 2][0];
      const fields = [`${mid(o.key)} = _`, ...Object.entries(o.defaults || {}).map(([k, v]) => `${mid(k)} = ${v}`), `${mid(o.flag || 'IsInferred')} = true`].join(', ');
      return q.add(`F18 Add missing ${o.key} values`, `Table.Combine({Table.AddColumn(${before === 'Source' ? 'Source' : mid(before)}, ${ms(o.flag || 'IsInferred')}, each false, type logical), Table.FromRecords(List.Transform(${missing}, each [${fields}]))})`);
    }
    case 'm': return q.m(o.label, o.expr);
    default: errors.push(`${t.name}: unknown op ${o.op}`); return q;
  }
}
const tables = (B.tables || []).map((t) => {
  const q = new Query();
  q.add('Source', stagingNames.has(t.from) ? t.from : t.from);
  for (const o of t.ops || []) op(q, o, t);
  const cols = t.columns;
  const pairs = cols.map((c) => [c.from || c.name, c.name]);
  q.m('Select and name columns', `Table.RenameColumns(Table.SelectColumns(<prev>, ${L(pairs.map((p) => p[0]))}), {${pairs.filter(([a, b]) => a !== b).map(([a, b]) => `{${ms(a)}, ${ms(b)}}`).join(', ')}})`);
  q.add('M99 Set final types', `Table.TransformColumnTypes(<prev>, {${cols.map((c) => `{${ms(c.name)}, ${mType(c.type)}}`).join(', ')}})`);
  return { ...t, q };
});

// ---------- TMDL ----------
function tableTmdl(t) {
  let s = `${t.description ? `/// ${t.description}\n` : ''}table ${q(t.name)}\n${t.hidden ? '\tisHidden\n' : ''}\tlineageTag: ${g()}\n\n`;
  for (const c of t.columns) {
    const [, dt, fmt, sum] = TYPES[c.type] || TYPES.text;
    if (!TYPES[c.type]) warnings.push(`${t.name}[${c.name}]: unknown type ${c.type}, used text`);
    if (c.description) s += `\t/// ${c.description}\n`;
    s += `\tcolumn ${q(c.name)}\n\t\tdataType: ${dt}\n`;
    if (c.hidden) s += '\t\tisHidden\n';
    const f = c.format === undefined ? fmt : c.format;
    if (f) s += `\t\tformatString: ${f}\n`;
    s += `\t\tlineageTag: ${g()}\n\t\tsummarizeBy: ${c.summarize || sum}\n\t\tsourceColumn: ${c.name}\n\n\t\tannotation SummarizationSetBy = Automatic\n\n`;
    if (c.type === 'date') s += '\t\tannotation UnderlyingDateTimeDataType = Date\n\n';
  }
  s += `\tpartition ${q(t.name)} = m\n\t\tmode: import\n\t\tqueryGroup: ${t.kind === 'fact' ? '03_Facts' : t.kind === 'support' ? '04_Support' : '02_Dimensions'}\n\t\tsource =\n\t\t\t\t${t.q.text('\t\t\t\t')}\n\n\tannotation PBI_ResultType = Table\n`;
  return s;
}
function dateTmdl(d) {
  const name = d.name || 'Date';
  const refs = d.columns.map((r) => { const x = colRef(r); return `${mid(x.table)}[${x.column}]`; }).join(', ');
  const col = (n, dt, extra) => `\tcolumn ${q(n)}\n\t\tdataType: ${dt}\n${extra || ''}\t\tlineageTag: ${g()}\n\t\tsummarizeBy: none\n\t\tsourceColumn: ${n}\n\n\t\tannotation SummarizationSetBy = Automatic\n\n`;
  let s = `/// Calendar covering whole years from the first to the last date in the facts. Marked as date table.\ntable ${q(name)}\n\tlineageTag: ${g()}\n\tdataCategory: Time\n\n`;
  s += col('Date', 'dateTime', '\t\tisKey\n\t\tformatString: yyyy-mm-dd\n') + '\t\tannotation UnderlyingDateTimeDataType = Date\n\n';
  s += col('Year', 'int64', '\t\tformatString: 0\n') + col('Quarter', 'string') + col('Month no', 'int64', '\t\tisHidden\n\t\tformatString: 0\n');
  s += col('Month', 'string', "\t\tsortByColumn: 'Month no'\n") + col('Month start', 'dateTime', '\t\tformatString: mmm yyyy\n') + '\t\tannotation UnderlyingDateTimeDataType = Date\n\n';
  if (d.completeMonth) s += col('Is complete month', 'boolean');
  const steps = [
    `Dates = List.RemoveNulls(List.Combine({${refs}}))`, 'Start = #date(Date.Year(List.Min(Dates)), 1, 1)', 'End = #date(Date.Year(List.Max(Dates)), 12, 31)',
    'Days = List.Dates(Start, Duration.Days(End - Start) + 1, #duration(1, 0, 0, 0))', 'Calendar = Table.FromList(Days, Splitter.SplitByNothing(), type table [Date = date])',
    'Year = Table.AddColumn(Calendar, "Year", each Date.Year([Date]), Int64.Type)', 'Quarter = Table.AddColumn(Year, "Quarter", each "Q" & Text.From(Date.QuarterOfYear([Date])), type text)',
    'MonthNo = Table.AddColumn(Quarter, "Month no", each Date.Month([Date]), Int64.Type)', `MonthName = Table.AddColumn(MonthNo, "Month", each Date.ToText([Date], [Format = "MMM", Culture = ${ms(B.culture || 'en-US')}]), type text)`,
    'MonthStart = Table.AddColumn(MonthName, "Month start", each Date.StartOfMonth([Date]), type date)',
  ];
  let last = 'MonthStart';
  if (d.completeMonth) {
    const x = colRef(d.completeMonth);
    steps.push(`DataStart = List.Min(List.RemoveNulls(${mid(x.table)}[${x.column}]))`, `DataEnd = List.Max(List.RemoveNulls(${mid(x.table)}[${x.column}]))`,
      'Complete = Table.AddColumn(MonthStart, "Is complete month", each Date.StartOfMonth([Date]) >= DataStart and Date.EndOfMonth([Date]) <= DataEnd, type logical)');
    last = 'Complete';
  }
  s += `\tpartition ${q(name)} = m\n\t\tmode: import\n\t\tqueryGroup: 03_Facts\n\t\tsource =\n\t\t\t\tlet\n\t\t\t\t\t${steps.join(',\n\t\t\t\t\t')}\n\t\t\t\tin\n\t\t\t\t\t${last}\n\n\tannotation PBI_ResultType = Table\n`;
  return { name, text: s };
}
function measuresTmdl(list) {
  let s = `/// All measures. The column is a hidden placeholder required for a calculated table.\ntable _Measures\n\tlineageTag: ${g()}\n\n`;
  for (const m of list) {
    const dax = m.expr.includes('\n') ? '\n' + m.expr.split('\n').map((l) => '\t\t\t' + l).join('\n') : m.expr;
    s += `${m.description ? `\t/// ${m.description}\n` : ''}\tmeasure ${q(m.name)} = ${dax}\n${m.format ? `\t\tformatString: ${m.format}\n` : ''}${m.folder ? `\t\tdisplayFolder: ${m.folder}\n` : ''}\t\tlineageTag: ${g()}\n${m.term ? `\n\t\tannotation Term = ${m.term}\n` : ''}\n`;
  }
  return s + `\tcolumn Placeholder\n\t\tisHidden\n\t\tlineageTag: ${g()}\n\t\tsummarizeBy: none\n\t\tisNameInferred\n\t\tsourceColumn: [Placeholder]\n\n\t\tannotation SummarizationSetBy = Automatic\n\n\tpartition _Measures = calculated\n\t\tmode: import\n\t\tsource = ROW ( "Placeholder", BLANK () )\n`;
}
const tmdlCol = (r) => { const x = colRef(r); return `${q(x.table)}.${q(x.column)}`; };

// ---------- checks before writing ----------
const tableCols = new Map(tables.map((t) => [t.name, new Set(t.columns.map((c) => c.name))]));
const date = B.date ? dateTmdl(B.date) : null;
if (date) tableCols.set(date.name, new Set(['Date', 'Year', 'Quarter', 'Month no', 'Month', 'Month start', 'Is complete month']));
for (const r of B.relationships || []) {
  const [f, t] = r.from && r.to ? [r.from, r.to] : String(r).split('->').map((x) => x.trim());
  for (const side of [f, t]) { const x = colRef(side); if (!tableCols.has(x.table) || !tableCols.get(x.table).has(x.column)) errors.push(`relationship column not in model: ${side}`); }
}
for (const t of tables) { const n = new Set(); for (const c of t.columns) { if (n.has(c.name)) errors.push(`${t.name}: column ${c.name} twice`); n.add(c.name); } }
if (errors.length) { console.log(JSON.stringify({ ok: false, errors, warnings }, null, 1)); process.exit(2); }

// ---------- write ----------
// Written to definition.new first and swapped in at the end, so a failed write (full disk) never leaves
// a half-written or empty model behind.
const sm = path.join(OUT, `${NAME}.SemanticModel`);
const finalDef = path.join(sm, 'definition');
const def = path.join(sm, 'definition.new');
if (fs.existsSync(def)) fs.rmSync(def, { recursive: true, force: true });
fs.mkdirSync(path.join(def, 'tables'), { recursive: true });
fs.writeFileSync(path.join(sm, '.platform'), JSON.stringify({ $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json', metadata: { type: 'SemanticModel', displayName: NAME }, config: { version: '2.0', logicalId: g() } }, null, 2));
fs.writeFileSync(path.join(sm, 'definition.pbism'), JSON.stringify({ version: '4.2', settings: {} }, null, 2));
fs.writeFileSync(path.join(def, 'database.tmdl'), 'database\n\tcompatibilityLevel: 1600\n');
const allTables = [...tables.map((t) => t.name), ...(date ? [date.name] : []), ...(B.measures && B.measures.length ? ['_Measures'] : [])];
const roles = B.roles || [];
fs.writeFileSync(path.join(def, 'model.tmdl'), `model Model\n\tculture: ${B.culture || 'en-US'}\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n\tsourceQueryCulture: ${B.culture || 'en-US'}\n\tdataAccessOptions\n\t\tlegacyRedirects\n\t\treturnErrorValuesAsNull\n\n` +
  ['Parameters', 'Functions', '01_Stage', '02_Dimensions', '03_Facts', '04_Support'].map((n, i) => `queryGroup ${n}\n\n\tannotation PBI_QueryGroupOrder = ${i}\n`).join('\n') +
  `\nannotation __PBI_TimeIntelligenceEnabled = 0\n\n${allTables.map((n) => `ref table ${q(n)}`).join('\n')}\n${roles.length ? '\n' + roles.map((r) => `ref role ${q(r.name)}`).join('\n') + '\n' : ''}`);
let ex = `/// Folder that holds the source files. Ends with a backslash. Change it in Transform data > Manage parameters if the files move.\nexpression SourceFolder = ${ms(B.sourceFolder)} meta [IsParameterQuery = true, Type = "Text", IsParameterQueryRequired = true]\n\tlineageTag: ${g()}\n\tqueryGroup: Parameters\n\n\tannotation PBI_ResultType = Text\n`;
for (const fn of fnUsed) {
  if (!fnBlocks[fn]) { warnings.push(`function ${fn} not found in source-model.md`); continue; }
  ex += '\n' + fnBlocks[fn].replace(/lineageTag: [0-9a-f-]+/, `lineageTag: ${g()}`).trimEnd() + '\n';
}
for (const s of staging) ex += `\n/// Staging (not loaded): ${s.from}, with its cleaning steps.\nexpression ${q(s.name)} =\n\t\t${s.q.text('\t\t')}\n\tlineageTag: ${g()}\n\tqueryGroup: 01_Stage\n\n\tannotation PBI_ResultType = Table\n`;
fs.writeFileSync(path.join(def, 'expressions.tmdl'), ex);
for (const t of tables) fs.writeFileSync(path.join(def, 'tables', `${t.name}.tmdl`), tableTmdl(t));
if (date) fs.writeFileSync(path.join(def, 'tables', `${date.name}.tmdl`), date.text);
if (B.measures && B.measures.length) fs.writeFileSync(path.join(def, 'tables', '_Measures.tmdl'), measuresTmdl(B.measures));
const rels = (B.relationships || []).map((r) => {
  const [f, t] = r.from && r.to ? [r.from, r.to] : String(r).split('->').map((x) => x.trim());
  return `relationship ${g()}\n${r.active === false ? '\tisActive: false\n' : ''}\tfromColumn: ${tmdlCol(f)}\n\ttoColumn: ${tmdlCol(t)}\n`;
});
fs.writeFileSync(path.join(def, 'relationships.tmdl'), rels.join('\n'));
if (roles.length) {
  fs.mkdirSync(path.join(def, 'roles'), { recursive: true });
  for (const r of roles) fs.writeFileSync(path.join(def, 'roles', `${r.name}.tmdl`), `role ${q(r.name)}\n\tmodelPermission: read\n\n${(r.filters || [{ table: r.table, filter: r.filter }]).map((f) => `\ttablePermission ${q(f.table)} = ${f.filter}`).join('\n')}\n`);
}
const bak = path.join(sm, 'definition.bak');
if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });
if (fs.existsSync(finalDef)) fs.renameSync(finalDef, bak);
fs.renameSync(def, finalDef);
if (fs.existsSync(bak)) fs.rmSync(bak, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, semanticModel: sm, staging: staging.length, functions: [...fnUsed], tables: allTables.length, relationships: rels.length, measures: (B.measures || []).length, roles: roles.length, warnings }, null, 1));
