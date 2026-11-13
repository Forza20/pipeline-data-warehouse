#!/usr/bin/env python3
"""Model size and performance check of a Power BI project (PBIP). Read-only.

    python model_health.py <pbip folder> [--profile <profile.json>] [--out <folder>]

Findings (warning = fix before the model grows, info = worth knowing):
  unused column            not used by a measure, relationship, RLS rule, sort-by, calculated column or the
                           report – remove it from the build spec (smaller model, faster refresh)
  near-unique text         a text column in a fact where almost every value is different (memory)    [profile]
  date with time           a date column that holds times – split it or keep only the date            [profile]
  text key                 a relationship on a text column – an integer key is smaller and faster
  both directions          a bidirectional relationship – ambiguous filters, slower queries
  many-to-many             a many-to-many relationship – check the grain before keeping it
  auto date/time           hidden date tables for every date column
  calculated column        in a fact – compute it in Power Query instead
  today in measure         TODAY()/NOW() in a measure – the number moves with the calendar, not the data
  division without DIVIDE  '/' in a measure – an error or infinity when the denominator is 0 or blank
  unknown reference        [Name] that is neither a measure nor a column in the model (a typo, a renamed
                           field, or a measure that only existed in a DAX query's DEFINE block)
  hardcoded result         a number in a measure equal to an expected value of a check or question –
                           the result is typed in, not computed                                   [choices]
Writes model-health.md and model-health.json (default: next to the pbip folder).
--choices <choices.json> gives the expected values (checks[], and questions.json in the same folder).
Reads the model with ../../pbip-governance/scripts/parse_pbip.py.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

PARSER = Path(__file__).resolve().parent.parent.parent / 'pbip-governance' / 'scripts' / 'parse_pbip.py'


def strip_dax(expr):
    """The expression without string contents and comments."""
    s = re.sub(r'"(?:[^"]|"")*"', '""', expr or '')
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    return re.sub(r'(//|--)[^\n]*', ' ', s)


def expected_values(choices_file):
    """Expected values of the given checks and the grounded-answer questions (only numbers >= 100 in size,
    so 1, 12 or 100 % in a formula are never taken for a typed-in result)."""
    if not choices_file or not Path(choices_file).exists():
        return []
    vals = [c.get('expected') for c in json.loads(Path(choices_file).read_text(encoding='utf-8-sig')).get('checks') or []]
    qf = Path(choices_file).parent / 'questions.json'
    if qf.exists():
        raw = json.loads(qf.read_text(encoding='utf-8-sig'))
        vals += [x.get('expected') for x in (raw if isinstance(raw, list) else raw.get('questions') or [])]
    return [float(v) for v in vals if isinstance(v, (int, float)) and abs(v) >= 100]


def dax_rules(model, choices_file, add):
    """Rules every measure should follow, whatever the dataset."""
    measures = {m['name'] for t in model['tables'] for m in t['measures']}
    tcols = {t['name']: {c['name'] for c in t['columns']} for t in model['tables']}
    all_cols = set().union(*tcols.values()) if tcols else set()
    expected = expected_values(choices_file)
    for t in model['tables']:
        for m in t['measures']:
            expr = m.get('expression') or ''
            s = strip_dax(expr)
            where = f"[{m['name']}]"
            if re.search(r'\b(?:UTC)?(?:TODAY|NOW)\s*\(', s, re.I):
                add('warning', 'today in measure', where, 'TODAY()/NOW() moves with the calendar – anchor on the latest date '
                    'in the data: CALCULATE ( MAX ( <fact>[<date>] ), REMOVEFILTERS () )')
            if '/' in s:
                add('warning', 'division without DIVIDE', where, "'/' fails or gives infinity when the denominator is 0 or blank "
                    '– use DIVIDE ( numerator, denominator )')
            # references: Table[Name] with a model table, and bare [Name]
            made = set(re.findall(r'"((?:[^"]|"")*)"', expr))   # columns made in the formula (ADDCOLUMNS "x", …)
            unknown, spans = set(), []
            for r in re.finditer(r"('(?:[^']|'')+'|(?<![\w\]])[^\W\d]\w*)\s*\[([^\]]+)\]", s):
                tn = r.group(1)
                tn = tn[1:-1].replace("''", "'") if tn.startswith("'") else tn
                if tn not in tcols:
                    continue   # a variable table, or a table the parser does not know
                spans.append((r.start(), r.end()))
                n = r.group(2).strip()
                if n not in tcols[tn] and n not in measures:
                    unknown.add(f"{tn}[{n}]")
            for r in re.finditer(r'\[([^\]]+)\]', s):
                if any(a <= r.start() < b for a, b in spans):
                    continue
                n = r.group(1).strip()
                if n not in measures and n not in all_cols and n not in made and not re.fullmatch(r'Value\d*', n):
                    unknown.add(f"[{n}]")
            if unknown:
                add('warning', 'unknown reference', where, f"{', '.join(sorted(unknown))} is neither a measure nor a column in the "
                    'model – a typo, a renamed field, or a definition that only existed in a DAX query')
            if expected:
                bare = re.sub(r"'(?:[^']|'')*'", "''", re.sub(r'\[[^\]]*\]', '[]', s))
                for lit in re.findall(r'(?<![\w.])(\d+(?:\.\d+)?)(?![\w.])', bare):
                    v = float(lit)
                    if abs(v) >= 100 and any(abs(v - e) < 0.005 for e in expected):
                        add('warning', 'hardcoded result', where, f'{lit} equals an expected value of a check – compute the '
                            'number in DAX; expected values are only for checking')
                        break


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pbip')
    ap.add_argument('--profile')
    ap.add_argument('--out')
    ap.add_argument('--choices')
    a = ap.parse_args()
    pbip = Path(a.pbip).resolve()
    out = Path(a.out) if a.out else pbip.parent
    if not PARSER.exists():
        sys.exit(f'needs the pbip-governance skill next to this one ({PARSER})')
    res = subprocess.run([sys.executable, '-X', 'utf8', str(PARSER), str(pbip)], capture_output=True)
    if res.returncode:
        sys.exit('parse_pbip.py failed:\n' + res.stderr.decode('utf-8', 'replace')[-800:])
    data = json.loads(res.stdout.decode('utf-8-sig'))
    model = data['model']
    tmdl = '\n'.join(p.read_text(encoding='utf-8-sig', errors='replace')
                     for p in pbip.glob('*.SemanticModel/definition/**/*.tmdl'))
    profile = json.loads(Path(a.profile).read_text(encoding='utf-8-sig')) if a.profile else None

    rels = model.get('relationships', [])
    facts = {r['from']['table'] for r in rels} - {r['to']['table'] for r in rels}
    used = set()
    for t in model['tables']:
        for m in t['measures']:
            used |= {(c['table'], c['column']) for c in m['dependencies'].get('columns', [])}
    for r in rels:
        used |= {(r['from']['table'], r['from']['column']), (r['to']['table'], r['to']['column'])}
    for p in (data.get('report') or {}).get('pages', []):
        for v in p.get('visuals', []):
            used |= {(f['table'], f['name']) for f in v.get('fieldRefs', []) if f.get('kind') != 'Measure'}
    report_text = ' '.join(f.read_text(encoding='utf-8-sig', errors='replace')
                           for f in pbip.glob('*.Report/definition/**/*.json'))
    rls_text = ' '.join(tp.get('filter', '') for r in model.get('roles', []) for tp in r.get('tablePermissions', []))
    calc_text = ' '.join(c.get('expression') or '' for t in model['tables'] for c in t['columns'] if c.get('isCalculated'))
    sort_by = set(re.findall(r"sortByColumn:\s*'?([^'\n]+?)'?\s*$", tmdl, re.M))

    findings = []

    def add(sev, kind, where, text):
        findings.append({'severity': sev, 'kind': kind, 'where': where, 'text': text})

    for t in model['tables']:
        if t.get('dataCategory') == 'Time' or t['name'].startswith('_') or not t['columns']:
            continue
        for c in t['columns']:
            key = (t['name'], c['name'])
            if key in used or c['name'] in sort_by:
                continue
            pat = re.escape(c['name'])
            if re.search(rf"\[{pat}\]", rls_text + ' ' + calc_text) or f'"Property":"{c["name"]}"' in report_text.replace(' ', ''):
                continue
            # visible dimension attributes are there for slicing; only facts and hidden columns are dead weight
            if t['name'] in facts:
                is_id = re.search(r'(?:^|[\s_]|\b)(id|nr|no|number|key)$', c['name'], re.I)
                add('info' if is_id else 'warning', 'unused column', f"{t['name']}[{c['name']}]",
                    'id in a fact – keep it only for drill-through or a detail table' if is_id else
                    'not used by a measure, relationship, RLS rule or the report – remove it from the build spec')
            elif c.get('isHidden'):
                add('info', 'unused column', f"{t['name']}[{c['name']}]", 'hidden and not used anywhere – remove it')
        if t['name'] in facts:
            for c in t['columns']:
                if c.get('isCalculated'):
                    add('info', 'calculated column', f"{t['name']}[{c['name']}]", 'compute it in Power Query instead (smaller, compressed)')

    types = {(t['name'], c['name']): c['dataType'] for t in model['tables'] for c in t['columns']}
    for r in rels:
        f, to = r['from'], r['to']
        where = f"{f['table']}[{f['column']}] → {to['table']}[{to['column']}]"
        if types.get((f['table'], f['column'])) == 'string':
            add('info', 'text key', where, 'relationship on a text column – an integer surrogate key is smaller and faster')
        if r.get('crossFilter') == 'bothDirections':
            add('warning', 'both directions', where, 'bidirectional filter – ambiguous paths and slower queries; use single direction')
        if r.get('fromCardinality') == 'many' and r.get('toCardinality') == 'many':
            add('warning', 'many-to-many', where, 'many-to-many – check the grain; a bridge table is usually clearer')
    if re.search(r'__PBI_TimeIntelligenceEnabled\s*=\s*1', tmdl):
        add('warning', 'auto date/time', 'model', 'auto date/time is on – a hidden date table per date column; turn it off and use the Date table')

    dax_rules(model, a.choices, add)

    if profile:
        ptab = {}
        for pt in profile['tables']:
            for k in {pt.get('name'), pt.get('sheet'), pt.get('excelTable'), Path(str(pt.get('file', ''))).stem}:
                if k:
                    ptab[k] = pt
        for t in model['tables']:
            if t['name'] not in facts:
                continue
            for c in t['columns']:
                o = c.get('origin') or {}
                obj = re.sub(r'\s*\((?:Sheet|Table)\)$', '', o.get('object', '') or '')
                pt = ptab.get(obj) or ptab.get(o.get('query', ''))
                pc = next((x for x in (pt or {}).get('columns', []) if x['name'] == o.get('column')), None)
                if not pc:
                    continue
                rows = max(1, pc.get('nonEmpty') or 0)
                if c['dataType'] == 'string' and rows >= 1000 and (pc.get('distinct') or 0) / rows > 0.9 \
                        and (t['name'], c['name']) not in {(r['from']['table'], r['from']['column']) for r in rels}:
                    add('warning', 'near-unique text', f"{t['name']}[{c['name']}]",
                        f"{pc['distinct']} different values in {rows} rows – costs memory; drop it or move it to a dimension")
                if c['dataType'] == 'dateTime' and any('time' in k for k in (pc.get('patterns') or {})):
                    add('info', 'date with time', f"{t['name']}[{c['name']}]", 'holds times – keep the date only (and a separate time column if needed)')

    order = {'warning': 0, 'info': 1}
    findings.sort(key=lambda f: (order[f['severity']], f['kind'], f['where']))
    md = ['# Model health', '', f'Model: `{pbip.name}` · {sum(len(t["columns"]) for t in model["tables"])} columns · '
          f'{len(rels)} relationships · facts: {", ".join(sorted(facts)) or "–"}', '',
          f'**{sum(f["severity"] == "warning" for f in findings)} warnings, {sum(f["severity"] == "info" for f in findings)} info.**'
          + ('' if profile else ' (Without `--profile`: no checks of distinct values and times.)'), '',
          '| | Finding | Where | Why / what to do |', '|---|---|---|---|']
    md += [f"| {'⚠' if f['severity'] == 'warning' else 'ℹ'} | {f['kind']} | {f['where']} | {f['text']} |" for f in findings] or ['| ✅ | – | – | nothing found |']
    out.mkdir(parents=True, exist_ok=True)
    (out / 'model-health.md').write_text('\n'.join(md) + '\n', encoding='utf-8')
    (out / 'model-health.json').write_text(json.dumps(findings, ensure_ascii=False, indent=1), encoding='utf-8')
    summary = {}
    for f in findings:
        summary[f['kind']] = summary.get(f['kind'], 0) + 1
    print(json.dumps({'ok': True, 'warnings': sum(f['severity'] == 'warning' for f in findings),
                      'info': sum(f['severity'] == 'info' for f in findings), 'by_kind': summary,
                      'file': str(out / 'model-health.md')}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    import sys
    # A redirected stream on Windows defaults to cp1252, which cannot write characters such as →.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding='utf-8')
    main()
