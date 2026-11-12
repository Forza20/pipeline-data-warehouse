#!/usr/bin/env python3
"""
Find the source files (CSV, Excel) behind an existing Power BI project, so pipeline-power-bi can profile
and clean the user's own data instead of a demo. Read-only.

    python pbip_sources.py <project.pbip | project folder | file.pbix>

Prints JSON:
    ok        true when at least one CSV/Excel source file exists
    project   the project name
    files[]   {path, kind, exists, tables[]} – one per CSV/Excel file (a Folder.Files source is expanded)
    other[]   {kind, details, tables[]} – sources that are not files (SQL Server, SharePoint, Web …)
    message   what to tell the user when ok is false

Exit code 0 = files found, 2 = nothing to profile (a .pbix, no semantic model, or only non-file sources).
Reads the model with ../../pbip-governance/scripts/parse_pbip.py.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

PARSER = Path(__file__).resolve().parent.parent.parent / 'pbip-governance' / 'scripts' / 'parse_pbip.py'
FILE_KINDS = {'CSV File': 'csv', 'Excel File': 'excel'}
EXTS = {'.csv': 'csv', '.txt': 'csv', '.xlsx': 'excel', '.xlsm': 'excel'}


def stop(message, **extra):
    print(json.dumps({'ok': False, 'message': message, **extra}, indent=1, ensure_ascii=False))
    sys.exit(2)


def project_root(p):
    """The folder that holds <Name>.SemanticModel: the .pbip's folder, the folder itself, or one level down."""
    if p.is_file() and p.suffix.lower() == '.pbip':
        return p.parent
    if p.is_dir():
        if any(p.glob('*.SemanticModel')):
            return p
        for sub in sorted(x for x in p.iterdir() if x.is_dir()):
            if any(sub.glob('*.SemanticModel')):
                return sub
    return None


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    p = Path(sys.argv[1].strip().strip('"')).expanduser().resolve()
    if not p.exists():
        stop(f'Not found: {p}')
    if p.suffix.lower() == '.pbix':
        stop('A .pbix file cannot be read outside Power BI Desktop. Open it in Desktop, choose File → Save as → '
             'Power BI project (*.pbip), and give me the path of the .pbip file. (Or give me the CSV/Excel files '
             'the report reads.)', pbix=str(p))
    root = project_root(p)
    if not root:
        stop(f'No Power BI project (a <Name>.SemanticModel folder) in {p}.')
    if not PARSER.exists():
        stop(f'needs the pbip-governance skill next to this one ({PARSER})')
    spec = importlib.util.spec_from_file_location('parse_pbip', PARSER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    model = mod.parse_model(root)

    files, other = {}, []
    for s in model.get('dataSources', []):
        kind, details, tables = s.get('kind'), s.get('details') or '', s.get('tables', [])
        if kind in FILE_KINDS:
            f = files.setdefault(details.lower(), {'path': details, 'kind': FILE_KINDS[kind],
                                                   'exists': Path(details).is_file(), 'tables': []})
            f['tables'] += [t for t in tables if t not in f['tables']]
        elif kind == 'Folder' and Path(details).is_dir():
            for x in sorted(Path(details).iterdir()):
                if x.suffix.lower() in EXTS and not x.name.startswith('~$'):
                    files.setdefault(str(x).lower(), {'path': str(x), 'kind': EXTS[x.suffix.lower()],
                                                      'exists': True, 'tables': list(tables)})
        elif kind not in ('Other', 'Unknown'):   # Other/Unknown = calculated tables (date, measures)
            other.append({'kind': kind, 'details': details, 'tables': tables})

    # parse_pbip names one source per table, so a file read only by a query that is merged into another
    # table (stg_orders → Sales merged with Customer) is missing above. Scan every query for File.Contents too.
    params = {e['name']: (e.get('parameterValue') or '').strip().strip('"')
              for e in model.get('expressions', []) if e.get('kind') == 'parameter'}

    def resolve(arg):
        parts = []
        for tok in re.findall(r'"((?:[^"]|"")*)"|#"((?:[^"]|"")*)"|([A-Za-z_][\w.]*)', arg):
            lit, quoted, ident = tok
            if lit or (not quoted and not ident):
                parts.append(lit.replace('""', '"'))
            else:
                name = quoted.replace('""', '"') if quoted else ident
                if name not in params:
                    return None
                parts.append(params[name])
        return ''.join(parts)

    tables = [(t['name'], ' '.join(p.get('mExpression') or '' for p in t.get('partitions', [])))
              for t in model.get('tables', [])]
    queries = [(e['name'], e.get('mExpression') or '', False) for e in model.get('expressions', [])] + \
              [(name, m, True) for name, m in tables]
    for qname, m, is_table in queries:
        for fn, arg in re.findall(r'(Excel\.Workbook|Csv\.Document)\(\s*File\.Contents\(\s*([^)]*?)\s*\)', m):
            path = resolve(arg)
            if not path:
                continue
            f = files.setdefault(path.lower(), {'path': path, 'kind': 'excel' if fn.startswith('Excel') else 'csv',
                                                'exists': Path(path).is_file(), 'tables': []})
            # the model tables built from this query (Source = stg_orders), or the table itself
            users = [qname] if is_table else \
                [t for t, tm in tables if re.search(r'(?<![\w"])' + re.escape(qname) + r'(?![\w"])|#"' + re.escape(qname) + '"', tm)]
            f['tables'] += [t for t in users if t not in f['tables']]

    out = {'ok': any(f['exists'] for f in files.values()), 'project': model.get('name') or root.name,
           'root': str(root), 'files': list(files.values()), 'other': other}
    if not files:
        out['message'] = ('The project reads no CSV or Excel files' +
                          (' – its data comes from ' + ', '.join(sorted({o['kind'] for o in other})) if other else '') +
                          '. Export the tables to CSV or Excel and give me those files.')
    elif not out['ok']:
        out['message'] = ('The source files the project points at are not on this PC: ' +
                          ', '.join(f['path'] for f in files.values()) + '. Give me the folder where they are now.')
    print(json.dumps(out, indent=1, ensure_ascii=False))
    sys.exit(0 if out['ok'] else 2)


if __name__ == '__main__':
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding='utf-8')
    main()
