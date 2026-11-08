#!/usr/bin/env python3
"""Grounded-answer test: can the model answer real business questions with the right number, under the
asker's permissions, and can every answer be traced back to its definition and source column?

    python grounded_answers.py <pbip folder> <questions.json> [--out <folder>]

questions.json – a list, each item:
{
  "question": "Sales in region North in March 2025",   the business question, in the user's words
  "measure": "Total sales",                             a measure in the model
  "filters": {"Customer[Region]": "North", "Date[Year]": 2025, "Date[Month no]": 3},
  "expected": 1234.5,                                   computed from the SOURCE files, not from the model
  "expected_how": "SUM of LineTotal in order_line_items for orders of North customers in March 2025",
  "role": "Regional Access",                            optional: also answer as this RLS role …
  "role_user": "anna@example.com",                      … for this user (USERPRINCIPALNAME)
  "role_expected": 1234.5                               the number that user may see (0 or blank when none)
}

Writes (default: next to the pbip folder, i.e. the run folder):
  grounded-answers.dax  one EVALUATE: a row per question (and per role check) with Value, Expected, Difference
  grounded-answers.md   per question: the measure's DAX, the measures and columns it uses, the source sheet/
                        file and column of each, the role rule, and how to check the role in Power BI Desktop

The role rows simulate the role in DAX (the role's filter with USERPRINCIPALNAME () replaced by the user),
because the DAX query view does not apply roles. Confirm them once with Modeling → View as.
Reads the model with ../../pbip-governance/scripts/parse_pbip.py (read-only).
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARSER = HERE.parent.parent / 'pbip-governance' / 'scripts' / 'parse_pbip.py'


def load(pbip):
    if not PARSER.exists():
        sys.exit(f'needs the pbip-governance skill next to this one ({PARSER})')
    out = subprocess.run([sys.executable, '-X', 'utf8', str(PARSER), str(pbip)], capture_output=True)
    if out.returncode:
        sys.exit('parse_pbip.py failed:\n' + out.stderr.decode('utf-8', 'replace')[-800:])
    return json.loads(out.stdout.decode('utf-8-sig'))['model']


def q(name):
    return "'" + name.replace("'", "''") + "'"


def ref(colref):
    """'Customer[Region]' -> ("Customer", "Region", "'Customer'[Region]")."""
    m = re.match(r"^\s*'?(.+?)'?\s*\[(.+)\]\s*$", colref)
    if not m:
        sys.exit(f'filter column must look like Table[Column]: {colref}')
    t, c = m.group(1), m.group(2)
    return t, c, f'{q(t)}[{c}]'


def literal(v):
    if isinstance(v, bool):
        return 'TRUE ()' if v else 'FALSE ()'
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v)
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return f'DATE ( {int(s[:4])}, {int(s[5:7])}, {int(s[8:10])} )'
    return '"' + s.replace('"', '""') + '"'


def dax_str(s):
    return '"' + str(s).replace('"', '""') + '"'


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pbip')
    ap.add_argument('questions')
    ap.add_argument('--out')
    a = ap.parse_args()
    pbip = Path(a.pbip).resolve()
    out = Path(a.out) if a.out else pbip.parent
    questions = json.loads(Path(a.questions).read_text(encoding='utf-8-sig'))
    model = load(pbip)

    measures = {m['name']: {**m, 'home': t['name']} for t in model['tables'] for m in t['measures']}
    columns = {(t['name'], c['name']): c for t in model['tables'] for c in t['columns']}
    roles = {r['name']: r for r in model.get('roles', [])}

    errors = []
    for i, x in enumerate(questions, 1):
        if x.get('measure') not in measures:
            errors.append(f'question {i}: no measure "{x.get("measure")}"')
        for col in (x.get('filters') or {}):
            t, c, _ = ref(col)
            if (t, c) not in columns:
                errors.append(f'question {i}: no column {col}')
        if x.get('role') and x['role'] not in roles:
            errors.append(f'question {i}: no role "{x["role"]}"')
        if x.get('expected') is None:
            errors.append(f'question {i}: "expected" is missing (compute it from the source files)')
    if errors:
        print(json.dumps({'ok': False, 'errors': errors}, ensure_ascii=False, indent=1))
        sys.exit(2)

    def trace(name, seen=()):
        """Measures and source columns behind a measure (depth first)."""
        if name in seen:
            return [], []
        m = measures[name]
        ms, cs = [name], []
        for c in m['dependencies'].get('columns', []):
            cs.append((c['table'], c['column']))
        for d in m['dependencies'].get('measures', []):
            d = d if isinstance(d, str) else d.get('name', '')
            if d in measures:
                sub_m, sub_c = trace(d, seen + (name,))
                ms += [x for x in sub_m if x not in ms]
                cs += [x for x in sub_c if x not in cs]
        return ms, list(dict.fromkeys(cs))

    def source_of(t, c):
        col = columns.get((t, c)) or {}
        if col.get('isCalculated'):
            return 'calculated column (DAX) in Power BI'
        o = col.get('origin') or {}
        if o.get('kind') == 'source':
            f = re.split(r'[\\/]', str((o.get('source') or {}).get('details', '')))[-1]
            obj = re.sub(r'\s*\((?:Sheet|Table)\)$', '', o.get('object', ''))
            return ' › '.join(x for x in (f, obj, o.get('column', '')) if x)
        if o.get('kind') == 'computed':
            return f'computed in Power Query ({o.get("query", "")})'
        return 'not traced'

    rows, md = [], ['# Grounded-answer test', '',
                    'Each question is answered by the model, compared with a number computed from the source files, '
                    'and traced back to the definition and source columns that produce it.', '',
                    'Run `grounded-answers.dax` in Power BI Desktop → DAX query view after a refresh. Every '
                    'Difference should be 0. Then check each role row once with Modeling → **View as**.', '']
    for i, x in enumerate(questions, 1):
        m = measures[x['measure']]
        filt = [f'{ref(k)[2]} = {literal(v)}' for k, v in (x.get('filters') or {}).items()]
        value = f'CALCULATE ( [{x["measure"]}]' + ''.join(f', {f}' for f in filt) + ' )' if filt else f'[{x["measure"]}]'
        rows.append(f'ROW ( "No", {i}, "Question", {dax_str(x["question"])}, "Value", {value}, '
                    f'"Expected", {literal(x["expected"])}, "Difference", {value} - {literal(x["expected"])} )')
        role_txt = []
        if x.get('role'):
            r = roles[x['role']]
            perms = [p for p in r.get('tablePermissions', []) if p.get('filter')]
            user = x.get('role_user') or ''
            sim = []
            for p in perms:
                f = re.sub(r'USERPRINCIPALNAME\s*\(\s*\)', dax_str(user), p['filter'], flags=re.I)
                sim.append(f'FILTER ( ALL ( {q(p["table"])} ), {f} )')
            rv = f'CALCULATE ( [{x["measure"]}]' + ''.join(f', {f}' for f in filt + sim) + ' )'
            exp = x.get('role_expected', 0) or 0
            rows.append(f'ROW ( "No", {i}, "Question", {dax_str(x["question"] + " – as " + x["role"] + " (" + user + ")")}, '
                        f'"Value", {rv}, "Expected", {literal(exp)}, "Difference", {rv} - {literal(exp)} )')
            role_txt = [f'- **Role:** {x["role"]} as `{user}` – expected {exp}. Rule: '
                        + '; '.join(f'`{p["table"]}`: `{p["filter"]}`' for p in perms),
                        f'  Check in Desktop: Modeling → View as → tick *{x["role"]}* and *Other user* `{user}` → the card '
                        f'for {x["measure"]} with the same filters should show {exp}.']
        ms, cs = trace(x['measure'])
        md += [f'## {i}. {x["question"]}', '',
               f'- **Measure:** {x["measure"]}' + (f' – {m["description"]}' if m.get('description') else ''),
               f'- **Filters:** ' + (', '.join(f'{k} = {v}' for k, v in (x.get("filters") or {}).items()) or 'none'),
               f'- **Expected:** {x["expected"]} – {x.get("expected_how") or "(how it was computed is missing)"}',
               '- **In Power BI:** _(fill in after the refresh)_'] + role_txt + [
               '', '**Definition**', '```dax']
        for name in ms:
            md.append(f'{name} = {measures[name]["expression"].strip()}')
        md += ['```', '', '**Traced to the source**', '', '| Model column | Source |', '|---|---|']
        md += [f'| {t}[{c}] | {source_of(t, c)} |' for t, c in cs] or ['| – | – |']
        md.append('')

    dax = ['// Grounded-answer test – Power BI Desktop → Refresh → DAX query view → paste → Run.',
           '// Every Difference should be 0. Role rows simulate RLS in DAX; confirm them with Modeling → View as.',
           'EVALUATE', 'UNION (', '    ' + ',\n    '.join(rows), ')' if len(rows) > 1 else '']
    if len(rows) == 1:
        dax = dax[:2] + ['EVALUATE', rows[0]]
    out.mkdir(parents=True, exist_ok=True)
    (out / 'grounded-answers.dax').write_text('\n'.join(dax).rstrip() + '\n', encoding='utf-8')
    (out / 'grounded-answers.md').write_text('\n'.join(md), encoding='utf-8')
    untraced = sum(1 for x in questions for t, c in trace(x['measure'])[1] if source_of(t, c) == 'not traced')
    print(json.dumps({'ok': True, 'questions': len(questions), 'role_checks': sum(1 for x in questions if x.get('role')),
                      'untraced_columns': untraced, 'dax': str(out / 'grounded-answers.dax'),
                      'md': str(out / 'grounded-answers.md')}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
