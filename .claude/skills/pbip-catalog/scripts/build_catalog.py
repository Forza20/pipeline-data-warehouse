#!/usr/bin/env python3
"""
build_catalog.py - Data catalog, lineage and dbdiagram.io model for a PBIP project.

Usage:
    python3 build_catalog.py <pbip-folder> [--out DIR] [--layout-config FILE]
                             [--previous catalog.xlsx] [--ai-descriptions FILE]
                             [--fence azdo|github] [--parser parse_pbip.py]
                             [--sql DIR_OR_FILE ...] [--html]

Writes to --out (default <pbip-folder>/docs):
    catalog.xlsx               Excel catalog (edit Description/Owner/Sensitivity/Upstream source/Status)
    lineage.md                 Mermaid lineage: overview, per dashboard slot, per column
    model.dbml                 DBML for dbdiagram.io / dbdocs.io
    catalog.json               Machine-readable catalog (pipeline handoff / diff)
    missing_descriptions.json  Items without a description + context, for AI drafts
    lineage.html               (--html) table-level lineage page: files → layers → model → pages

Description precedence: earlier Excel edits > TMDL `///` > AI draft (--ai-descriptions).
Upstream source is filled automatically from the Power Query origin and, with --sql, followed
through CREATE VIEW / INSERT INTO ... SELECT in the given SQL files. Text you typed yourself
is never replaced (the last auto value is kept in "Upstream source (auto)").
"""

import argparse
import datetime
import importlib.util
import json
import os
import re
import shutil
import sys
from pathlib import Path

LAYOUT_PAGE_ID = '8d1e4c7a2b5f9e3d6c10'   # fixed page id written by pbip-layout
EDITABLE = ['Description', 'Owner', 'Sensitivity', 'Upstream source', 'Status']
STATUSES = ['Missing', 'Translate', 'AI suggestion', 'From model', 'Edited', 'Approved']
# function words only; words both languages share ('for', 'i', 'a') are left out
EN_WORDS = {'the', 'of', 'and', 'with', 'only', 'from', 'is', 'are', 'each', 'which', 'that', 'this',
            'when', 'to', 'an', 'not', 'or', 'be', 'as', 'on', 'at', 'its', 'than', 'per', 'into', 'all',
            # common report words with a different Danish form (omsætning, linjer, kunde, antal …)
            'revenue', 'line', 'lines', 'every', 'paid', 'invoice', 'invoices', 'customer', 'customers',
            'order', 'orders', 'row', 'rows', 'number', 'count', 'amount', 'value', 'latest', 'month',
            'months', 'year', 'previous', 'average', 'share', 'used', 'hidden', 'booking', 'bookings',
            'guest', 'guests', 'account', 'accounts', 'manager', 'managers', 'product', 'products',
            'sales', 'target', 'targets', 'status', 'valid', 'complete', 'days', 'nights', 'room', 'rooms'}
DA_WORDS = {'og', 'af', 'er', 'med', 'kun', 'fra', 'som', 'på', 'der', 'den', 'det', 'til', 'ikke', 'hver',
            'en', 'et', 'eller', 'alle', 'ved', 'efter', 'samt', 'uden', 'inkl', 'pr', 'de', 'om', 'når',
            'hvor', 'by', 'mod', 'antal', 'kunder', 'ordrer', 'linjer', 'gns', 'seneste', 'forrige', 'uanset'}


def _word_counts(text):
    t = re.sub(r'`[^`]*`|\[[^\]]*\]|\b\w+_\w+\b', ' ', str(text or '').lower())
    words = re.findall(r'[a-zæøå]+', t)
    en = sum(w in EN_WORDS for w in words)
    da = sum(w in DA_WORDS or bool(re.search('[æøå]', w)) for w in words)
    return words, en, da


def looks_english(text):
    """True for a description that reads as English."""
    words, en, da = _word_counts(text)
    return (en >= 2 and en > 2 * da) or (da == 0 and en >= 1 and len(words) <= 6)


def needs_translation(text):
    """True for a model description that is not in English (the catalog is English). Detects Danish."""
    words, en, da = _word_counts(text)
    return (da >= 2 and da > en) or (da >= 1 and en == 0)
PII_DEFAULT = 'Possible PII - assess'
UPSTREAM_AUTO = 'Upstream source (auto)'   # last auto value; tells auto text apart from own edits


# ---------------------------------------------------------------------------
# Parser loading (shared with pbip-governance)
# ---------------------------------------------------------------------------

def load_parser(explicit=None):
    sys.dont_write_bytecode = True  # do not leave __pycache__ in the skill folders
    here = Path(__file__).resolve()
    candidates = [explicit, os.environ.get('PBIP_PARSER')]
    candidates += [str(p / 'skills' / 'pbip-governance' / 'scripts' / 'parse_pbip.py') for p in here.parents]
    candidates += [str(p / 'pbip-governance' / 'scripts' / 'parse_pbip.py') for p in here.parents]
    candidates += [
        str(Path.home() / '.claude' / 'skills' / 'pbip-governance' / 'scripts' / 'parse_pbip.py'),
        '/mnt/skills/user/pbip-governance/scripts/parse_pbip.py',
    ]
    for c in candidates:
        if c and Path(c).is_file():
            spec = importlib.util.spec_from_file_location('parse_pbip', c)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if not hasattr(mod, 'enrich_model'):
                continue  # old parser version without lineage support
            return mod, c
    sys.exit('Could not find pbip-governance/scripts/parse_pbip.py (with lineage support). '
             'Give the path with --parser or the environment variable PBIP_PARSER.')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fkey(table, name):
    return f'{table}[{name}]'


def parse_fkey(s):
    m = re.match(r"^'?(.+?)'?\[(.+)\]$", (s or '').strip())
    return (m.group(1), m.group(2)) if m else (None, None)


def short(s, n=80):
    s = re.sub(r'\s+', ' ', str(s or '')).strip()
    return s if len(s) <= n else s[:n - 1] + '…'


def classify_table(t, rels):
    n = t['name'].lower()
    if t['measures'] and all(c['isHidden'] for c in t['columns']):
        return 'Measures'
    if t.get('dataCategory', '').lower() == 'time' or re.match(r'^(dim_)?(date|dato|kalender|calendar)', n):
        return 'Date'
    if n.startswith(('fact_', 'fct_', 'f_', 'fakta')):
        return 'Fact'
    if n.startswith(('dim_', 'd_')):
        return 'Dimension'
    if n.startswith(('bridge', 'bro_')):
        return 'Bridge'
    many = any(r['from']['table'] == t['name'] for r in rels)
    one = any(r['to']['table'] == t['name'] for r in rels)
    if many and not one:
        return 'Fact'
    if one:
        return 'Dimension'
    return 'Helper'


def source_text(src):
    if not src:
        return ''
    if src.get('kind') in ('Other', 'Unknown'):
        return ''
    return f"{src['kind']}: {src.get('details', '')}"


def origin_text(origin):
    if not origin:
        return ''
    k = origin.get('kind')
    if k == 'source':
        obj = origin.get('object') or origin.get('query', '')
        return f"{obj}.{origin.get('column', '')}"
    if k == 'computed':
        step = origin.get('step', '')
        return f"Calculated in {origin.get('query', '')}" + (f" (step {step})" if step and step != '__expr__' else '')
    if k == 'join':
        return f"{origin.get('query', '')}[{origin.get('column', '')}]"
    return ''


def lineage_text(events):
    parts = []
    for e in events or []:
        if e['action'] == 'Data type set':
            continue
        d = short(e.get('detail', ''), 60)
        parts.append(f"{e['query']}: {e['action']}" + (f" ({d})" if d else ''))
    return ' → '.join(parts)


# ---------------------------------------------------------------------------
# Upstream source (automatic)
# ---------------------------------------------------------------------------

def _file_label(src):
    if (src or {}).get('kind') in ('Excel File', 'CSV File', 'Folder'):
        return re.split(r'[\\/]', str(src.get('details', '')).strip('"'))[-1]
    return ''


def _obj_label(obj):
    return re.sub(r'\s*\((?:Sheet|Table|DefinedName)\)$', '', obj or '')


def _nav_items(expr):
    """Sheet/table names a navigation step points at: Kilde{[Item="x",Kind="Sheet"]} -> ['x']."""
    out = []
    for body in re.findall(r'\{\s*\[(.*?)\]\s*\}', expr or '', re.S):
        kv = dict(re.findall(r'(\w+)\s*=\s*"((?:[^"]|"")*)"', body))
        if 'Item' in kv or 'Name' in kv:
            out.append('.'.join(kv[k] for k in ('Schema', 'Item', 'Name') if k in kv)
                       if 'Kind' not in kv else kv.get('Item', kv.get('Name')))
    return out


def column_objects(c, steps):
    """Source objects of a column; an append of several sheets gives all of them."""
    o, ev = c.get('origin') or {}, c.get('lineage') or []
    if o.get('kind') != 'source' or not o.get('object'):
        return []
    objs = [_obj_label(o['object'])]
    nav_q = next((e['query'] for e in ev if e['action'] == 'Navigation'), None)
    for e in ev:
        if e['action'] == 'Combined (append)' and e['query'] == nav_q:
            parts = []
            for step in [x.strip() for x in e['detail'].split(',')]:
                parts += _nav_items_back(e['query'], step, steps)
            if len(parts) > 1:
                objs = list(dict.fromkeys(parts))
    return objs


def _nav_items_back(query, step, steps, hops=12):
    """Sheet/table names behind a step: follow the first table argument back through the query's steps
    until a navigation step (`Source{[Item="x", Kind="Sheet"]}[Data]`) is found."""
    name = step[2:-1].replace('""', '"') if step.startswith('#"') and step.endswith('"') else step
    for _ in range(hops):
        expr = steps.get((query, name))
        if expr is None:
            return _nav_items(name)
        found = _nav_items(expr)
        if found:
            return found
        m = re.match(r'^\s*[\w.]+\(\s*(#"(?:[^"]|"")*"|[^\W\d][\w.]*)', expr)
        if not m:
            return []
        nxt = m.group(1)
        name = nxt[2:-1].replace('""', '"') if nxt.startswith('#"') else nxt
    return []


def auto_upstream_column(c, table, steps, sql):
    """Upstream text for a column from its Power Query origin, followed through SQL when given."""
    if c.get('isCalculated'):
        return 'Calculated column (DAX) in Power BI'
    o, ev = c.get('origin') or {}, c.get('lineage') or []
    idx = next((e for e in ev if e['action'] == 'Index/key'), None)
    if idx:
        return ('Surrogate key generated in Power Query' if idx['query'] == table
                else f"Surrogate key from {idx['query']} (generated in Power Query)")
    kind = o.get('kind')
    if kind == 'source':
        obj, col, src = o.get('object', ''), o.get('column', ''), o.get('source') or {}
        if sql and obj:
            chain = sql.column_chain(obj, col)
            if chain:
                return chain
        f = _file_label(src)
        if f:
            return f"{f} › {' + '.join(column_objects(c, steps))} › {col}"
        if obj:
            k = src.get('kind')
            return f'{obj}.{col}' + (f' ({k})' if k not in (None, 'Other', 'Unknown') else '')
        return ''
    if kind == 'computed':
        expr = steps.get((o.get('query'), o.get('step')), '')
        if expr.lstrip().startswith('#table'):
            q = o.get('query', '')
            return 'Fixed list in Power Query' if q == table else f'Lookup in fixed list in Power Query ({q})'
        calc = next((e for e in reversed(ev) if e['action'] == 'Calculated'), None)
        if calc:
            return f"Calculated in Power Query ({calc['query']}): {short(re.sub(r'^each\\s+', '', calc['detail']), 90)}"
        return f"Genereret i Power Query ({o.get('query', '')})"
    if kind == 'join':
        return f"{o.get('query', '')}[{o.get('column', '')}] via join i Power Query"
    return ''


def auto_upstream_table(t, ttype, steps, sql, model):
    if ttype == 'Measures':
        return 'None – measure table in Power BI'
    cols = [c for c in t['columns'] if not c.get('isCalculated')]
    origins = [c.get('origin') or {} for c in cols]
    raw_objs = sorted({o.get('object') for o in origins if o.get('kind') == 'source' and o.get('object')})
    if sql:
        chains = [ch for ch in (sql.table_chain(o) for o in raw_objs) if ch]
        if chains:
            return '; '.join(dict.fromkeys(chains))
    objs = list(dict.fromkeys(x for c in cols for x in column_objects(c, steps)))
    files = sorted({_file_label(o.get('source')) for o in origins if o.get('kind') == 'source'} - {''})
    if files and objs:
        return f"{', '.join(files)} › {', '.join(objs)}"
    if raw_objs:
        return ', '.join(raw_objs)
    if not origins or not all(o.get('kind') == 'computed' for o in origins):
        return ''
    exprs = [steps.get((o.get('query'), o.get('step')), '') for o in origins]
    if all(e.lstrip().startswith('#table') for e in exprs):
        return 'Fixed list in Power Query'
    part = next(iter(t['partitions']), {})
    refs = part.get('references', [])
    queries = {e['name']: e for e in model.get('expressions', []) if e['kind'] == 'query'}
    tables = {x['name'] for x in model['tables']}
    only_keys = all(any(e['action'] == 'Index/key' for e in (c.get('lineage') or [])) for c in cols)
    if only_keys:
        # a bridge/link table: rows come from a shared query, keys are looked up in dimensions
        items, files = [], set()
        for r in refs:
            if r in queries:
                items += _nav_items(queries[r]['mExpression'])
                f = _file_label(queries[r].get('resolvedSource'))
                if f:
                    files.add(f)
        if items:
            dims = [r for r in refs if r in tables]
            return (f"{', '.join(sorted(files)) + ' › ' if files else ''}{', '.join(dict.fromkeys(items))}"
                    + (f" (keys looked up in {', '.join(dims)})" if dims else ''))
    return 'Generated in Power Query' + (f" from {', '.join(refs)}" if refs else '')


def apply_upstream(row, key, auto, prev):
    """Fill Upstream source with the auto text unless the user wrote something else."""
    p = prev.get(key) or {}
    cur = str(p.get('Upstream source') or '').strip()
    last_auto = str(p.get(UPSTREAM_AUTO) or '').strip()
    if not cur or cur == last_auto:
        row['Upstream source'] = auto
    row[UPSTREAM_AUTO] = auto


# ---------------------------------------------------------------------------
# Dashboard slots (pbip-layout)
# ---------------------------------------------------------------------------

def template_json(key):
    """pbip-layout's template.json (templates/<key>) next to this skill, or None."""
    here = Path(__file__).resolve()
    for root in (here.parents[2], here.parents[3] / 'skills', Path.home() / '.claude' / 'skills'):
        p = root / 'pbip-layout' / 'templates' / key / 'template.json'
        if p.is_file():
            return json.loads(p.read_text(encoding='utf-8'))
    return None


def template_page_ids(key='adventureworks'):
    """The page ids gen-report.js gives the template's pages: md5('pbip-layout:<template>:<page key>')[:20]."""
    import hashlib
    tpl = template_json(key) or {}
    return {hashlib.md5(f'pbip-layout:{key}:{p["key"]}'.encode()).hexdigest()[:20]: p['displayName']
            for p in tpl.get('pages', [])}


def slots_from_config(cfg):
    out = []

    def add(slot, field, role, label=''):
        if field:
            out.append({'slot': slot, 'field': field, 'role': role, 'label': label})
    # pbip-layout's report template: config.fields maps template fields to the model, config.pages the pages
    if 'fields' in cfg and 'pages' in cfg:
        tpl = template_json(cfg.get('template') or 'adventureworks') or {}
        names = {p['key']: p['displayName'] for p in tpl.get('pages', [])}
        tfields = tpl.get('fields', {})
        for tf, model_field in (cfg.get('fields') or {}).items():
            if not model_field:
                continue
            label = (cfg.get('labels') or {}).get(tf) or tf[tf.index('[') + 1:-1].split('.')[-1]
            role = 'Measure' if (tfields.get(tf) or {}).get('kind') == 'Measure' else 'Column'
            for page in (tfields.get(tf) or {}).get('pages', cfg['pages']):
                if page in cfg['pages']:
                    add(names.get(page, page), model_field, role, label)
        return out
    for i, k in enumerate(cfg.get('kpis', []), 1):
        add(f'KPI {i}', k.get('measure'), 'Value', k.get('label', ''))
    tr = cfg.get('trend', {})
    add('Trend', tr.get('measure'), 'Value', tr.get('title', ''))
    add('Trend', tr.get('monthColumn'), 'Axis', tr.get('title', ''))
    for i, m in enumerate(cfg.get('monthly', []), 1):
        for key, role in (('sparkMeasure', 'Sparkline'), ('currentMeasure', 'Latest month'),
                          ('labelMeasure', 'Previous month text'), ('colorMeasure', 'Colour')):
            add(f'Monthly card {i}', m.get(key), role, m.get('title', ''))
    b = cfg.get('bar', {})
    add('Bars per category', b.get('measure'), 'Value', b.get('title', ''))
    add('Bars per category', b.get('categoryColumn'), 'Category', b.get('title', ''))
    tb = cfg.get('table', {})
    add('Top 10 table', tb.get('rowColumn'), 'Row', tb.get('title', ''))
    for c in tb.get('columns', []):
        add('Top 10 table', c.get('measure'), 'Column', tb.get('title', ''))
    for key, role in (('sortMeasure', 'Sortering'), ('dataBarMeasure', 'Data bars'),
                      ('gradientMeasure', 'Farvegradient')):
        add('Top 10 table', tb.get(key), role, tb.get('title', ''))
    add('Top 10 table', (tb.get('topN') or {}).get('orderByColumn'), 'TopN-filter', tb.get('title', ''))
    for i, h in enumerate(cfg.get('highlights', []), 1):
        add(f'Highlight {i}', h.get('measure'), 'Value', h.get('header', ''))
    return out


ROLE_DA = {'Y': 'Value', 'Values': 'Value', 'Data': 'Value', 'Category': 'Category', 'Rows': 'Row',
           'Columns': 'Column', 'Tooltips': 'Tooltip', 'Legend': 'Legend', 'Series': 'Series',
           'X': 'Axis', 'Size': 'Size'}


def slots_from_page(page):
    """Fallback without layout-config.json: recognise the pbip-layout page by positions (layout.md)."""
    out = []

    def bucket(x, starts):
        return min(range(len(starts)), key=lambda i: abs(starts[i] - x)) + 1
    # 1–4 KPI tiles spread over the row: number them left to right, not by fixed positions
    kpi_x = sorted({v.get('position', {}).get('x', 0) for v in page['visuals']
                    if v.get('type') == 'cardVisual' and abs(v.get('position', {}).get('y', 0) - 20) < 10})
    for v in page['visuals']:
        p = v.get('position', {})
        x, y, typ = p.get('x', 0), p.get('y', 0), v.get('type')
        slot = None
        if typ == 'cardVisual' and abs(y - 20) < 10:
            slot = f'KPI {kpi_x.index(x) + 1}'
        elif typ == 'lineChart':
            slot = 'Trend'
        elif y >= 760 and x < 1060 and typ in ('areaChart', 'cardVisual'):
            slot = f'Monthly card {bucket(x, [96, 422, 748])}'
        elif typ == 'clusteredBarChart':
            slot = 'Bars per category'
        elif typ == 'tableEx':
            slot = 'Top 10 table'
        elif typ == 'cardVisual' and y >= 930:
            slot = f'Highlight {bucket(x, [1072, 1500])}'
        if not slot:
            continue
        for r in v.get('fieldRefs', []):
            out.append({'slot': slot, 'field': fkey(r['table'], r['name']),
                        'role': ROLE_DA.get(r['role'], r['role']), 'label': v.get('title', '')})
    return out


# ---------------------------------------------------------------------------
# Previous Excel (round-trip)
# ---------------------------------------------------------------------------

def read_previous(path):
    prev = {}
    if not path or not Path(path).is_file():
        return prev
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    for sheet in ('Tables', 'Columns', 'Measures'):
        if sheet not in wb.sheetnames:
            continue
        rows = list(wb[sheet].iter_rows(values_only=True))
        if not rows:
            continue
        head = [str(h or '') for h in rows[0]]
        if 'Key' not in head:
            continue
        for r in rows[1:]:
            d = {h: (r[i] if i < len(r) else None) for i, h in enumerate(head)}
            if d.get('Key'):
                d['_sheet'] = sheet
                prev[str(d['Key'])] = d
    return prev


def merge_editable(key, tmdl_desc, ai, prev, defaults=None):
    """Apply the description precedence. Returns dict with the editable columns."""
    p = prev.get(key) or {}
    out = {k: (p.get(k) or '') for k in EDITABLE}
    for k, v in (defaults or {}).items():
        if not out.get(k):
            out[k] = v
    prev_desc = str(p.get('Description') or '').strip()
    prev_status = str(p.get('Status') or '').strip()
    tmdl_desc = (tmdl_desc or '').strip()
    if prev_desc and prev_status not in ('From model', 'Translate'):
        out['Description'], out['Status'] = prev_desc, prev_status or 'Edited'
        if prev_status == 'AI suggestion' and ai.get(key) and ai[key].strip() != prev_desc:
            pass  # keep what is in Excel; a new AI draft never overwrites it
        src = 'Excel'
    elif tmdl_desc and needs_translation(tmdl_desc):
        # non-English text from the model: an AI translation may replace it; otherwise flag it
        if ai.get(key):
            out['Description'], out['Status'], src = ai[key].strip(), 'AI suggestion', 'AI (translated from TMDL)'
        else:
            out['Description'], out['Status'], src = tmdl_desc, 'Translate', 'TMDL'
    elif tmdl_desc:
        out['Description'], out['Status'], src = tmdl_desc, 'From model', 'TMDL'
    elif ai.get(key):
        out['Description'], out['Status'], src = ai[key].strip(), 'AI suggestion', 'AI'
    else:
        out['Description'], out['Status'], src = '', 'Missing', ''
    if out['Status'] not in STATUSES:
        out['Status'] = 'Edited'
    out['Description source'] = src
    return out


# ---------------------------------------------------------------------------
# Catalog assembly
# ---------------------------------------------------------------------------

def build(parsed, slots, prev, ai, pii_reason, sql=None):
    model, report = parsed['model'], parsed['report']
    rels = model['relationships']
    tables = model['tables']
    measure_table = {m['name']: t['name'] for t in tables for m in t['measures']}
    mdeps = {m['name']: m.get('dependencies', {}) for t in tables for m in t['measures']}

    # transitive closure per measure
    def closure(mname, seen=None):
        seen = seen if seen is not None else set()
        cols, tabs = set(), set()
        for d in mdeps.get(mname, {}).get('measures', []):
            if d not in seen:
                seen.add(d)
                c2, t2, _ = closure(d, seen)
                cols |= c2
                tabs |= t2
        for c in mdeps.get(mname, {}).get('columns', []):
            cols.add(fkey(c['table'], c['column']))
        tabs |= set(mdeps.get(mname, {}).get('tables', []))
        return cols, tabs, seen

    used_by = {}   # measure -> measures that use it directly
    for name, d in mdeps.items():
        for dep in d.get('measures', []):
            used_by.setdefault(dep, set()).add(name)

    # dashboard slot tagging (direct + indirect)
    direct, indirect = {}, {}
    for s in slots:
        direct.setdefault(s['field'], []).append(f"{s['slot']} ({s['role']})")
        t, n = parse_fkey(s['field'])
        if n in mdeps:
            cols, tabs, ms = closure(n)
            for m in ms:
                indirect.setdefault(fkey(measure_table[m], m), set()).add(s['slot'])
            for c in cols:
                indirect.setdefault(c, set()).add(s['slot'])
            for tb in tabs:
                indirect.setdefault(tb, set()).add(s['slot'])
        if t:
            indirect.setdefault(t, set()).add(s['slot'])

    # report usage (all pages)
    usage = {}
    for page in report.get('pages', []):
        for v in page.get('visuals', []):
            refs = v.get('fieldRefs')
            if refs is None:
                refs = []
                for f in v.get('fields', []):
                    if '.' in f:
                        a, b = f.split('.', 1)
                        refs.append({'table': a, 'name': b})
            label = f"{page.get('displayName', '')} › {v.get('type', '')}"
            for r in refs:
                usage.setdefault(fkey(r['table'], r['name']), set()).add(label)

    def slot_list(key):
        return '; '.join(dict.fromkeys(direct.get(key, [])))

    def indirect_list(key):
        own = {x.split(' (')[0] for x in direct.get(key, [])}
        return ', '.join(sorted(set(indirect.get(key, set())) - own))

    out = {'tables': [], 'columns': [], 'measures': [], 'relationships': [],
           'sources': [], 'slots': [], 'missing': []}

    steps = {}   # (query, step) -> M expression, for upstream texts
    for t in tables:
        for p in t['partitions']:
            for st in p.get('steps', []):
                steps[(t['name'], st['name'])] = st['expression']
    for e in model.get('expressions', []):
        for st in e.get('steps', []):
            steps[(e['name'], st['name'])] = st['expression']

    for t in tables:
        ttype = classify_table(t, rels)
        part = next(iter(t['partitions']), {})
        src = part.get('resolvedSource') or {}
        cols_from_origin = sorted({(c.get('origin') or {}).get('object') or '' for c in t['columns']} - {''})
        row = {
            'Key': t['name'], 'Table': t['name'], 'Type': ttype,
            'Hidden': 'Yes' if t['isHidden'] else '',
            'Columns': len(t['columns']), 'Measures': len(t['measures']),
            'Source': source_text(src),
            'Source objects': ', '.join(cols_from_origin),
            'Upstream queries': ', '.join(part.get('references', [])),
            'Query group': part.get('queryGroup', ''),
            'Storage': part.get('mode', '') + (' (calculated)' if t.get('isCalculated') else ''),
            'Dashboard (indirect)': ', '.join(sorted(indirect.get(t['name'], set()))),
        }
        row.update(merge_editable(t['name'], t.get('description'), ai, prev))
        apply_upstream(row, t['name'], auto_upstream_table(t, ttype, steps, sql, model), prev)
        row['_type'] = 'Table'
        out['tables'].append(row)
        if row['Status'] == 'Missing':
            out['missing'].append({'key': t['name'], 'type': 'Table', 'context': {
                'tableType': ttype, 'columns': [c['name'] for c in t['columns']][:40],
                'measures': [m['name'] for m in t['measures']][:40], 'source': row['Source'],
                'sourceObjects': row['Source objects']}})

        pk_cols = {r['to']['column'] for r in rels if r['to']['table'] == t['name']}
        for c in t['columns']:
            if ttype == 'Measures' and c['isHidden']:
                continue
            key = fkey(t['name'], c['name'])
            pii = pii_reason(c['name'], t['name'])
            # `annotation PII = not personal` on the column: a person reviewed it – not flagged again
            reviewed = bool(pii) and str((c.get('annotations') or {}).get('PII', '')).strip().strip('"').lower() == 'not personal'
            if reviewed:
                pii = ''
            origin = c.get('origin') or {}
            row = {
                'Key': key, 'Table': t['name'], 'Column': c['name'],
                'Data type': c.get('dataType', ''), 'Format': c.get('formatString', ''),
                'Hidden': 'Yes' if c['isHidden'] else '',
                'Key field': 'Yes' if (c.get('isKey') or c['name'] in pk_cols) else '',
                'Calculated': 'DAX' if c.get('isCalculated') else '',
                'Possible PII': f'Yes ({pii})' if pii else ('No (reviewed: not personal)' if reviewed else ''),
                'Origin': origin_text(origin) if not c.get('isCalculated') else 'Calculated column (DAX)',
                'Source': source_text(origin.get('source')),
                'Power Query steps': lineage_text(c.get('lineage')),
                'DAX': c.get('expression', '') if c.get('isCalculated') else '',
                'Dashboard slot': slot_list(key),
                'Dashboard (indirect)': indirect_list(key),
                'Used in report': '; '.join(sorted(usage.get(key, set()))),
            }
            row.update(merge_editable(key, c.get('description'), ai, prev,
                                      defaults={'Sensitivity': PII_DEFAULT if pii else ''}))
            if not pii and row['Sensitivity'] == PII_DEFAULT:
                row['Sensitivity'] = ''   # old auto-flag that no longer applies; own text is kept
            apply_upstream(row, key, auto_upstream_column(c, t['name'], steps, sql), prev)
            row['_type'] = 'Column'
            out['columns'].append(row)
            if row['Status'] == 'Missing':
                out['missing'].append({'key': key, 'type': 'Column', 'context': {
                    'table': t['name'], 'tableType': ttype, 'dataType': row['Data type'],
                    'origin': row['Origin'], 'powerQuery': row['Power Query steps'],
                    'dax': row['DAX'], 'dashboard': row['Dashboard slot'] or row['Dashboard (indirect)']}})

        for m in t['measures']:
            key = fkey(t['name'], m['name'])
            d = m.get('dependencies', {})
            cols, tabs, _ = closure(m['name'])
            row = {
                'Key': key, 'Table': t['name'], 'Measure': m['name'],
                'Folder': m.get('displayFolder', ''), 'Format': m.get('formatString', ''),
                'Hidden': 'Yes' if m.get('isHidden') else '',
                'DAX': m.get('expression', ''),
                'Depends on measures': ', '.join(d.get('measures', [])),
                'Depends on columns': ', '.join(fkey(c['table'], c['column']) for c in d.get('columns', [])),
                'All source columns': ', '.join(sorted(cols)),
                'Used by measures': ', '.join(sorted(used_by.get(m['name'], set()))),
                'Dashboard slot': slot_list(key),
                'Dashboard (indirect)': indirect_list(key),
                'Used in report': '; '.join(sorted(usage.get(key, set()))),
            }
            row.update(merge_editable(key, m.get('description'), ai, prev))
            row['_type'] = 'Measure'
            out['measures'].append(row)
            if row['Status'] == 'Missing':
                out['missing'].append({'key': key, 'type': 'Measure', 'context': {
                    'dax': m.get('expression', ''), 'format': m.get('formatString', ''),
                    'folder': m.get('displayFolder', ''), 'dependsOn': row['Depends on measures'],
                    'sourceColumns': row['All source columns'],
                    'dashboard': row['Dashboard slot'] or row['Dashboard (indirect)']}})

    for r in rels:
        card = f"{r.get('fromCardinality', 'many')}:{r.get('toCardinality', 'one')}"
        out['relationships'].append({
            'From': fkey(r['from']['table'], r['from']['column']),
            'To': fkey(r['to']['table'], r['to']['column']),
            'Cardinality': {'many:one': 'Many-to-one', 'one:one': 'One-to-one',
                             'many:many': 'Many-to-many', 'one:many': 'One-to-many'}.get(card, card),
            'Cross filter': 'Both directions' if str(r.get('crossFilter', '')).lower().startswith('both') else 'Single',
            'Active': 'Yes' if r.get('active', True) else 'No (USERELATIONSHIP)',
        })

    for s in model.get('dataSources', []):
        out['sources'].append({'Type': 'Data source', 'Name': s['kind'], 'Details': s['details'],
                               'Used by': ', '.join(s.get('tables', [])), 'Description': ''})
    for e in model.get('expressions', []):
        out['sources'].append({
            'Type': 'Parameter' if e['kind'] == 'parameter' else 'Shared query',
            'Name': e['name'],
            'Details': e.get('parameterValue', '') if e['kind'] == 'parameter' else source_text(e.get('resolvedSource')),
            'Used by': ', '.join(e.get('references', [])) if e['kind'] != 'parameter' else '',
            'Query group': e.get('queryGroup', ''),
            'Description': e.get('description', ''),
        })

    lookup = {r['Key']: r for r in out['columns'] + out['measures']}
    for s in slots:
        r = lookup.get(s['field'], {})
        out['slots'].append({
            'Slot': s['slot'], 'Role': s['role'], 'Field': s['field'],
            'Type': r.get('_type', '?'), 'Title': s.get('label', ''),
            'Description': r.get('Description', ''),
            'Source columns': r.get('All source columns', '') or r.get('Origin', ''),
        })

    # English model descriptions: ask for a Danish translation through the same AI step
    for r in out['tables'] + out['columns'] + out['measures']:
        if r['Status'] == 'Translate':
            out['missing'].append({'key': r['Key'], 'type': r['_type'], 'translate': r['Description'],
                                   'context': {'table': r.get('Table', ''), 'dax': r.get('DAX', ''),
                                               'origin': r.get('Origin', '')}})

    current = {r['Key'] for r in out['tables'] + out['columns'] + out['measures']}
    out['removed'] =[{'Key': k, 'Sheet': v.get('_sheet', ''), 'Description': v.get('Description') or '',
                       'Status': v.get('Status') or ''}
                      for k, v in prev.items() if k not in current]
    return out


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

def write_excel(cat, path, project, slots_source):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
    from openpyxl.worksheet.datavalidation import DataValidation

    dark = PatternFill('solid', fgColor='333333')
    teal = PatternFill('solid', fgColor='1FC8C0')
    edit_fill = PatternFill('solid', fgColor='FFF8DC')
    wb = Workbook()
    ws = wb.active
    ws.title = 'Overview'

    def status_count(rows):
        c = {s: 0 for s in STATUSES}
        for r in rows:
            c[r['Status']] = c.get(r['Status'], 0) + 1
        return c
    all_rows = cat['tables'] + cat['columns'] + cat['measures']
    sc = status_count(all_rows)
    lines = [
        ('Data catalog', project),
        ('Generated', datetime.datetime.now().strftime('%Y-%m-%d %H:%M')),
        ('', ''),
        ('Tables', len(cat['tables'])),
        ('Columns', len(cat['columns'])),
        ('Measures', len(cat['measures'])),
        ('Relationships', len(cat['relationships'])),
        ('Dashboard fields', f"{len(cat['slots'])} ({slots_source})"),
        ('', ''),
        ('Descriptions', ''),
    ] + [(f'  {s}', n) for s, n in sc.items()] + [
        ('', ''),
        ('Removed since last run', len(cat['removed'])),
        ('Changes since last run', len(cat.get('changes', [])) if cat.get('changesSince') else 'first run'),
        ('', ''),
        ('How to edit', 'Edit only the teal columns (Description, Owner, Sensitivity, Upstream source, Status).'),
        ('', 'Set Status = Approved when a description may be written back to the model (/// description in TMDL).'),
        ('', 'The next run reads your edits and merges them in - they are never overwritten.'),
        ('Status values', ' · '.join(STATUSES)),
        ('', 'Translate = the description in the model is not in English; an English AI suggestion replaces it.'),
    ]
    for r in lines:
        ws.append(list(r))
    ws['A1'].font = Font(bold=True, size=14)
    ws.column_dimensions['A'].width = 24
    ws.column_dimensions['B'].width = 100

    def sheet(name, rows, cols, wide=()):
        s = wb.create_sheet(name)
        s.append(cols)
        for r in rows:
            s.append([r.get(c, '') for c in cols])
        for i, c in enumerate(cols, 1):
            cell = s.cell(row=1, column=i)
            cell.font = Font(bold=True, color='FFFFFF' if c not in EDITABLE else '252423')
            cell.fill = teal if c in EDITABLE else dark
            width = 60 if c in wide else min(45, max(10, len(c) + 2,
                                                       *(len(str(r.get(c, '')))
                                                         for r in rows[:200]) if rows else [10]))
            s.column_dimensions[get_column_letter(i)].width = width
            if c in EDITABLE or c in wide:
                for row in range(2, len(rows) + 2):
                    cell = s.cell(row=row, column=i)
                    cell.alignment = Alignment(wrap_text=True, vertical='top')
                    if c in EDITABLE:
                        cell.fill = edit_fill
        if 'Status' in cols and rows:
            col = get_column_letter(cols.index('Status') + 1)
            dv = DataValidation(type='list', formula1='"' + ','.join(STATUSES) + '"', allow_blank=True)
            s.add_data_validation(dv)
            dv.add(f'{col}2:{col}{len(rows) + 1}')
        s.freeze_panes = 'B2' if 'Key' in cols else 'A2'
        if rows:
            s.auto_filter.ref = f'A1:{get_column_letter(len(cols))}{len(rows) + 1}'
        return s

    tail = EDITABLE + ['Description source']
    sheet('Tables', cat['tables'],
          ['Key', 'Type', 'Hidden', 'Columns', 'Measures', 'Source', 'Source objects',
           'Upstream queries', 'Query group', 'Storage', 'Dashboard (indirect)'] + tail + [UPSTREAM_AUTO],
          wide=('Description', 'Upstream source'))
    sheet('Columns', cat['columns'],
          ['Key', 'Table', 'Column', 'Data type', 'Format', 'Hidden', 'Key field', 'Calculated',
           'Possible PII', 'Origin', 'Source', 'Power Query steps', 'DAX', 'Dashboard slot',
           'Dashboard (indirect)', 'Used in report'] + tail + [UPSTREAM_AUTO],
          wide=('Description', 'Power Query steps', 'DAX', 'Upstream source'))
    sheet('Measures', cat['measures'],
          ['Key', 'Table', 'Measure', 'Folder', 'Format', 'Hidden', 'DAX', 'Depends on measures',
           'Depends on columns', 'All source columns', 'Used by measures', 'Dashboard slot',
           'Dashboard (indirect)', 'Used in report'] + tail,
          wide=('Description', 'DAX', 'All source columns'))
    sheet('Dashboard', cat['slots'],
          ['Slot', 'Role', 'Field', 'Type', 'Title', 'Description', 'Source columns'],
          wide=('Description', 'Source columns'))
    sheet('Relationships', cat['relationships'], ['From', 'To', 'Cardinality', 'Cross filter', 'Active'])
    sheet('Sources', cat['sources'], ['Type', 'Name', 'Details', 'Used by', 'Query group', 'Description'],
          wide=('Details', 'Description'))
    if cat.get('changes'):
        sheet('Changes', cat['changes'], ['Change', 'Sheet', 'Key', 'Field', 'Before', 'After'],
              wide=('Before', 'After'))
    if cat['removed']:
        sheet('Removed', cat['removed'], ['Key', 'Sheet', 'Description', 'Status'], wide=('Description',))
    wb.save(path)


# fields compared between runs (descriptions included: they are what reviewers check)
DIFF_FIELDS = {
    'tables': ('Tables', ['Type', 'Source objects', 'Description', 'Status']),
    'columns': ('Columns', ['Data type', 'Format', 'Hidden', 'Origin', UPSTREAM_AUTO, 'Description', 'Status']),
    'measures': ('Measures', ['DAX', 'Format', 'Folder', 'Hidden', 'Description', 'Status']),
}


def diff_catalog(old, cat):
    """Rows for the 'Changes' sheet: new and changed items since the previous catalog.json.
    Removed items are listed in 'Removed' already."""
    out = []
    for part, (sheet_name, fields) in DIFF_FIELDS.items():
        before = {r['Key']: r for r in old.get(part, [])}
        for r in cat[part]:
            o = before.get(r['Key'])
            if o is None:
                out.append({'Change': 'New', 'Sheet': sheet_name, 'Key': r['Key'], 'Field': '', 'Before': '',
                            'After': short(r.get('Description', ''), 120)})
                continue
            for f in fields:
                a, b = str(o.get(f) or '').strip(), str(r.get(f) or '').strip()
                if a != b:
                    out.append({'Change': 'Changed', 'Sheet': sheet_name, 'Key': r['Key'], 'Field': f,
                                'Before': a, 'After': b})
    return out


# ---------------------------------------------------------------------------
# Mermaid lineage
# ---------------------------------------------------------------------------

class Mermaid:
    def __init__(self):
        self.ids, self.nodes, self.edges, self.classes = {}, [], [], {}

    def node(self, key, label, cls, shape='box'):
        if key not in self.ids:
            nid = f'n{len(self.ids)}'
            self.ids[key] = nid
            lab = str(label).replace('"', '#quot;').replace('\n', ' ')
            open_, close = {'box': ('["', '"]'), 'round': ('("', '")'),
                            'stadium': ('(["', '"])'), 'hex': ('{{"', '"}}')}[shape]
            self.nodes.append(f'    {nid}{open_}{lab}{close}')
            self.classes.setdefault(cls, []).append(nid)
        return self.ids[key]

    def edge(self, a, b, label=''):
        e = f'    {a} -->|{label}| {b}' if label else f'    {a} --> {b}'
        if e not in self.edges:
            self.edges.append(e)

    def render(self, fence):
        styles = {
            'src': 'fill:#252423,color:#FFFFFF,stroke:#252423',
            'qry': 'fill:#E1DFDD,color:#252423,stroke:#C8C6C4',
            'tbl': 'fill:#333333,color:#FFFFFF,stroke:#333333',
            'col': 'fill:#FFFFFF,color:#252423,stroke:#C8C6C4',
            'msr': 'fill:#1FC8C0,color:#252423,stroke:#1FC8C0',
            'slot': 'fill:#FDEDEF,color:#252423,stroke:#E36C78',
            'page': 'fill:#FDEDEF,color:#252423,stroke:#E36C78',
        }
        body = ['flowchart LR'] + self.nodes + self.edges
        body += [f'    classDef {c} {styles[c]}' for c in self.classes]
        body += [f'    class {",".join(ids)} {c}' for c, ids in self.classes.items()]
        if fence == 'azdo':
            return '::: mermaid\n' + '\n'.join(body) + '\n:::\n'
        return '```mermaid\n' + '\n'.join(body) + '\n```\n'


def write_lineage(parsed, cat, slots, path, fence, project):
    model, report = parsed['model'], parsed['report']
    tables = {t['name']: t for t in model['tables']}
    measure_table = {m['name']: t['name'] for t in model['tables'] for m in t['measures']}
    mdeps = {m['name']: m.get('dependencies', {}) for t in model['tables'] for m in t['measures']}
    exprs = {e['name']: e for e in model.get('expressions', [])}
    out = [f'# Data lineage – {project}', '',
           f"Generated {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} by pbip-catalog. "
           'Colours: black = data source, grey = Power Query, dark = table, white = column, '
           'teal = measure, pink = dashboard.', '']
    if fence == 'azdo':
        out += ['[[_TOC_]]', '']

    # 1. overview
    mm = Mermaid()
    for e in exprs.values():
        if e['kind'] != 'query':
            continue
        q = mm.node('q:' + e['name'], e['name'], 'qry', 'round')
        src = e.get('resolvedSource') or {}
        if src.get('kind') not in (None, 'Other', 'Unknown') and not any(r in exprs and exprs[r]['kind'] == 'query' for r in e.get('references', [])):
            s = mm.node('s:' + source_text(src), source_text(src), 'src', 'stadium')
            mm.edge(s, q)
        for r in e.get('references', []):
            if r in exprs and exprs[r]['kind'] == 'query':
                mm.edge(mm.node('q:' + r, r, 'qry', 'round'), q)
    for t in model['tables']:
        tid = mm.node('t:' + t['name'], t['name'], 'tbl')
        part = next(iter(t['partitions']), {})
        refs = part.get('references', [])
        query_refs = [r for r in refs if r in exprs and exprs[r]['kind'] == 'query']
        table_refs = [r for r in refs if r in tables]
        for r in query_refs:
            mm.edge(mm.node('q:' + r, r, 'qry', 'round'), tid)
        for r in table_refs:
            mm.edge(mm.node('t:' + r, r, 'tbl'), tid)
        if not query_refs and not table_refs:
            src = part.get('resolvedSource') or {}
            if src.get('kind') not in (None, 'Other', 'Unknown'):
                mm.edge(mm.node('s:' + source_text(src), source_text(src), 'src', 'stadium'), tid)
    for page in report.get('pages', []):
        used = set()
        for v in page.get('visuals', []):
            for r in v.get('fieldRefs', []):
                if r['kind'] == 'Measure' and r['name'] in mdeps:
                    used.add(measure_table[r['name']])
                    stack, seen = [r['name']], set()
                    while stack:
                        m = stack.pop()
                        if m in seen:
                            continue
                        seen.add(m)
                        d = mdeps.get(m, {})
                        stack += d.get('measures', [])
                        used |= {c['table'] for c in d.get('columns', [])} | set(d.get('tables', []))
                else:
                    used.add(r['table'])
        if used:
            pid = mm.node('p:' + page['name'], f"Page: {page.get('displayName', page['name'])}", 'page', 'hex')
            for tname in sorted(used):
                if tname in tables:
                    mm.edge(mm.ids.get('t:' + tname) or mm.node('t:' + tname, tname, 'tbl'), pid)
    out += ['## Overview (table level)', '',
            'Data sources → shared Power Query queries → tables → report pages.', '', mm.render(fence)]

    # 2. per dashboard slot
    if slots:
        out += ['## Dashboard slots', '',
                'One graph per slot on the dashboard page from pbip-layout: measure → dependent measures → '
                'columns → origin in the source.', '']
        col_rows = {r['Key']: r for r in cat['columns']}
        by_slot = {}
        for s in slots:
            by_slot.setdefault(s['slot'], []).append(s)
        for slot, items in by_slot.items():
            mm = Mermaid()
            sid = mm.node('slot', slot, 'slot', 'hex')
            used_cols = set()

            def add_measure(name, parent, seen):
                if name in seen:
                    return mm.ids.get('m:' + name)
                seen.add(name)
                mid = mm.node('m:' + name, f'[{name}]', 'msr', 'round')
                mm.edge(mid, parent)
                d = mdeps.get(name, {})
                for dm in d.get('measures', []):
                    add_measure(dm, mid, seen)
                for c in d.get('columns', []):
                    add_column(fkey(c['table'], c['column']), mid)
                for tb in d.get('tables', []):
                    mm.edge(mm.node('t:' + tb, tb, 'tbl'), mid)
                return mid

            def add_column(key, parent):
                cid = mm.node('c:' + key, key, 'col')
                mm.edge(cid, parent)
                used_cols.add(key)
                r = col_rows.get(key)
                if r and r.get('Origin') and not r['Origin'].startswith('Calculated'):
                    oid = mm.node('o:' + r['Origin'], r['Origin'], 'src', 'stadium')
                    mm.edge(oid, cid)
            seen = set()
            for it in items:
                t, n = parse_fkey(it['field'])
                if n in mdeps:
                    add_measure(n, sid, seen)
                else:
                    add_column(it['field'], sid)
            out += [f'### {slot}', '', mm.render(fence)]
            rows = [col_rows[k] for k in sorted(used_cols) if k in col_rows]
            if rows:
                out += ['| Column | Origin | Power Query steps |', '|---|---|---|']
                for r in rows:
                    out.append(f"| `{r['Key']}` | {md(r['Origin'])} | {md(r['Power Query steps']) or '–'} |")
                out.append('')

    # 3. column lineage per table
    out += ['## Column lineage per table', '']
    for t in model['tables']:
        rows = [r for r in cat['columns'] if r['Table'] == t['name']]
        if not rows:
            continue
        out += ['<details>', f"<summary><b>{t['name']}</b> ({len(rows)} columns)</summary>", '',
                '| Column | Origin | Power Query steps / DAX |', '|---|---|---|']
        for r in rows:
            out.append(f"| `{r['Column']}` | {md(r['Origin'])} | {md(r['DAX'] or r['Power Query steps']) or '–'} |")
        out += ['', '</details>', '']
    Path(path).write_text('\n'.join(out), encoding='utf-8')


def md(s):
    return str(s or '').replace('|', '\\|').replace('\n', ' ')


# ---------------------------------------------------------------------------
# DBML (dbdiagram.io / dbdocs.io)
# ---------------------------------------------------------------------------

def dq(name):
    return '"' + str(name).replace('\\', '\\\\').replace('"', '\\"') + '"'


def sq(text):
    return "'" + re.sub(r'\s+', ' ', str(text or '')).strip().replace('\\', '\\\\').replace("'", "\\'") + "'"


def tq(text):
    return "'''" + str(text or '').replace('\\', '\\\\').replace("'''", "\\'''") + "'''"


GROUP_COLORS = {'Fact': '#333333', 'Dimension': '#605E5C', 'Date': '#252423',
                'Bridge': '#605E5C', 'Measures': '#1FC8C0', 'Helper': '#C8C6C4'}


def write_dbml(parsed, cat, path, project):
    model = parsed['model']
    rels = model['relationships']
    trows = {r['Key']: r for r in cat['tables']}
    crows = {r['Key']: r for r in cat['columns']}
    mrows = {r['Key']: r for r in cat['measures']}
    out = [f'// Generated by pbip-catalog {datetime.date.today().isoformat()} – edit descriptions in catalog.xlsx',
           f'Project {dq(project)} {{', "  database_type: 'Power BI'",
           '  Note: ' + tq(f'Power BI semantic model "{project}". Tables, columns and measures with '
                           'descriptions, origin and dashboard slots in the notes.'), '}', '']
    groups = {}
    for t in model['tables']:
        tr = trows[t['name']]
        ttype = tr['Type']
        groups.setdefault(ttype, []).append(t['name'])
        pk = next((c['name'] for c in t['columns'] if c.get('isKey')), None) or \
            next((r['to']['column'] for r in rels if r['to']['table'] == t['name']), None)
        out.append(f"Table {dq(t['name'])} [headercolor: {GROUP_COLORS.get(ttype, '#C8C6C4')}] {{")
        for c in t['columns']:
            row = crows.get(fkey(t['name'], c['name']))
            if not row:
                continue
            settings = []
            if c['name'] == pk:
                settings.append('pk')
            note = [row['Description']]
            if c['isHidden']:
                note.append('Hidden')
            if c.get('isCalculated'):
                note.append('Calculated (DAX): ' + short(c.get('expression', ''), 200))
            elif row['Origin']:
                note.append('Origin: ' + row['Origin'])
            if row['Possible PII'].startswith('Yes'):
                note.append('Possible PII')
            if row['Dashboard slot']:
                note.append('Dashboard: ' + row['Dashboard slot'])
            note = ' · '.join(x for x in note if x)
            if note:
                settings.append('note: ' + sq(note))
            dtype = re.sub(r'\W', '', c.get('dataType') or 'unknown') or 'unknown'
            out.append(f"  {dq(c['name'])} {dtype}" + (f" [{', '.join(settings)}]" if settings else ''))
        for m in t['measures']:
            row = mrows[fkey(t['name'], m['name'])]
            note = [row['Description'], 'DAX: ' + short(m.get('expression', ''), 300)]
            if row['Dashboard slot']:
                note.append('Dashboard: ' + row['Dashboard slot'])
            elif row['Dashboard (indirect)']:
                note.append('Used indirectly in: ' + row['Dashboard (indirect)'])
            out.append(f"  {dq(m['name'])} measure [note: {sq(' · '.join(x for x in note if x))}]")
        tnote = [tr['Description'], f'Type: {ttype}']
        if tr['Source']:
            tnote.append(f"Source: {tr['Source']}")
        if tr['Source objects']:
            tnote.append(f"Source objects: {tr['Source objects']}")
        if tr['Upstream queries']:
            tnote.append(f"Power Query: {tr['Upstream queries']}")
        inactive = [f"{r['from']['column']} → {r['to']['table']}.{r['to']['column']}"
                    for r in rels if r['from']['table'] == t['name'] and not r.get('active', True)]
        if inactive:
            tnote.append('Inactive relationships (USERELATIONSHIP): ' + '; '.join(inactive))
        both = [f"{r['from']['column']} ↔ {r['to']['table']}.{r['to']['column']}"
                for r in rels if r['from']['table'] == t['name']
                and str(r.get('crossFilter', '')).lower().startswith('both')]
        if both:
            tnote.append('Cross filter both directions: ' + '; '.join(both))
        if tr['Dashboard (indirect)']:
            tnote.append(f"Dashboard: {tr['Dashboard (indirect)']}")
        if not t['columns'] and not t['measures']:
            out.append('  "(no columns)" unknown')
        out += ['', '  Note: ' + tq('\n'.join(x for x in tnote if x)), '}', '']
    for g in ('Fact', 'Bridge', 'Dimension', 'Date', 'Measures', 'Helper'):
        if groups.get(g):
            out.append(f'TableGroup {dq(g)} {{')
            out += [f'  {dq(t)}' for t in groups[g]]
            out += ['}', '']
    for r in rels:
        op = {('many', 'one'): '>', ('one', 'many'): '<', ('one', 'one'): '-',
              ('many', 'many'): '<>'}.get((r.get('fromCardinality', 'many'), r.get('toCardinality', 'one')), '>')
        flags = []
        if not r.get('active', True):
            flags.append('inactive (USERELATIONSHIP)')
        if str(r.get('crossFilter', '')).lower().startswith('both'):
            flags.append('cross filter both directions')
        comment = f"  // {', '.join(flags)}" if flags else ''
        out.append(f"Ref: {dq(r['from']['table'])}.{dq(r['from']['column'])} {op} "
                   f"{dq(r['to']['table'])}.{dq(r['to']['column'])}{comment}")
    Path(path).write_text('\n'.join(out) + '\n', encoding='utf-8')


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pbip')
    ap.add_argument('--out')
    ap.add_argument('--layout-config')
    ap.add_argument('--previous')
    ap.add_argument('--ai-descriptions')
    ap.add_argument('--fence', choices=['azdo', 'github'], default='azdo')
    ap.add_argument('--parser')
    ap.add_argument('--sql', nargs='+', default=[],
                    help='SQL files or folders (views, INSERT ... SELECT) for Upstream source')
    ap.add_argument('--no-dbml', action='store_true',
                    help='do not write model.dbml (the dbdiagram.io data model is optional)')
    ap.add_argument('--html', action='store_true',
                    help='also write lineage.html: table-level lineage overview (files → layers → model → pages)')
    ap.add_argument('--missing-only', action='store_true',
                    help='only write missing_descriptions.json (no Excel, lineage, DBML or catalog.json) – a fast '
                         'first run when AI descriptions and the full run follow right after')
    a = ap.parse_args()

    pbip = Path(a.pbip).resolve()
    out = Path(a.out).resolve() if a.out else pbip / 'docs'
    out.mkdir(parents=True, exist_ok=True)
    parser, parser_path = load_parser(a.parser)
    parsed = {'model': parser.parse_model(pbip), 'report': parser.parse_report(pbip)}
    project = parsed['model']['name'] or pbip.name

    cfg_path = Path(a.layout_config) if a.layout_config else out / 'layout-config.json'
    if cfg_path.is_file():
        slots = slots_from_config(json.loads(cfg_path.read_text(encoding='utf-8')))
        slots_source = f'from {cfg_path.name}'
    else:
        tpl_ids = template_page_ids()
        tpl_pages = [p for p in parsed['report'].get('pages', []) if p['name'] in tpl_ids]
        page = next((p for p in parsed['report'].get('pages', []) if p['name'] == LAYOUT_PAGE_ID), None)
        if tpl_pages:
            # pbip-layout template pages: every field on a page is tagged with the page's name
            slots = [{'slot': tpl_ids[p['name']], 'field': fkey(r['table'], r['name']),
                      'role': ROLE_DA.get(r['role'], r['role']), 'label': v.get('title', '')}
                     for p in tpl_pages for v in p['visuals'] for r in v.get('fieldRefs', [])]
            slots_source = 'derived from the template pages'
        else:
            slots = slots_from_page(page) if page else []
            slots_source = 'derived from the dashboard page' if page else 'no pbip-layout page found'

    xlsx = out / 'catalog.xlsx'
    prev_path = Path(a.previous) if a.previous else xlsx
    prev = read_previous(prev_path)
    ai = json.loads(Path(a.ai_descriptions).read_text(encoding='utf-8')) if a.ai_descriptions else {}

    pii_reason = getattr(parser, 'pii_reason', None) or \
        (lambda col, table: 'name pattern' if parser.is_pii(col) else '')
    sql = None
    if a.sql:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from sql_lineage import SqlLineage
        sql = SqlLineage().load(a.sql)
    cat = build(parsed, slots, prev, ai, pii_reason, sql)
    if a.missing_only:
        # openpyxl (seconds to import on Windows) is only needed when there is a previous catalog.xlsx
        (out / 'missing_descriptions.json').write_text(
            json.dumps(cat['missing'], indent=2, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'project': project, 'out': str(out), 'missingOnly': True,
                          'missingDescriptions': len(cat['missing'])}, indent=2, ensure_ascii=False))
        return
    old_json = out / 'catalog.json'
    cat['changes'], cat['changesSince'] = [], ''
    if old_json.is_file():
        try:
            old = json.loads(old_json.read_text(encoding='utf-8-sig'))
            cat['changes'], cat['changesSince'] = diff_catalog(old, cat), old.get('generated', '')
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f'build_catalog: could not compare with the previous catalog.json ({e})', file=sys.stderr)
    if xlsx.is_file():
        shutil.copy2(xlsx, out / 'catalog.backup.xlsx')
    write_excel(cat, xlsx, project, slots_source)
    write_lineage(parsed, cat, slots, out / 'lineage.md', a.fence, project)
    if not a.no_dbml:
        write_dbml(parsed, cat, out / 'model.dbml', project)
    html_info = None
    if a.html:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from lineage_html import write_lineage_html
        html_info = write_lineage_html(parsed, cat, sql, out / 'lineage.html', project,
                                       (_file_label, _nav_items, column_objects))
    strip =lambda rows: [{k: v for k, v in r.items() if not k.startswith('_')} for r in rows]  # noqa: E731
    (out / 'catalog.json').write_text(json.dumps({
        'project': project, 'generated': datetime.datetime.now().isoformat(timespec='seconds'),
        'slotsSource': slots_source,
        **{k: strip(v) if isinstance(v, list) else v for k, v in cat.items() if k != 'missing'},
    }, indent=2, ensure_ascii=False), encoding='utf-8')
    (out / 'missing_descriptions.json').write_text(
        json.dumps(cat['missing'], indent=2, ensure_ascii=False), encoding='utf-8')

    rows = cat['tables'] + cat['columns'] + cat['measures']
    counts = {s: sum(1 for r in rows if r['Status'] == s) for s in STATUSES}
    print(json.dumps({
        'project': project, 'out': str(out), 'parser': parser_path,
        'tables': len(cat['tables']), 'columns': len(cat['columns']), 'measures': len(cat['measures']),
        'dashboardFields': len(cat['slots']), 'slotsSource': slots_source,
        'descriptionStatus': counts, 'missingDescriptions': len(cat['missing']),
        'removedSinceLastRun': len(cat['removed']),
        'changesSinceLastRun': len(cat['changes']) if cat['changesSince'] else None,
        'toTranslate': sum(1 for r in rows if r['Status'] == 'Translate'),
        'upstream': {
            'filled': sum(1 for r in cat['tables'] + cat['columns'] if r.get('Upstream source')),
            'auto': sum(1 for r in cat['tables'] + cat['columns']
                        if r.get('Upstream source') and r.get('Upstream source') == r.get(UPSTREAM_AUTO)),
            'of': len(cat['tables']) + len(cat['columns']),
            'sqlTargets': len(sql.tables) if sql else 0,
        },
        'lineageHtml': html_info,
    }, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    import sys
    # A redirected stream on Windows defaults to cp1252, which cannot write characters such as →.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding='utf-8')
    main()
