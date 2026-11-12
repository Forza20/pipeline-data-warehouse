#!/usr/bin/env python3
"""Writes runs/<run-id>/governance/handover.md from the run's choices and the model, so it is never written by
hand and never goes stale after a --resume.

    python build_handover.py runs/<run-id>

Reads choices.json (name, design: facts, left_out, review; build: tables, staging, relationships, measures,
roles; handover_notes[]; pii_not_personal[]) and the model in pbip/<Name>.SemanticModel via
../../pbip-governance/scripts/parse_pbip.py (its PII heuristic and role parser). Sections: model, data source,
personal data, row-level security, decisions (review points that are settled), open points (review points
still open + handover_notes), left out, documentation.

pii_not_personal: ["Customer[Customer name]", ...] – columns the user has reviewed as not personal data
(company names); they stay in the table as "reviewed" instead of being flagged again on every run.
Prints JSON: {ok, file, pii: {candidates, visible}, roles, decisions, open, warnings}.
"""
import importlib.util
import json
import sys
from pathlib import Path

PARSER = Path(__file__).resolve().parent.parent.parent / 'pbip-governance' / 'scripts' / 'parse_pbip.py'


def load_parser():
    if not PARSER.exists():
        sys.exit(f'needs the pbip-governance skill next to this one ({PARSER})')
    spec = importlib.util.spec_from_file_location('parse_pbip', PARSER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cell(s):
    s = '–' if s is None or s == '' else str(s)
    return s.replace('|', '\\|').replace('\n', ' ')


def main():
    if len(sys.argv) < 2:
        sys.exit('Usage: python build_handover.py runs/<run-id>')
    run = Path(sys.argv[1]).resolve()
    choices = json.loads((run / 'choices.json').read_text(encoding='utf-8-sig'))
    b = choices.get('build')
    if not b:
        sys.exit('choices.json has no build spec – run build-model.js first')
    name = b.get('name') or choices.get('name') or 'Model'
    run_id = choices.get('run_id') or run.name
    pbip = run / 'pbip'
    pp = load_parser()
    model = pp.parse_model(pbip)
    design = choices.get('design') or {}
    warnings = []

    L = [f'# Handover – {name} (Power BI project)', '']
    files = sorted({s.get('file') for s in b.get('staging', []) if s.get('file')})
    src = Path(choices['source_original']).name if choices.get('source_original') else ', '.join(files)
    L += [f"Built by `/pipeline-power-bi`{' (fast mode)' if choices.get('fast') else ''} from `{src}`, run `{run_id}`. "
          f"Project: `runs/{run_id}/pbip/{name}.pbip`. Written by `build_handover.py` – rerun it after every rebuild.", '']

    # ---------- model ----------
    grain = {f.get('name'): f.get('grain') for f in design.get('facts', []) if isinstance(f, dict)}
    L += ['## Model', '', '| Table | Kind | Grain / content |', '|---|---|---|']
    for t in b.get('tables', []):
        kind = t.get('kind', '') + (' (hidden)' if t.get('hidden') else '')
        L.append(f"| {cell(t['name'])} | {cell(kind)} | {cell(grain.get(t['name']) or t.get('description'))} |")
    rels = b.get('relationships', [])
    inactive = [f"{r['from']} → {r['to']}" for r in rels if r.get('active') is False]
    folders = sorted({m.get('folder') for m in b.get('measures', []) if m.get('folder')})
    L += ['', f"{len(rels)} relationships" + (f" ({len(inactive)} inactive: {'; '.join(inactive)})" if inactive else '') +
          f". {len(b.get('measures', []))} measures in `_Measures`" + (f" (folders {', '.join(folders)})" if folders else '') +
          ('. Auto date/time off; `Date` is marked as the date table.' if b.get('date') else '.'), '']

    # ---------- data source ----------
    L += ['## Data source', '', 'One parameter, `SourceFolder` (Transform data → Manage parameters), points at the folder that holds '
          f"{', '.join('`' + f + '`' for f in files)}. {len(b.get('staging', []))} staging queries (`01_Stage`, not loaded) "
          'read one file, sheet or Excel table each – by name, so renaming a sheet or table breaks the refresh.', '']

    # ---------- personal data ----------
    reviewed = {s.lower() for s in choices.get('pii_not_personal', [])}
    rows, n_cand, n_visible = [], 0, 0
    for t in model['tables']:
        for c in t['columns']:
            reason = pp.pii_reason(c['name'], t['name'])
            if not reason:
                continue
            n_cand += 1
            ref = f"{t['name']}[{c['name']}]"
            annotated = hasattr(pp, 'pii_reviewed') and pp.pii_reviewed(c)   # annotation PII = not personal
            if t.get('isHidden'):
                status = 'table hidden'
            elif c.get('isHidden'):
                status = 'hidden'
            elif annotated or ref.lower() in reviewed:
                status = 'visible – reviewed, not personal data'
            else:
                status = f'**visible** – review: hide, keep or remove (matched "{reason}")'
                n_visible += 1
            rows.append(f'| {cell(ref)} | {status} |')
    L += [f"## {':warning: ' if n_visible else ''}Personal data (PII audit)", '',
          'A name heuristic (pbip-governance): candidates, not proof. Review the visible ones.', '']
    L += (['| Column | Status |', '|---|---|'] + rows) if rows else ['No candidate columns.']
    L.append('')

    # ---------- RLS ----------
    roles = model.get('roles', [])
    L += ['## :key: Row-level security' if roles else '## Row-level security', '']
    if roles:
        for r in roles:
            L.append(f"Role **{r['name']}**:")
            for tp in r.get('tablePermissions', []):
                L.append(f"- `{tp.get('table') or tp.get('name')}`: `{' '.join(str(tp.get('filter', '')).split())}`")
        rule = {x.get('name'): x for x in design.get('roles', []) if isinstance(x, dict)}
        for r in roles:
            d = rule.get(r['name'])
            if d and d.get('rule'):
                L.append(f"- {r['name']} in words: {d['rule']}" + (f" (mapping: {d['mapping']})" if d.get('mapping') else ''))
        L += ['', 'Add members in the Power BI service; test with Modeling → View as.', '']
    else:
        L += ['No roles – every viewer sees all rows.', '']

    # ---------- decisions and open points ----------
    review = [r for r in design.get('review', []) if isinstance(r, dict)]
    done = [r for r in review if r.get('status') != 'open']
    open_ = [r for r in review if r.get('status') == 'open']
    def evidence(r):
        e = r.get('evidence')
        if not e:
            return ''
        return ' – evidence: ' + (' – '.join(str(x) for x in (e.get('value'), e.get('how')) if x) if isinstance(e, dict) else str(e))
    note = lambda r: r['point'] + (f" → {r['note']}" if r.get('note') and r.get('note') != 'drafted' else '') + evidence(r)
    if done:
        L += ['## Decisions', ''] + [f"- {note(r)} ({r.get('status')})" for r in done] + ['']
    extra = [str(x) for x in choices.get('handover_notes', [])]
    L += ['## Open points', '']
    L += [f'- {note(r)}' for r in open_] + [f'- {x}' for x in extra] if (open_ or extra) else ['- None.']
    if n_visible:
        L.append(f'- {n_visible} visible personal-data candidate(s) – see above.')
    L.append('')
    left = [x for x in design.get('left_out', []) if isinstance(x, dict)]
    if left:
        L += ['## Left out of the model', ''] + [f"- {x.get('table')}: {x.get('reason')}" for x in left] + ['']

    # ---------- documentation ----------
    docs = [('pbip/docs/catalog.xlsx', 'data catalog'), ('pbip/docs/lineage.html', 'lineage page'), ('pbip/docs/lineage.md', 'lineage (Mermaid)'),
            ('pbip/docs/model.dbml', 'dbdiagram.io model'), (f'governance/{name}_azdo_wiki.zip', 'Azure DevOps wiki bundle'),
            ('overview.html', 'overview page'), ('cleaning-log.md', 'cleaning log'), ('expected-values.md', 'expected values'),
            ('checks.dax', 'DAX checks'), ('grounded-answers.md', 'grounded-answer test'), ('model-context.md', 'model context for AI assistants'),
            ('model-health.md', 'model health')]
    have = [f'- {label}: `{p}`' for p, label in docs if (run / p).exists()]
    L += ['## Documentation', '', 'Paths are relative to the run folder.', ''] + (have or ['- None yet.']) + ['']

    out = run / 'governance' / 'handover.md'
    out.parent.mkdir(exist_ok=True)
    out.write_text('\n'.join(L), encoding='utf-8', newline='\n')
    print(json.dumps({'ok': True, 'file': str(out), 'pii': {'candidates': n_cand, 'visible': n_visible},
                      'roles': len(roles), 'decisions': len(done), 'open': len(open_) + len(extra), 'warnings': warnings}, indent=1))


if __name__ == '__main__':
    main()
