#!/usr/bin/env python3
"""
generate_azdo_wiki.py — Generate an Azure DevOps wiki bundle from parsed PBIP data.

Usage:
    python3 generate_azdo_wiki.py <parsed_json_file> [--output /path/to/output.zip]
    # or pipe from parse_pbip.py:
    python3 parse_pbip.py /path/to/pbip | python3 generate_azdo_wiki.py - --output out.zip
"""

import datetime
import json
import re
import sys
import zipfile
from io import BytesIO
from pathlib import Path

# Share PII patterns with the parser
sys.path.insert(0, str(Path(__file__).parent))
from parse_pbip import identify_m_source, is_pii, pii_reason  # noqa: E402


def wiki_filename(name):
    """AzDO wiki page filename conventions: no # ? : * " < > | \\ /"""
    s = re.sub(r'[#?:*"<>|\\/]', '', str(name))
    s = re.sub(r'\s+', '-', s)
    s = re.sub(r'-+', '-', s)
    s = s.strip('-')
    return s or 'untitled'


def mermaid_label(label):
    return str(label).replace('"', '#quot;').replace('\n', ' ')


def count_pii(model):
    n = 0
    for t in model['tables']:
        for c in t['columns']:
            if is_pii(c['name'], t['name']):
                n += 1
    return n


def build_mermaid_relationships(model):
    if not model['relationships']:
        return ''

    dim_nodes, fact_nodes, hidden_nodes = [], [], []
    for t in model['tables']:
        tid = 't_' + wiki_filename(t['name']).replace('-', '_')
        if t['isHidden']:
            hidden_nodes.append(tid)
        elif re.match(r'^(dim|d_|lkp)|dim|date|calendar|kalender', t['name'], re.IGNORECASE):
            dim_nodes.append(tid)
        else:
            fact_nodes.append(tid)

    node_defs = []
    seen = set()
    for t in model['tables']:
        tid = 't_' + wiki_filename(t['name']).replace('-', '_')
        if tid not in seen:
            node_defs.append(f'    {tid}["{mermaid_label(t["name"])}"]')
            seen.add(tid)

    body = ':::mermaid\nflowchart LR\n' + '\n'.join(node_defs) + '\n'
    for rel in model['relationships']:
        fid = 't_' + wiki_filename(rel['from']['table']).replace('-', '_')
        tid = 't_' + wiki_filename(rel['to']['table']).replace('-', '_')
        arrow = '<-->' if rel['crossFilter'] == 'bothDirections' else '-->'
        label = '|inactive|' if not rel.get('active', True) else ''
        body += f'    {fid} {arrow}{label} {tid}\n'

    body += '    classDef dim fill:#bfdbfe,stroke:#111827,color:#111827\n'
    body += '    classDef fact fill:#111827,stroke:#111827,color:#ffffff\n'
    body += '    classDef hidden fill:#f3f4f6,stroke:#b45309,color:#6b7280,stroke-dasharray: 3 3\n'
    if dim_nodes:
        body += f'    class {",".join(dim_nodes)} dim\n'
    if fact_nodes:
        body += f'    class {",".join(fact_nodes)} fact\n'
    if hidden_nodes:
        body += f'    class {",".join(hidden_nodes)} hidden\n'
    body += ':::\n'
    return body


def build_mermaid_lineage(model, report):
    if not model['tables']:
        return ''

    src_nodes, table_nodes, page_nodes = [], [], []
    edges = []
    referenced_tables = set()

    for i, s in enumerate(model['dataSources']):
        sid = f's_{i}'
        details = s['details']
        if len(details) > 40:
            details = details[:37] + '...'
        label = f'{s["kind"]}<br/>{details}'
        src_nodes.append(f'{sid}["{mermaid_label(label)}"]')
        for tname in s['tables']:
            tid = 't_' + wiki_filename(tname).replace('-', '_')
            edges.append(f'{sid} --> {tid}')
            referenced_tables.add(tname)

    if report and report.get('pages'):
        for pi, p in enumerate(report['pages']):
            pid = f'p_{pi}'
            page_nodes.append(f'{pid}(["{mermaid_label(p["displayName"])}"])')
            tables_on_page = set()
            for v in p['visuals']:
                for f in v['fields']:
                    if '.' in f:
                        tname = f.split('.', 1)[0]
                        tables_on_page.add(tname)
                        referenced_tables.add(tname)
            for tname in tables_on_page:
                tid = 't_' + wiki_filename(tname).replace('-', '_')
                edges.append(f'{tid} --> {pid}')

    for t in model['tables']:
        if t['name'] in referenced_tables:
            tid = 't_' + wiki_filename(t['name']).replace('-', '_')
            table_nodes.append(f'{tid}["{mermaid_label(t["name"])}"]')

    body = ':::mermaid\nflowchart LR\n'
    if src_nodes:
        body += '    subgraph SOURCES["Data Sources"]\n        ' + '\n        '.join(src_nodes) + '\n    end\n'
    if table_nodes:
        body += '    subgraph MODEL["Semantic Model"]\n        ' + '\n        '.join(table_nodes) + '\n    end\n'
    if page_nodes:
        body += '    subgraph REPORT["Report Pages"]\n        ' + '\n        '.join(page_nodes) + '\n    end\n'
    body += '\n'.join(f'    {e}' for e in edges) + '\n'
    body += '    classDef src fill:#0f766e,stroke:#111827,color:#ffffff\n'
    body += '    classDef tbl fill:#111827,stroke:#111827,color:#ffffff\n'
    body += '    classDef pg fill:#2563eb,stroke:#111827,color:#ffffff\n'
    if src_nodes:
        body += f'    class {",".join(f"s_{i}" for i in range(len(src_nodes)))} src\n'
    if table_nodes:
        ids = ['t_' + wiki_filename(t['name']).replace('-', '_')
               for t in model['tables'] if t['name'] in referenced_tables]
        body += f'    class {",".join(ids)} tbl\n'
    if page_nodes:
        body += f'    class {",".join(f"p_{i}" for i in range(len(page_nodes)))} pg\n'
    body += ':::\n'
    return body


def build_home_page(model, report):
    d = datetime.date.today().isoformat()
    pii_count = count_pii(model)
    total_measures = sum(len(t['measures']) for t in model['tables'])
    total_columns = sum(len(t['columns']) for t in model['tables'])
    total_visuals = sum(len(p['visuals']) for p in (report.get('pages', []) if report else []))

    md = f"# {model['name'] or 'Power BI Semantic Model'}\n\n"
    md += f"> Handover documentation — generated {d} by **PBIP Governance Inspector**\n\n"
    md += "[[_TOC_]]\n\n"
    md += "## Summary\n\n"
    md += "| Metric | Count |\n|---|---:|\n"
    md += f"| Tables | {len(model['tables'])} |\n"
    md += f"| Columns | {total_columns} |\n"
    md += f"| Measures | {total_measures} |\n"
    md += f"| Relationships | {len(model['relationships'])} |\n"
    md += f"| RLS roles | {len(model['roles'])} |\n"
    md += f"| Data sources | {len(model['dataSources'])} |\n"
    md += f"| Report pages | {len(report.get('pages', []) if report else [])} |\n"
    md += f"| Visuals | {total_visuals} |\n"
    warn = ':warning: ' if pii_count > 0 else ''
    md += f"| Potential PII columns | {warn}{pii_count} |\n\n"

    md += "## Governance snapshot\n\n"
    if pii_count > 0:
        plural = 's' if pii_count != 1 else ''
        md += f":warning: **{pii_count} potential PII column{plural} detected** — see [Governance](/Governance).\n\n"
    if model['roles']:
        plural = 's' if len(model['roles']) != 1 else ''
        md += f":warning: **{len(model['roles'])} RLS role{plural} configured** — see [Governance](/Governance).\n\n"
    if pii_count == 0 and not model['roles']:
        md += "No PII or RLS flags detected. :white_check_mark:\n\n"

    md += "## Table index\n\n"
    md += "| Table | Columns | Measures | Source | Mode |\n|---|---:|---:|---|---|\n"
    for t in model['tables']:
        part = t['partitions'][0] if t['partitions'] else None
        src = identify_m_source(part['mExpression']) if part else {'kind': '-', 'details': '-'}
        hidden = ' _(hidden)_' if t['isHidden'] else ''
        mode = part['mode'] if part else '-'
        md += f"| [{t['name']}](/Tables/{wiki_filename(t['name'])}){hidden} | {len(t['columns'])} | {len(t['measures'])} | {src['kind']} | {mode} |\n"
    md += "\n"

    md += "## All measures\n\n_Full DAX bodies on each table page._\n\n"
    all_measures = []
    for t in model['tables']:
        for me in t['measures']:
            all_measures.append({'table': t['name'], 'name': me['name'], 'folder': me.get('displayFolder', '')})
    all_measures.sort(key=lambda x: x['name'])
    if not all_measures:
        md += "_No measures._\n\n"
    else:
        md += "| Measure | Table | Display folder |\n|---|---|---|\n"
        for me in all_measures:
            anchor = wiki_filename(me['name']).lower()
            md += f"| [{me['name']}](/Tables/{wiki_filename(me['table'])}#{anchor}) | `{me['table']}` | {me['folder'] or '-'} |\n"
        md += "\n"
    return md


def build_governance_page(model):
    md = "# :shield: Governance\n\n[[_TOC_]]\n\n"
    piis = []
    for t in model['tables']:
        for c in t['columns']:
            if is_pii(c['name'], t['name']):
                matched = pii_reason(c['name'], t['name'])
                piis.append({'table': t['name'], 'col': c['name'],
                             'type': c.get('dataType', ''), 'hidden': c['isHidden'],
                             'matched': matched})

    md += "## :warning: Potential PII columns\n\n"
    md += "> Heuristic match against DA/EN field names. **Review manually before publishing** — false positives are expected.\n\n"
    if not piis:
        md += "No potential PII columns matched. :white_check_mark:\n\n"
    else:
        md += "| Table | Column | Match | Type | Visibility |\n|---|---|---|---|---|\n"
        for p in piis:
            vis = ':lock: hidden' if p['hidden'] else ':eye: **visible**'
            md += f"| `{p['table']}` | `{p['col']}` | `{p['matched']}` | {p['type'] or '-'} | {vis} |\n"
        md += "\n"

    md += "## :key: Row-Level Security roles\n\n"
    if not model['roles']:
        md += "No RLS roles defined in this model.\n\n"
    else:
        for role in model['roles']:
            md += f"### :warning: {role['name']}\n\n"
            md += f"- **Model permission:** `{role['modelPermission']}`\n"
            md += f"- **Table filters:** {len(role['tablePermissions'])}\n\n"
            for tp in role['tablePermissions']:
                md += f"<details><summary><b>{tp['table']}</b> — filter expression</summary>\n\n"
                md += f"```dax\n{tp['filter']}\n```\n\n</details>\n\n"
    return md


def build_lineage_page(model, report):
    md = "# :link: Data Lineage\n\n[[_TOC_]]\n\n"
    md += "## Relationships\n\n"
    md += "Each node is a table. Arrows follow the filter direction. Bidirectional relationships use `<-->`, inactive relationships are labeled `inactive`.\n\n"
    if not model['relationships']:
        md += "_No relationships._\n\n"
    else:
        md += build_mermaid_relationships(model) + '\n'

    md += "## Source → Table → Page\n\n"
    md += "End-to-end lineage from data sources through the semantic model to the report pages that consume them.\n\n"
    md += build_mermaid_lineage(model, report) + '\n'

    md += "## Relationships (table)\n\n"
    if not model['relationships']:
        md += "_None._\n\n"
    else:
        md += "| From | To | Cross-filter | Active |\n|---|---|---|---|\n"
        for rel in model['relationships']:
            active = ':white_check_mark:' if rel.get('active', True) else ':x:'
            md += f"| `{rel['from']['table']}[{rel['from']['column']}]` | `{rel['to']['table']}[{rel['to']['column']}]` | {rel['crossFilter']} | {active} |\n"
        md += "\n"
    return md


def build_data_sources_page(model):
    md = "# :cloud: Data Sources\n\n[[_TOC_]]\n\n_Extracted from Power Query M expressions._\n\n"
    if not model['dataSources']:
        md += "No data sources detected.\n"
        return md
    for s in model['dataSources']:
        md += f"## {s['kind']} — `{s['details']}`\n\n"
        tbl_links = ', '.join(f"[{t}](/Tables/{wiki_filename(t)})" for t in s['tables'])
        md += f"**Tables using this source:** {tbl_links}\n\n"
    return md


def build_table_page(t):
    md = f"# {t['name']}\n\n"
    if t['isHidden']:
        md += "> :lock: This table is **hidden** from report authors.\n\n"
    if t.get('description'):
        md += f"_{t['description']}_\n\n"
    md += "[[_TOC_]]\n\n"

    if t['partitions']:
        p = t['partitions'][0]
        src = identify_m_source(p['mExpression'])
        md += "## Source\n\n"
        md += f"- **Type:** {src['kind']}\n"
        md += f"- **Details:** `{src['details']}`\n"
        md += f"- **Storage mode:** `{p['mode']}`\n\n"
        if p['mExpression']:
            md += "<details><summary>M expression</summary>\n\n"
            md += f"```powerquery\n{p['mExpression']}\n```\n\n</details>\n\n"

    md += f"## Columns ({len(t['columns'])})\n\n"
    if not t['columns']:
        md += "_No columns._\n\n"
    else:
        md += "| Name | Type | Flags |\n|---|---|---|\n"
        for c in t['columns']:
            flags = []
            if c.get('isKey'):
                flags.append(':key: key')
            if c.get('isHidden'):
                flags.append(':lock: hidden')
            if c.get('isCalculated'):
                flags.append(':abacus: calculated')
            if is_pii(c['name'], t['name']):
                flags.append(':warning: **PII?**')
            md += f"| `{c['name']}` | {c.get('dataType', '-') or '-'} | {' · '.join(flags) or '-'} |\n"
        md += "\n"

    md += f"## Measures ({len(t['measures'])})\n\n"
    if not t['measures']:
        md += "_No measures._\n\n"
    else:
        for me in t['measures']:
            md += f"### {me['name']}\n\n"
            meta = []
            if me.get('displayFolder'):
                meta.append(f":file_folder: `{me['displayFolder']}`")
            if me.get('formatString'):
                meta.append(f"format: `{me['formatString']}`")
            if me.get('isHidden'):
                meta.append(':lock: hidden')
            if meta:
                md += ' · '.join(meta) + '\n\n'
            if me.get('description'):
                md += f"> {me['description']}\n\n"
            md += "<details><summary>DAX</summary>\n\n"
            md += f"```dax\n{me['expression'] or '(empty)'}\n```\n\n</details>\n\n"
    return md


def build_report_page(page):
    md = f"# :bar_chart: {page['displayName']}\n\n"
    md += f"- **Internal name:** `{page['name']}`\n"
    md += f"- **Visuals:** {len(page['visuals'])}\n\n"
    if not page['visuals']:
        md += "_Empty page._\n"
        return md
    md += "## Visuals\n\n"
    md += "| # | Type | Title | Fields |\n|---:|---|---|---|\n"
    for i, v in enumerate(page['visuals'], 1):
        fields = '_none_' if not v['fields'] else ', '.join(f'`{f}`' for f in v['fields'])
        md += f"| {i} | {v['type']} | {v['title'] or '-'} | {fields} |\n"
    md += "\n"
    return md


def build_zip(parsed, output_path=None):
    model = parsed['model']
    report = parsed.get('report', {'pages': []})

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Top-level .order
        zf.writestr('.order', '\n'.join(['Home', 'Governance', 'Lineage',
                                         'Data-Sources', 'Tables', 'Report-Pages']) + '\n')

        zf.writestr('Home.md', build_home_page(model, report))
        zf.writestr('Governance.md', build_governance_page(model))
        zf.writestr('Lineage.md', build_lineage_page(model, report))
        zf.writestr('Data-Sources.md', build_data_sources_page(model))

        # Tables
        table_order = []
        for t in model['tables']:
            fn = wiki_filename(t['name'])
            zf.writestr(f'Tables/{fn}.md', build_table_page(t))
            table_order.append(fn)
        zf.writestr('Tables/.order', '\n'.join(table_order) + '\n')

        tables_index = "# :page_facing_up: Tables\n\n[[_TOC_]]\n\n| Table | Columns | Measures | Hidden |\n|---|---:|---:|---|\n"
        for t in model['tables']:
            hidden = ':lock:' if t['isHidden'] else ''
            tables_index += f"| [{t['name']}](/Tables/{wiki_filename(t['name'])}) | {len(t['columns'])} | {len(t['measures'])} | {hidden} |\n"
        zf.writestr('Tables.md', tables_index)

        # Report pages
        page_order = []
        if report.get('pages'):
            for p in report['pages']:
                fn = wiki_filename(p['displayName'])
                zf.writestr(f'Report-Pages/{fn}.md', build_report_page(p))
                page_order.append(fn)
            zf.writestr('Report-Pages/.order', '\n'.join(page_order) + '\n')
            pages_index = "# :bar_chart: Report Pages\n\n| Page | Visuals |\n|---|---:|\n"
            for p in report['pages']:
                pages_index += f"| [{p['displayName']}](/Report-Pages/{wiki_filename(p['displayName'])}) | {len(p['visuals'])} |\n"
            zf.writestr('Report-Pages.md', pages_index)
        else:
            zf.writestr('Report-Pages/.order', '')
            zf.writestr('Report-Pages.md', "# :bar_chart: Report Pages\n\n_No report pages found._\n")

        # README for the repo folder
        zf.writestr('README.md',
                    f"# {model['name'] or 'Power BI Semantic Model'} — Wiki\n\n"
                    "This folder is structured for Azure DevOps **Publish code as wiki**.\n\n"
                    "## Publish steps\n\n"
                    "1. Commit and push this folder to your Azure DevOps Git repository.\n"
                    "2. In Azure DevOps → **Overview → Wiki** → **Publish code as wiki**.\n"
                    "3. Select the repo, branch, and this folder as the wiki root.\n\n"
                    f"Generated by PBIP Governance Inspector on {datetime.date.today().isoformat()}.\n")

    data = buffer.getvalue()
    if output_path:
        Path(output_path).write_bytes(data)
        return output_path
    return data


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0 if args else 1)

    input_arg = args[0]
    output_path = None
    if '--output' in args:
        idx = args.index('--output')
        if idx + 1 < len(args):
            output_path = args[idx + 1]

    if input_arg == '-':
        parsed = json.load(sys.stdin)
    else:
        parsed = json.loads(Path(input_arg).read_text(encoding='utf-8'))

    if not output_path:
        name = parsed['model'].get('name', 'pbip') or 'pbip'
        output_path = f"{wiki_filename(name)}_azdo_wiki_{datetime.date.today().isoformat()}.zip"

    build_zip(parsed, output_path)
    print(f'Wrote {output_path}')


if __name__ == '__main__':
    main()
