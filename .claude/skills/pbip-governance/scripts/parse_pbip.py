#!/usr/bin/env python3
"""
parse_pbip.py — Parse a Power BI Project (PBIP) folder into structured JSON.

Usage:
    python3 parse_pbip.py <pbip_folder_path> [--output /path/to/output.json]

Outputs JSON to stdout (or to --output file) with keys:
    - model: {name, tables, relationships, roles, expressions, dataSources}
    - report: {pages}

Beyond the basic inventory the parser also adds (used by pbip-catalog):
    - TMDL `///` descriptions on tables, columns, measures and expressions
    - Power Query steps per partition/shared query and the queries it references
    - Column lineage through Power Query steps (`column.lineage`, `column.origin`)
    - DAX dependencies per measure / calculated column (`dependencies`)
    - Relationship cardinality and every field a PBIR visual binds to (`fieldRefs`)
"""

import json
import os
import re
import sys
from pathlib import Path


# PII heuristic (DA/EN). Column names are split into words (snake_case, camelCase,
# spaces), so `name` no longer hits product_name and `ip` no longer hits shipping_date.
# Words that are personal data on their own:
PII_WORDS = {
    # contact
    'email', 'mail', 'phone', 'telephone', 'telefon', 'telefonnummer', 'tlf', 'mobil', 'mobile',
    # national identifiers
    'cpr', 'cprnr', 'cprnummer', 'ssn', 'passport', 'pasnummer',
    # names and persons
    'firstname', 'lastname', 'fullname', 'middlename', 'surname', 'fornavn', 'efternavn',
    'mellemnavn', 'username', 'brugernavn', 'contact', 'kontakt', 'kontaktperson',
    # addresses
    'address', 'adresse', 'street', 'gade', 'streetname', 'postnr', 'postnummer', 'zip',
    'zipcode', 'postal', 'postalcode', 'postcode',
    # birth
    'dob', 'birth', 'birthdate', 'birthday', 'dateofbirth', 'fødsel', 'fodsel', 'foedsel',
    'fødselsdato', 'fodselsdato', 'foedselsdato',
    # online identifiers
    'ip', 'ipaddress', 'deviceid', 'userid', 'brugerid',
    # financial
    'iban', 'accountnumber', 'kontonummer', 'kortnummer', 'cardnumber', 'creditcard',
    'salary', 'løn', 'loen', 'income', 'indkomst',
    # special categories (GDPR art. 9) and similar
    'gender', 'sex', 'køn', 'koen', 'ethnic', 'ethnicity', 'religion', 'nationality', 'nationalitet',
    'marital', 'maritalstatus', 'civilstand',
}
# Words that hold a person's name when used as a column (account_manager, salesperson).
PII_PERSON_ROLES = {'manager', 'salesperson', 'sælger', 'saelger', 'owner', 'ejer', 'ansvarlig'}
# `name`/`navn` only counts when the column or table is about a person ...
PII_NAME_WORDS = {'name', 'navn'}
PII_PERSON_WORDS = {
    'first', 'last', 'full', 'middle', 'customer', 'kunde', 'contact', 'kontakt', 'employee',
    'medarbejder', 'user', 'bruger', 'person', 'manager', 'owner', 'ejer', 'patient', 'member',
    'medlem', 'borger', 'student', 'elev', 'client', 'klient', 'guest', 'gæst', 'gaest', 'passenger',
    'passager', 'traveler', 'traveller', 'rejsende', 'tenant', 'lejer', 'resident', 'beboer',
}
# ... and never when it names a thing (product_name, month_name, city_name ...).
PII_NOT_PERSON = {
    'product', 'produkt', 'campaign', 'kampagne', 'channel', 'kanal', 'region', 'month', 'maaned',
    'måned', 'day', 'dag', 'week', 'uge', 'city', 'by', 'country', 'land', 'category', 'kategori',
    'subcategory', 'company', 'firma', 'virksomhed', 'brand', 'store', 'butik', 'table', 'column',
    'file', 'fil', 'sheet', 'ark', 'segment', 'department', 'afdeling', 'project', 'projekt',
    'supplier', 'leverandør', 'leverandor', 'vendor', 'shop', 'site', 'event', 'team', 'group',
    'gruppe', 'role', 'rolle', 'status', 'type',
}
# City/town is only personal data inside a table about persons (dim_customer.city).
PII_PERSON_LOCATION = {'city', 'town', 'by'}
PII_PERSON_TABLE_WORDS = {
    'customer', 'customers', 'kunde', 'kunder', 'employee', 'employees', 'medarbejder',
    'medarbejdere', 'user', 'users', 'bruger', 'brugere', 'person', 'persons', 'personer',
    'people', 'contact', 'contacts', 'kontakt', 'kontakter', 'patient', 'patients', 'member',
    'members', 'medlem', 'medlemmer', 'client', 'clients', 'klient', 'klienter', 'guest', 'guests',
    'gæst', 'gæster', 'gaest', 'gaester', 'passenger', 'passengers', 'passager', 'passagerer',
    'traveler', 'travelers', 'traveller', 'travellers', 'rejsende', 'tenant', 'tenants', 'lejer', 'lejere',
    'resident', 'residents', 'beboer', 'beboere',
}
# Backwards compatible flat list (used by older callers for display).
PII_PATTERNS = sorted(PII_WORDS | PII_PERSON_ROLES | PII_NAME_WORDS)


def unquote_tmdl(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def split_table_column(s):
    """Parse 'Table.Column' or 'Table'.'Column' (with optional quoting)."""
    s = s.strip()
    m = re.match(r"^'?([^'.]+)'?\.'?([^']+)'?$", s)
    if m:
        return m.group(1), m.group(2)
    parts = s.split('.', 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return s, ''


def _name_words(name):
    """'customerEmail' / 'First Name' / 'ip_address' -> ['customer', 'email'] etc."""
    s = re.sub(r'([a-zæøå0-9])([A-ZÆØÅ])', r'\1 \2', str(name or ''))
    s = re.sub(r'([A-ZÆØÅ]+)([A-ZÆØÅ][a-zæøå])', r'\1 \2', s)
    return [w for w in re.split(r'[^0-9a-zæøåA-ZÆØÅ]+', s.lower()) if w]


def pii_reason(col_name, table_name=None):
    """Why a column looks like personal data ('' when it does not). Heuristic only."""
    words = _name_words(col_name)
    if not words:
        return ''
    # single words and adjacent pairs joined (first_name -> firstname, e_mail -> email)
    candidates = list(words) + [a + b for a, b in zip(words, words[1:])]
    candidates += [a + b + c for a, b, c in zip(words, words[1:], words[2:])]
    for w in candidates:
        if w in PII_WORDS:
            return w
    table_words = set(_name_words(table_name)) if table_name else set()
    person_table = bool(table_words & PII_PERSON_TABLE_WORDS)
    ws = set(words)
    if ws & PII_PERSON_ROLES and not ws & PII_NOT_PERSON:
        return next(iter(ws & PII_PERSON_ROLES))
    if ws & PII_NAME_WORDS and not ws & PII_NOT_PERSON:
        if ws & PII_PERSON_WORDS or (person_table and len(ws - PII_NAME_WORDS) <= 1):
            return 'person name'
    if person_table and ws & PII_PERSON_LOCATION and len(ws) <= 2:
        return 'by (persontabel)'
    return ''


def is_pii(col_name, table_name=None):
    """True when the column name looks like personal data. Pass the table name
    for context: `name` and `city` only count in tables about persons."""
    return bool(pii_reason(col_name, table_name))


def identify_m_source(m_expr):
    """Extract source kind and details from Power Query M expression."""
    if not m_expr:
        return {'kind': 'Unknown', 'details': '(no expression)'}

    patterns = [
        (r'Sql\.Databases?\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")?',
         'SQL Server', lambda r: f'{r[0]} / {r[1]}' if r[1] else r[0]),
        (r'Snowflake\.Databases\(\s*"([^"]+)"\s*,\s*"([^"]+)"',
         'Snowflake', lambda r: f'{r[0]} / {r[1]}'),
        (r'AzureStorage\.DataLake\(\s*"([^"]+)"', 'Azure Data Lake', lambda r: r[0]),
        (r'AzureStorage\.Blobs\(\s*"([^"]+)"', 'Azure Blob', lambda r: r[0]),
        (r'Databricks\.Catalogs\(\s*"([^"]+)"', 'Databricks', lambda r: r[0]),
        (r'PostgreSQL\.Database\(\s*"([^"]+)"\s*,\s*"([^"]+)"',
         'PostgreSQL', lambda r: f'{r[0]} / {r[1]}'),
        (r'MySQL\.Database\(\s*"([^"]+)"\s*,\s*"([^"]+)"',
         'MySQL', lambda r: f'{r[0]} / {r[1]}'),
        (r'Oracle\.Database\(\s*"([^"]+)"', 'Oracle', lambda r: r[0]),
        (r'Web\.Contents\(\s*"([^"]+)"', 'Web / REST', lambda r: r[0]),
        (r'SharePoint\.(Files|Contents)\(\s*"([^"]+)"',
         'SharePoint', lambda r: r[1]),
        (r'OData\.Feed\(\s*"([^"]+)"', 'OData', lambda r: r[0]),
        # the path may be a folder parameter joined with the file name: "C:\data\" & "sales.xlsx"
        (r'Excel\.Workbook\(File\.Contents\(\s*((?:"[^"]*"\s*&\s*)*"[^"]+")',
         'Excel File', lambda r: ''.join(re.findall(r'"([^"]*)"', r[0]))),
        (r'Csv\.Document\(File\.Contents\(\s*((?:"[^"]*"\s*&\s*)*"[^"]+")',
         'CSV File', lambda r: ''.join(re.findall(r'"([^"]*)"', r[0]))),
        (r'Folder\.Files\(\s*"([^"]+)"', 'Folder', lambda r: r[0]),
        (r'Pbi\.Dataflows?\(', 'Dataflow', lambda r: '(Power BI Dataflow)'),
        (r'#shared\s*\[', 'Shared / Dataflow', lambda r: '(Dataflow or shared)'),
    ]

    for pat, kind, fmt in patterns:
        # (?<![\w.]) keeps e.g. `Sql.Database` from matching inside `PostgreSQL.Database`
        match = re.search(r'(?<![\w.])' + pat, m_expr, re.IGNORECASE)
        if match:
            groups = match.groups()
            return {'kind': kind, 'details': fmt(groups)}

    return {'kind': 'Other', 'details': '(unrecognized)'}


# ---------------------------------------------------------------------------
# Generic TMDL block parser
# ---------------------------------------------------------------------------
# TMDL is indentation based: an object is declared as `<kind> <name>` (optionally
# `= <expression>`), its properties sit one level deeper, and a multi-line
# expression sits one level deeper than the properties. Descriptions are `///`
# lines placed directly ABOVE the object they describe.

TMDL_OBJECT_KINDS = {
    'table', 'column', 'measure', 'partition', 'hierarchy', 'level',
    'calculationGroup', 'calculationItem', 'annotation', 'expression',
    'relationship', 'role', 'tablePermission', 'columnPermission',
    'changedProperty', 'extendedProperty', 'perspective', 'perspectiveTable',
    'perspectiveColumn', 'perspectiveMeasure', 'culture', 'linguisticMetadata',
    'calendar', 'formatStringDefinition', 'detailRowsDefinition', 'model',
    'database', 'dataSource', 'queryGroup', 'member', 'function',
}


def _flag(v):
    return v is True or str(v).strip().lower() == 'true'


def _line_levels(lines):
    """Indentation level per line (tabs = 1 level, spaces grouped by the file's unit)."""
    space_counts = [len(l) - len(l.lstrip(' ')) for l in lines
                    if l.startswith(' ') and l.strip()]
    unit = min([c for c in space_counts if c > 0], default=4)
    levels = []
    for l in lines:
        ws = l[:len(l) - len(l.lstrip('\t '))]
        levels.append(ws.count('\t') + ws.count(' ') // unit)
    return levels


def _dedent(buf):
    while buf and not buf[-1].strip():
        buf.pop()
    while buf and not buf[0].strip():
        buf.pop(0)
    if not buf:
        return ''
    pad = min(len(l) - len(l.lstrip('\t ')) for l in buf if l.strip())
    return '\n'.join(l[pad:] if len(l) >= pad else l.strip() for l in buf)


def _read_expression(lines, levels, i, stop_level):
    """Read a multi-line expression starting at line i. Stops at the first
    non-empty line whose level is <= stop_level. Supports ``` fences."""
    n = len(lines)
    j = i
    while j < n and not lines[j].strip():
        j += 1
    if j < n and lines[j].strip().startswith('```'):
        buf = []
        j += 1
        while j < n and not lines[j].strip().startswith('```'):
            buf.append(lines[j])
            j += 1
        return _dedent(buf), j + 1
    buf = []
    while i < n:
        if lines[i].strip() and levels[i] <= stop_level:
            break
        buf.append(lines[i])
        i += 1
    return _dedent(buf), i


def _split_decl_name(rest):
    """`'Name with space' = expr` -> (name, has_equals, inline_expr)."""
    rest = rest.strip()
    if rest.startswith("'"):
        i, buf = 1, []
        while i < len(rest):
            ch = rest[i]
            if ch == "'":
                if i + 1 < len(rest) and rest[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                i += 1
                break
            buf.append(ch)
            i += 1
        name, tail = ''.join(buf), rest[i:].strip()
    else:
        m = re.match(r'([^\s=]+)\s*(.*)$', rest)
        name, tail = (m.group(1), m.group(2).strip()) if m else (rest, '')
    if tail.startswith('='):
        return name, True, tail[1:].strip()
    return name, False, ''


def parse_tmdl_tree(text):
    """Parse TMDL text into a tree of {kind, name, value, props, children, description}."""
    lines = text.replace('\r\n', '\n').split('\n')
    levels = _line_levels(lines)
    root = {'kind': 'root', 'name': '', 'value': '', 'props': {},
            'children': [], 'description': ''}
    stack = [(-1, root)]
    pending_desc = []
    i, n = 0, len(lines)
    while i < n:
        t = lines[i].strip()
        d = levels[i]
        if not t:
            i += 1
            continue
        if t.startswith('///'):
            pending_desc.append(re.sub(r'^///\s?', '', t))
            i += 1
            continue
        while stack[-1][0] >= d:
            stack.pop()
        parent = stack[-1][1]
        m = re.match(r'^(\w+)\b\s*(.*)$', t)
        word, rest = (m.group(1), m.group(2)) if m else ('', '')
        if word == 'ref':
            pending_desc = []
            i += 1
            continue
        if word in TMDL_OBJECT_KINDS and rest and rest[0] not in ':=':
            name, has_eq, val = _split_decl_name(rest)
            node = {'kind': word, 'name': name, 'value': val, 'props': {},
                    'children': [], 'description': ' '.join(pending_desc).strip()}
            pending_desc = []
            i += 1
            if has_eq and val == '':
                node['value'], i = _read_expression(lines, levels, i, d + 1)
            parent['children'].append(node)
            stack.append((d, node))
            continue
        pending_desc = []
        pm = re.match(r'^(\w+)\s*([:=])\s*(.*)$', t)
        if pm:
            key, sep, val = pm.groups()
            i += 1
            if sep == '=' and not val.strip():
                val, i = _read_expression(lines, levels, i, d)
            parent['props'][key] = val.strip() if sep == ':' else val
            continue
        if re.match(r'^\w+$', t):
            parent['props'][t] = True
        i += 1
    return root


def _table_from_node(tn):
    p = tn['props']
    table = {
        'name': tn['name'],
        'isHidden': _flag(p.get('isHidden')),
        'dataCategory': p.get('dataCategory', ''),
        'description': tn['description'],
        'isCalculated': False,
        'columns': [],
        'measures': [],
        'partitions': [],
    }
    for c in tn['children']:
        cp = c['props']
        if c['kind'] == 'column':
            expr = c['value'] or cp.get('expression', '')
            table['columns'].append({
                'name': c['name'],
                'dataType': cp.get('dataType', ''),
                'isHidden': _flag(cp.get('isHidden')),
                'isKey': _flag(cp.get('isKey')),
                'isCalculated': bool(expr),
                'expression': expr,
                'sourceColumn': cp.get('sourceColumn', ''),
                'formatString': cp.get('formatString', ''),
                'displayFolder': cp.get('displayFolder', ''),
                'dataCategory': cp.get('dataCategory', ''),
                'description': c['description'],
            })
        elif c['kind'] == 'measure':
            table['measures'].append({
                'name': c['name'],
                'expression': c['value'],
                'displayFolder': cp.get('displayFolder', ''),
                'description': c['description'],
                'formatString': cp.get('formatString', ''),
                'isHidden': _flag(cp.get('isHidden')),
            })
        elif c['kind'] == 'partition':
            source_type = (c['value'] or '').strip()
            table['partitions'].append({
                'name': c['name'],
                'mode': str(cp.get('mode', 'import')).lower(),
                'mExpression': cp.get('source', '') if isinstance(cp.get('source'), str) else '',
                'sourceType': source_type,
                'queryGroup': cp.get('queryGroup', ''),
            })
            if source_type == 'calculated':
                table['isCalculated'] = True
    return table


def parse_table_tmdl(text):
    """Parse a single table .tmdl file into a table dict."""
    tree = parse_tmdl_tree(text)
    for node in tree['children']:
        if node['kind'] == 'table':
            return _table_from_node(node)
    return None


def parse_expressions_tmdl(text):
    """Shared queries and parameters from expressions.tmdl."""
    out = []
    for node in parse_tmdl_tree(text)['children']:
        if node['kind'] != 'expression':
            continue
        value = node['value']
        is_param = bool(re.search(r'IsParameterQuery\s*=\s*true', value, re.IGNORECASE))
        literal = ''
        if is_param:
            lm = re.match(r'^\s*("(?:[^"]|"")*"|[\w.\-#]+)\s*meta\b', value)
            literal = lm.group(1) if lm else ''
        out.append({
            'name': node['name'],
            'kind': 'parameter' if is_param else 'query',
            'mExpression': value,
            'parameterValue': literal,
            'description': node['description'],
            'queryGroup': node['props'].get('queryGroup', ''),
        })
    return out


# ---------------------------------------------------------------------------
# Power Query (M) analysis: steps, references and column lineage
# ---------------------------------------------------------------------------

def _strip_m_comments(s):
    out, i, n = [], 0, len(s)
    while i < n:
        ch = s[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if s[j] == '"':
                    if j + 1 < n and s[j + 1] == '"':
                        j += 2
                        continue
                    break
                j += 1
            out.append(s[i:j + 1])
            i = j + 1
        elif s.startswith('//', i):
            while i < n and s[i] != '\n':
                i += 1
        elif s.startswith('/*', i):
            end = s.find('*/', i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _scan_top_level(s, on_char):
    """Walk s tracking bracket depth and strings; call on_char(i, depth) outside strings."""
    depth, i, n = 0, 0, len(s)
    while i < n:
        ch = s[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if s[j] == '"':
                    if j + 1 < n and s[j + 1] == '"':
                        j += 2
                        continue
                    break
                j += 1
            i = j + 1
            continue
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        stop = on_char(i, depth)
        if stop:
            return i
        i += 1
    return -1


def _split_top_level(s, sep=','):
    parts, last = [], [0]

    def cb(i, depth):
        if depth == 0 and s[i] == sep:
            parts.append(s[last[0]:i])
            last[0] = i + 1
        return False
    _scan_top_level(s, cb)
    parts.append(s[last[0]:])
    return [p.strip() for p in parts]


def _m_ident(s):
    s = s.strip()
    m = re.match(r'^#"((?:[^"]|"")*)"$', s)
    if m:
        return m.group(1).replace('""', '"')
    return s


def parse_m_steps(m_expr):
    """Split `let a = ..., b = ... in b` into ([{'name','expression'}], result)."""
    s = _strip_m_comments(m_expr or '').strip()
    lm = re.match(r'^let\b', s)
    if not lm:
        return [], s
    body = s[3:]
    # find the matching top-level `in`, honouring nested let/in
    words = []

    def cb(i, depth):
        if depth == 0 and (i == 0 or not (body[i - 1].isalnum() or body[i - 1] in '_.#')):
            for w in ('let', 'in'):
                if body.startswith(w, i) and (i + len(w) == len(body) or not (body[i + len(w)].isalnum() or body[i + len(w)] == '_')):
                    words.append((i, w))
        return False
    _scan_top_level(body, cb)
    nest, in_pos = 0, -1
    for pos, w in words:
        if w == 'let':
            nest += 1
        elif nest == 0:
            in_pos = pos
            break
        else:
            nest -= 1
    if in_pos < 0:
        return [], s
    steps_txt, result = body[:in_pos], body[in_pos + 2:].strip()
    steps = []
    for part in _split_top_level(steps_txt):
        if not part:
            continue
        sm = re.match(r'^(#"(?:[^"]|"")*"|[^\W\d][\w.]*)\s*=\s*(.*)$', part, re.S)
        if sm:
            steps.append({'name': _m_ident(sm.group(1)), 'expression': sm.group(2).strip()})
    return steps, _m_ident(result)


def _m_identifiers(expr):
    """Identifiers used in an M expression (strings removed)."""
    s = re.sub(r'"(?:[^"]|"")*"', '""', _strip_m_comments(expr or ''))
    ids = set(re.findall(r'(?<![\w.#\[])([^\W\d][\w]*)(?![\w.])', s))
    ids |= {m.replace('""', '"') for m in re.findall(r'#"((?:[^"]|"")*)"', expr or '')}
    return ids


def m_references(expr, known_names, local_names=()):
    """Other queries/tables an M expression refers to."""
    used = _m_identifiers(expr)
    return sorted(n for n in known_names if n in used and n not in local_names)


def _parse_call(expr):
    """`Fn(a, b, c)...` -> ('Fn', ['a','b','c']) or (None, [])."""
    e = expr.strip()
    m = re.match(r'^([\w.]+)\s*\(', e)
    if not m:
        return None, []
    start = m.end() - 1
    end = [-1]
    sub = e[start:]

    def cb(i, depth):
        if depth == 0 and sub[i] == ')':
            end[0] = i
            return True
        return False
    _scan_top_level(sub, cb)
    inner = sub[1:end[0]] if end[0] > 0 else sub[1:]
    return m.group(1), _split_top_level(inner)


def _m_str(arg):
    m = re.match(r'^"((?:[^"]|"")*)"$', (arg or '').strip())
    return m.group(1).replace('""', '"') if m else None


def _m_str_list(arg):
    return [s.replace('""', '"') for s in re.findall(r'"((?:[^"]|"")*)"', arg or '')]


def _m_first_strings(arg):
    """First string of each inner list: {{"a", ...}, {"b", ...}} -> ['a','b']."""
    return [s.replace('""', '"') for s in re.findall(r'\{\s*"((?:[^"]|"")*)"\s*,', arg or '')]


def _m_first_table_arg(arg):
    """Dig out the table an argument starts from: `{Table.SelectColumns(A, x), B}` -> 'A',
    `Table.PromoteHeaders(Kilde{[...]}[Data])` -> 'Kilde{[...]}[Data]'."""
    a = (arg or '').strip()
    for _ in range(8):
        if a.startswith('{') and a.endswith('}'):
            a = _split_top_level(a[1:-1])[0]
            continue
        fn, args = _parse_call(a)
        if fn and args:
            a = args[0]
            continue
        break
    return a


def _m_item_for(arg, col):
    """The `{"col", ...}` item for one column inside a transform list."""
    a = (arg or '').strip()
    if a.startswith('{') and a.endswith('}'):
        for item in _split_top_level(a[1:-1]):
            if re.match(r'^\{\s*"' + re.escape(col.replace('"', '""')) + r'"\s*,', item):
                return item
    return a


def _m_navigation(expr):
    """`Kilde{[Schema="gold",Item="x"]}[Data]` -> (base, 'gold.x')."""
    m = re.match(r'^\s*(#"(?:[^"]|"")*"|[^\W\d][\w.]*)\s*\{\s*\[(.*?)\]\s*\}', expr or '', re.S)
    if not m:
        return None, ''
    kv = dict(re.findall(r'(\w+)\s*=\s*"((?:[^"]|"")*)"', m.group(2)))
    parts = [kv[k] for k in ('Schema', 'Item', 'Name') if k in kv]
    if 'Kind' in kv and 'Item' in kv:
        parts = [f"{kv['Item']} ({kv['Kind']})"]
    return _m_ident(m.group(1)), '.'.join(parts)


def substitute_parameters(expr, params):
    """Replace parameter identifiers with their literal values (for source detection)."""
    out = expr or ''
    for name, literal in params.items():
        if not literal:
            continue
        out = re.sub(r'(?<![\w."#])' + re.escape(name) + r'(?![\w"])', lambda _m: literal, out)
        out = out.replace(f'#"{name}"', literal)
    return out


def trace_m_column(query, column, queries, depth=0):
    """Follow `column` backwards through the steps of `query` (and the queries it
    reads from). Returns (events ordered source -> table, origin dict)."""
    q = queries.get(query)
    if not q or depth > 10:
        return [], {'kind': 'unknown', 'query': query, 'column': column}
    steps = {s['name']: s['expression'] for s in q['steps']}
    if not steps:
        # single-expression query (no let/in): treat the whole expression as one step
        steps = {'__expr__': q['mExpression']}
        cur = '__expr__'
    else:
        cur = q['result']
    col = column
    back = []
    nav_obj = ''

    def ev(action, detail, **extra):
        back.append({'query': query, 'step': '' if cur == '__expr__' else cur,
                     'action': action, 'detail': detail, **extra})

    def finish(sub_query=None, sub_col=None, origin=None):
        mine = list(reversed(back))
        if sub_query:
            up, org = trace_m_column(sub_query, sub_col, queries, depth + 1)
            return up + mine, org
        return mine, origin

    guard = 0
    while cur in steps and guard < 500:
        guard += 1
        e = steps[cur]
        fn, args = _parse_call(e)
        prev = None
        if args:
            first = _m_first_table_arg(args[0])
            if re.match(r'^(#"(?:[^"]|"")*"|[^\W\d][\w.]*)$', first):
                prev = _m_ident(first)
            elif _m_navigation(first)[0]:
                e = first
        if fn == 'Table.Combine' and args:
            parts = _split_top_level(args[0].strip()[1:-1]) if args[0].strip().startswith('{') else []
            if len(parts) > 1:
                ev('Combined (append)', ', '.join(_m_first_table_arg(x) for x in parts))
        if fn == 'Table.AddIndexColumn' and len(args) > 1 and _m_str(args[1]) == col:
            ev('Index/key', f'Running number from {args[2] if len(args) > 2 else 0}')
            return finish(origin={'kind': 'computed', 'query': query, 'step': cur, 'column': col})
        if fn == 'Table.RenameColumns' and len(args) > 1:
            names = _m_str_list(args[1])
            for old, new in zip(names[0::2], names[1::2]):
                if new == col:
                    ev('Renamed', f'{old} → {new}')
                    col = old
                    break
        elif fn == 'Table.AddColumn' and len(args) > 2 and _m_str(args[1]) == col:
            formula = args[2]
            ev('Calculated', formula, inputs=sorted(set(re.findall(r'\[([^\]]+)\]', formula))))
            return finish(origin={'kind': 'computed', 'query': query, 'step': cur, 'column': col})
        elif fn == 'Table.DuplicateColumn' and len(args) > 2 and _m_str(args[2]) == col:
            ev('Copied', f'{_m_str(args[1])} → {col}')
            col = _m_str(args[1]) or col
        elif fn in ('Table.ExpandTableColumn', 'Table.ExpandRecordColumn') and len(args) > 2:
            nested = _m_str(args[1])
            src_cols = _m_str_list(args[2])
            new_cols = _m_str_list(args[3]) if len(args) > 3 else src_cols
            if col in new_cols and len(new_cols) == len(src_cols):
                src_col = src_cols[new_cols.index(col)]
                joined = None
                join_expr = None
                # NestedJoin and AddJoinColumn: (table1, key1, table2, key2, newColumnName, ...)
                # 1) inline in this step: Table.ExpandTableColumn(Table.NestedJoin(...), "j", ...) – the
                #    usual shape when every join reuses the same column name, so it must win over 2)
                jfn, jargs = _parse_call(args[0].strip())
                if jfn in ('Table.NestedJoin', 'Table.AddJoinColumn') and len(jargs) > 4 and _m_str(jargs[4]) == nested:
                    join_expr = jargs[2]
                else:
                    # 2) in an earlier step of its own
                    for sname, sexpr in steps.items():
                        jfn, jargs = _parse_call(sexpr)
                        if jfn in ('Table.NestedJoin', 'Table.AddJoinColumn') and len(jargs) > 4 \
                                and _m_str(jargs[4]) == nested:
                            join_expr = jargs[2]
                            break
                if join_expr is not None:
                    gfn, gargs = _parse_call(join_expr.strip())
                    if gfn == 'Table.Group' and len(gargs) > 2:
                        # joined from an aggregate: follow the aggregated column into the grouped table
                        group_src = _m_ident(_m_first_table_arg(gargs[0]))
                        agg = _m_item_for(gargs[2], src_col)
                        inner = re.findall(r'\[([^\]]+)\]', agg)
                        ev('Joined in', f'{group_src} aggregated: {src_col}' + (f' → {col}' if src_col != col else ''))
                        ev('Aggregated', agg)
                        if inner and group_src in queries:
                            return finish(group_src, inner[0])
                        if inner and group_src in steps and group_src != cur:
                            cur, col = group_src, inner[0]
                            continue
                        return finish(origin={'kind': 'computed', 'query': query, 'step': cur, 'column': col})
                    joined = _m_ident(_m_first_table_arg(join_expr))
                ev('Joined in', f'{joined or nested}[{src_col}]' + (f' → {col}' if src_col != col else ''))
                if joined and joined in steps and joined != cur:
                    # the joined table is a local step: keep tracing inside this query
                    cur, col = joined, src_col
                    continue
                if joined and joined in queries:
                    return finish(joined, src_col)
                return finish(origin={'kind': 'join', 'query': joined or nested, 'column': src_col})
        elif fn == 'Table.SplitColumn' and len(args) > 3 and col in _m_str_list(args[3]):
            src = _m_str(args[1]) or col
            delim = _m_str_list(args[2])
            ev('Split', f'{src} → {col}' + (f' (delimiter "{delim[0]}")' if delim else ''))
            col = src
        elif fn == 'Table.UnpivotOtherColumns' and len(args) > 3 and col in (_m_str(args[2]), _m_str(args[3])):
            keep = ', '.join(_m_str_list(args[1]))
            what = 'column names' if col == _m_str(args[2]) else 'values'
            ev('Unpivot', f'{col} = {what} from all columns except {keep}')
            col = f'(all columns except {keep})'
        elif fn == 'Table.TransformColumns' and len(args) > 1 and col in _m_first_strings(args[1]):
            ev('Transformed', _m_item_for(args[1], col))
        elif fn == 'Table.TransformColumnTypes' and len(args) > 1 and col in _m_first_strings(args[1]):
            ev('Data type set', '')
        elif fn == 'Table.ReplaceValue' and args and col in _m_str_list(args[-1]):
            ev('Values replaced', ', '.join(args[1:3]))
        elif fn == 'Table.Group' and len(args) > 2 and col in _m_first_strings(args[2]):
            ev('Aggregated', args[2])
            return finish(origin={'kind': 'computed', 'query': query, 'step': cur, 'column': col})

        if prev and prev in steps and prev != cur:
            cur = prev
            continue
        if prev and prev in queries and prev != query:
            return finish(prev, col)
        bare = _m_ident(e) if re.match(r'^(#"(?:[^"]|"")*"|[^\W\d][\w.]*)$', e.strip()) else None
        if bare and bare in steps and bare != cur:
            cur = bare
            continue
        if bare and bare in queries and bare != query:
            # a loaded table, or a shared query with its own steps (a staging query that is not loaded):
            # keep tracing inside it, down to the sheet or file it reads. After a navigation step
            # (Source{[Schema=…, Item=…]}) the shared query is only a connection: stop here instead.
            if queries[bare]['kind'] == 'table' or (queries[bare].get('steps') and not nav_obj):
                return finish(bare, col)
            return finish(origin={'kind': 'source', 'query': bare, 'object': nav_obj,
                                  'column': col, 'source': resolve_query_source(bare, queries)})
        base, obj = _m_navigation(e)
        if base:
            if obj:
                ev('Navigation', obj)
                nav_obj = nav_obj or obj
            if base in steps and base != cur:
                cur = base
                continue
            if base in queries and queries[base]['kind'] == 'table':
                return finish(base, col)
            src = resolve_query_source(base, queries) if base in queries else identify_m_source(e)
            return finish(origin={'kind': 'source', 'query': base, 'object': nav_obj or obj,
                                  'column': col, 'source': src})
        src = identify_m_source(q.get('mResolved', e) if cur == '__expr__' else substitute_parameters(e, q.get('params', {})))
        kind = 'source' if src['kind'] not in ('Other', 'Unknown') else 'computed'
        return finish(origin={'kind': kind, 'query': query, 'step': cur, 'column': col,
                              'object': nav_obj, 'source': src})
    return finish(origin={'kind': 'unknown', 'query': query, 'column': col})


def resolve_query_source(name, queries, seen=None):
    """Data source behind a query, following references to shared queries."""
    seen = seen or set()
    if name in seen or name not in queries:
        return {'kind': 'Unknown', 'details': '(no expression)'}
    seen.add(name)
    q = queries[name]
    src = identify_m_source(q.get('mResolved', q.get('mExpression', '')))
    if src['kind'] not in ('Other', 'Unknown'):
        return src
    for ref in q.get('references', []):
        s = resolve_query_source(ref, queries, seen)
        if s['kind'] not in ('Other', 'Unknown'):
            return s
    return src


def build_queries(model):
    """Map every M query (tables + shared expressions) to steps and references."""
    params = {e['name']: e['parameterValue'] for e in model.get('expressions', [])
              if e['kind'] == 'parameter'}
    raw = {}
    for e in model.get('expressions', []):
        raw[e['name']] = {'kind': e['kind'], 'mExpression': e['mExpression']}
    for t in model['tables']:
        for p in t['partitions']:
            if p['sourceType'] in ('m', '') and p['mExpression']:
                raw[t['name']] = {'kind': 'table', 'mExpression': p['mExpression']}
                break
    names = set(raw)
    queries = {}
    for name, q in raw.items():
        steps, result = parse_m_steps(q['mExpression'])
        local = {s['name'] for s in steps}
        queries[name] = {
            **q,
            'steps': steps,
            'result': result,
            'params': params,
            'mResolved': substitute_parameters(q['mExpression'], params),
            'references': m_references(q['mExpression'], names - {name}, local),
        }
    return queries


# ---------------------------------------------------------------------------
# DAX dependencies
# ---------------------------------------------------------------------------

def _strip_dax(expr):
    s = re.sub(r'"(?:[^"]|"")*"', '""', expr or '')
    s = re.sub(r'/\*.*?\*/', ' ', s, flags=re.S)
    s = re.sub(r'(//|--)[^\n]*', ' ', s)
    return s


def dax_dependencies(expr, measure_index, table_columns):
    """Measures, columns and tables referenced by a DAX expression.
    measure_index: {measure_name: table}; table_columns: {table: set(columns)}."""
    s = _strip_dax(expr)
    measures, columns, tables = set(), set(), set()
    spans = []
    for m in re.finditer(r"('(?:[^']|'')+'|(?<![\w\]])[^\W\d]\w*)\s*\[([^\]]+)\]", s):
        tname = m.group(1)
        if tname.startswith("'"):
            tname = tname[1:-1].replace("''", "'")
        name = m.group(2).strip()
        if tname not in table_columns:
            continue
        spans.append((m.start(), m.end()))
        if name in measure_index and name not in table_columns[tname]:
            measures.add(name)
        else:
            columns.add((tname, name))
    for m in re.finditer(r'\[([^\]]+)\]', s):
        if any(a <= m.start() < b for a, b in spans):
            continue
        name = m.group(1).strip()
        if name in measure_index:
            measures.add(name)
    for tname in table_columns:
        pat = (r"'" + re.escape(tname.replace("'", "''")) + r"'(?!\s*\[)") if not re.match(r'^[^\W\d]\w*$', tname) \
            else (r"(?<![\w'\[])" + re.escape(tname) + r"(?![\w'])(?!\s*\[)")
        if re.search(pat, s):
            tables.add(tname)
    return {
        'measures': sorted(measures),
        'columns': [{'table': t, 'column': c} for t, c in sorted(columns)],
        'tables': sorted(tables),
    }


def enrich_model(model):
    """Add M steps, column lineage and DAX dependencies to a parsed model."""
    queries = build_queries(model)
    measure_index = {m['name']: t['name'] for t in model['tables'] for m in t['measures']}
    table_columns = {t['name']: {c['name'] for c in t['columns']} for t in model['tables']}
    for t in model['tables']:
        q = queries.get(t['name'])
        for p in t['partitions']:
            if q and p['mExpression'] == q['mExpression']:
                p['steps'] = q['steps']
                p['references'] = q['references']
                p['resolvedSource'] = resolve_query_source(t['name'], queries)
        for c in t['columns']:
            if c.get('isCalculated'):
                c['dependencies'] = dax_dependencies(c.get('expression', ''), measure_index, table_columns)
            elif q and c.get('sourceColumn'):
                events, origin = trace_m_column(t['name'], c['sourceColumn'], queries)
                c['lineage'] = events
                c['origin'] = origin
        for m in t['measures']:
            m['dependencies'] = dax_dependencies(m.get('expression', ''), measure_index, table_columns)
        if t.get('isCalculated'):
            calc = next((p for p in t['partitions'] if p['sourceType'] == 'calculated'), None)
            if calc:
                t['dependencies'] = dax_dependencies(calc['mExpression'], measure_index, table_columns)
    for e in model.get('expressions', []):
        q = queries.get(e['name'], {})
        e['steps'] = q.get('steps', [])
        e['references'] = q.get('references', [])
        if e['kind'] == 'query':
            e['resolvedSource'] = resolve_query_source(e['name'], queries)
    return model


def parse_relationships_tmdl(text):
    rels = []
    regex = re.compile(
        r"relationship\s+('[^']+'|[\w-]+)\s*\n((?:[ \t]+.*\n?|\s*\n)+)",
        re.MULTILINE
    )
    for match in regex.finditer(text):
        body = match.group(2)
        rel = {
            'name': unquote_tmdl(match.group(1)),
            'from': {},
            'to': {},
            'crossFilter': 'singleDirection',
            'active': True,
            'fromCardinality': 'many',
            'toCardinality': 'one',
        }
        for side in ('from', 'to'):
            cm = re.search(side + r'Cardinality\s*:?\s*(\w+)', body)
            if cm:
                rel[side + 'Cardinality'] = cm.group(1)
        fc = re.search(r'fromColumn\s*:?\s*(.+)', body)
        tc = re.search(r'toColumn\s*:?\s*(.+)', body)
        cf = re.search(r'crossFilteringBehavior\s*:?\s*(\w+)', body)
        ac = re.search(r'isActive\s*:?\s*(false|true)', body, re.IGNORECASE)
        if fc:
            t, c = split_table_column(fc.group(1).strip())
            rel['from'] = {'table': t, 'column': c}
        if tc:
            t, c = split_table_column(tc.group(1).strip())
            rel['to'] = {'table': t, 'column': c}
        if cf:
            rel['crossFilter'] = cf.group(1)
        if ac:
            rel['active'] = ac.group(1).lower() == 'true'
        if rel['from'].get('table') and rel['to'].get('table'):
            rels.append(rel)
    return rels


def parse_roles_tmdl(text):
    roles = []
    lines = text.split('\n')
    current = None
    i = 0
    while i < len(lines):
        l = lines[i]
        trimmed = l.strip()
        indent = len(l) - len(l.lstrip())

        if indent == 0 and re.match(r'^role\s+', trimmed):
            if current:
                roles.append(current)
            name = unquote_tmdl(re.sub(r'^role\s+', '', trimmed).strip())
            current = {'name': name, 'modelPermission': 'read', 'tablePermissions': []}
        elif current and re.match(r'^tablePermission\s+', trimmed):
            tp_match = re.match(r'^tablePermission\s+(.+?)\s*=\s*(.*)$', trimmed)
            if tp_match:
                tp = {
                    'table': unquote_tmdl(tp_match.group(1)),
                    'filter': tp_match.group(2).strip(),
                }
                if not tp['filter']:
                    base = indent
                    expr_lines = []
                    j = i + 1
                    while j < len(lines):
                        ll = lines[j]
                        ind = len(ll) - len(ll.lstrip())
                        if ind <= base and ll.strip():
                            break
                        expr_lines.append(ll.strip())
                        j += 1
                    tp['filter'] = '\n'.join(expr_lines)
                    i = j - 1
                current['tablePermissions'].append(tp)
        elif current:
            mp = re.match(r'^modelPermission\s*:?\s*(\w+)', trimmed)
            if mp:
                current['modelPermission'] = mp.group(1)
        i += 1
    if current:
        roles.append(current)
    return roles


def parse_tmsl(obj, model):
    """Fallback parser for legacy model.bim TMSL JSON."""
    m = obj.get('model', obj)
    for t in m.get('tables', []):
        table = {
            'name': t['name'],
            'isHidden': bool(t.get('isHidden')),
            'dataCategory': t.get('dataCategory', ''),
            'description': t.get('description', ''),
            'columns': [],
            'measures': [],
            'partitions': [],
        }
        for c in t.get('columns', []):
            table['columns'].append({
                'name': c['name'],
                'dataType': c.get('dataType', ''),
                'isHidden': bool(c.get('isHidden')),
                'isKey': bool(c.get('isKey')),
                'isCalculated': c.get('type') == 'calculated',
            })
        for me in t.get('measures', []):
            expr = me.get('expression', '')
            if isinstance(expr, list):
                expr = '\n'.join(expr)
            table['measures'].append({
                'name': me['name'],
                'expression': expr,
                'displayFolder': me.get('displayFolder', ''),
                'description': me.get('description', ''),
                'formatString': me.get('formatString', ''),
                'isHidden': bool(me.get('isHidden')),
            })
        for p in t.get('partitions', []):
            src = p.get('source', {})
            expr = src.get('expression', '')
            if isinstance(expr, list):
                expr = '\n'.join(expr)
            table['partitions'].append({
                'name': p['name'],
                'mode': p.get('mode', 'import'),
                'mExpression': expr,
                'sourceType': src.get('type', ''),
            })
        model['tables'].append(table)

    for r in m.get('relationships', []):
        model['relationships'].append({
            'from': {'table': r['fromTable'], 'column': r['fromColumn']},
            'to': {'table': r['toTable'], 'column': r['toColumn']},
            'crossFilter': r.get('crossFilteringBehavior', 'singleDirection'),
            'active': r.get('isActive', True),
        })

    for r in m.get('roles', []):
        role = {
            'name': r['name'],
            'modelPermission': r.get('modelPermission', 'read'),
            'tablePermissions': [],
        }
        for tp in r.get('tablePermissions', []):
            role['tablePermissions'].append({
                'table': tp.get('name', tp.get('table', '')),
                'filter': tp.get('filterExpression', tp.get('filter', '')),
            })
        model['roles'].append(role)


def parse_model(pbip_root):
    """Find and parse SemanticModel. Returns model dict."""
    pbip_root = Path(pbip_root)
    model = {
        'name': '',
        'tables': [],
        'relationships': [],
        'roles': [],
        'expressions': [],
        'dataSources': [],
    }

    # Project name from .pbip file
    for f in pbip_root.iterdir():
        if f.suffix == '.pbip':
            model['name'] = f.stem
            break

    # Find SemanticModel folder
    sm_dirs = list(pbip_root.glob('*.SemanticModel'))
    if not sm_dirs:
        raise RuntimeError(f'No *.SemanticModel folder found in {pbip_root}')
    sm_dir = sm_dirs[0]

    definition_dir = sm_dir / 'definition'
    bim_file = sm_dir / 'model.bim'

    if definition_dir.is_dir():
        # TMDL format
        tables_dir = definition_dir / 'tables'
        if tables_dir.is_dir():
            for tmdl_file in sorted(tables_dir.glob('*.tmdl')):
                text = tmdl_file.read_text(encoding='utf-8-sig')
                t = parse_table_tmdl(text)
                if t:
                    model['tables'].append(t)

        # Shared queries and parameters
        expr_file = definition_dir / 'expressions.tmdl'
        if expr_file.is_file():
            model['expressions'] = parse_expressions_tmdl(
                expr_file.read_text(encoding='utf-8-sig')
            )

        # Relationships
        rel_file = definition_dir / 'relationships.tmdl'
        if rel_file.is_file():
            model['relationships'] = parse_relationships_tmdl(
                rel_file.read_text(encoding='utf-8-sig')
            )
        # Sometimes in model.tmdl
        model_file = definition_dir / 'model.tmdl'
        if model_file.is_file():
            extra = parse_relationships_tmdl(model_file.read_text(encoding='utf-8-sig'))
            model['relationships'].extend(extra)

        # Roles
        roles_dir = definition_dir / 'roles'
        if roles_dir.is_dir():
            for role_file in sorted(roles_dir.glob('*.tmdl')):
                model['roles'].extend(parse_roles_tmdl(
                    role_file.read_text(encoding='utf-8-sig')
                ))
        roles_file = definition_dir / 'roles.tmdl'
        if roles_file.is_file():
            model['roles'].extend(parse_roles_tmdl(
                roles_file.read_text(encoding='utf-8-sig')
            ))

    elif bim_file.is_file():
        # Legacy TMSL
        obj = json.loads(bim_file.read_text(encoding='utf-8-sig'))
        parse_tmsl(obj, model)
    else:
        raise RuntimeError(f'Neither definition/ nor model.bim found in {sm_dir}')

    enrich_model(model)

    # Data source inventory (shared queries and parameters are followed)
    sources = {}
    for t in model['tables']:
        for p in t['partitions']:
            src = p.get('resolvedSource') or identify_m_source(p['mExpression'])
            key = f"{src['kind']}::{src['details']}"
            if key not in sources:
                sources[key] = {**src, 'tables': []}
            if t['name'] not in sources[key]['tables']:
                sources[key]['tables'].append(t['name'])
    model['dataSources'] = list(sources.values())

    return model


def extract_field_from_expr(pr):
    """Extract 'Table.Column' or 'Measure' string from a PBIR projection."""
    try:
        f = pr.get('field', pr)
        col = f.get('Column') or f.get('Measure') or f.get('HierarchyLevel')
        if not col:
            return None
        expr = col.get('Expression', {})
        source_ref = expr.get('SourceRef', {})
        entity = source_ref.get('Entity') or source_ref.get('Source')
        prop = col.get('Property') or col.get('Level')
        if entity and prop:
            return f'{entity}.{prop}'
        if prop:
            return prop
    except (KeyError, TypeError, AttributeError):
        pass
    return None


def extract_pbir_visual(vo):
    inner = vo.get('visual', vo)
    visual = {
        'type': inner.get('visualType', 'unknown'),
        'title': '',
        'fields': [],
    }
    try:
        t = inner.get('objects', {}).get('title', [{}])[0].get(
            'properties', {}).get('text', {}).get('expr', {}).get(
            'Literal', {}).get('Value')
        if t:
            visual['title'] = t.strip("'")
    except (KeyError, IndexError, AttributeError, TypeError):
        pass
    query_state = inner.get('query', {}).get('queryState', {})
    for role, rdata in query_state.items():
        for pr in rdata.get('projections', []):
            field = extract_field_from_expr(pr)
            if field:
                visual['fields'].append(field)
    visual['id'] = vo.get('name', '')
    pos = vo.get('position', {})
    visual['position'] = {k: pos.get(k) for k in ('x', 'y', 'width', 'height') if k in pos}
    visual['fieldRefs'] = collect_field_refs(vo)
    return visual


def collect_field_refs(vo):
    """Every measure/column a PBIR visual binds to, incl. formatting and filters.
    Returns [{'table','name','kind','role'}] where role is the query role
    (Values, Category, ...) or 'Formatering' / 'Filter'."""
    aliases = {}

    def find_aliases(o):
        if isinstance(o, dict):
            for f in o.get('From', []) if isinstance(o.get('From'), list) else []:
                if isinstance(f, dict) and f.get('Name') and f.get('Entity'):
                    aliases[f['Name']] = f['Entity']
            for v in o.values():
                find_aliases(v)
        elif isinstance(o, list):
            for v in o:
                find_aliases(v)
    find_aliases(vo)

    refs, seen = [], set()

    def add(node, kind, role):
        expr = node.get('Expression', {})
        if kind == 'HierarchyLevel':
            expr = expr.get('Hierarchy', {}).get('Expression', {})
            name = node.get('Level')
        else:
            name = node.get('Property')
        sref = expr.get('SourceRef', {}) if isinstance(expr, dict) else {}
        table = sref.get('Entity') or aliases.get(sref.get('Source', ''), '')
        if not (table and name):
            return
        key = (table, name, kind, role)
        if key not in seen:
            seen.add(key)
            refs.append({'table': table, 'name': name,
                         'kind': 'Measure' if kind == 'Measure' else 'Column', 'role': role})

    def walk(o, role):
        if isinstance(o, dict):
            for kind in ('Measure', 'Column', 'HierarchyLevel'):
                if isinstance(o.get(kind), dict):
                    add(o[kind], kind, role)
            for v in o.values():
                walk(v, role)
        elif isinstance(o, list):
            for v in o:
                walk(v, role)

    inner = vo.get('visual', vo)
    for role, rdata in inner.get('query', {}).get('queryState', {}).items():
        walk(rdata, role)
    rest = {k: v for k, v in inner.items() if k != 'query'}
    walk(rest, 'Formatering')
    walk(inner.get('query', {}).get('sortDefinition', {}), 'Sortering')
    walk(vo.get('filterConfig', {}), 'Filter')
    return refs


def extract_legacy_visual(config, query):
    sv = config.get('singleVisual', {})
    visual = {
        'type': sv.get('visualType', 'unknown'),
        'title': '',
        'fields': [],
    }
    try:
        t = sv.get('objects', {}).get('title', [{}])[0].get(
            'properties', {}).get('text', {}).get('expr', {}).get(
            'Literal', {}).get('Value')
        if t:
            visual['title'] = t.strip("'")
    except (KeyError, IndexError, AttributeError, TypeError):
        pass
    for role, prs in sv.get('projections', {}).items():
        for pr in prs:
            if 'queryRef' in pr:
                visual['fields'].append(pr['queryRef'])
    return visual


def parse_report(pbip_root):
    pbip_root = Path(pbip_root)
    report = {'pages': []}

    report_dirs = list(pbip_root.glob('*.Report'))
    if not report_dirs:
        return report
    report_dir = report_dirs[0]

    pbir_def = report_dir / 'definition' / 'pages'
    if pbir_def.is_dir():
        # PBIR format
        page_order = {}
        pages_json = pbir_def / 'pages.json'
        if pages_json.is_file():
            try:
                pf = json.loads(pages_json.read_text(encoding='utf-8-sig'))
                for idx, name in enumerate(pf.get('pageOrder', [])):
                    page_order[name] = idx
            except (json.JSONDecodeError, KeyError):
                pass

        for page_folder in sorted(pbir_def.iterdir()):
            if not page_folder.is_dir():
                continue
            page_file = page_folder / 'page.json'
            if not page_file.is_file():
                continue
            try:
                obj = json.loads(page_file.read_text(encoding='utf-8-sig'))
            except json.JSONDecodeError:
                continue
            page = {
                'name': obj.get('name', page_folder.name),
                'displayName': obj.get('displayName', page_folder.name),
                'visuals': [],
                'order': page_order.get(obj.get('name'), 999),
                'format': 'PBIR',
            }
            visuals_dir = page_folder / 'visuals'
            if visuals_dir.is_dir():
                for vf in sorted(visuals_dir.iterdir()):
                    if not vf.is_dir():
                        continue
                    vjson = vf / 'visual.json'
                    if vjson.is_file():
                        try:
                            vo = json.loads(vjson.read_text(encoding='utf-8-sig'))
                            page['visuals'].append(extract_pbir_visual(vo))
                        except json.JSONDecodeError:
                            pass
            report['pages'].append(page)
        report['pages'].sort(key=lambda p: p['order'])
    else:
        # Legacy report.json
        report_json = report_dir / 'report.json'
        if report_json.is_file():
            try:
                obj = json.loads(report_json.read_text(encoding='utf-8-sig'))
                for s in obj.get('sections', []):
                    page = {
                        'name': s.get('name', ''),
                        'displayName': s.get('displayName', s.get('name', '')),
                        'visuals': [],
                    }
                    for vc in s.get('visualContainers', []):
                        try:
                            cfg = json.loads(vc.get('config', '{}'))
                            q = vc.get('query')
                            if isinstance(q, str):
                                q = json.loads(q) if q else None
                            page['visuals'].append(extract_legacy_visual(cfg, q))
                        except (json.JSONDecodeError, TypeError):
                            pass
                    report['pages'].append(page)
            except json.JSONDecodeError:
                pass

    return report


def main():
    args = sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(__doc__)
        sys.exit(0 if args else 1)

    pbip_path = args[0]
    output_file = None
    if '--output' in args:
        idx = args.index('--output')
        if idx + 1 < len(args):
            output_file = args[idx + 1]

    if not os.path.isdir(pbip_path):
        print(f'Error: {pbip_path} is not a directory', file=sys.stderr)
        sys.exit(1)

    result = {
        'model': parse_model(pbip_path),
        'report': parse_report(pbip_path),
    }

    out_json = json.dumps(result, indent=2, ensure_ascii=False)
    if output_file:
        Path(output_file).write_text(out_json, encoding='utf-8')
        print(f'Wrote {output_file}')
    else:
        print(out_json)


if __name__ == '__main__':
    import sys
    # A redirected stream on Windows defaults to cp1252, which cannot write characters such as →.
    for _stream in (sys.stdout, sys.stderr):
        _stream.reconfigure(encoding='utf-8')
    main()
