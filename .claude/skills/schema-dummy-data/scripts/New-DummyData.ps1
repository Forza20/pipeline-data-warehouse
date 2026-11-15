#Requires -Version 5.1
<#
Generates deterministic dummy data CSV files from a table/column schema file,
so pipeline-power-bi can build a demo dashboard without real customer data.

Schema input (CSV or XLSX, first sheet): a long list, one row per column, with
headers (case-insensitive, Danish or English accepted):
  table | tabel        (required)
  column | kolonne     (required)
  type | datatype      (optional hint: id, date, int, decimal, bool, email, string, ...)
  example | eksempel   (optional: "A|B|C" = pick from these values; one value = a
                        number range, a date, or a code pattern like "DK-1234")

Usage:
  New-DummyData.ps1 -SchemaPath schema.csv -OutDir out -PlanOnly
  New-DummyData.ps1 -SchemaPath schema.xlsx -OutDir out -Locale da -Seed 42 -RowsFact 1000 -RowsDim 30
  New-DummyData.ps1 -SchemaPath schema.csv -OutDir out -Rows "fact_orders=2000,dim_customer=100" -EndDate 2026-10-31

NB (Windows PowerShell 5.1): keep the UTF-8 BOM on this file (Danish literals), and
never reuse a param name (Rows, Seed, Locale, EndDate, ...) as a local variable in any
casing - PowerShell treats them as the same variable.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SchemaPath,
    [Parameter(Mandatory = $true)][string]$OutDir,
    [ValidateSet('da', 'en')][string]$Locale = 'da',
    [int]$Seed = -1,
    [int]$RowsFact = 1000,
    [int]$RowsDim = 30,
    [string]$Rows = '',
    [string]$EndDate = '',
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

if ($Seed -lt 0) { $Seed = Get-Random -Minimum 1 -Maximum 2147483646 }

# Two full years ending on the last day of the previous month (complete months only,
# so a demo dashboard has no half-finished last month and can show year-over-year).
if ($EndDate) { $periodEnd = [datetime]::ParseExact($EndDate, 'yyyy-MM-dd', $inv) }
else { $todayDate = (Get-Date).Date; $periodEnd = $todayDate.AddDays(-$todayDate.Day) }
$periodStart = $periodEnd.AddYears(-2).AddDays(1)
$spanDays = ($periodEnd - $periodStart).Days

# One RNG per column, seeded from (seed, table.column): adding or reordering a column
# never reshuffles the values of the other columns.
$md5 = [System.Security.Cryptography.MD5]::Create()
function New-Rng([string]$key) {
    $hash = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("$Seed|$key"))
    return New-Object System.Random ([BitConverter]::ToInt32($hash, 0) -band 0x7FFFFFFF)
}

# ---------------------------------------------------------------------------
# 1. Read the schema file (CSV or XLSX)
# ---------------------------------------------------------------------------

function Read-SchemaCsv([string]$path) {
    $firstLine = Get-Content -Path $path -Encoding UTF8 -TotalCount 1
    # Danish Excel "Save as CSV" uses ';' (',' is the decimal separator there).
    # Pick the delimiter that splits the header into the most fields; comma wins ties.
    $delimiter = ','
    $best = ([regex]::Matches($firstLine, ',')).Count
    foreach ($d in @(';', "`t")) {
        $cnt = ([regex]::Matches($firstLine, [regex]::Escape($d))).Count
        if ($cnt -gt $best) { $delimiter = $d; $best = $cnt }
    }
    $parsed = @(Import-Csv -Path $path -Encoding UTF8 -Delimiter $delimiter)
    if ($parsed.Count -eq 0) { throw "No rows found in $path" }
    return $parsed
}

function Read-ZipXml($zip, [string]$entryName) {
    $entry = $zip.GetEntry($entryName)
    if (-not $entry) { return $null }
    $sr = New-Object System.IO.StreamReader($entry.Open())
    try { $doc = New-Object xml; $doc.LoadXml($sr.ReadToEnd()); return $doc } finally { $sr.Dispose() }
}

function Read-SchemaXlsx([string]$path) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $path).Path)
    try {
        $shared = New-Object System.Collections.Generic.List[string]
        $ss = Read-ZipXml $zip 'xl/sharedStrings.xml'
        if ($ss) {
            foreach ($si in $ss.DocumentElement.ChildNodes) {
                $parts = $si.SelectNodes("*[local-name()='t'] | *[local-name()='r']/*[local-name()='t']")
                $shared.Add((($parts | ForEach-Object { $_.InnerText }) -join ''))
            }
        }

        # First sheet in workbook order (not necessarily sheet1.xml).
        $sheetPath = 'xl/worksheets/sheet1.xml'
        $wb = Read-ZipXml $zip 'xl/workbook.xml'
        $rels = Read-ZipXml $zip 'xl/_rels/workbook.xml.rels'
        if ($wb -and $rels) {
            $firstSheet = @($wb.workbook.sheets.sheet)[0]
            $rid = $firstSheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
            $rel = @($rels.Relationships.Relationship | Where-Object { $_.Id -eq $rid })[0]
            if ($rel) {
                $target = $rel.Target -replace '^/', ''
                $sheetPath = if ($target.StartsWith('xl/')) { $target } else { 'xl/' + $target }
            }
        }
        $sheet = Read-ZipXml $zip $sheetPath
        if (-not $sheet) { throw "No first worksheet found in $path" }

        $grid = New-Object System.Collections.Generic.List[object]
        foreach ($r in $sheet.worksheet.sheetData.row) {
            $cells = @{}
            foreach ($c in $r.c) {
                $colIndex = 0
                foreach ($ch in ($c.r -replace '[0-9]', '').ToCharArray()) { $colIndex = $colIndex * 26 + ([int][char]$ch - 64) }
                $val = $null
                $vNode = $c.Item('v')
                if ($vNode) {
                    $val = if ($c.t -eq 's') { $shared[[int]$vNode.InnerText] } else { $vNode.InnerText }
                } elseif ($c.Item('is')) { $val = $c.Item('is').InnerText }
                $cells[$colIndex] = $val
            }
            if ($cells.Count -gt 0) {
                $maxCol = ($cells.Keys | Measure-Object -Maximum).Maximum
                $arr = New-Object string[] ($maxCol + 1)
                foreach ($k in $cells.Keys) { $arr[$k] = $cells[$k] }
                $grid.Add($arr)
            }
        }
        if ($grid.Count -eq 0) { throw "The first sheet of $path is empty" }
        $header = @($grid[0] | ForEach-Object { if ($_) { $_.Trim() } else { '' } })
        $out = New-Object System.Collections.Generic.List[object]
        for ($i = 1; $i -lt $grid.Count; $i++) {
            $row = $grid[$i]
            $obj = [ordered]@{}
            for ($j = 0; $j -lt $header.Count; $j++) {
                if ($header[$j] -and -not $obj.Contains($header[$j])) { $obj[$header[$j]] = if ($j -lt $row.Count) { $row[$j] } else { '' } }
            }
            $out.Add([pscustomobject]$obj)
        }
        return $out.ToArray()
    } finally {
        $zip.Dispose()
    }
}

function Get-FieldInsensitive($row, [string[]]$names) {
    foreach ($p in $row.PSObject.Properties) {
        if ($names -contains $p.Name.Trim().ToLowerInvariant()) { return [string]$p.Value }
    }
    return $null
}

function Get-Tokens([string]$name) {
    $spaced = $name -creplace '([a-zæøå0-9])([A-ZÆØÅ])', '$1_$2'
    return @(($spaced -split '[^a-zA-Z0-9æøåÆØÅ]+') | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() })
}

function Has([string[]]$tokens, [string[]]$set) {
    foreach ($t in $tokens) { if ($set -contains $t) { return $true } }
    return $false
}

$ext = [System.IO.Path]::GetExtension($SchemaPath).ToLowerInvariant()
$schemaRows = if ($ext -eq '.xlsx' -or $ext -eq '.xlsm') { Read-SchemaXlsx $SchemaPath } else { Read-SchemaCsv $SchemaPath }

$tableNames = New-Object System.Collections.Generic.List[string]
$columnsByTable = @{}
foreach ($row in $schemaRows) {
    $table = Get-FieldInsensitive $row @('table', 'tabel', 'table_name', 'tabelnavn')
    $column = Get-FieldInsensitive $row @('column', 'kolonne', 'column_name', 'kolonnenavn', 'felt', 'field')
    if (-not $table -or -not $column -or -not $table.Trim() -or -not $column.Trim()) { continue }
    $table = $table.Trim(); $column = $column.Trim()
    $example = Get-FieldInsensitive $row @('example', 'eksempel', 'examples', 'eksempler')
    $exampleList = @()
    if ($example -and $example.Trim()) { $exampleList = @($example -split '\s*[|;,]\s*' | Where-Object { $_ -ne '' }) }
    if (-not $columnsByTable.ContainsKey($table)) {
        $columnsByTable[$table] = New-Object System.Collections.Generic.List[object]
        $tableNames.Add($table)
    }
    if (@($columnsByTable[$table] | Where-Object { $_.Lower -eq $column.ToLowerInvariant() }).Count) { continue }  # duplicate schema row
    $columnsByTable[$table].Add(@{
        Name = $column; Lower = $column.ToLowerInvariant(); Tokens = (Get-Tokens $column)
        Type = (Get-FieldInsensitive $row @('type', 'datatype', 'data_type', 'datatype hint'))
        Examples = $exampleList
    })
}
if ($tableNames.Count -eq 0) { throw "No table/column pairs found. Check the headers (table/tabel, column/kolonne)." }

# ---------------------------------------------------------------------------
# 2. Table names, primary keys and foreign keys (naming conventions)
# ---------------------------------------------------------------------------

function Get-Singular([string]$n) {
    if ($n.EndsWith('ies')) { return $n.Substring(0, $n.Length - 3) + 'y' }
    if ($n.EndsWith('s') -and -not $n.EndsWith('ss') -and -not $n.EndsWith('us')) { return $n.Substring(0, $n.Length - 1) }
    return $n
}

$dateDimTokens = @('date', 'dato', 'calendar', 'kalender', 'dag', 'day')
$meta = @{}
foreach ($table in $tableNames) {
    $lower = $table.ToLowerInvariant()
    $prefixRole = $null
    if ($lower -match '^(fact|fct|fakt)[_ ]') { $prefixRole = 'fact' }
    elseif ($lower -match '^(dim|d)[_ ]') { $prefixRole = 'dimension' }
    $base = Get-Singular (($lower -replace '^(dim|fact|fct|fakt|stg|tbl|bridge|d|f)[_ ]+', '') -replace ' ', '_')
    $flat = $base.Replace('_', '')
    $own = @('id', "${base}_id", "${flat}id", "${lower}_id", "${base}_key", "${flat}key", "${base}_nr", "${flat}nr", "${base}_no", "${base}_nummer")
    $self = @('manager_id', 'parent_id', 'leder_id', 'chef_id', 'overordnet_id', 'reports_to', "parent_${base}_id", "parent_${flat}id")
    $meta[$table] = @{ Lower = $lower; Base = $base; Flat = $flat; Tokens = (Get-Tokens $base); PrefixRole = $prefixRole; OwnKeys = $own; SelfKeys = $self }
}

# key name -> table that "owns" it, e.g. customer_id -> dim_customer (not 'id', too generic)
$ownKeyOwner = @{}
foreach ($table in $tableNames) { foreach ($k in $meta[$table].OwnKeys) { if ($k -ne 'id' -and -not $ownKeyOwner.ContainsKey($k)) { $ownKeyOwner[$k] = $table } } }

function Test-IdLike($col) {
    $tk = $col.Tokens
    if ($tk.Count -eq 0) { return $false }
    $last = $tk[$tk.Count - 1]
    return ($last -eq 'id' -or $last -eq 'key' -or ($tk.Count -gt 1 -and $last -eq 'nr'))
}

$primaryKeyByTable = @{}
$pkIsCode = @{}
foreach ($table in $tableNames) {
    $m = $meta[$table]; $cols = $columnsByTable[$table]
    # 1) exact own-key name: id, customer_id, customerid, customer_key, kunde_nr, ...
    $pk = @($cols | Where-Object { $m.OwnKeys -contains $_.Lower })[0]
    # 2) first id-like column that is not another table's key and not a self-reference
    if (-not $pk) {
        $pk = @($cols | Where-Object {
            (Test-IdLike $_) -and $m.SelfKeys -notcontains $_.Lower -and
            -not ($ownKeyOwner.ContainsKey($_.Lower) -and $ownKeyOwner[$_.Lower] -ne $table)
        })[0]
    }
    # 3) business key named after the table: region_code on dim_region, product_sku on dim_product
    if (-not $pk) {
        $pk = @($cols | Where-Object {
            $_.Tokens.Count -ge 2 -and (Has @($_.Tokens[$_.Tokens.Count - 1]) @('code', 'kode', 'sku', 'key', 'nr', 'nummer', 'number')) -and
            ($_.Lower.StartsWith($m.Base) -or $_.Lower.StartsWith($m.Flat))
        })[0]
        if ($pk) { $pkIsCode[$table] = $true }
    }
    if ($pk) { $primaryKeyByTable[$table] = $pk.Name }
}

$pkOwner = @{}   # lower-case pk name -> table
foreach ($table in $tableNames) {
    if ($primaryKeyByTable.ContainsKey($table)) {
        $pl = $primaryKeyByTable[$table].ToLowerInvariant()
        if ($pl -ne 'id' -and -not $pkOwner.ContainsKey($pl)) { $pkOwner[$pl] = $table }
    }
}

$foreignKeys = @{}   # "table.column" -> referenced table
foreach ($table in $tableNames) {
    foreach ($col in $columnsByTable[$table]) {
        if ($primaryKeyByTable[$table] -eq $col.Name) { continue }
        $target = $null
        if ($pkOwner.ContainsKey($col.Lower) -and $pkOwner[$col.Lower] -ne $table) { $target = $pkOwner[$col.Lower] }
        elseif ($ownKeyOwner.ContainsKey($col.Lower) -and $ownKeyOwner[$col.Lower] -ne $table -and $primaryKeyByTable.ContainsKey($ownKeyOwner[$col.Lower])) { $target = $ownKeyOwner[$col.Lower] }
        elseif ($primaryKeyByTable.ContainsKey($table) -and $meta[$table].SelfKeys -contains $col.Lower) { $target = $table }
        if ($target) { $foreignKeys["$table.$($col.Name)"] = $target }
    }
}

# ---------------------------------------------------------------------------
# 3. Column classifier: name pattern (+ optional type hint / example) -> kind
# ---------------------------------------------------------------------------

$T = @{
    date        = @('date', 'dato', 'created', 'oprettet', 'updated', 'opdateret', 'tidspunkt', 'time', 'timestamp', 'datetime', 'modified', 'ændret', 'aendret')
    laterDate   = @('updated', 'opdateret', 'modified', 'ændret', 'aendret', 'ship', 'shipped', 'shipping', 'delivery', 'delivered', 'levering', 'leveret', 'leveringsdato',
                    'due', 'forfald', 'forfaldsdato', 'end', 'slut', 'closed', 'lukket', 'paid', 'betalt', 'betalingsdato', 'resolved', 'løst', 'completed', 'afsluttet')
    birth       = @('birth', 'birthdate', 'birthday', 'dob', 'fødselsdato', 'foedselsdato', 'fødselsdag')
    amount      = @('price', 'pris', 'amount', 'beløb', 'belob', 'total', 'revenue', 'omsætning', 'omsaetning', 'sum', 'cost', 'kostpris', 'omkostning', 'cogs',
                    'værdi', 'vaerdi', 'value', 'sales', 'salg', 'profit', 'fortjeneste', 'avance', 'margin', 'budget', 'fee', 'gebyr', 'tax', 'moms', 'freight', 'fragt',
                    'unitprice', 'enhedspris', 'stykpris', 'linetotal', 'salary', 'løn', 'loen', 'balance', 'saldo')
    price       = @('price', 'pris', 'unitprice', 'enhedspris', 'stykpris', 'listprice', 'listepris')
    total       = @('total', 'amount', 'beløb', 'belob', 'revenue', 'omsætning', 'omsaetning', 'sum', 'sales', 'salg', 'linetotal', 'value', 'værdi', 'vaerdi')
    cost        = @('cost', 'kostpris', 'omkostning', 'cogs')
    profit      = @('profit', 'fortjeneste', 'avance', 'margin')
    quantity    = @('quantity', 'antal', 'qty', 'count', 'stk', 'units', 'enheder', 'mængde', 'maengde')
    discount    = @('discount', 'rabat')
    percent     = @('percent', 'procent', 'pct', 'rate', 'sats')
    person      = @('customer', 'kunde', 'contact', 'kontakt', 'person', 'user', 'bruger', 'employee', 'ansat', 'medarbejder', 'owner', 'ejer', 'lead', 'prospect',
                    'rep', 'seller', 'sælger', 'saelger', 'manager', 'leder', 'author', 'forfatter', 'member', 'medlem', 'patient', 'student', 'elev', 'driver', 'agent', 'staff', 'personale')
    product     = @('product', 'produkt', 'vare', 'varer', 'item', 'article', 'artikel', 'sku')
    store       = @('store', 'butik', 'shop', 'branch', 'filial', 'outlet')
    region      = @('region', 'landsdel', 'area', 'område', 'omraade', 'territory')
    department  = @('department', 'afdeling', 'dept')
    channel     = @('channel', 'kanal', 'saleschannel', 'salgskanal')
    segment     = @('segment', 'kundesegment', 'tier')
    category    = @('type', 'kategori', 'category', 'klasse', 'class', 'niveau', 'level', 'group', 'gruppe', 'subcategory', 'underkategori')
    company     = @('company', 'virksomhed', 'firma', 'leverandor', 'leverandør', 'supplier', 'vendor', 'kreditor', 'brand', 'mærke', 'maerke', 'manufacturer', 'producent')
}

$numberedKinds = @('amount', 'quantity', 'percent', 'generic_int', 'example_number', 'year', 'month', 'quarter', 'day', 'week')

function Get-ColumnKind($col, $m) {
    $tk = $col.Tokens
    $name = $col.Lower
    $hint = if ($col.Type) { $col.Type.ToLowerInvariant() } else { '' }
    $ctx = @($tk) + @($m.Tokens)
    $last = if ($tk.Count) { $tk[$tk.Count - 1] } else { '' }

    # explicit examples beat name inference
    if ($col.Examples.Count -ge 2) { return 'examples' }
    if ($col.Examples.Count -eq 1) {
        $ex = $col.Examples[0]
        if ($ex -match '^\d{4}-\d{2}-\d{2}') { return 'date' }
        if ($ex -match '^-?\d+([.,]\d+)?$') { return 'example_number' }
        if ($ex -match '\d') { return 'pattern' }
    }

    if ((Has $tk @('email', 'mail', 'e-mail')) -or $name -like '*email*') { return 'email' }
    if (Has $tk @('phone', 'telefon', 'tlf', 'mobil', 'mobile', 'telefonnummer', 'phonenumber')) { return 'phone' }
    if (Has $tk @('url', 'link', 'website', 'hjemmeside', 'webside')) { return 'url' }
    # created_by / approved_by / sold_by -> a person, not a date or the Danish word "by" (city)
    if ($tk.Count -ge 2 -and $last -eq 'by' -and ($tk[$tk.Count - 2] -match 'ed$' -or (Has @($tk[$tk.Count - 2]) @('sold', 'paid', 'made', 'sent', 'owned', 'solgt')))) { return 'fullname' }
    if (Has $tk $T.birth) { return 'birthdate' }
    if (Has $tk @('year', 'år', 'aar', 'årstal', 'yr')) { return 'year' }
    if (Has $tk @('quarter', 'kvartal', 'qtr')) { return 'quarter' }
    if (Has $tk @('month', 'måned', 'maaned', 'mdr', 'monthname', 'månedsnavn')) { if ((Has $tk @('name', 'navn', 'monthname', 'månedsnavn'))) { return 'monthname' } else { return 'month' } }
    if (Has $tk @('weekday', 'ugedag', 'dayofweek', 'dayname')) { return 'weekday' }
    if (Has $tk @('week', 'uge', 'ugenr')) { return 'week' }
    if ($tk.Count -eq 1 -and (Has $tk @('day', 'dag'))) { return 'day' }
    if (Has $tk $T.date) { return 'date' }
    if ($name -match '^(is|has|er|har)[_ ]' -or (Has $tk @('active', 'aktiv', 'enabled', 'flag', 'deleted', 'slettet', 'returned', 'returneret', 'cancelled', 'annulleret'))) { return 'bool' }
    if (Has $tk @('zip', 'postal', 'postnr', 'postnummer', 'zipcode', 'postcode', 'post')) { return 'postal' }
    if (Test-IdLike $col) { return 'generic_int' }
    if (Has $tk @('rep', 'seller', 'sælger', 'saelger', 'salesperson', 'manager', 'leder', 'agent', 'owner', 'ejer', 'author', 'forfatter', 'assignee')) { return 'fullname' }
    if (Has $tk @('country', 'land')) { return 'country' }
    if (Has $tk @('city', 'bynavn', 'town')) { return 'city' }
    if ($last -eq 'by' -or $name -eq 'by') { return 'city' }
    if (Has $tk @('address', 'adresse', 'vej', 'street', 'gade', 'vejnavn')) { return 'address' }
    if (Has $tk @('firstname', 'fornavn', 'givenname') -or ((Has $tk @('first', 'given')) -and (Has $tk @('name', 'navn')))) { return 'firstname' }
    if (Has $tk @('lastname', 'efternavn', 'surname', 'familyname') -or ((Has $tk @('last', 'family')) -and (Has $tk @('name', 'navn')))) { return 'lastname' }
    if (Has $tk @('fullname', 'fuldenavn')) { return 'fullname' }
    if (Has $tk $T.company) { return 'company' }
    if (Has $tk @('currency', 'valuta')) { return 'currency' }
    if ((Has $tk $T.percent) -or ((Has $tk $T.discount) -and -not (Has $tk $T.amount))) { return 'percent' }
    if (Has $tk $T.amount) { return 'amount' }
    if (Has $tk $T.quantity) { return 'quantity' }
    if (Has $tk @('status', 'tilstand', 'state')) { return 'status' }
    if (Has $tk $T.region) { return 'region' }
    if (Has $tk $T.department) { return 'department' }
    if (Has $tk $T.channel) { return 'channel' }
    if (Has $tk $T.segment) { return 'segment' }
    if (Has $tk $T.category) { if (Has $ctx $T.product) { return 'product_category' } else { return 'category' } }
    if (Has $tk @('name', 'navn', 'label', 'betegnelse')) {
        if (Has $ctx $T.person) { return 'fullname' }
        if (Has $ctx $T.product) { return 'product' }
        if (Has $ctx $T.store) { return 'store' }
        if (Has $ctx $T.region) { return 'region' }
        if (Has $ctx $T.department) { return 'department' }
        if (Has $ctx $T.channel) { return 'channel' }
        if (Has $ctx $T.segment) { return 'segment' }
        if (Has $ctx $T.category) { if (Has $ctx $T.product) { return 'product_category' } else { return 'category' } }
        if (Has $ctx $T.company) { return 'company' }
        return 'entity_name'
    }
    if (Has $tk @('code', 'kode', 'sku', 'ean', 'barcode', 'stregkode')) { return 'code' }
    if (Has $tk @('description', 'beskrivelse', 'note', 'notes', 'notat', 'kommentar', 'comment', 'tekst', 'text', 'remark', 'bemærkning')) { return 'description' }

    switch -regex ($hint) {
        'date|dato|time' { return 'date' }
        'bool|bit' { return 'bool' }
        'email' { return 'email' }
        'decimal|float|double|money|currency|numeric|real' { return 'amount' }
        'int|number|heltal|tal' { return 'generic_int' }
    }
    return 'generic_text'
}

foreach ($table in $tableNames) {
    foreach ($col in $columnsByTable[$table]) { $col.Kind = Get-ColumnKind $col $meta[$table] }
}

# ---------------------------------------------------------------------------
# 4. Fact vs. dimension, date tables, row counts
# ---------------------------------------------------------------------------

$roleByTable = @{}
foreach ($table in $tableNames) {
    $m = $meta[$table]; $cols = $columnsByTable[$table]
    $kinds = @($cols | ForEach-Object { $_.Kind })
    $fkCount = @($foreignKeys.Keys | Where-Object { $_.StartsWith("$table.") -and $foreignKeys[$_] -ne $table }).Count
    $hasDate = $kinds -contains 'date' -or @($foreignKeys.Keys | Where-Object { $_.StartsWith("$table.") -and $meta[$foreignKeys[$_]].Tokens -and (Has $meta[$foreignKeys[$_]].Tokens $dateDimTokens) }).Count -gt 0
    $hasMeasure = ($kinds -contains 'amount') -or ($kinds -contains 'quantity')
    if ($m.PrefixRole) { $roleByTable[$table] = $m.PrefixRole }
    elseif ($hasDate -and ($hasMeasure -or $fkCount -ge 2)) { $roleByTable[$table] = 'fact' }
    else { $roleByTable[$table] = 'dimension' }
    $m.IsDateDim = ($roleByTable[$table] -eq 'dimension' -and (Has $m.Tokens $dateDimTokens))
}

$rowOverrides = @{}
if ($Rows) {
    foreach ($pair in ($Rows -split ',')) {
        if ($pair -match '^\s*(.+?)\s*=\s*(\d+)\s*$') { $rowOverrides[$Matches[1].ToLowerInvariant()] = [int]$Matches[2] }
    }
}

# ---------------------------------------------------------------------------
# 5. Word banks (short on purpose: demo data, not a linguistics project)
# ---------------------------------------------------------------------------

$bank = @{
    da = @{
        firstNames  = 'Anders,Mette,Lars,Louise,Peter,Camilla,Jan,Mathilde,Søren,Ida,Thomas,Freja,Henrik,Emma,Morten,Sofie,Christian,Line,Rasmus,Anne'.Split(',')
        lastNames   = 'Jensen,Nielsen,Hansen,Pedersen,Andersen,Christensen,Larsen,Sørensen,Rasmussen,Jørgensen,Petersen,Madsen,Kristensen,Olsen,Thomsen'.Split(',')
        # city|region|country|postal - big cities first (they get picked more often)
        cities      = @('København|Hovedstaden|Danmark|1050', 'Aarhus|Midtjylland|Danmark|8000', 'Odense|Syddanmark|Danmark|5000', 'Aalborg|Nordjylland|Danmark|9000',
                        'Esbjerg|Syddanmark|Danmark|6700', 'Randers|Midtjylland|Danmark|8900', 'Kolding|Syddanmark|Danmark|6000', 'Horsens|Midtjylland|Danmark|8700',
                        'Vejle|Syddanmark|Danmark|7100', 'Roskilde|Sjælland|Danmark|4000', 'Herning|Midtjylland|Danmark|7400', 'Silkeborg|Midtjylland|Danmark|8600',
                        'Næstved|Sjælland|Danmark|4700', 'Fredericia|Syddanmark|Danmark|7000', 'Viborg|Midtjylland|Danmark|8800', 'Hillerød|Hovedstaden|Danmark|3400',
                        'Holbæk|Sjælland|Danmark|4300', 'Hjørring|Nordjylland|Danmark|9800')
        regions     = 'Hovedstaden,Midtjylland,Syddanmark,Sjælland,Nordjylland'.Split(',')
        streets     = 'Hovedgaden,Skolevej,Kirkevej,Industrivej,Strandvejen,Nørregade,Søndergade,Vestergade,Østergade,Bakkevej'.Split(',')
        companySfx  = 'ApS,A/S,I/S'.Split(',')
        companyWord = 'Nordlys,Vestkyst,Østbro,Dansk Handel,Bright,Smart,Prime,Horizon,Blåvand,Fjord,Skovly,Havn'.Split(',')
        products    = @('Kaffemaskine|Køkken', 'Elkedel|Køkken', 'Blender|Køkken', 'Stegepande|Køkken', 'Støvsuger|Bolig', 'Gulvlampe|Bolig', 'Sengesæt|Bolig',
                        'Puf|Bolig', 'Kontorstol|Kontor', 'Skrivebord|Kontor', 'Skærm|Elektronik', 'Hovedtelefoner|Elektronik', 'Højttaler|Elektronik',
                        'Tablet|Elektronik', 'Løbesko|Sport', 'Yogamåtte|Sport', 'Cykelhjelm|Sport', 'Vinterjakke|Tøj', 'Regnjakke|Tøj', 'Strikbluse|Tøj')
        variants    = 'Basic,Classic,Plus,Pro,Max,Eco'.Split(',')
        storeFmt    = 'Butik {0}'
        departments = 'Salg,Marketing,Økonomi,IT,HR,Kundeservice,Logistik'.Split(',')
        channels    = 'Webshop,Butik,Telefon,Partner'.Split(',')
        segments    = 'Privat,Erhverv,Offentlig'.Split(',')
        # weighted: repeated entries are picked more often
        status      = 'Afsluttet,Afsluttet,Afsluttet,Afsluttet,Afsluttet,Afsluttet,Afsluttet,Afsluttet,Aktiv,Aktiv,Aktiv,Afventer,Afventer,Annulleret'.Split(',')
        categoryLabels = 'Kategori A,Kategori B,Kategori C,Kategori D'.Split(',')
        months      = 'januar,februar,marts,april,maj,juni,juli,august,september,oktober,november,december'.Split(',')
        weekdays    = 'søndag,mandag,tirsdag,onsdag,torsdag,fredag,lørdag'.Split(',')   # DayOfWeek order
        currency    = 'DKK'
        descriptions = 'Standardvare til lager.|Leveret efter aftale.|Se produktbeskrivelse for detaljer.|Opdateret efter seneste gennemgang.|Ingen yderligere bemærkninger.'.Split('|')
    }
    en = @{
        firstNames  = 'James,Emma,Michael,Olivia,David,Sophia,John,Isabella,Robert,Mia,William,Charlotte,Daniel,Amelia,Henry,Harper,Thomas,Evelyn,Joseph,Abigail'.Split(',')
        lastNames   = 'Smith,Johnson,Williams,Brown,Jones,Garcia,Miller,Davis,Rodriguez,Martinez,Wilson,Anderson,Taylor,Thomas,Moore'.Split(',')
        cities      = @('New York|North America|United States|10001', 'London|Europe|United Kingdom|EC1A', 'Chicago|North America|United States|60601',
                        'Berlin|Europe|Germany|10115', 'Paris|Europe|France|75001', 'Toronto|North America|Canada|M5H', 'Sydney|Asia Pacific|Australia|2000',
                        'Amsterdam|Europe|Netherlands|1012', 'Madrid|Europe|Spain|28001', 'Singapore|Asia Pacific|Singapore|018956', 'Stockholm|Europe|Sweden|11120',
                        'Dublin|Europe|Ireland|D01', 'Munich|Europe|Germany|80331', 'Oslo|Europe|Norway|0150', 'Austin|North America|United States|73301',
                        'Melbourne|Asia Pacific|Australia|3000')
        regions     = 'North America,Europe,Asia Pacific,Latin America,Middle East & Africa'.Split(',')
        streets     = 'Main St,Oak Ave,Park Rd,Maple St,Cedar Ave,Elm St,Washington Ave,Lake Rd,Hill St,River Rd'.Split(',')
        companySfx  = 'Inc.,Ltd.,LLC'.Split(',')
        companyWord = 'Northwind,Southgate,Global,Bright,Smart,Prime,Horizon,Bluewater,Summit,Union,Redwood,Harbor'.Split(',')
        products    = @('Coffee Maker|Kitchen', 'Kettle|Kitchen', 'Blender|Kitchen', 'Frying Pan|Kitchen', 'Vacuum Cleaner|Home', 'Floor Lamp|Home', 'Bedding Set|Home',
                        'Pouf|Home', 'Office Chair|Office', 'Desk|Office', 'Monitor|Electronics', 'Headphones|Electronics', 'Speaker|Electronics',
                        'Tablet|Electronics', 'Running Shoes|Sports', 'Yoga Mat|Sports', 'Bike Helmet|Sports', 'Winter Jacket|Clothing', 'Rain Jacket|Clothing', 'Knit Sweater|Clothing')
        variants    = 'Basic,Classic,Plus,Pro,Max,Eco'.Split(',')
        storeFmt    = '{0} Store'
        departments = 'Sales,Marketing,Finance,IT,HR,Customer Service,Logistics'.Split(',')
        channels    = 'Online,Store,Phone,Partner'.Split(',')
        segments    = 'Consumer,Business,Public Sector'.Split(',')
        status      = 'Completed,Completed,Completed,Completed,Completed,Completed,Completed,Completed,Active,Active,Active,Pending,Pending,Cancelled'.Split(',')
        categoryLabels = 'Category A,Category B,Category C,Category D'.Split(',')
        months      = 'January,February,March,April,May,June,July,August,September,October,November,December'.Split(',')
        weekdays    = 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday'.Split(',')
        currency    = 'USD'
        descriptions = 'Standard stock item.|Delivered as agreed.|See product notes for details.|Updated after the latest review.|No further remarks.'.Split('|')
    }
}
$w = $bank[$Locale]
$cityParts = @($w.cities | ForEach-Object { , ($_.Split('|')) })
$productParts = @($w.products | ForEach-Object { , ($_.Split('|')) })
$productCategories = @($productParts | ForEach-Object { $_[1] } | Select-Object -Unique)

# A dimension that *is* a short closed list gets exactly that many rows by default.
function Get-ClosedListSize($m) {
    if (Has $m.Tokens $T.region) { return $w.regions.Count }
    if (Has $m.Tokens $T.department) { return $w.departments.Count }
    if (Has $m.Tokens $T.channel) { return $w.channels.Count }
    if (Has $m.Tokens $T.segment) { return $w.segments.Count }
    if ((Has $m.Tokens $T.category) -and (Has $m.Tokens $T.product)) { return $productCategories.Count }
    return 0
}

$rowCountByTable = @{}
foreach ($table in $tableNames) {
    $m = $meta[$table]
    if ($rowOverrides.ContainsKey($m.Lower)) { $rowCountByTable[$table] = $rowOverrides[$m.Lower]; continue }
    if ($roleByTable[$table] -eq 'fact') { $rowCountByTable[$table] = $RowsFact; continue }
    if ($m.IsDateDim) { $rowCountByTable[$table] = $spanDays + 1; continue }
    $closed = Get-ClosedListSize $m
    $rowCountByTable[$table] = if ($closed -gt 0) { [math]::Min($RowsDim, $closed) } else { $RowsDim }
}

# ---------------------------------------------------------------------------
# 6. Lookups (denormalised columns) and derived numbers - decided from the schema
# ---------------------------------------------------------------------------

foreach ($table in $tableNames) {
    $cols = $columnsByTable[$table]
    $fkCols = @($cols | Where-Object { $foreignKeys.ContainsKey("$table.$($_.Name)") -and $foreignKeys["$table.$($_.Name)"] -ne $table })
    foreach ($col in $cols) {
        if ($primaryKeyByTable[$table] -eq $col.Name -or $foreignKeys.ContainsKey("$table.$($col.Name)")) { continue }
        # fact_sales.unit_price copied from dim_product.unit_price of the sampled product, etc.
        foreach ($fk in $fkCols) {
            $src = $foreignKeys["$table.$($fk.Name)"]
            $srcCol = @($columnsByTable[$src] | Where-Object { $_.Lower -eq $col.Lower -and $_.Name -ne $primaryKeyByTable[$src] })[0]
            if ($srcCol) { $col.Lookup = @{ Fk = $fk.Name; Table = $src; Column = $srcCol.Name }; break }
        }
    }
    # quantity x price = line total; cost below price; profit = revenue - cost
    $amountCols = @($cols | Where-Object { $_.Kind -eq 'amount' })
    $qtyCol = @($cols | Where-Object { $_.Kind -eq 'quantity' })[0]
    $priceCol = @($amountCols | Where-Object { (Has $_.Tokens $T.price) -and -not (Has $_.Tokens $T.cost) -and -not (Has $_.Tokens @('total')) })[0]
    $totalCol = @($amountCols | Where-Object { $_ -ne $priceCol -and (Has $_.Tokens $T.total) -and -not (Has $_.Tokens $T.cost) -and -not (Has $_.Tokens $T.profit) -and -not $_.Lookup })[0]
    $discountCol = @($cols | Where-Object { $_.Kind -eq 'percent' -and (Has $_.Tokens $T.discount) })[0]
    $d = @{}
    if ($qtyCol -and $priceCol -and $totalCol) { $d.Total = @{ Col = $totalCol.Name; Qty = $qtyCol.Name; Price = $priceCol.Name; Discount = $(if ($discountCol) { $discountCol.Name }) } }
    $revenueName = if ($totalCol) { $totalCol.Name } elseif ($priceCol) { $priceCol.Name } else { $null }
    $d.Cost = @(); $d.Profit = @()
    if ($revenueName) {
        foreach ($c in @($amountCols | Where-Object { (Has $_.Tokens $T.cost) -and -not $_.Lookup })) {
            $base = if ((Has $c.Tokens @('unit', 'enhed', 'stk')) -and $priceCol) { $priceCol.Name } else { $revenueName }
            $d.Cost += @{ Col = $c.Name; Base = $base }
        }
        $costName = @($d.Cost | Where-Object { $_.Base -eq $revenueName })[0]
        if ($costName) {
            foreach ($c in @($amountCols | Where-Object { (Has $_.Tokens $T.profit) -and -not $_.Lookup })) { $d.Profit += @{ Col = $c.Name; Revenue = $revenueName; Cost = $costName.Col } }
        }
    }
    $meta[$table].Derive = $d
}

function Get-KindLabel([string]$table, $col) {
    if ($primaryKeyByTable[$table] -eq $col.Name) { return 'primary_key' }
    $fk = "$table.$($col.Name)"
    if ($foreignKeys.ContainsKey($fk)) { return "foreign_key -> $($foreignKeys[$fk])" }
    if ($col.Lookup) { return "lookup <- $($col.Lookup.Table).$($col.Lookup.Column) via $($col.Lookup.Fk)" }
    $d = $meta[$table].Derive
    if ($d.Total -and $d.Total.Col -eq $col.Name) { return "derived: $($d.Total.Qty) x $($d.Total.Price)" }
    foreach ($c in $d.Cost) { if ($c.Col -eq $col.Name) { return "derived: 45-75% of $($c.Base)" } }
    foreach ($c in $d.Profit) { if ($c.Col -eq $col.Name) { return "derived: $($c.Revenue) - $($c.Cost)" } }
    return $col.Kind
}

$unmatched = New-Object System.Collections.Generic.List[string]
foreach ($table in $tableNames) {
    foreach ($col in $columnsByTable[$table]) {
        $label = Get-KindLabel $table $col
        if (@('generic_text', 'generic_int', 'entity_name') -contains $label) { $unmatched.Add("$table.$($col.Name)") }
    }
}

# ---------------------------------------------------------------------------
# 7. Key pools: every table's keys exist before any foreign key is sampled
# ---------------------------------------------------------------------------

function Get-CodePrefix([string]$s) {
    $ascii = ($s.ToUpperInvariant().Replace('Æ', 'AE').Replace('Ø', 'OE').Replace('Å', 'AA') -replace '[^A-Z]', '')
    if ($ascii.Length -ge 3) { return $ascii.Substring(0, 3) } elseif ($ascii) { return $ascii } else { return 'K' }
}

$pkPools = @{}
$rowDates = @{}
foreach ($table in $tableNames) {
    $n = $rowCountByTable[$table]; $m = $meta[$table]
    $dates = New-Object datetime[] $n
    $dr = New-Rng "$table|rowdate"
    for ($i = 0; $i -lt $n; $i++) {
        if ($m.IsDateDim) { $dates[$i] = $periodStart.AddDays([math]::Min($i, $spanDays)) }
        elseif ($roleByTable[$table] -eq 'fact') {
            # linear growth: the last month has about twice the rows of the first
            $x = -1 + [math]::Sqrt(1 + 3 * $dr.NextDouble())
            $dates[$i] = $periodStart.AddDays([math]::Min([int][math]::Floor($x * ($spanDays + 1)), $spanDays))
        } else { $dates[$i] = $periodStart.AddDays($dr.Next(0, $spanDays + 1)) }
    }
    $rowDates[$table] = $dates

    $pool = New-Object string[] $n
    $pkName = $primaryKeyByTable[$table]
    if ($m.IsDateDim -and $pkName) {
        $keyFmt = if (Has (Get-Tokens $pkName) @('key', 'id', 'nr')) { 'yyyyMMdd' } else { 'yyyy-MM-dd' }
        for ($i = 0; $i -lt $n; $i++) { $pool[$i] = $dates[$i].ToString($keyFmt, $inv) }
    } elseif ($pkIsCode[$table]) {
        $pfx = Get-CodePrefix $m.Base
        for ($i = 0; $i -lt $n; $i++) { $pool[$i] = $pfx + '-' + ($i + 1).ToString('0000', $inv) }
    } else {
        for ($i = 0; $i -lt $n; $i++) { $pool[$i] = [string]($i + 1) }
    }
    $pkPools[$table] = $pool
}

# Popularity order per referenced table, shared by every fact that points at it:
# the same few customers/products are the big ones everywhere, like real data.
$popularity = @{}
foreach ($table in @($foreignKeys.Values | Select-Object -Unique)) {
    $n = $rowCountByTable[$table]
    $pr = New-Rng "$table|popularity"
    $perm = [int[]](0..([math]::Max($n, 1) - 1))
    for ($i = $perm.Length - 1; $i -gt 0; $i--) { $j = $pr.Next(0, $i + 1); $tmp = $perm[$i]; $perm[$i] = $perm[$j]; $perm[$j] = $tmp }
    $popularity[$table] = $perm
}

function Get-Shuffled([int]$count, $r) {
    $perm = [int[]](0..($count - 1))
    for ($i = $count - 1; $i -gt 0; $i--) { $j = $r.Next(0, $i + 1); $tmp = $perm[$i]; $perm[$i] = $perm[$j]; $perm[$j] = $tmp }
    return , $perm
}

# Generation order: referenced tables first (so lookups can copy their values);
# a cycle just falls back to schema order - keys never need ordering.
$deps = @{}
foreach ($table in $tableNames) { $deps[$table] = @($foreignKeys.Keys | Where-Object { $_.StartsWith("$table.") } | ForEach-Object { $foreignKeys[$_] } | Where-Object { $_ -ne $table } | Select-Object -Unique) }
$done = @{}
$genOrder = New-Object System.Collections.Generic.List[string]
while ($genOrder.Count -lt $tableNames.Count) {
    $next = $null
    foreach ($table in $tableNames) {
        if ($done[$table]) { continue }
        if (@($deps[$table] | Where-Object { -not $done[$_] }).Count -eq 0) { $next = $table; break }
    }
    if (-not $next) { $next = @($tableNames | Where-Object { -not $done[$_] })[0] }
    $genOrder.Add($next); $done[$next] = $true
}

# ---------------------------------------------------------------------------
# 8. Generate
# ---------------------------------------------------------------------------

if (-not $PlanOnly -and -not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$generated = @{}   # table -> @{ lower column name -> string[] }
$fkIndex = @{}     # table -> @{ column name -> int[] row index into the referenced table }
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$cal = [System.Globalization.CultureInfo]::InvariantCulture.Calendar

if (-not $PlanOnly) {
    foreach ($table in $genOrder) {
        $m = $meta[$table]; $cols = $columnsByTable[$table]
        $n = $rowCountByTable[$table]
        $isFact = $roleByTable[$table] -eq 'fact'
        $dates = $rowDates[$table]
        $str = @{}; $num = @{}; $fmt = @{}
        $fkIndex[$table] = @{}

        # Row context shared by the columns of one row: one person, one city, one product,
        # so email matches name, country matches city, category matches product.
        $cr = New-Rng "$table|context"
        $personCount = $w.firstNames.Count * $w.lastNames.Count
        $personIdx = New-Object int[] $n
        $cityIdx = New-Object int[] $n
        $productIdx = New-Object int[] $n
        $productCount = $productParts.Count * $w.variants.Count
        $pPerm = Get-Shuffled $personCount $cr
        $cPerm = Get-Shuffled $cityParts.Count $cr
        $prPerm = Get-Shuffled $productCount $cr
        $distinctCity = Has $m.Tokens ($T.store + @('city', 'by'))
        for ($i = 0; $i -lt $n; $i++) {
            if ($isFact) { $personIdx[$i] = $cr.Next(0, $personCount); $productIdx[$i] = $cr.Next(0, $productCount) }
            else { $personIdx[$i] = $pPerm[$i % $personCount]; $productIdx[$i] = $prPerm[$i % $productCount] }
            $cityIdx[$i] = if ($distinctCity) { $cPerm[$i % $cityParts.Count] } else { [int][math]::Floor([math]::Pow($cr.NextDouble(), 1.6) * $cityParts.Count) }
        }

        $firstDateDone = $false
        foreach ($col in $cols) {
            $cn = $col.Name
            $r = New-Rng "$table.$cn"
            $vals = New-Object string[] $n

            if ($primaryKeyByTable[$table] -eq $cn) { $str[$cn] = $pkPools[$table]; continue }

            $fkKey = "$table.$cn"
            if ($foreignKeys.ContainsKey($fkKey)) {
                $target = $foreignKeys[$fkKey]; $pool = $pkPools[$target]; $perm = $popularity[$target]
                $idxs = New-Object int[] $n
                $pc = $pool.Length
                if ($pc -gt 0) {
                    for ($i = 0; $i -lt $n; $i++) {
                        if ($meta[$target].IsDateDim) {
                            # date_key = the row's own date, so it agrees with order_date in the same row
                            $k = [math]::Min([math]::Max(($dates[$i] - $periodStart).Days, 0), $pc - 1)
                        } else {
                            $k = $perm[[math]::Min([int][math]::Floor([math]::Pow($r.NextDouble(), 2) * $pc), $pc - 1)]
                        }
                        if ($target -eq $table -and $k -ge $i) {
                            # self-reference (manager_id): the first rows are the top of the tree,
                            # everyone else reports to one of the first few rows
                            if ($i -lt 3) { $vals[$i] = ''; $idxs[$i] = -1; continue }
                            $k = $r.Next(0, [math]::Min($i, 3 + [int]($i / 5)))
                        }
                        $idxs[$i] = $k; $vals[$i] = $pool[$k]
                    }
                }
                $fkIndex[$table][$cn] = $idxs
                $str[$cn] = $vals
                continue
            }

            if ($col.Lookup -and $generated.ContainsKey($col.Lookup.Table) -and $fkIndex[$table].ContainsKey($col.Lookup.Fk)) {
                $srcVals = $generated[$col.Lookup.Table][$col.Lookup.Column.ToLowerInvariant()]
                $idxs = $fkIndex[$table][$col.Lookup.Fk]
                for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($idxs[$i] -ge 0) { $srcVals[$idxs[$i]] } else { '' } }
                $str[$cn] = $vals
                continue
            }

            $kind = $col.Kind
            if ($numberedKinds -contains $kind) {
                $nv = New-Object double[] $n
                switch ($kind) {
                    'amount' {
                        # log-uniform 20..5000: many small amounts, few big ones
                        $lo = 20.0; $hi = 5000.0
                        if (Has $col.Tokens @('salary', 'løn', 'loen')) { $lo = 25000; $hi = 75000 }
                        elseif (Has $col.Tokens @('budget')) { $lo = 10000; $hi = 500000 }
                        for ($i = 0; $i -lt $n; $i++) { $nv[$i] = [math]::Round($lo * [math]::Pow($hi / $lo, $r.NextDouble()), 2) }
                        $fmt[$cn] = '0.00'
                    }
                    'quantity' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = 1 + [math]::Floor([math]::Pow($r.NextDouble(), 2.5) * 20) }; $fmt[$cn] = '0' }
                    'percent' {
                        if (Has $col.Tokens $T.discount) { $steps = @(0, 0, 0, 0, 5, 5, 10, 10, 15, 20, 25); for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $steps[$r.Next(0, $steps.Count)] }; $fmt[$cn] = '0' }
                        else { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = [math]::Round($r.NextDouble() * 100, 1) }; $fmt[$cn] = '0.0' }
                    }
                    'generic_int' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $r.Next(100, 1000) }; $fmt[$cn] = '0' }
                    'example_number' {
                        $exText = $col.Examples[0].Replace(',', '.')
                        $exVal = [double]::Parse($exText, $inv)
                        $decimals = if ($exText.Contains('.')) { $exText.Split('.')[1].Length } else { 0 }
                        for ($i = 0; $i -lt $n; $i++) { $nv[$i] = [math]::Round($exVal * (0.5 + $r.NextDouble()), $decimals) }
                        $fmt[$cn] = if ($decimals -gt 0) { '0.' + ('0' * $decimals) } else { '0' }
                    }
                    'year' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $dates[$i].Year }; $fmt[$cn] = '0' }
                    'month' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $dates[$i].Month }; $fmt[$cn] = '0' }
                    'quarter' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = [math]::Ceiling($dates[$i].Month / 3) }; $fmt[$cn] = '0' }
                    'day' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $dates[$i].Day }; $fmt[$cn] = '0' }
                    'week' { for ($i = 0; $i -lt $n; $i++) { $nv[$i] = $cal.GetWeekOfYear($dates[$i], [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday) }; $fmt[$cn] = '0' }
                }
                $num[$cn] = $nv
                continue
            }

            switch ($kind) {
                'email' {
                    for ($i = 0; $i -lt $n; $i++) {
                        $p = $personIdx[$i]
                        $fn = $w.firstNames[$p % $w.firstNames.Count]; $ln = $w.lastNames[[math]::Floor($p / $w.firstNames.Count) % $w.lastNames.Count]
                        $local = ("$fn.$ln").ToLowerInvariant().Replace('æ', 'ae').Replace('ø', 'oe').Replace('å', 'aa').Replace(' ', '')
                        if ($n -gt $personCount -and -not $isFact) { $local += [string]($i + 1) }
                        $vals[$i] = "$local@example.com"
                    }
                }
                'phone' {
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($Locale -eq 'da') { '{0} {1:D2} {2:D2} {3:D2}' -f $r.Next(20, 99), $r.Next(0, 100), $r.Next(0, 100), $r.Next(0, 100) } else { '(555) {0:D3}-{1:D4}' -f $r.Next(200, 999), $r.Next(1000, 9999) }
                    }
                }
                'url' { $slug = (Get-CodePrefix $m.Base).ToLowerInvariant(); for ($i = 0; $i -lt $n; $i++) { $vals[$i] = "https://example.com/$slug/$($i + 1)" } }
                'date' {
                    $isLater = $firstDateDone -and (Has $col.Tokens $T.laterDate)
                    for ($i = 0; $i -lt $n; $i++) {
                        if (-not $firstDateDone) { $dt = $dates[$i] }
                        elseif ($isLater) { $dt = $dates[$i].AddDays($r.Next(0, 31)); if ($dt -gt $periodEnd) { $dt = $periodEnd } }
                        else { $dt = $periodStart.AddDays($r.Next(0, $spanDays + 1)) }
                        $vals[$i] = $dt.ToString('yyyy-MM-dd', $inv)
                    }
                    $firstDateDone = $true
                }
                'birthdate' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = (Get-Date '1950-01-01').AddDays($r.Next(0, 20089)).ToString('yyyy-MM-dd', $inv) } }
                'monthname' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.months[$dates[$i].Month - 1] } }
                'weekday' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.weekdays[[int]$dates[$i].DayOfWeek] } }
                'bool' {
                    $pTrue = 0.5
                    if (Has $col.Tokens @('active', 'aktiv', 'enabled')) { $pTrue = 0.85 }
                    elseif (Has $col.Tokens @('deleted', 'slettet', 'returned', 'returneret', 'cancelled', 'annulleret')) { $pTrue = 0.08 }
                    for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($r.NextDouble() -lt $pTrue) { 'true' } else { 'false' } }
                }
                'postal' {
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($Locale -eq 'da') { [string]([int]$cityParts[$cityIdx[$i]][3] + 10 * $r.Next(0, 5)) } else { $cityParts[$cityIdx[$i]][3] }
                    }
                }
                'country' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $cityParts[$cityIdx[$i]][2] } }
                'city' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $cityParts[$cityIdx[$i]][0] } }
                'region' {
                    $useCity = @($cols | Where-Object { $_.Kind -eq 'city' -or $_.Kind -eq 'store' }).Count -gt 0
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($useCity) { $cityParts[$cityIdx[$i]][1] } elseif ($isFact) { $w.regions[$r.Next(0, $w.regions.Count)] } else { $w.regions[$i % $w.regions.Count] }
                    }
                }
                'address' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = '{0} {1}' -f $w.streets[$r.Next(0, $w.streets.Count)], $r.Next(1, 200) } }
                'company' {
                    $cc = $w.companyWord.Count * $w.companySfx.Count; $cp = Get-Shuffled $cc $r
                    for ($i = 0; $i -lt $n; $i++) {
                        $k = if ($isFact) { $r.Next(0, $cc) } else { $cp[$i % $cc] }
                        $vals[$i] = '{0} {1}' -f $w.companyWord[$k % $w.companyWord.Count], $w.companySfx[[math]::Floor($k / $w.companyWord.Count)]
                        if (-not $isFact -and $n -gt $cc) { $vals[$i] += " $([math]::Floor($i / $cc) + 1)" }
                    }
                }
                'firstname' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.firstNames[$personIdx[$i] % $w.firstNames.Count] } }
                'lastname' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.lastNames[[math]::Floor($personIdx[$i] / $w.firstNames.Count) % $w.lastNames.Count] } }
                'fullname' {
                    # a second person column in the row (created_by next to customer_name) gets its own person
                    $own = @($cols | Where-Object { $_.Kind -eq 'fullname' })[0].Name -eq $cn
                    for ($i = 0; $i -lt $n; $i++) {
                        $p = if ($own) { $personIdx[$i] } else { $r.Next(0, $personCount) }
                        $vals[$i] = '{0} {1}' -f $w.firstNames[$p % $w.firstNames.Count], $w.lastNames[[math]::Floor($p / $w.firstNames.Count) % $w.lastNames.Count]
                    }
                }
                'product' {
                    for ($i = 0; $i -lt $n; $i++) {
                        $k = $productIdx[$i]
                        $vals[$i] = '{0} {1}' -f $productParts[$k % $productParts.Count][0], $w.variants[[math]::Floor($k / $productParts.Count) % $w.variants.Count]
                        if (-not $isFact -and $n -gt $productCount) { $vals[$i] += " $([math]::Floor($i / $productCount) + 1)" }
                    }
                }
                'product_category' {
                    $useProduct = @($cols | Where-Object { $_.Kind -eq 'product' }).Count -gt 0
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($useProduct) { $productParts[$productIdx[$i] % $productParts.Count][1] } elseif ($isFact) { $productCategories[$r.Next(0, $productCategories.Count)] } else { $productCategories[$i % $productCategories.Count] }
                    }
                }
                'store' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.storeFmt -f $cityParts[$cityIdx[$i]][0] } }
                'department' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($isFact -or -not (Has $m.Tokens $T.department)) { $w.departments[$r.Next(0, $w.departments.Count)] } else { $w.departments[$i % $w.departments.Count] } } }
                'channel' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($isFact -or -not (Has $m.Tokens $T.channel)) { $w.channels[[int][math]::Floor([math]::Pow($r.NextDouble(), 1.5) * $w.channels.Count)] } else { $w.channels[$i % $w.channels.Count] } } }
                'segment' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($isFact -or -not (Has $m.Tokens $T.segment)) { $w.segments[[int][math]::Floor([math]::Pow($r.NextDouble(), 1.5) * $w.segments.Count)] } else { $w.segments[$i % $w.segments.Count] } } }
                'currency' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.currency } }
                'status' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.status[$r.Next(0, $w.status.Count)] } }
                'category' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.categoryLabels[[int][math]::Floor([math]::Pow($r.NextDouble(), 1.5) * $w.categoryLabels.Count)] } }
                'description' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $w.descriptions[$r.Next(0, $w.descriptions.Count)] } }
                'code' {
                    $pfx = Get-CodePrefix $(if ($col.Tokens.Count -gt 1) { $col.Tokens[0] } else { $m.Base })
                    for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($isFact) { '{0}-{1:D4}' -f $pfx, $r.Next(1, 10000) } else { '{0}-{1:D4}' -f $pfx, (1000 + $i) } }
                }
                'examples' {
                    $ex = $col.Examples
                    for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $ex[[int][math]::Floor([math]::Pow($r.NextDouble(), 1.3) * $ex.Count)] }
                }
                'pattern' {
                    # "DK-1234" -> same letters, fresh digits
                    $pat = $col.Examples[0]
                    for ($i = 0; $i -lt $n; $i++) {
                        $sb = New-Object System.Text.StringBuilder
                        foreach ($ch in $pat.ToCharArray()) { if ([char]::IsDigit($ch)) { [void]$sb.Append($r.Next(0, 10)) } else { [void]$sb.Append($ch) } }
                        $vals[$i] = $sb.ToString()
                    }
                }
                'entity_name' {
                    $label = ($col.Tokens | Where-Object { @('name', 'navn') -notcontains $_ } | Select-Object -First 1)
                    if (-not $label) { $label = $m.Base }
                    $label = (Get-Culture).TextInfo.ToTitleCase($label)
                    for ($i = 0; $i -lt $n; $i++) { $vals[$i] = if ($isFact) { "$label $($r.Next(1, 100))" } else { "$label $($i + 1)" } }
                }
                default { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = "$cn $($i + 1)" } }
            }
            $str[$cn] = $vals
        }

        # Derived numbers: line total = quantity x price (- discount), cost below price, profit = revenue - cost
        function Get-Num([string]$name) {
            if ($num.ContainsKey($name)) { return , $num[$name] }
            $out = New-Object double[] $n
            $s = $str[$name]
            for ($i = 0; $i -lt $n; $i++) { $v = 0.0; [void][double]::TryParse($s[$i], [System.Globalization.NumberStyles]::Float, $inv, [ref]$v); $out[$i] = $v }
            return , $out
        }
        $d = $m.Derive
        if ($d.Total) {
            $q = Get-Num $d.Total.Qty; $p = Get-Num $d.Total.Price
            $disc = if ($d.Total.Discount) { Get-Num $d.Total.Discount } else { $null }
            $tv = New-Object double[] $n
            for ($i = 0; $i -lt $n; $i++) { $tv[$i] = [math]::Round($q[$i] * $p[$i] * $(if ($disc) { 1 - $disc[$i] / 100 } else { 1 }), 2) }
            $num[$d.Total.Col] = $tv; $fmt[$d.Total.Col] = '0.00'; $str.Remove($d.Total.Col)
        }
        foreach ($c in $d.Cost) {
            $b = Get-Num $c.Base; $cr2 = New-Rng "$table.$($c.Col)|cost"
            $cv = New-Object double[] $n
            for ($i = 0; $i -lt $n; $i++) { $cv[$i] = [math]::Round($b[$i] * (0.45 + 0.30 * $cr2.NextDouble()), 2) }
            $num[$c.Col] = $cv; $fmt[$c.Col] = '0.00'; $str.Remove($c.Col)
        }
        foreach ($c in $d.Profit) {
            $rv = Get-Num $c.Revenue; $co = Get-Num $c.Cost
            $pv = New-Object double[] $n
            for ($i = 0; $i -lt $n; $i++) { $pv[$i] = [math]::Round($rv[$i] - $co[$i], 2) }
            $num[$c.Col] = $pv; $fmt[$c.Col] = '0.00'; $str.Remove($c.Col)
        }

        foreach ($cn in @($num.Keys)) {
            $nv = $num[$cn]; $f = $fmt[$cn]; $sv = New-Object string[] $n
            for ($i = 0; $i -lt $n; $i++) { $sv[$i] = $nv[$i].ToString($f, $inv) }
            $str[$cn] = $sv
        }

        $byLower = @{}
        foreach ($col in $cols) { $byLower[$col.Lower] = $str[$col.Name] }
        $generated[$table] = $byLower

        # Write CSV (UTF-8 without BOM, comma, LF - same CSV rules as messy-dataset)
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append((($cols | ForEach-Object { $_.Name }) -join ',')).Append("`n")
        # quote once per column, then join row by row
        $special = [char[]]@(',', '"', "`n", "`r")
        $colArrays = foreach ($col in $cols) {
            $src = $str[$col.Name]
            $esc = New-Object string[] $n
            for ($i = 0; $i -lt $n; $i++) {
                $v = $src[$i]
                $esc[$i] = if ($v -and $v.IndexOfAny($special) -ge 0) { '"' + $v.Replace('"', '""') + '"' } else { $v }
            }
            , $esc
        }
        $colArrays = @($colArrays)
        $cc = $colArrays.Count
        $line = New-Object string[] $cc
        for ($i = 0; $i -lt $n; $i++) {
            for ($j = 0; $j -lt $cc; $j++) { $line[$j] = $colArrays[$j][$i] }
            [void]$sb.Append([string]::Join(',', $line)).Append("`n")
        }
        [System.IO.File]::WriteAllText((Join-Path $OutDir "$table.csv"), $sb.ToString(), $utf8NoBom)
    }
}

# ---------------------------------------------------------------------------
# 9. JSON summary (schema order)
# ---------------------------------------------------------------------------

$tableSummary = New-Object System.Collections.Generic.List[object]
foreach ($table in $tableNames) {
    $tableSummary.Add([ordered]@{
        table       = $table
        role        = $(if ($meta[$table].IsDateDim) { 'date' } else { $roleByTable[$table] })
        rows        = $rowCountByTable[$table]
        primaryKey  = $primaryKeyByTable[$table]
        foreignKeys = @($columnsByTable[$table] | Where-Object { $foreignKeys.ContainsKey("$table.$($_.Name)") } | ForEach-Object { [ordered]@{ column = $_.Name; references = $foreignKeys["$table.$($_.Name)"] } })
        columns     = @($columnsByTable[$table] | ForEach-Object { [ordered]@{ name = $_.Name; kind = (Get-KindLabel $table $_) } })
    })
}

$result = [ordered]@{
    seed             = $Seed
    locale           = $Locale
    endDate          = $periodEnd.ToString('yyyy-MM-dd', $inv)
    period           = '{0} .. {1}' -f $periodStart.ToString('yyyy-MM-dd', $inv), $periodEnd.ToString('yyyy-MM-dd', $inv)
    outDir           = $(if ($PlanOnly) { $OutDir } else { [string](Resolve-Path $OutDir) })
    planOnly         = [bool]$PlanOnly
    tables           = $tableSummary.ToArray()
    unmatchedColumns = @($unmatched)
}
$result | ConvertTo-Json -Depth 6
