#!/usr/bin/env python3
"""DAX measures in an Obsidian vault: one note per measure, generated from a Power BI project (PBIP),
with status and checks that Dataview can read (type: dax-measure).

    python tools/dax-vault.py sync   <pbip folder> --vault <vault> [--model <name>] [--folder DAX/Measures]
    python tools/dax-vault.py status <measure name> <todo|review|complete> --vault <vault> [--model <name>]
    python tools/dax-vault.py certify <measure name> --owner <name> --vault <vault> [--model <name>] [--force]
    python tools/dax-vault.py list   --vault <vault> [--status review] [--problems]

sync     writes DAX/Measures/<model>/Measure-<Name>.md for every measure and DAX/Modeller/<model>.md.
         Glossary: terms from choices.json (glossary[], next to the pbip folder) become DAX/Begreber/<term>.md
         (never overwritten); a measure's term (TMDL `annotation Term`, or build.measures[].term) is linked
         in its `begreb` field. Once DAX/Begreber has notes, a report measure without a term is a finding.
         Only the block between the dax-vault markers and the generated frontmatter fields are rewritten;
         status, own fields and everything under "## Mine noter" are kept. Measures that are gone from the
         model get status "slettet" (the note is not deleted).
status   sets the status of one measure note.
certify  a person confirms the definition: status complete, ejer (owner), certificeret (date) and the DAX it
         was confirmed for. If the DAX changes later, sync flags "Ændret efter certificering" and sets review.
list     prints the measure notes (optionally only one status, or only those with problems).

Reads the model with .claude/skills/pbip-governance/scripts/parse_pbip.py (read-only on the PBIP).
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PARSER = ROOT / '.claude' / 'skills' / 'pbip-governance' / 'scripts' / 'parse_pbip.py'
STATUSES = ('todo', 'review', 'complete')
START, END = '<!-- dax-vault:start – generated, do not edit -->', '<!-- dax-vault:end -->'
USER_HEADING = '## Mine noter'
# frontmatter fields written by sync; every other field (status, own fields) is kept
GENERATED = ['type', 'navn', 'model', 'tabel', 'tabeller', 'mappe', 'format', 'beskrivelse', 'skjult', 'funktioner',
             'afhaenger_af', 'bruges_af', 'rapportsider', 'problemer', 'problemer_antal', 'dax_hash', 'kilde',
             'synkroniseret']
# kept, written by `certify`: ejer (owner), certificeret (date), certificeret_hash (dax_hash when certified)


# ---------------------------------------------------------------- frontmatter

def yaml_value(v):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, list):
        return '[' + ', '.join(yaml_value(x) for x in v) + ']'
    return json.dumps('' if v is None else str(v), ensure_ascii=False)


def read_note(path):
    """(fields as raw text lines by key, body) – raw lines keep the user's own formatting."""
    text = path.read_text(encoding='utf-8-sig')
    m = re.match(r'^---\r?\n(.*?)\r?\n---\r?\n?(.*)$', text, re.S)
    if not m:
        return {}, text
    fields, key = {}, None
    for line in m.group(1).splitlines():
        km = re.match(r'^([A-Za-z_][\w-]*):(.*)$', line)
        if km:
            key = km.group(1)
            fields[key] = [line]
        elif key:
            fields[key].append(line)
    return fields, m.group(2)


def field_text(fields, key):
    if key not in fields:
        return ''
    v = fields[key][0].split(':', 1)[1].strip()
    return v[1:-1] if len(v) > 1 and v[0] == v[-1] and v[0] in '"\'' else v


def write_note(path, generated, kept, body):
    lines = ['---']
    for k in GENERATED:
        lines.append(f'{k}: {yaml_value(generated[k])}')
    for k, raw in kept.items():
        if k not in GENERATED:
            lines.extend(raw)
    lines.append('---')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(lines) + '\n' + body, encoding='utf-8')


# ---------------------------------------------------------------- DAX analysis

def strip_dax(expr):
    """Expression without comments, strings and quoted names (so their content is not read as code)."""
    s = re.sub(r'//[^\n]*|--[^\n]*|/\*.*?\*/', ' ', expr or '', flags=re.S)
    s = re.sub(r'"(?:[^"]|"")*"', '""', s)
    return re.sub(r"'(?:[^']|'')*'", "'T'", s)


def functions(expr):
    s = re.sub(r'\[[^\]]*\]', '', strip_dax(expr))
    return sorted(set(f.upper() for f in re.findall(r'\b([A-Za-z][A-Za-z0-9.]*)\s*\(', s)) - {'VAR', 'RETURN'})


def references(expr):
    """Column references Table[Col] / 'Table'[Col] and bare [Name] references (measures or row columns)."""
    s = re.sub(r'//[^\n]*|--[^\n]*|/\*.*?\*/', ' ', expr or '', flags=re.S)
    s = re.sub(r'"(?:[^"]|"")*"', '""', s)
    cols = [(t.strip("'").replace("''", "'"), c) for t, c in
            re.findall(r"('(?:[^']|'')+'|[A-Za-z_][\w.]*)\s*\[([^\]]+)\]", s)]
    bare = re.findall(r"(?<!['\w\]])\[([^\]]+)\]", s)
    return cols, bare


# ---------------------------------------------------------------- glossary (begreber)

def term_link(term):
    return f'[[DAX/Begreber/{slug(term)}|{term}]]'


def measure_terms(pbip):
    """Measure → term, from `annotation Term = …` in the TMDL and from choices.json build.measures[].term."""
    out = {}
    for p in pbip.glob('*.SemanticModel/definition/tables/*.tmdl'):
        text = p.read_text(encoding='utf-8-sig', errors='replace')
        for block in re.split(r'\n(?=\t(?:///|measure |column |partition |hierarchy ))', text):
            mm = re.match(r"\s*(?:///[^\n]*\n\s*)*measure\s+('(?:[^']|'')+'|[^\s=]+)\s*=", block)
            tm = re.search(r'^\t\tannotation Term = (.+)$', block, re.M)
            if mm and tm:
                out[mm.group(1).strip("'").replace("''", "'")] = tm.group(1).strip()
    choices = pbip.parent / 'choices.json'
    if choices.exists():
        for m in (json.loads(choices.read_text(encoding='utf-8-sig')).get('build') or {}).get('measures', []):
            if m.get('term'):
                out.setdefault(m['name'], m['term'])
    return out


def load_glossary(pbip):
    choices = pbip.parent / 'choices.json'
    if not choices.exists():
        return []
    return json.loads(choices.read_text(encoding='utf-8-sig')).get('glossary') or []


def write_terms(folder, glossary, model_name, today):
    """One note per term (type: begreb). An existing note is never overwritten – the user owns it."""
    made = 0
    for g in glossary:
        p = folder / f'{slug(g["term"])}.md'
        if p.exists():
            continue
        folder.mkdir(parents=True, exist_ok=True)
        fm = ['---', 'type: begreb', f'navn: {yaml_value(g["term"])}', f'definition: {yaml_value(g.get("definition", ""))}',
              f'ejer: {yaml_value(g.get("owner", ""))}', f'modeller: {yaml_value([model_name])}', 'tags: [dax, begreb]',
              f'oprettet: {today}', '---']
        body = [f'# {g["term"]}', '', 'Tilbage til [[DAX Measure Oversigt]].', '', '## Definition',
                g.get('definition', '') or '_mangler_', '']
        if g.get('examples'):
            body += ['## Eksempler', str(g['examples']), '']
        body += ['## Measures', '```dataview', 'TABLE WITHOUT ID file.link AS "Measure", model AS "Model", status AS "Status"',
                 'FROM -"Skabeloner"', 'WHERE type = "dax-measure" AND contains(string(begreb), this.file.name)', '```', '',
                 USER_HEADING, '']
        p.write_text('\n'.join(fm + body), encoding='utf-8')
        made += 1
    return made


def code_of(expr):
    """The DAX as code: comments and whitespace removed, case ignored (used for duplicates and dax_hash)."""
    return re.sub(r'\s+', '', re.sub(r'//[^\n]*|--[^\n]*|/\*.*?\*/', ' ', expr or '', flags=re.S)).upper()


def slug(name):
    s = re.sub(r'[\\/:*?"<>|#^\[\]]', '', name).strip()
    s = s.replace('%', 'pct')
    return re.sub(r'\s+', '-', s) or 'measure'


# ---------------------------------------------------------------- sync

def load_model(pbip):
    out = subprocess.run([sys.executable, '-X', 'utf8', str(PARSER), str(pbip)], capture_output=True)
    if out.returncode:
        sys.exit(f'parse_pbip.py failed:\n{out.stderr.decode("utf-8", "replace")[-800:]}')
    data = json.loads(out.stdout.decode('utf-8-sig'))
    data['_pbip'] = str(Path(pbip).resolve())
    return data


def analyse(data):
    model = data['model']
    measures, columns = {}, defaultdict(set)
    for t in model['tables']:
        for c in t['columns']:
            columns[t['name']].add(c['name'])
        for m in t['measures']:
            measures[m['name']] = {**m, 'home': t['name']}
    facts = {r['from']['table'] for r in model.get('relationships', [])} - \
            {r['to']['table'] for r in model.get('relationships', [])}

    pages = defaultdict(list)
    for p in (data.get('report') or {}).get('pages', []):
        for v in p.get('visuals', []):
            for f in v.get('fieldRefs', []):
                if f.get('kind') == 'Measure' and p['displayName'] not in pages[f['name']]:
                    pages[f['name']].append(p['displayName'])
    # measures used only in formatting (colours, labels, titles) are not in fieldRefs: scan the page files
    for page_json in Path(data.get('_pbip', '.')).glob('*.Report/definition/pages/*/page.json'):
        try:
            title = json.loads(page_json.read_text(encoding='utf-8-sig')).get('displayName', page_json.parent.name)
        except (OSError, ValueError):
            continue
        text = ' '.join(f.read_text(encoding='utf-8-sig', errors='replace') for f in page_json.parent.rglob('*.json'))
        for name in set(re.findall(r'"Property"\s*:\s*"((?:[^"\\]|\\.)*)"', text)):
            if title not in pages[name]:
                pages[name].append(title)

    # dependencies.measures holds names (str) or {name/measure: …} records, depending on the parser version
    deps = {n: {d if isinstance(d, str) else d.get('name', d.get('measure', ''))
                for d in m['dependencies'].get('measures', [])}
            for n, m in measures.items()}
    used_by = defaultdict(set)
    for n, ds in deps.items():
        for d in ds:
            used_by[d].add(n)

    def depth(n, seen=()):
        if n in seen:
            return 99  # circular
        return 1 + max((depth(d, seen + (n,)) for d in deps.get(n, ()) if d in measures), default=0)

    def tables_of(n, seen=()):
        if n in seen or n not in measures:
            return Counter()
        cnt = Counter(c['table'] for c in measures[n]['dependencies'].get('columns', []))
        for d in deps.get(n, ()):
            cnt.update(tables_of(d, seen + (n,)))
        return cnt

    # duplicates: same code including strings ("cancelled" vs "returned" is not a duplicate), comments ignored
    code = code_of
    norm = defaultdict(list)
    for n, m in measures.items():
        norm[code(m['expression'])].append(n)

    out = {}
    for n, m in measures.items():
        expr = m['expression'] or ''
        s = strip_dax(expr)
        tcount = tables_of(n)
        fact = next((t for t, _ in tcount.most_common() if t in facts), None) or \
            (tcount.most_common(1)[0][0] if tcount else '')
        problems = []
        if not (m.get('description') or '').strip():
            problems.append('Ingen beskrivelse')
        # text results (labels, colours, CONCATENATEX) need no format string
        returns_text = re.search(r'"[^"]+"', expr) or re.search(r'\b(FORMAT|CONCATENATEX?)\s*\(|&', s, re.I)
        if not (m.get('formatString') or '').strip() and not returns_text:
            problems.append('Intet format')
        if not pages.get(n) and not used_by.get(n):
            problems.append('Ikke brugt i rapport eller andre measures')
        cols, bare = references(expr)
        broken = [f"{t}[{c}]" for t, c in cols if t in columns and c not in columns[t] and not
                  any(c == mm and measures[mm]['home'] == t for mm in measures)]
        broken += [f"{t}[{c}]" for t, c in cols if t not in columns and t not in ('T',)]
        row_ctx = set().union(*columns.values()) if columns else set()
        broken += [f'[{b}]' for b in bare if b not in measures and b not in row_ctx and not re.search(r'\bVAR\s+' + re.escape(b), expr)]
        if broken:
            problems.append('Brudt reference: ' + ', '.join(dict.fromkeys(broken)))
        if re.search(r'(?<![/*])/(?![/*])', s):
            problems.append('Division med / (brug DIVIDE)')
        if re.search(r"\bFILTER\s*\(\s*(?:'T'|[A-Za-z_][\w]*)\s*,", s, re.I) and not re.search(r'\bFILTER\s*\(\s*(?:ALL|VALUES|DISTINCT|KEEPFILTERS)\b', s, re.I):
            problems.append('FILTER over hel tabel (filtrer på kolonne)')
        if re.search(r'\b(IFERROR|ISERROR)\s*\(', s, re.I):
            problems.append('IFERROR/ISERROR (langsomt, skjuler fejl)')
        d = depth(n)
        if d >= 99:
            problems.append('Cirkulær afhængighed')
        elif d > 4:
            problems.append(f'Lang kæde af measures ({d} niveauer)')
        twins = [x for x in norm[code(expr)] if x != n]
        if twins:
            problems.append('Samme DAX som ' + ', '.join(twins))
        out[n] = {'m': m, 'fact': fact, 'tables': sorted(tcount), 'functions': functions(expr),
                  'deps': sorted(d for d in deps[n] if d in measures), 'used_by': sorted(used_by.get(n, ())),
                  'pages': pages.get(n, []), 'problems': problems}
    return out, facts


def sync(args):
    vault = Path(args.vault)
    data = load_model(args.pbip)
    model_name = args.model or data['model'].get('name') or Path(args.pbip).name
    model_name = re.sub(r'\.SemanticModel$', '', model_name) or Path(args.pbip).resolve().name
    folder = vault / args.folder / model_name
    info, facts = analyse(data)
    link = lambda n: f'[[{args.folder}/{model_name}/Measure-{slug(n)}|{n}]]'
    today = dt.date.today().isoformat()
    terms, glossary = measure_terms(Path(args.pbip)), load_glossary(Path(args.pbip))
    terms_dir = vault / 'DAX' / 'Begreber'
    new_terms = write_terms(terms_dir, glossary, model_name, today)
    have_terms = terms_dir.exists() and any(terms_dir.glob('*.md'))
    written, new = [], 0
    for n, a in sorted(info.items()):
        m = a['m']
        path = folder / f'Measure-{slug(n)}.md'
        fields, body = read_note(path) if path.exists() else ({}, '')
        if not path.exists():
            new += 1
        dax_hash = hashlib.sha1(code_of(m['expression']).encode('utf-8')).hexdigest()[:12]
        problems = list(a['problems'])
        if terms.get(n):
            fields['begreb'] = [f'begreb: {yaml_value(term_link(terms[n]))}']
        fields.setdefault('begreb', ['begreb: ""'])
        if have_terms and a['pages'] and not field_text(fields, 'begreb'):
            problems.append('Intet begreb (rapport-measure uden forretningsdefinition)')
        cert_hash = field_text(fields, 'certificeret_hash')
        if cert_hash and cert_hash != dax_hash:
            problems.insert(0, f'Ændret efter certificering ({field_text(fields, "certificeret") or "?"})')
            fields['status'] = ['status: review']
        if 'status' not in fields:
            fields['status'] = [f'status: {"review" if problems else "todo"}']
        for k in ('ejer', 'certificeret'):
            fields.setdefault(k, [f'{k}: ""'])
        if 'tags' not in fields:
            fields['tags'] = ['tags: [dax, measure]']
        gen = {
            'type': 'dax-measure', 'navn': n, 'model': model_name, 'tabel': a['fact'], 'tabeller': a['tables'],
            'mappe': m.get('displayFolder') or '', 'format': m.get('formatString') or '',
            'beskrivelse': (m.get('description') or '').strip(), 'skjult': bool(m.get('isHidden')),
            'funktioner': a['functions'], 'afhaenger_af': [link(d) for d in a['deps']],
            'bruges_af': [link(d) for d in a['used_by']], 'rapportsider': a['pages'],
            'problemer': problems, 'problemer_antal': len(problems), 'dax_hash': dax_hash,
            'kilde': str(Path(args.pbip).resolve()).replace('\\', '/'), 'synkroniseret': today,
        }
        block = [START, '', f'# {n}', '', f'Tilbage til [[DAX Measure Oversigt]] · model [[{model_name}]].', '']
        if gen['beskrivelse']:
            block += [gen['beskrivelse'], '']
        block += ['## DAX', '```dax', f'{n} =', (m['expression'] or '').strip(), '```', '']
        block += ['## Fakta', f'- Faktatabel: {a["fact"] or "–"} · tabeller: {", ".join(a["tables"]) or "–"}',
                  f'- Mappe: {gen["mappe"] or "–"} · format: `{gen["format"] or "–"}`' + (' · skjult' if gen['skjult'] else ''),
                  f'- Funktioner: {", ".join(a["functions"]) or "–"}',
                  f'- Afhænger af: {", ".join(gen["afhaenger_af"]) or "–"}',
                  f'- Bruges af: {", ".join(gen["bruges_af"]) or "–"}',
                  f'- Rapportsider: {", ".join(a["pages"]) or "–"}', '']
        cert = field_text(fields, 'certificeret')
        block += ['## Certificering', (f'- Certificeret {cert} af {field_text(fields, "ejer") or "?"}'
                                       + (' – **DAX ændret siden**' if cert_hash and cert_hash != dax_hash else ''))
                  if cert else '- Ikke certificeret', '']
        block += ['## Fejlfinding'] + ([f'- [ ] {p}' for p in problems] or ['- Ingen fund']) + ['', END]
        rest = body.split(END, 1)[1] if END in body else ''
        if USER_HEADING not in rest:
            rest = f'\n\n{USER_HEADING}\n\n' + rest.lstrip('\n')
        write_note(path, gen, fields, '\n'.join(block) + rest)
        written.append(path)

    # measures that are no longer in the model
    gone = 0
    for p in folder.glob('Measure-*.md'):
        if p in written:
            continue
        fields, body = read_note(p)
        if field_text(fields, 'type') == 'dax-measure' and field_text(fields, 'status') != 'slettet':
            fields['status'] = ['status: slettet']
            p.write_text('---\n' + '\n'.join(l for v in fields.values() for l in v) + '\n---\n' + body, encoding='utf-8')
            gone += 1

    # model note
    probs = Counter(p.split(':')[0] for a in info.values() for p in a['problems'])
    mpath = vault / 'DAX' / 'Modeller' / f'{model_name}.md'
    mfields, mbody = read_note(mpath) if mpath.exists() else ({}, '')
    mgen = ['---', 'type: dax-model', f'model: {yaml_value(model_name)}', f'measures: {len(info)}',
            f'faktatabeller: {yaml_value(sorted(facts))}', f'problemer_antal: {sum(probs.values())}',
            f'kilde: {yaml_value(str(Path(args.pbip).resolve()).replace(chr(92), "/"))}', f'synkroniseret: {today}', '---']
    mblock = [START, '', f'# {model_name}', '', 'Tilbage til [[DAX Measure Oversigt]].', '',
              f'- Measures: {len(info)} · faktatabeller: {", ".join(sorted(facts)) or "–"}',
              f'- Kilde: `{mgen[6].split(": ", 1)[1].strip(chr(34))}`', '', '## Fund i modellen']
    mblock += [f'- {k}: {v}' for k, v in probs.most_common()] or ['- Ingen fund']
    mblock += ['', '## Measures', '```dataview',
               'TABLE WITHOUT ID file.link AS "Measure", tabel AS "Faktatabel", status AS "Status", problemer_antal AS "Fund"',
               'FROM ""', f'WHERE type = "dax-measure" AND model = "{model_name}"', 'SORT problemer_antal DESC, navn ASC', '```', '', END]
    mrest = mbody.split(END, 1)[1] if END in mbody else f'\n\n{USER_HEADING}\n'
    mpath.parent.mkdir(parents=True, exist_ok=True)
    mpath.write_text('\n'.join(mgen) + '\n' + '\n'.join(mblock) + mrest, encoding='utf-8')

    print(json.dumps({'model': model_name, 'measures': len(info), 'new': new, 'marked_deleted': gone,
                      'terms_linked': sum(1 for n in info if terms.get(n)), 'term_notes_created': new_terms,
                      'with_problems': sum(1 for a in info.values() if a['problems']),
                      'problems': dict(probs.most_common()), 'folder': str(folder)}, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- status / list

def measure_notes(vault):
    for p in Path(vault).rglob('*.md'):
        if '.obsidian' in p.parts or '.trash' in p.parts or 'Skabeloner' in p.parts:
            continue
        try:
            fields, _ = read_note(p)
        except (OSError, UnicodeDecodeError):
            continue
        if field_text(fields, 'type') == 'dax-measure':
            yield p, fields


def find_one(args):
    hits = [(p, f) for p, f in measure_notes(args.vault)
            if field_text(f, 'navn').lower() == args.name.lower() and (not args.model or field_text(f, 'model') == args.model)]
    if not hits:
        sys.exit(f'no dax-measure note named "{args.name}"' + (f' in model {args.model}' if args.model else ''))
    if len(hits) > 1:
        sys.exit('several models have this measure – add --model: ' + ', '.join(field_text(f, 'model') for _, f in hits))
    return hits[0]


def set_fields(path, values):
    """Set frontmatter fields in place (one line each), keeping everything else."""
    text = path.read_text(encoding='utf-8-sig')
    m = re.match(r'^(---\r?\n)(.*?)(\r?\n---)', text, re.S)
    head = m.group(2)
    for k, v in values.items():
        line = f'{k}: {v}'
        if re.search(rf'^{k}:.*$', head, re.M):
            head = re.sub(rf'^{k}:.*$', lambda _m: line, head, count=1, flags=re.M)
        else:
            head += '\n' + line
    path.write_text(m.group(1) + head + text[m.end(2):], encoding='utf-8')


def set_status(args):
    if args.status not in STATUSES:
        sys.exit(f'status must be one of {", ".join(STATUSES)}')
    p, f = find_one(args)
    set_fields(p, {'status': args.status})
    note = ''
    if args.status == 'complete' and not field_text(f, 'certificeret'):
        note = ' – not certified yet (use certify to record owner and date)'
    print(f'{args.name}: status {args.status} ({p}){note}')


def certify(args):
    """A person confirms the definition: status complete, owner, date, and the DAX it was confirmed for."""
    p, f = find_one(args)
    if not field_text(f, 'dax_hash'):
        sys.exit('run sync first – the note has no dax_hash')
    if int(field_text(f, 'problemer_antal') or 0) and not args.force:
        sys.exit(f'{args.name} has open findings ({field_text(f, "problemer")}) – fix them or pass --force')
    today = dt.date.today().isoformat()
    set_fields(p, {'status': 'complete', 'ejer': yaml_value(args.owner), 'certificeret': today,
                   'certificeret_hash': yaml_value(field_text(f, 'dax_hash'))})
    print(f'{args.name}: certified {today} by {args.owner} ({p})')


def list_notes(args):
    rows = []
    for p, f in measure_notes(args.vault):
        st, n = field_text(f, 'status'), int(field_text(f, 'problemer_antal') or 0)
        if (args.status and st != args.status) or (args.problems and not n):
            continue
        rows.append((field_text(f, 'model'), field_text(f, 'navn'), st, n))
    for r in sorted(rows):
        print(f'{r[0]:<20} {r[1]:<40} {r[2]:<9} {r[3]} fund')
    print(f'{len(rows)} measures')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sync')
    s.add_argument('pbip')
    s.add_argument('--vault', required=True)
    s.add_argument('--model')
    s.add_argument('--folder', default='DAX/Measures')
    s.set_defaults(fn=sync)
    st = sub.add_parser('status')
    st.add_argument('name')
    st.add_argument('status')
    st.add_argument('--vault', required=True)
    st.add_argument('--model')
    st.set_defaults(fn=set_status)
    ce = sub.add_parser('certify')
    ce.add_argument('name')
    ce.add_argument('--owner', required=True)
    ce.add_argument('--vault', required=True)
    ce.add_argument('--model')
    ce.add_argument('--force', action='store_true', help='certify although the note has findings')
    ce.set_defaults(fn=certify)
    ls = sub.add_parser('list')
    ls.add_argument('--vault', required=True)
    ls.add_argument('--status')
    ls.add_argument('--problems', action='store_true')
    ls.set_defaults(fn=list_notes)
    a = ap.parse_args()
    a.fn(a)


if __name__ == '__main__':
    main()
