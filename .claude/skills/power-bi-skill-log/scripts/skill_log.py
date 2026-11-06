#!/usr/bin/env python3
"""Adds an entry to the Power BI skill log in the Obsidian vault.

    python skill_log.py add <entry.json> [--vault <vault>] [--note "Power BI Learning/Power-BI-Skill-Log.md"]
    python skill_log.py init [--vault <vault>]

entry.json (UTF-8):
{
  "titel": "Avanceret DAX",                 required
  "kategori": "DAX",                        DAX | M | Datamodellering | Rapportering (ticks it in the overview)
  "dato": "2026-11-06",                     optional, default today
  "kontekst": "…", "laering": "…",          what the task was, what was learned
  "kode": "YoY % = …", "sprog": "dax",      optional code block (dax, m, sql …)
  "teknisk_note": "…",                      why it works (e.g. why ALL resets the filter context)
  "measure": "Total sales"                  optional: links the dax-measure note with that name
}
The entry goes directly under <!-- CLAUDE_START --> (newest first). The note is created if it is missing.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]  # the repository (the user-level skill folder is a link to it)


def default_vault():
    """--vault, else OBSIDIAN_VAULT, else obsidian.vault in pipeline.config.json (git-ignored, per user)."""
    if os.environ.get('OBSIDIAN_VAULT'):
        return os.environ['OBSIDIAN_VAULT']
    cfg = ROOT / 'pipeline.config.json'
    if cfg.exists():
        vault = (json.loads(cfg.read_text(encoding='utf-8-sig')).get('obsidian') or {}).get('vault')
        if vault:
            return vault
    return None


NOTE ='Power BI Learning/Power-BI-Skill-Log.md'
MARK = '<!-- CLAUDE_START -->'
MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober',
          'november', 'december']
# kategori -> start of its checkbox line in the overview
SKILLS = {
    'DAX': 'DAX (Data Analysis Expressions)',
    'M': 'M-Code / Power Query (datatransformation)',
    'Datamodellering': 'Datamodellering (stjerneskemaer, relationer)',
    'Rapportering': 'Rapportering & UX (visuelle elementer)',
}
TEMPLATE = """---
type: skill-log
tags: [power-bi, læring, log]
indlaeg: 0
senest:
---

# 📊 Power BI Skill Development Log

Tilbage til [[DAX]] · [[DAX Measure Oversigt]].

## 🎯 Overblik over kompetencer
{skills}

---

## 📝 Logbog: Læring & Problemløsning
Nyeste øverst. Claude indsætter nye indlæg lige under markøren – ret gerne i teksten bagefter.

{mark}
"""


def init(vault, note):
    path = vault / note
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    skills = '\n'.join(f'- [ ] {v}' for v in SKILLS.values())
    path.write_text(TEMPLATE.format(skills=skills, mark=MARK), encoding='utf-8')
    return path


def find_measure(vault, name):
    for p in vault.rglob('*.md'):
        if {'.obsidian', '.trash', 'Skabeloner'} & set(p.parts):
            continue
        head = p.read_text(encoding='utf-8-sig', errors='replace')[:1500]
        if re.search(r'^type:\s*"?dax-measure"?\s*$', head, re.M) and \
                re.search(r'^navn:\s*"?' + re.escape(name) + r'"?\s*$', head, re.M | re.I):
            return p.relative_to(vault).with_suffix('').as_posix()
    return None


def add(args):
    vault, entry = Path(args.vault), json.loads(Path(args.entry).read_text(encoding='utf-8-sig'))
    if not entry.get('titel'):
        sys.exit('entry needs "titel"')
    kat = entry.get('kategori', '')
    if kat and kat not in SKILLS:
        sys.exit(f'kategori must be one of {", ".join(SKILLS)}')
    path = init(vault, args.note)
    text = path.read_text(encoding='utf-8-sig')
    if MARK not in text:
        sys.exit(f'{MARK} is missing in {path} – put it back under the Logbog heading')

    d = dt.date.fromisoformat(entry.get('dato') or dt.date.today().isoformat())
    lines = [f'### 📅 {d.day}. {MONTHS[d.month - 1]} {d.year}: {entry["titel"]}']
    if kat:
        lines.append(f'* **Kategori:** {kat}')
    if entry.get('kontekst'):
        lines.append(f'* **Kontekst:** {entry["kontekst"]}')
    if entry.get('laering'):
        lines.append(f'* **Læring:** {entry["laering"]}')
    if entry.get('kode'):
        lang = entry.get('sprog') or ('dax' if kat in ('DAX', '') else 'm' if kat == 'M' else '')
        lines += ['', '**Implementeret kode:**' if lang != 'dax' else '**Implementeret DAX-kode:**',
                  f'```{lang}', entry['kode'].strip('\n'), '```']
    if entry.get('teknisk_note'):
        lines += ['', f'* **Teknisk note:** {entry["teknisk_note"]}']
    if entry.get('measure'):
        link = find_measure(vault, entry['measure'])
        lines.append(f'* **Measure:** ' + (f'[[{link}|{entry["measure"]}]]' if link else entry['measure']))
    block = '\n'.join(lines) + '\n\n---\n'

    text = text.replace(MARK, MARK + '\n\n' + block, 1)
    ticked = False
    if kat:
        new = re.sub(r'^- \[ \] ' + re.escape(SKILLS[kat]), '- [x] ' + SKILLS[kat], text, count=1, flags=re.M)
        ticked, text = new != text, new
    n = len(re.findall(r'^### 📅 ', text, re.M))
    text = re.sub(r'^indlaeg:.*$', f'indlaeg: {n}', text, count=1, flags=re.M)
    text = re.sub(r'^senest:.*$', f'senest: {max(d.isoformat(), _senest(text))}', text, count=1, flags=re.M)
    path.write_text(text, encoding='utf-8')
    print(json.dumps({'note': str(path), 'entries': n, 'ticked': kat if ticked else None}, ensure_ascii=False))


def _senest(text):
    m = re.search(r'^senest:\s*(\d{4}-\d{2}-\d{2})', text, re.M)
    return m.group(1) if m else ''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('add')
    a.add_argument('entry')
    i = sub.add_parser('init')
    for p in (a, i):
        p.add_argument('--vault', default=default_vault())
        p.add_argument('--note', default=NOTE)
    args = ap.parse_args()
    if not args.vault:
        sys.exit('no vault: pass --vault, set OBSIDIAN_VAULT, or set obsidian.vault in pipeline.config.json')
    if args.cmd == 'init':
        print(init(Path(args.vault), args.note))
    else:
        add(args)


if __name__ == '__main__':
    main()
