"""
lineage_html.py - table-level lineage as one self-contained HTML page (docs/lineage.html).

Columns are layers, left to right: files → database schemas (bronze, silver, gold …) → Power Query
queries → Power BI tables → report pages. A schema whose tables feed each other is split into steps
("silver · step 2"). Nodes in a column are grouped by the node they feed. Tables that feed nothing
further are drawn with a dashed red border. Click a node to highlight its whole path.

Called from build_catalog.py with --html. The page needs no server and no network.
"""

import datetime
import json
import re
from pathlib import Path

TEMPLATE = Path(__file__).resolve().parent.parent / 'assets' / 'lineage-template.html'

# rank = column order; database schemas are ranked by their name
RANK_FILE, RANK_PQ, RANK_MODEL, RANK_PAGE = 0, 6, 7, 8
LAYER_WORDS = [(('gold', 'mart'), 5, 'gold'), (('silver',), 4, 'silver'), (('stg', 'staging'), 3, 'stage'),
               (('bronze',), 2, 'bronze'), (('raw', 'landing'), 1, 'raw')]
COLORS = {'file': '#9aa0b4', 'raw': '#9aa0b4', 'bronze': '#d08f5e', 'stage': '#b9a6e8', 'silver': '#a99cf5',
          'gold': '#e8c547', 'db': '#6fb3d9', 'pq': '#7fc8a9', 'model': '#4fd1c5', 'page': '#f08fb0'}
KIND_TEXT = {'file': 'File', 'raw': 'Database', 'bronze': 'Bronze', 'stage': 'Staging', 'silver': 'Silver',
             'gold': 'Gold', 'db': 'Database', 'pq': 'Power Query', 'model': 'Power BI table',
             'page': 'Report page'}


def _norm(name):
    return re.sub(r'["\[\]`]', '', str(name or '')).strip().lower()


def _schema_layer(schema):
    s = schema.lower()
    for words, rank, kind in LAYER_WORDS:
        if any(w in s for w in words):
            return rank, kind
    return None, 'db'


def page_usage(model, report):
    """[(page name, display name, {tables})] – tables a page uses, incl. tables behind its measures."""
    measure_table = {m['name']: t['name'] for t in model['tables'] for m in t['measures']}
    mdeps = {m['name']: m.get('dependencies', {}) for t in model['tables'] for m in t['measures']}
    out = []
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
        out.append((page['name'], page.get('displayName', page['name']), used))
    return out


class Graph:
    def __init__(self):
        self.nodes, self.edges = {}, set()

    def node(self, nid, label, kind, rank, group, title='', desc='', ntype=''):
        if nid not in self.nodes:
            self.nodes[nid] = {'id': nid, 'label': label, 'kind': kind, 'rank': rank, 'group': group,
                               'title': title or label, 'desc': desc, 'type': ntype}
        return nid

    def edge(self, a, b):
        if a and b and a != b:
            self.edges.add((a, b))

    def db(self, name, sql=None):
        """Node for a database table/view; the column is its schema."""
        n = (sql.find_table(name) if sql else None) or _norm(name)
        schema, _, table = n.rpartition('.')
        if sql and n in sql.temp:
            schema = '(temp)'   # temp tables get their own column, placed after their sources
        rank, kind = _schema_layer(schema)
        return self.node('db:' + n, table, kind, rank, 'db:' + schema, n)


def build_graph(parsed, cat, sql, helpers):
    """helpers: functions from build_catalog (_file_label, _nav_items, column_objects)."""
    file_label, nav_items, column_objects = helpers
    model, report = parsed['model'], parsed['report']
    g = Graph()
    tables = {t['name']: t for t in model['tables']}
    queries = {e['name']: e for e in model.get('expressions', []) if e['kind'] == 'query'}
    trow = {r['Table']: r for r in cat['tables']}
    steps = {(e['name'], s['name']): s.get('expression', '')
             for e in model.get('expressions', []) for s in e.get('steps', [])}
    for t in model['tables']:
        for p in t['partitions']:
            for s in p.get('steps', []):
                steps[(t['name'], s['name'])] = s.get('expression', '')

    files = set()

    def file_node(fname, item=''):
        files.add(fname)
        nid = f'f:{fname} › {item}' if item else 'f:' + fname
        return g.node(nid, item or fname, 'file', RANK_FILE, 'files', f'{fname} › {item}' if item else fname)

    def source_of(obj, src):
        """Node for a Power Query source object: SQL table, schema.table or file › sheet."""
        if sql and sql.find_table(obj):
            return g.db(obj, sql)
        f = file_label(src)
        if f:
            return file_node(f, re.sub(r'\s*\((?:Sheet|Table|DefinedName)\)$', '', obj))
        if '.' in obj:
            return g.db(obj)
        return None

    # 1. database layers from the SQL files
    if sql:
        for t, info in sql.tables.items():
            tid = g.db(t, sql)
            for s in info.get('sources', set()):
                if s.split('.')[-1] == 'raw_lines' and info.get('csv_file'):
                    g.edge(file_node(info['csv_file'] + '.csv'), tid)
                else:
                    g.edge(g.db(s, sql), tid)

    # 2. shared Power Query queries (skip connection hubs: no navigation, no query references)
    def query_node(name, seen=()):
        q = queries.get(name)
        if not q or name in seen:
            return None
        items = nav_items(q.get('mExpression', ''))
        qrefs = [r for r in q.get('references', []) if r in queries]
        ups = [u for u in (query_node(r, seen + (name,)) for r in qrefs) if u]
        if not items and not ups:
            return None
        qid = g.node('q:' + name, name, 'pq', RANK_PQ, 'pq')
        for u in ups:
            g.edge(u, qid)
        for it in items:
            g.edge(source_of(it, q.get('resolvedSource')), qid)
        return qid

    # 3. Power BI tables
    for t in model['tables']:
        row = trow.get(t['name'], {})
        tid = g.node('t:' + t['name'], t['name'], 'model', RANK_MODEL, 'model',
                     desc=row.get('Description', ''), ntype=row.get('Type', ''))
        part = next(iter(t['partitions']), {})
        refs = part.get('references', [])
        via_query = set()
        for r in refs:
            if r in tables:
                g.edge('t:' + r, tid)
            elif r in queries:
                qid = query_node(r)
                if qid:
                    g.edge(qid, tid)
                    via_query |= set(nav_items(queries[r].get('mExpression', '')))
        for c in t['columns']:
            o = c.get('origin') or {}
            if o.get('kind') != 'source' or not o.get('object'):
                continue
            objs = column_objects(c, steps) if file_label(o.get('source')) else [o['object']]
            for obj in objs:
                if obj in via_query or re.sub(r'\s*\(\w+\)$', '', obj) in via_query:
                    continue
                g.edge(source_of(obj, o.get('source')), tid)

    # 4. report pages
    for name, display, used in page_usage(model, report):
        if not used:
            continue
        pid = g.node('p:' + name, display, 'page', RANK_PAGE, 'pages')
        for tname in sorted(used):
            if tname in tables:
                g.edge('t:' + tname, pid)
    return g, files


def layout_columns(g, files):
    nodes, edges = g.nodes, g.edges
    ins = {n: [] for n in nodes}
    for a, b in edges:
        if a in nodes and b in nodes:
            ins[b].append(a)
    # schemas without a layer word: one step right of their sources
    for _ in range(len(nodes)):
        changed = False
        for n in nodes.values():
            if n['rank'] is None or (n['kind'] == 'db' and n.get('_free', True)):
                n['_free'] = True
                srcs = [nodes[s]['rank'] for s in ins[n['id']] if nodes[s]['rank'] is not None and s != n['id']]
                r = min(5.5, max(srcs) + 0.5) if srcs else 4.5
                if n['rank'] != r:
                    n['rank'], changed = r, True
        if not changed:
            break
    # one schema/group can need several steps when its tables feed each other
    depth = {n: 0 for n in nodes}
    for _ in range(len(nodes)):
        changed = False
        for b, srcs in ins.items():
            d = max([depth[a] + 1 for a in srcs if nodes[a]['group'] == nodes[b]['group']] + [0])
            if d != depth[b] and d < 50:
                depth[b], changed = d, True
        if not changed:
            break
    cols = {}
    for n in nodes.values():
        key = (n['rank'], n['group'], depth[n['id']])
        cols.setdefault(key, []).append(n)
    out = []
    for i, key in enumerate(sorted(cols, key=lambda k: (k[0], k[1], k[2]))):
        rank, group, d = key
        kind = cols[key][0]['kind']
        if group == 'files':
            title = next(iter(files)) if len(files) == 1 and kind == 'file' else 'Files'
            if len(files) == 1:
                for n in cols[key]:
                    if ' › ' in n['title']:
                        n['label'] = n['title'].split(' › ', 1)[1]
            unit = 'files' if all(' › ' not in n['title'] for n in cols[key]) else 'sources'
        elif group == 'pq':
            title, unit = 'Power Query', 'queries'
        elif group == 'model':
            title, unit = 'Power BI model', 'tables'
        elif group == 'pages':
            title, unit = 'Report', 'pages'
        elif group == 'db:(temp)':
            title, unit = 'temp tables', 'tables'
        else:
            title, unit = group[3:] or 'database', 'tables'
        if d:
            title += f' · step {d + 1}'
        out.append({'id': i, 'title': title, 'unit': unit, 'count': len(cols[key])})
        for n in cols[key]:
            n['col'] = i
    return out


def write_lineage_html(parsed, cat, sql, path, project, helpers):
    g, files = build_graph(parsed, cat, sql, helpers)
    columns = layout_columns(g, files)
    has_out = {a for a, b in g.edges}
    has_pages = any(n['kind'] == 'page' for n in g.nodes.values())
    nodes = []
    for n in g.nodes.values():
        # without report pages there is nothing to judge model tables against
        unused = n['kind'] != 'page' and n['id'] not in has_out and (n['kind'] != 'model' or has_pages)
        nodes.append({
            'id': n['id'], 'label': n['label'], 'col': n['col'], 'kind': KIND_TEXT[n['kind']],
            'color': COLORS[n['kind']], 'title': n['title'], 'desc': n['desc'], 'type': n['type'],
            'unused': unused,
            'unusedText': ('Not used on any report page' if n['kind'] == 'model'
                           else 'No SQL or Power Query that was read uses it further') if unused else '',
        })
    data = {
        'project': project,
        'generated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
        'sqlUsed': bool(sql),
        'columns': columns,
        'nodes': nodes,
        'edges': sorted([a, b] for a, b in g.edges if a in g.nodes and b in g.nodes),
    }
    blob = json.dumps(data, ensure_ascii=False).replace('</', '<\\/')
    html = TEMPLATE.read_text(encoding='utf-8')
    html = html.replace('__PROJECT__', re.sub(r'[<>&"]', '', project))
    html = html.replace('/*__DATA__*/{}', blob)
    Path(path).write_text(html, encoding='utf-8')
    return {'columns': len(columns), 'nodes': len(nodes), 'edges': len(data['edges']),
            'unused': sum(1 for n in nodes if n['unused'])}
