#!/usr/bin/env python3
"""
descriptions.py - Every table, column and measure in the model gets a description, and a list to download.

    python descriptions.py <pbip-folder> [--ai <ai_descriptions.json>] [--apply] [--xlsx <file>]

1. Reads every `table`, `column` and `measure` in <Name>.SemanticModel/definition/tables/*.tmdl and its
   `///` description.
2. Fields without one get the AI description from --ai (default <pbip>/docs/ai_descriptions.json, written by
   the pbip-catalog step; keys "Table", "Table[Column]" or "_Measures[Measure]"). With --apply they are
   written to the TMDL as `///` lines - only those lines change, never DAX, M or properties.
3. Writes the list (default <pbip>/docs/descriptions.xlsx) with the columns Name | Description | Type |
   Table | Hidden, one row per measure, column and table.

Prints JSON {total, described, filledFromAi, missing[], xlsx}. Exit 1 when a field is still without a
description: draft one for each key in `missing`, add it to the AI file and run again (--warn-only: exit 0).
Close the project in Power BI Desktop before --apply, or Desktop may overwrite the files.
"""
import argparse
import json
import re
import sys
from pathlib import Path

DECL = re.compile(r'^([\t ]*)(table|column|measure)\s+(.*)$')


def parse_name(rest):
    rest = rest.strip()
    if rest.startswith("'"):
        i, buf = 1, []
        while i < len(rest):
            if rest[i] == "'":
                if i + 1 < len(rest) and rest[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                break
            buf.append(rest[i])
            i += 1
        return ''.join(buf)
    return re.match(r'([^\s=]+)', rest).group(1)


def scan(lines):
    """Yield dicts per declaration: index, indent, kind, name, desc, hidden."""
    items, table = [], None
    for i, line in enumerate(lines):
        m = DECL.match(line)
        if not m:
            continue
        indent, kind, rest = m.groups()
        name = parse_name(rest)
        if kind == 'table':
            table = name
        j, desc = i, []
        while j > 0 and lines[j - 1].strip().startswith('///'):
            j -= 1
            desc.insert(0, lines[j].strip()[3:].strip())
        # properties follow on deeper-indented lines until the next declaration at the same level
        hidden, k = False, i + 1
        while k < len(lines) and (not lines[k].strip() or len(lines[k]) - len(lines[k].lstrip('\t ')) > len(indent)):
            if lines[k].strip() == 'isHidden':
                hidden = True
            if DECL.match(lines[k]) or lines[k].strip().startswith(('partition ', 'hierarchy ')):
                break
            k += 1
        items.append({'index': i, 'indent': indent, 'kind': kind, 'table': table, 'name': name,
                      'desc': ' '.join(d for d in desc if d), 'hidden': hidden})
    return items


def ai_lookup(ai, it):
    if it['kind'] == 'table':
        keys = [it['table']]
    elif it['kind'] == 'measure':
        keys = [f"{it['table']}[{it['name']}]", f"[{it['name']}]", it['name']]
    else:
        keys = [f"{it['table']}[{it['name']}]"]
    for k in keys:
        v = ai.get(k)
        if v and str(v).strip():
            return ' '.join(str(v).split())
    return ''


def key_of(it):
    return it['table'] if it['kind'] == 'table' else f"{it['table']}[{it['name']}]"


def write_xlsx(path, rows):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = 'Descriptions'
    head = ['Name', 'Description', 'Type', 'Table', 'Hidden']
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor='1F3A5F')
    for r in rows:
        ws.append([r['name'], r['desc'], r['type'], r['table'], 'Yes' if r['hidden'] else ''])
    for col, w in zip('ABCDE', (32, 90, 10, 22, 8)):
        ws.column_dimensions[col].width = w
    for row in ws.iter_rows(min_row=2):
        row[1].alignment = Alignment(wrap_text=True, vertical='top')
        for c in (row[0], row[2], row[3], row[4]):
            c.alignment = Alignment(vertical='top')
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = f'A1:E{len(rows) + 1}'
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pbip')
    ap.add_argument('--ai')
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--xlsx')
    ap.add_argument('--warn-only', action='store_true', help='exit 0 when fields are missing (rebuild.js)')
    a = ap.parse_args()

    pbip = Path(a.pbip)
    sm = next(pbip.glob('*.SemanticModel'), None)
    tables_dir = sm / 'definition' / 'tables' if sm else None
    if not tables_dir or not tables_dir.is_dir():
        sys.exit('Could not find <Name>.SemanticModel/definition/tables (only the TMDL format is supported).')
    ai_file = Path(a.ai) if a.ai else pbip / 'docs' / 'ai_descriptions.json'
    ai = json.loads(ai_file.read_text(encoding='utf-8-sig')) if ai_file.exists() else {}

    rows, missing, filled = [], [], 0
    for f in sorted(tables_dir.glob('*.tmdl')):
        text = f.read_text(encoding='utf-8-sig')
        nl = '\r\n' if '\r\n' in text else '\n'
        lines = text.split(nl)
        items = scan(lines)
        inserts = []
        for it in items:
            if not it['desc']:
                d = ai_lookup(ai, it)
                if d:
                    it['desc'] = d
                    filled += 1
                    inserts.append((it['index'], f"{it['indent']}/// {d}"))
                else:
                    missing.append(key_of(it))
            rows.append({'name': it['name'], 'desc': it['desc'], 'type': it['kind'].capitalize(),
                         'table': it['table'], 'hidden': it['hidden']})
        if a.apply and inserts:
            for idx, line in sorted(inserts, reverse=True):
                lines.insert(idx, line)
            f.write_text(nl.join(lines), encoding='utf-8', newline='')

    order = {'Measure': 0, 'Table': 1, 'Column': 2}
    rows.sort(key=lambda r: (order[r['type']], r['table'] or '', r['name'].lower()))
    xlsx = Path(a.xlsx) if a.xlsx else pbip / 'docs' / 'descriptions.xlsx'
    write_xlsx(xlsx, rows)
    print(json.dumps({'total': len(rows), 'described': len(rows) - len(missing), 'filledFromAi': filled,
                      'written': bool(a.apply and filled), 'missing': missing, 'xlsx': str(xlsx),
                      'warnings': [f'{len(missing)} field(s) without a description: ' + ', '.join(missing[:10])] if missing else []},
                     ensure_ascii=False, indent=1))
    sys.exit(1 if missing and not a.warn_only else 0)


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):
        _s.reconfigure(encoding='utf-8')
    main()
