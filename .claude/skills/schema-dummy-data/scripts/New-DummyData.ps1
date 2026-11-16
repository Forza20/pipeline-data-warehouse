#Requires -Version 5.1
<#
Generates deterministic dummy data from a client's schema, so pipeline-power-bi can
build a demo dashboard without real customer data. Output: one XLSX with a sheet per
table (default), or one CSV per table (-Format csv), or both.

Schema input, two shapes (detected automatically):
  A) Long list (CSV or XLSX first sheet), one row per column, headers case-insensitive:
       table | tabel        (required)
       column | kolonne     (required)
       type | datatype      (optional hint: id, date, int, decimal, bool, email, string, ...)
       example | eksempel   (optional: "A|B|C" = pick from these values; one value = a
                             number range, a date, or a code pattern like "DK-1234")
  B) Sheet per table (XLSX: every sheet; CSV: one table named after the file): row 1 =
     column names, any further rows = the client's sample rows. Sample rows are kept as
     the first rows of the output (unless -ExcludeSampleRows) and are the inspiration for
     the rest: recurring values -> same list and frequencies, numbers -> same range,
     codes/ids -> same format continued, dates -> the period, empty share -> kept.
     No sample rows -> the column names alone decide (same as a long list without examples).

Usage:
  New-DummyData.ps1 -SchemaPath schema.xlsx -OutDir out -PlanOnly
  New-DummyData.ps1 -SchemaPath schema.xlsx -OutDir out -Locale da -Seed 42 -RowsFact 1000 -RowsDim 30
  New-DummyData.ps1 -SchemaPath schema.csv -OutDir out -Format csv -Rows "fact_orders=2000,dim_customer=100" -EndDate 2026-10-31

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
    [ValidateSet('xlsx', 'csv', 'both')][string]$Format = 'xlsx',
    [string]$OutName = '',
    [switch]$ExcludeSampleRows,
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($Seed -lt 0) { $Seed = Get-Random -Minimum 1 -Maximum 2147483646 }

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

function Get-CsvDelimiter([string]$firstLine) {
    # Danish Excel "Save as CSV" uses ';' (',' is the decimal separator there).
    # Pick the delimiter that splits the header into the most fields; comma wins ties.
    $delimiter = ','
    $best = ([regex]::Matches($firstLine, ',')).Count
    foreach ($d in @(';', "`t")) {
        $cnt = ([regex]::Matches($firstLine, [regex]::Escape($d))).Count
        if ($cnt -gt $best) { $delimiter = $d; $best = $cnt }
    }
    return $delimiter
}

# Excel stores numbers as binary doubles: 2576.55 can come back as 2576.5500000000002.
function Get-CleanNumberText([string]$v) {
    if ($v -match '^-?\d+\.\d{9,}$') { return ([math]::Round([double]::Parse($v, $inv), 6)).ToString('0.######', $inv) }
    return $v
}

# A grid (header row + data rows as string[]) per sheet, in workbook order.
# Date-formatted cells (built-in date formats or a custom d/m/y format) come back as
# yyyy-MM-dd, or yyyy-MM-dd HH:mm:ss when the cell has a time part.
function Read-XlsxSheets([string]$path) {
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

        # style index -> 'date' / 'datetime' for date-formatted cells
        $dateStyle = @{}
        $st = Read-ZipXml $zip 'xl/styles.xml'
        if ($st) {
            $customFmt = @{}
            foreach ($f in $st.DocumentElement.SelectNodes("*[local-name()='numFmts']/*[local-name()='numFmt']")) {
                $code = ($f.GetAttribute('formatCode') -replace '"[^"]*"', '') -replace '\[[^\]]*\]', ''
                if ($code -match '[dDyY]') { $customFmt[$f.GetAttribute('numFmtId')] = $(if ($code -match '[hH]') { 'datetime' } else { 'date' }) }
            }
            $xfs = $st.DocumentElement.SelectNodes("*[local-name()='cellXfs']/*[local-name()='xf']")
            for ($i = 0; $i -lt $xfs.Count; $i++) {
                $fid = $xfs[$i].GetAttribute('numFmtId')
                $fnum = 0; [void][int]::TryParse($fid, [ref]$fnum)
                if ($fnum -ge 14 -and $fnum -le 17) { $dateStyle[$i] = 'date' }
                elseif ($fnum -eq 22) { $dateStyle[$i] = 'datetime' }
                elseif ($customFmt.ContainsKey($fid)) { $dateStyle[$i] = $customFmt[$fid] }
            }
        }

        $sheetList = New-Object System.Collections.Generic.List[object]
        $wb = Read-ZipXml $zip 'xl/workbook.xml'
        $rels = Read-ZipXml $zip 'xl/_rels/workbook.xml.rels'
        $relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        $sheetNodes = if ($wb) { @($wb.DocumentElement.SelectNodes("*[local-name()='sheets']/*[local-name()='sheet']")) } else { @() }
        if ($sheetNodes.Count -eq 0) { $sheetNodes = @($null) }
        $k = 0
        foreach ($sn in $sheetNodes) {
            $k++
            $sheetName = "Sheet$k"; $sheetPath = "xl/worksheets/sheet$k.xml"
            if ($sn) {
                $sheetName = $sn.GetAttribute('name')
                $rid = $sn.GetAttribute('id', $relNs)
                $rel = if ($rels) { @($rels.DocumentElement.ChildNodes | Where-Object { $_.Id -eq $rid })[0] } else { $null }
                if ($rel) {
                    $target = $rel.Target -replace '^/', ''
                    $sheetPath = if ($target.StartsWith('xl/')) { $target } else { 'xl/' + $target }
                }
            }
            $sheet = Read-ZipXml $zip $sheetPath
            if (-not $sheet) { continue }
            $grid = New-Object System.Collections.Generic.List[object]
            foreach ($r in $sheet.DocumentElement.SelectNodes("*[local-name()='sheetData']/*[local-name()='row']")) {
                $cells = @{}
                foreach ($c in $r.SelectNodes("*[local-name()='c']")) {
                    $colIndex = 0
                    foreach ($ch in ($c.GetAttribute('r') -replace '[0-9]', '').ToCharArray()) { $colIndex = $colIndex * 26 + ([int][char]$ch - 64) }
                    $val = $null
                    $t = $c.GetAttribute('t')
                    $vNode = $c.SelectSingleNode("*[local-name()='v']")
                    if ($vNode) {
                        $raw = $vNode.InnerText
                        if ($t -eq 's') { $val = $shared[[int]$raw] }
                        elseif ($t -eq 'b') { $val = $(if ($raw -eq '1') { 'TRUE' } else { 'FALSE' }) }
                        elseif ($t -eq 'str' -or $t -eq 'e') { $val = $raw }
                        else {
                            $sIdx = -1; [void][int]::TryParse($c.GetAttribute('s'), [ref]$sIdx)
                            $dbl = 0.0
                            if ($dateStyle.ContainsKey($sIdx) -and [double]::TryParse($raw, [System.Globalization.NumberStyles]::Float, $inv, [ref]$dbl)) {
                                $dt = [datetime]::FromOADate($dbl)
                                $val = if ($dateStyle[$sIdx] -eq 'datetime' -or $dt.TimeOfDay.TotalSeconds -ge 1) { $dt.ToString('yyyy-MM-dd HH:mm:ss', $inv) } else { $dt.ToString('yyyy-MM-dd', $inv) }
                            } else { $val = Get-CleanNumberText $raw }
                        }
                    } else {
                        $isNode = $c.SelectSingleNode("*[local-name()='is']")
                        if ($isNode) { $val = $isNode.InnerText }
                    }
                    if ($colIndex -gt 0) { $cells[$colIndex - 1] = $val }
                }
                if ($cells.Count -gt 0) {
                    $maxCol = ($cells.Keys | Measure-Object -Maximum).Maximum
                    $arr = New-Object string[] ($maxCol + 1)
                    foreach ($key in $cells.Keys) { $arr[$key] = $cells[$key] }
                    $grid.Add($arr)
                }
            }
            $sheetList.Add(@{ Name = $sheetName; Grid = $grid })
        }
        return $sheetList.ToArray()   # unrolled on purpose: the caller pipes the sheets one by one
    } finally {
        $zip.Dispose()
    }
}

function Test-LongListHeader([string[]]$header) {
    $h = @($header | ForEach-Object { if ($_) { $_.Trim().ToLowerInvariant() } else { '' } })
    $hasTable = @($h | Where-Object { @('table', 'tabel', 'table_name', 'tabelnavn') -contains $_ }).Count -gt 0
    $hasColumn = @($h | Where-Object { @('column', 'kolonne', 'column_name', 'kolonnenavn', 'felt', 'field') -contains $_ }).Count -gt 0
    return ($hasTable -and $hasColumn)
}

function ConvertTo-RowObjects($grid) {
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
}

function Read-ZipXml($zip, [string]$entryName) {
    $entry = $zip.GetEntry($entryName)
    if (-not $entry) { return $null }
    $sr = New-Object System.IO.StreamReader($entry.Open())
    try { $doc = New-Object xml; $doc.LoadXml($sr.ReadToEnd()); return $doc } finally { $sr.Dispose() }
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
# Every input becomes a list of sheets (Name + Grid); a CSV is one sheet named after the file.
if ($ext -eq '.xlsx' -or $ext -eq '.xlsm') {
    $sheets = @(Read-XlsxSheets $SchemaPath | Where-Object { $_.Grid.Count -gt 0 })
} else {
    $firstLine = Get-Content -Path $SchemaPath -Encoding UTF8 -TotalCount 1
    if (-not $firstLine) { throw "$SchemaPath is empty" }
    $delim = Get-CsvDelimiter $firstLine
    $hdr = @(($firstLine -split [regex]::Escape($delim)) | ForEach-Object { $_.Trim().Trim('"') })
    $csvGrid = New-Object System.Collections.Generic.List[object]
    $csvGrid.Add([string[]]$hdr)
    foreach ($o in @(Import-Csv -Path $SchemaPath -Encoding UTF8 -Delimiter $delim)) {
        $csvGrid.Add([string[]]@($hdr | ForEach-Object { [string]$o.$_ }))
    }
    $sheets = @(@{ Name = [System.IO.Path]::GetFileNameWithoutExtension($SchemaPath); Grid = $csvGrid })
}
if ($sheets.Count -eq 0) { throw "No sheets with content found in $SchemaPath" }

$inputShape = if (Test-LongListHeader $sheets[0].Grid[0]) { 'long-list' } else { 'sheet-per-table' }
$tableNames = New-Object System.Collections.Generic.List[string]
$columnsByTable = @{}
$sampleCountByTable = @{}   # table -> number of client sample rows read from the sheet
$schemaRows = if ($inputShape -eq 'long-list') { ConvertTo-RowObjects $sheets[0].Grid } else { @() }

if ($inputShape -eq 'sheet-per-table') {
    foreach ($sh in $sheets) {
        $table = ([string]$sh.Name).Trim()
        if (-not $table -or $columnsByTable.ContainsKey($table)) { continue }
        $header = $sh.Grid[0]
        $dataRows = @()
        for ($i = 1; $i -lt $sh.Grid.Count; $i++) {
            $gr = $sh.Grid[$i]
            if (@($gr | Where-Object { $_ -and $_.Trim() }).Count -gt 0) { $dataRows += , $gr }
        }
        $cols = New-Object System.Collections.Generic.List[object]
        for ($j = 0; $j -lt $header.Count; $j++) {
            $column = if ($header[$j]) { $header[$j].Trim() } else { '' }
            if (-not $column -or @($cols | Where-Object { $_.Lower -eq $column.ToLowerInvariant() }).Count) { continue }
            $samples = New-Object string[] $dataRows.Count
            for ($i = 0; $i -lt $dataRows.Count; $i++) {
                $cell = if ($j -lt $dataRows[$i].Count) { $dataRows[$i][$j] } else { $null }
                $samples[$i] = if ($cell) { $cell.Trim() } else { '' }
            }
            $cols.Add(@{ Name = $column; Lower = $column.ToLowerInvariant(); Tokens = (Get-Tokens $column); Type = $null; Examples = @(); Samples = $samples })
        }
        if ($cols.Count -eq 0) { continue }
        $columnsByTable[$table] = $cols
        $sampleCountByTable[$table] = $dataRows.Count
        $tableNames.Add($table)
    }
}

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
        Examples = $exampleList; Samples = @()
    })
    $sampleCountByTable[$table] = 0
}
if ($tableNames.Count -eq 0) { throw "No table/column pairs found. Check the headers (table/tabel, column/kolonne), or use one sheet per table with the column names in row 1." }

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

$numberedKinds = @('amount', 'quantity', 'percent', 'generic_int', 'example_number', 'sample_range', 'year', 'month', 'quarter', 'day', 'week')

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
# 3b. Sample rows (sheet-per-table input): the client's own rows refine the kind
# ---------------------------------------------------------------------------

$hints = New-Object System.Collections.Generic.List[string]
$companySuffixWords = @('group', 'holdings', 'holding', 'inc', 'inc.', 'ltd', 'ltd.', 'llc', 'corp', 'corp.', 'corporation', 'co', 'co.', 'company', 'gmbh', 'ag', 'ab', 'as', 'a/s', 'aps', 'i/s', 'bv', 'nv', 'sa', 'plc', 'oy',
    'industries', 'partners', 'trading', 'logistics', 'retail', 'supply', 'distribution', 'commerce', 'solutions', 'systems', 'services', 'consulting', 'technologies', 'enterprises', 'international', 'handel', 'gruppen', 'service')
# Kinds that keep their own generator (row-consistent or format-bound) even when samples exist
$structuredKinds = @('email', 'phone', 'url', 'city', 'country', 'postal', 'address', 'firstname', 'lastname', 'birthdate', 'year', 'quarter', 'month', 'monthname', 'weekday', 'week', 'day', 'currency', 'bool')
$closedListKinds = @('status', 'segment', 'channel', 'department', 'category', 'product_category', 'region')

function Get-DistinctOrdinal($values) {
    $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($v in $values) { if ($set.Add($v)) { $out.Add($v) } }
    return , $out.ToArray()
}

function Get-NumberRange($values) {
    $lo = [double]::MaxValue; $hi = [double]::MinValue; $dec = 0
    foreach ($v in $values) {
        $t = $v.Replace(',', '.')
        $d = [double]::Parse($t, $inv)
        if ($d -lt $lo) { $lo = $d }; if ($d -gt $hi) { $hi = $d }
        if ($t.Contains('.')) { $dec = [math]::Max($dec, [math]::Min($t.Split('.')[1].Length, 4)) }
    }
    if ($lo -eq $hi) { $hi = $lo * 1.5; $lo = $lo * 0.5; if ($lo -gt $hi) { $tmp = $lo; $lo = $hi; $hi = $tmp } }
    return @{ Lo = $lo; Hi = $hi; Dec = $dec }
}

function Set-SampleKind([string]$table, $col, [bool]$hasCity) {
    $s = $col.Samples.Count
    $filled = @($col.Samples | Where-Object { $_ -ne '' })
    $nameKind = $col.Kind
    if ($filled.Count -eq 0) {
        # three or more sample rows and never filled in: the client leaves it empty
        if ($s -ge 3) { $col.Kind = 'blank' }
        return
    }
    if ($s -ge 3 -and $filled.Count -lt $s) { $col.BlankRate = ($s - $filled.Count) / $s }
    $hasPipe = @($filled | Where-Object { $_.Contains('|') }).Count -gt 0
    $vals = @($filled | ForEach-Object { $_ -split '\s*\|\s*' } | Where-Object { $_ -ne '' })
    $distinct = Get-DistinctOrdinal $vals
    $nv = $vals.Count; $nd = $distinct.Count
    $lowCard = ($nd -le 12 -and $nv -ge 4 -and $nv -ge 2 * $nd)

    # an "A|B|C" cell defines the column; the other sample rows' blanks are not an empty share
    if ($hasPipe) { $col.Kind = 'sample_list'; $col.Pool = $vals; $col.PoolSkew = $true; $col.BlankRate = 0; return }
    if ($structuredKinds -contains $nameKind -or ($nameKind -eq 'region' -and $hasCity)) { return }

    if (@($vals | Where-Object { $_ -notmatch '^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$' }).Count -eq 0) {
        $col.Kind = 'date'
        $col.HasTime = @($vals | Where-Object { $_ -match '[ T](\d{2}):(\d{2})' -and $_ -notmatch '[ T]00:00(:00)?$' }).Count -gt 0
        $col.SampleDates = @($vals | ForEach-Object { [datetime]::ParseExact($_.Substring(0, 10), 'yyyy-MM-dd', $inv) })
        return
    }
    if (@($vals | Where-Object { $_ -notmatch '^-?\d+([.,]\d+)?$' }).Count -eq 0) {
        $leadingZero = @($vals | Where-Object { $_ -match '^0\d' }).Count -gt 0
        if ($lowCard -or $leadingZero) { $col.Kind = 'sample_list'; $col.Pool = $vals; return }
        $col.Range = Get-NumberRange $vals
        if (@('amount', 'quantity', 'percent') -notcontains $nameKind) { $col.Kind = 'sample_range' }
        return
    }
    if ($lowCard) { $col.Kind = 'sample_list'; $col.Pool = $vals; return }

    # company names: most samples end in a company word (Group, Holdings, ApS, Inc. ...)
    $lastWords = @($distinct | ForEach-Object { @($_ -split '\s+')[-1] })
    $companyLike = @($lastWords | Where-Object { $companySuffixWords -contains $_.ToLowerInvariant() }).Count
    if (@($distinct | Where-Object { $_ -match '\s' }).Count -eq $nd -and $companyLike * 2 -ge $nd) {
        $col.Kind = 'company'
        $col.CompanySuffixes = Get-DistinctOrdinal @($lastWords | Where-Object { $companySuffixWords -contains $_.ToLowerInvariant() })
        return
    }
    if (@($vals | Where-Object { $_ -notmatch '^[0-9a-fA-F]{16,}$' }).Count -eq 0) {
        $col.Kind = 'sample_hex'; $col.HexLen = $vals[0].Length; $col.HexUpper = $vals[0] -cmatch '[A-F]'; return
    }
    # codes: same prefix + digits (SAP-200000, ORD00001, INV-2026-0001 -> prefix INV-2026-)
    $prefixes = New-Object System.Collections.Generic.List[string]
    $codeWidth = 0; $codeMax = [long]0
    foreach ($v in $vals) {
        if ($v -match '^(.*?)(\d{1,15})$') {
            $prefixes.Add($Matches[1])
            $codeWidth = [math]::Max($codeWidth, $Matches[2].Length)
            $codeMax = [math]::Max($codeMax, [long]$Matches[2])
        }
    }
    if ($prefixes.Count -eq $nv -and (Get-DistinctOrdinal $prefixes).Count -eq 1) {
        $col.Kind = 'sample_code'; $col.CodePrefix = $prefixes[0]; $col.CodeWidth = $codeWidth; $col.CodeMax = $codeMax
        return
    }
    if ($nameKind -eq 'fullname') { return }
    $avgLen = ($vals | ForEach-Object { $_.Length } | Measure-Object -Average).Average
    if ($avgLen -gt 25 -or $nameKind -eq 'description') {
        # one distinct sentence only: mixed with the locale's filler sentences at generation time
        $col.Kind = 'sample_text'; $col.Pool = $vals; $col.PoolAddBank = ($nd -lt 2)
        return
    }
    if ($nd -eq 1 -and $closedListKinds -contains $nameKind) {
        $hints.Add("$table.$($col.Name): only one sample value ('$($distinct[0])') - kept the standard list; write all values separated by | to use yours")
        return
    }
    if (@('generic_text', 'entity_name', 'pattern', 'code') + $closedListKinds -contains $nameKind) {
        $col.Kind = 'sample_list'; $col.Pool = $vals
        if ($nd -eq 1) { $hints.Add("$table.$($col.Name): only one sample value ('$($distinct[0])') - every row gets it; write all values separated by |") }
        return
    }
}

foreach ($table in $tableNames) {
    $cols = $columnsByTable[$table]
    $hasCity = @($cols | Where-Object { $_.Kind -eq 'city' -or $_.Kind -eq 'store' }).Count -gt 0
    foreach ($col in $cols) { if ($col.Samples -and $col.Samples.Count -gt 0) { Set-SampleKind $table $col $hasCity } }
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

# Period. Default: two full years ending on the last day of the previous month (complete
# months only, so a demo has no half-finished month and can show year-over-year).
# With sample dates (fact tables first): it ends with the month of the latest sample date,
# and starts with the month of the earliest one when they span at least two months.
$periodSource = 'default'
if ($EndDate) { $periodEnd = [datetime]::ParseExact($EndDate, 'yyyy-MM-dd', $inv); $periodSource = 'endDate' }
else { $todayDate = (Get-Date).Date; $periodEnd = $todayDate.AddDays(-$todayDate.Day) }
$periodStart = $periodEnd.AddYears(-2).AddDays(1)
if (-not $EndDate) {
    $sampleDates = @()
    foreach ($pass in @('fact', 'any')) {
        foreach ($table in $tableNames) {
            if ($pass -eq 'fact' -and $roleByTable[$table] -ne 'fact') { continue }
            foreach ($col in $columnsByTable[$table]) { if ($col.Kind -eq 'date' -and $col.SampleDates) { $sampleDates += $col.SampleDates } }
        }
        if ($sampleDates.Count) { break }
    }
    if ($sampleDates.Count) {
        $sortedDates = @($sampleDates | Sort-Object); $minD = $sortedDates[0]; $maxD = $sortedDates[-1]
        $periodEnd = (New-Object datetime $maxD.Year, $maxD.Month, 1).AddMonths(1).AddDays(-1)
        $periodStart = if (($maxD - $minD).Days -ge 60) { New-Object datetime $minD.Year, $minD.Month, 1 } else { $periodEnd.AddYears(-2).AddDays(1) }
        $periodSource = 'sample rows'
    }
}
$spanDays = ($periodEnd - $periodStart).Days

# Name link: a fact without an id to a dimension, but with the dimension's name column
# (ORDERS.CustomerName next to CUSTOMERS.CustomerName) gets a hidden key, so the names
# it copies always exist in the dimension. The hidden key is never written out.
$nameLinks = @{}   # "table.column" -> dimension table
foreach ($table in $tableNames) {
    if ($roleByTable[$table] -ne 'fact') { continue }
    $linked = @($foreignKeys.Keys | Where-Object { $_.StartsWith("$table.") } | ForEach-Object { $foreignKeys[$_] })
    foreach ($dim in $tableNames) {
        if ($dim -eq $table -or $roleByTable[$dim] -ne 'dimension' -or $meta[$dim].IsDateDim -or $linked -contains $dim) { continue }
        # .ToArray(), not @(): @() on a List[object] can throw "argument types do not match" in PS 5.1
        foreach ($col in $columnsByTable[$table].ToArray()) {
            if ($col.Hidden -or $primaryKeyByTable[$table] -eq $col.Name -or $foreignKeys.ContainsKey("$table.$($col.Name)")) { continue }
            $dc = @($columnsByTable[$dim] | Where-Object { $_.Lower -eq $col.Lower -and $_.Name -ne $primaryKeyByTable[$dim] })[0]
            if (-not $dc) { continue }
            $nameish = ($col.Tokens.Count -ge 2 -and (Has $col.Tokens @('name', 'navn'))) -or (@('company', 'fullname', 'product', 'store') -contains $dc.Kind)
            if (-not $nameish) { continue }
            $hidden = @{ Name = "__link_$dim"; Lower = "__link_$($dim.ToLowerInvariant())"; Tokens = @(); Type = $null; Examples = @(); Samples = @(); Kind = 'hidden'; Hidden = $true }
            $columnsByTable[$table].Add($hidden)
            $foreignKeys["$table.$($hidden.Name)"] = $dim
            $nameLinks["$table.$($col.Name)"] = $dim
            break
        }
    }
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
        companyWord = 'Nordlys,Vestkyst,Østbro,Dansk Handel,Bright,Smart,Prime,Horizon,Blåvand,Fjord,Skovly,Havn,Egeskov,Lysholm,Højvang,Kystlinje,Lindegaard,Bakkehus,Strandby,Nordkyst'.Split(',')
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
        companyWord = 'Northwind,Southgate,Global,Bright,Smart,Prime,Horizon,Bluewater,Summit,Union,Redwood,Harbor,Aurora,Cobalt,Falcon,Granite,Juniper,Kestrel,Pioneer,Silverline'.Split(',')
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

# Client sample rows are kept as the first rows of their table (a date table is always
# a generated calendar); the row count never drops below them.
$keptSamples = @{}
foreach ($table in $tableNames) {
    $keptSamples[$table] = if ($ExcludeSampleRows -or $meta[$table].IsDateDim) { 0 } else { [int]$sampleCountByTable[$table] }
}

$rowCountByTable = @{}
foreach ($table in $tableNames) {
    $m = $meta[$table]
    if ($rowOverrides.ContainsKey($m.Lower)) { $cnt = $rowOverrides[$m.Lower] }
    elseif ($roleByTable[$table] -eq 'fact') { $cnt = $RowsFact }
    elseif ($m.IsDateDim) { $cnt = $spanDays + 1 }
    else { $closed = Get-ClosedListSize $m; $cnt = if ($closed -gt 0) { [math]::Min($RowsDim, $closed) } else { $RowsDim } }
    $rowCountByTable[$table] = [math]::Max($cnt, $keptSamples[$table])
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
    if ($col.Lookup) {
        if ($nameLinks.ContainsKey($fk)) { return "lookup <- $($col.Lookup.Table).$($col.Lookup.Column) (name link, no id in this table)" }
        $via = if ($col.Lookup.Fk.StartsWith('__link_')) { "the name link to $($col.Lookup.Table)" } else { $col.Lookup.Fk }
        return "lookup <- $($col.Lookup.Table).$($col.Lookup.Column) via $via"
    }
    $d = $meta[$table].Derive
    if ($d.Total -and $d.Total.Col -eq $col.Name) { return "derived: $($d.Total.Qty) x $($d.Total.Price)" }
    foreach ($c in $d.Cost) { if ($c.Col -eq $col.Name) { return "derived: 45-75% of $($c.Base)" } }
    foreach ($c in $d.Profit) { if ($c.Col -eq $col.Name) { return "derived: $($c.Revenue) - $($c.Cost)" } }
    $label = $col.Kind
    switch ($col.Kind) {
        'sample_list' { $label = "sample list ($((Get-DistinctOrdinal $col.Pool).Count) values)" }
        'sample_text' { $label = "sample text ($((Get-DistinctOrdinal $col.Pool).Count) values)" }
        'sample_range' { $label = 'sample range {0}..{1}' -f $col.Range.Lo.ToString($inv), $col.Range.Hi.ToString($inv) }
        'sample_code' { $label = "sample code $($col.CodePrefix)$('#' * $col.CodeWidth)" }
        'sample_hex' { $label = "sample hex ($($col.HexLen) chars)" }
        'blank' { $label = 'blank (empty in every sample row)' }
        'company' { if ($col.CompanySuffixes) { $label = "company (suffixes from samples: $($col.CompanySuffixes -join ', '))" } }
        'date' { if ($col.HasTime) { $label = 'datetime' } }
        default { if ($col.Range) { $label = '{0} (sample range {1}..{2})' -f $col.Kind, $col.Range.Lo.ToString($inv), $col.Range.Hi.ToString($inv) } }
    }
    if ($col.BlankRate) { $label += ' + {0:0}% empty' -f ($col.BlankRate * 100) }
    return $label
}

$unmatched = New-Object System.Collections.Generic.List[string]
foreach ($table in $tableNames) {
    foreach ($col in $columnsByTable[$table]) {
        if ($col.Hidden) { continue }
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
    } else {
        # Key format: from the client's sample keys (1001 -> 1002 ..., ORD00040 -> ORD00041 ...)
        # or an example, else 1..n (or PFX-0001 for a business key named after the table).
        $kept = $keptSamples[$table]
        $pkCol = if ($pkName) { @($columnsByTable[$table] | Where-Object { $_.Name -eq $pkName })[0] } else { $null }
        $keyVals = @()
        if ($pkCol) { $keyVals = @($pkCol.Samples | Where-Object { $_ -ne '' }); if (-not $keyVals.Count) { $keyVals = @($pkCol.Examples) } }
        $keyPrefix = $null; $keyWidth = 0; $keyStart = [long]1
        if ($keyVals.Count) {
            $parsed = @($keyVals | ForEach-Object { if ($_ -match '^(.*?)(\d{1,15})$') { [pscustomobject]@{ P = $Matches[1]; D = $Matches[2] } } })
            if ($parsed.Count -eq $keyVals.Count -and (Get-DistinctOrdinal @($parsed | ForEach-Object { $_.P })).Count -eq 1) {
                $keyPrefix = $parsed[0].P
                $keyWidth = if ($keyPrefix -or @($parsed | Where-Object { $_.D -match '^0' }).Count) { ($parsed | ForEach-Object { $_.D.Length } | Measure-Object -Maximum).Maximum } else { 0 }
                $nums = @($parsed | ForEach-Object { [long]$_.D } | Sort-Object)
                $keyStart = if ($kept -gt 0) { $nums[-1] + 1 } else { $nums[0] }
            }
        }
        if ($null -eq $keyPrefix -and $pkIsCode[$table]) { $keyPrefix = (Get-CodePrefix $m.Base) + '-'; $keyWidth = 4 }
        if ($null -eq $keyPrefix) { $keyPrefix = '' }
        $digitFmt = if ($keyWidth -gt 0) { 'D' + $keyWidth } else { 'D' }
        $counter = $keyStart
        for ($i = 0; $i -lt $n; $i++) {
            if ($i -lt $kept -and $pkCol -and $pkCol.Samples[$i] -ne '') { $pool[$i] = $pkCol.Samples[$i]; continue }
            $pool[$i] = $keyPrefix + $counter.ToString($digitFmt, $inv); $counter++
        }
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

$xlsxSheets = New-Object System.Collections.Generic.List[object]
$sampleWarnings = New-Object System.Collections.Generic.List[string]
$writtenFiles = New-Object System.Collections.Generic.List[string]
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

        # Several city columns in one row (CustomerCity, ShipToCity, BillToCity): the first is
        # the row's city, the others are their own city - the same one 40% of the time.
        # A country/region/postal column follows the city column with the same prefix
        # (ship_country -> ship_city), else the row's city.
        $placeWords = @('city', 'by', 'bynavn', 'town', 'country', 'land', 'region', 'postal', 'zip', 'postnr', 'postnummer', 'zipcode', 'postcode', 'post', 'name', 'navn', 'code', 'kode')
        $cityIdxByPrefix = @{}
        $cityCols = @($cols | Where-Object { $_.Kind -eq 'city' -and -not $_.Lookup -and -not $_.Hidden })
        for ($c = 0; $c -lt $cityCols.Count; $c++) {
            $pfxKey = (@($cityCols[$c].Tokens | Where-Object { $placeWords -notcontains $_ }) -join '_')
            if ($c -eq 0) { $idxArr = $cityIdx }
            else {
                $ccr = New-Rng "$table.$($cityCols[$c].Name)|city"
                $idxArr = New-Object int[] $n
                for ($i = 0; $i -lt $n; $i++) { $idxArr[$i] = if ($ccr.NextDouble() -lt 0.4) { $cityIdx[$i] } else { [int][math]::Floor([math]::Pow($ccr.NextDouble(), 1.6) * $cityParts.Count) } }
            }
            $cityCols[$c].CityIdx = $idxArr
            if (-not $cityIdxByPrefix.ContainsKey($pfxKey)) { $cityIdxByPrefix[$pfxKey] = $idxArr }
        }
        function Get-PlaceIdx($col) {
            $pfxKey = (@($col.Tokens | Where-Object { $placeWords -notcontains $_ }) -join '_')
            if ($pfxKey -and $cityIdxByPrefix.ContainsKey($pfxKey)) { return , $cityIdxByPrefix[$pfxKey] }
            return , $cityIdx
        }

        # keys first, so a lookup column never runs before the key it copies through
        $isKeyCol = { param($c) $primaryKeyByTable[$table] -eq $c.Name -or $foreignKeys.ContainsKey("$table.$($c.Name)") }
        $orderedCols = @($cols | Where-Object { & $isKeyCol $_ }) + @($cols | Where-Object { -not (& $isKeyCol $_) })

        $firstDateDone = $false
        foreach ($col in $orderedCols) {
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
            if ($col.Range -and $numberedKinds -contains $kind) {
                # the client's sample range: log-uniform when it spans a wide range (many small, few big)
                $rg = $col.Range; $nv = New-Object double[] $n
                $logScale = ($rg.Lo -gt 0 -and $rg.Hi / $rg.Lo -gt 4)
                for ($i = 0; $i -lt $n; $i++) {
                    $u = $r.NextDouble()
                    $x = if ($logScale) { $rg.Lo * [math]::Pow($rg.Hi / $rg.Lo, $u) } else { $rg.Lo + ($rg.Hi - $rg.Lo) * $u }
                    $nv[$i] = [math]::Round($x, $rg.Dec)
                }
                $num[$cn] = $nv; $fmt[$cn] = if ($rg.Dec -gt 0) { '0.' + ('0' * $rg.Dec) } else { '0' }
                continue
            }
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
                    $tr = New-Rng "$table.$cn|time"
                    for ($i = 0; $i -lt $n; $i++) {
                        if (-not $firstDateDone) { $dt = $dates[$i] }
                        elseif ($isLater) { $dt = $dates[$i].AddDays($r.Next(0, 31)); if ($dt -gt $periodEnd) { $dt = $periodEnd } }
                        else { $dt = $periodStart.AddDays($r.Next(0, $spanDays + 1)) }
                        # samples with a time of day -> a time within working hours (08:00-18:00)
                        $vals[$i] = if ($col.HasTime) { $dt.AddSeconds(28800 + $tr.Next(0, 36000)).ToString('yyyy-MM-dd HH:mm:ss', $inv) } else { $dt.ToString('yyyy-MM-dd', $inv) }
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
                    $pi = Get-PlaceIdx $col
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($Locale -eq 'da') { [string]([int]$cityParts[$pi[$i]][3] + 10 * $r.Next(0, 5)) } else { $cityParts[$pi[$i]][3] }
                    }
                }
                'country' { $pi = Get-PlaceIdx $col; for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $cityParts[$pi[$i]][2] } }
                'city' { $pi = if ($col.CityIdx) { $col.CityIdx } else { $cityIdx }; for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $cityParts[$pi[$i]][0] } }
                'region' {
                    $useCity = @($cols | Where-Object { $_.Kind -eq 'city' -or $_.Kind -eq 'store' }).Count -gt 0
                    $pi = Get-PlaceIdx $col
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($useCity) { $cityParts[$pi[$i]][1] } elseif ($isFact) { $w.regions[$r.Next(0, $w.regions.Count)] } else { $w.regions[$i % $w.regions.Count] }
                    }
                }
                'address' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = '{0} {1}' -f $w.streets[$r.Next(0, $w.streets.Count)], $r.Next(1, 200) } }
                'company' {
                    # suffixes from the client's samples (Group, Holdings ...) when there are any
                    $sfx = if ($col.CompanySuffixes) { @($col.CompanySuffixes) } else { $w.companySfx }
                    $cc = $w.companyWord.Count * $sfx.Count; $cp = Get-Shuffled $cc $r
                    $taken = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
                    if (-not $isFact) { for ($i = 0; $i -lt $keptSamples[$table]; $i++) { if ($col.Samples[$i]) { [void]$taken.Add($col.Samples[$i]) } } }
                    $k2 = 0
                    for ($i = 0; $i -lt $n; $i++) {
                        if ($isFact) { $k = $r.Next(0, $cc); $vals[$i] = '{0} {1}' -f $w.companyWord[$k % $w.companyWord.Count], $sfx[[math]::Floor($k / $w.companyWord.Count)]; continue }
                        if ($i -lt $keptSamples[$table]) { $vals[$i] = ''; continue }   # replaced by the sample row later
                        # distinct in a dimension, and never a name the client's sample rows already use
                        do {
                            $k = $cp[$k2 % $cc]
                            $v = '{0} {1}' -f $w.companyWord[$k % $w.companyWord.Count], $sfx[[math]::Floor($k / $w.companyWord.Count)]
                            if ($k2 -ge $cc) { $v += " $([math]::Floor($k2 / $cc) + 1)" }
                            $k2++
                        } while (-not $taken.Add($v))
                        $vals[$i] = $v
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
                'sample_list' {
                    # explicit "A|B|C" lists: skewed like other closed lists; recurring sample
                    # values: picked with the frequencies they have in the client's rows
                    $pl = @($col.Pool); $dl = Get-DistinctOrdinal $pl
                    for ($i = 0; $i -lt $n; $i++) {
                        $vals[$i] = if ($col.PoolSkew) { $dl[[int][math]::Floor([math]::Pow($r.NextDouble(), 1.3) * $dl.Count)] } else { $pl[$r.Next(0, $pl.Count)] }
                    }
                }
                'sample_text' {
                    $pl = @($col.Pool); if ($col.PoolAddBank) { $pl += $w.descriptions }
                    for ($i = 0; $i -lt $n; $i++) { $vals[$i] = $pl[$r.Next(0, $pl.Count)] }
                }
                'sample_hex' {
                    $hexChars = if ($col.HexUpper) { '0123456789ABCDEF' } else { '0123456789abcdef' }
                    for ($i = 0; $i -lt $n; $i++) {
                        $sb = New-Object System.Text.StringBuilder
                        for ($h = 0; $h -lt $col.HexLen; $h++) { [void]$sb.Append($hexChars[$r.Next(0, 16)]) }
                        $vals[$i] = $sb.ToString()
                    }
                }
                'sample_code' {
                    # a dimension continues the client's numbering (SAP-200060, SAP-200061 ...);
                    # a fact gets random numbers of the same width
                    $cw = [int]$col.CodeWidth; $next = [long]$col.CodeMax + 1
                    $maxRand = [long][math]::Min([math]::Pow(10, $cw) - 1, 999999999)
                    for ($i = 0; $i -lt $n; $i++) {
                        if ($isFact) { $vals[$i] = $col.CodePrefix + ([long]($r.NextDouble() * $maxRand)).ToString('D' + $cw, $inv) }
                        elseif ($i -lt $keptSamples[$table]) { $vals[$i] = '' }   # replaced by the sample row later
                        else { $vals[$i] = $col.CodePrefix + $next.ToString('D' + $cw, $inv); $next++ }
                    }
                }
                'blank' { for ($i = 0; $i -lt $n; $i++) { $vals[$i] = '' } }
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

        # The client's share of empty cells (OrderNotes filled in 2 of 3 rows -> about 33% empty)
        $kept = $keptSamples[$table]
        foreach ($col in $cols) {
            if (-not $col.BlankRate -or $col.Lookup -or $col.Hidden -or (& $isKeyCol $col)) { continue }
            $br = New-Rng "$table.$($col.Name)|blank"; $sv = $str[$col.Name]
            for ($i = $kept; $i -lt $n; $i++) { if ($br.NextDouble() -lt $col.BlankRate) { $sv[$i] = '' } }
        }
        # The client's own sample rows go first, exactly as written (a blank key is the only
        # cell that is filled in, so every row stays addressable)
        foreach ($col in $cols) {
            if ($col.Hidden -or -not $col.Samples -or $col.Samples.Count -eq 0 -or $primaryKeyByTable[$table] -eq $col.Name) { continue }
            $sv = $str[$col.Name]
            for ($i = 0; $i -lt $kept; $i++) { $sv[$i] = $col.Samples[$i] }
        }
        # Sample rows that point at something the dimension does not have
        if ($kept -gt 0) {
            foreach ($col in $cols) {
                if ($col.Hidden) { continue }
                $key = "$table.$($col.Name)"
                $target = $null; $targetVals = $null
                if ($foreignKeys.ContainsKey($key) -and $foreignKeys[$key] -ne $table) { $target = $foreignKeys[$key]; $targetVals = $pkPools[$target] }
                elseif ($nameLinks.ContainsKey($key) -and $generated.ContainsKey($nameLinks[$key])) { $target = $nameLinks[$key]; $targetVals = $generated[$target][$col.Lower] }
                if (-not $target) { continue }
                $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
                foreach ($v in $targetVals) { [void]$set.Add([string]$v) }
                $missing = Get-DistinctOrdinal @(for ($i = 0; $i -lt $kept; $i++) { $v = $col.Samples[$i]; if ($v -and -not $set.Contains($v)) { $v } })
                if ($missing.Count) { $sampleWarnings.Add("$table.$($col.Name): $($missing.Count) sample value(s) not found in $target (e.g. '$($missing[0])') - add them to the $target sheet or the link breaks for those rows") }
            }
        }

        $byLower = @{}
        foreach ($col in $cols) { $byLower[$col.Lower] = $str[$col.Name] }
        $generated[$table] = $byLower

        $outCols = @($cols | Where-Object { -not $_.Hidden })
        $colData = New-Object System.Collections.Generic.List[object]
        foreach ($col in $outCols) { $colData.Add($str[$col.Name]) }
        $xlsxSheets.Add(@{ Name = $table; Headers = [string[]]@($outCols | ForEach-Object { $_.Name }); Columns = $colData; Rows = $n })
        if ($Format -eq 'xlsx') { continue }

        # Write CSV (UTF-8 without BOM, comma, LF - same CSV rules as messy-dataset)
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append((($outCols | ForEach-Object { $_.Name }) -join ',')).Append("`n")
        # quote once per column, then join row by row
        $special = [char[]]@(',', '"', "`n", "`r")
        $colArrays = foreach ($col in $outCols) {
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
        $csvPath = Join-Path $OutDir "$table.csv"
        [System.IO.File]::WriteAllText($csvPath, $sb.ToString(), $utf8NoBom)
        $writtenFiles.Add([string](Resolve-Path $csvPath))
    }
}

# ---------------------------------------------------------------------------
# 8b. XLSX: one sheet per table (raw OOXML, no Excel needed). Numbers are numbers, ISO
#     dates are real Excel dates; header row bold, frozen and filtered. Fixed zip
#     timestamps, so the same seed gives a byte-identical file.
# ---------------------------------------------------------------------------

function Get-ColLetter([int]$index) {
    $s = ''; $x = $index + 1
    while ($x -gt 0) { $mod = ($x - 1) % 26; $s = [string][char](65 + $mod) + $s; $x = [int][math]::Floor(($x - 1) / 26) }
    return $s
}

function ConvertTo-XmlText([string]$s) {
    if ($s.IndexOfAny([char[]]@('<', '>', '&', '"', "'")) -lt 0 -and $s -notmatch '[\x00-\x08\x0B\x0C\x0E-\x1F]') { return $s }
    return [System.Security.SecurityElement]::Escape(($s -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ''))
}

function Write-Xlsx([string]$path, $sheetsOut) {
    $ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    $nsR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    $head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + "`n"
    $stamp = New-Object System.DateTimeOffset 2020, 1, 1, 0, 0, 0, ([TimeSpan]::Zero)

    # Excel sheet names: max 31 chars, no []:*?/\ and unique (case-insensitive)
    $used = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($so in $sheetsOut) {
        $base = ($so.Name -replace '[\[\]:\*\?/\\]', '_').Trim("'")
        if (-not $base) { $base = 'Sheet' }
        if ($base.Length -gt 31) { $base = $base.Substring(0, 31) }
        $nm = $base; $k = 2
        while (-not $used.Add($nm)) { $sfx = "_$k"; $nm = $base.Substring(0, [math]::Min($base.Length, 31 - $sfx.Length)) + $sfx; $k++ }
        $so.SheetName = $nm
    }

    if (Test-Path $path) { Remove-Item $path -Force }
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        function Add-ZipText([string]$name, [string]$text) {
            $e = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
            $e.LastWriteTime = $stamp
            $st = $e.Open(); $bytes = $utf8NoBom.GetBytes($text); $st.Write($bytes, 0, $bytes.Length); $st.Dispose()
        }
        $ct = New-Object System.Text.StringBuilder
        [void]$ct.Append($head).Append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>')
        [void]$ct.Append('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
        for ($s = 1; $s -le $sheetsOut.Count; $s++) { [void]$ct.Append("<Override PartName=`"/xl/worksheets/sheet$s.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml`"/>") }
        [void]$ct.Append('</Types>')
        Add-ZipText '[Content_Types].xml' $ct.ToString()
        Add-ZipText '_rels/.rels' ($head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')

        $wbx = New-Object System.Text.StringBuilder; $rels = New-Object System.Text.StringBuilder; $defs = New-Object System.Text.StringBuilder
        [void]$wbx.Append($head).Append("<workbook xmlns=`"$ns`" xmlns:r=`"$nsR`"><bookViews><workbookView activeTab=`"0`"/></bookViews><sheets>")
        [void]$rels.Append($head).Append('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">')
        for ($s = 0; $s -lt $sheetsOut.Count; $s++) {
            $so = $sheetsOut[$s]
            [void]$wbx.Append("<sheet name=`"$(ConvertTo-XmlText $so.SheetName)`" sheetId=`"$($s + 1)`" r:id=`"rId$($s + 1)`"/>")
            [void]$rels.Append("<Relationship Id=`"rId$($s + 1)`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet`" Target=`"worksheets/sheet$($s + 1).xml`"/>")
            $lastRef = '$' + (Get-ColLetter ($so.Headers.Count - 1)) + '$' + ($so.Rows + 1)
            [void]$defs.Append("<definedName name=`"_xlnm._FilterDatabase`" localSheetId=`"$s`" hidden=`"1`">'$(ConvertTo-XmlText ($so.SheetName.Replace("'", "''")))'!`$A`$1:$lastRef</definedName>")
        }
        [void]$wbx.Append('</sheets><definedNames>').Append($defs.ToString()).Append('</definedNames></workbook>')
        [void]$rels.Append("<Relationship Id=`"rId$($sheetsOut.Count + 1)`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles`" Target=`"styles.xml`"/></Relationships>")
        Add-ZipText 'xl/workbook.xml' $wbx.ToString()
        Add-ZipText 'xl/_rels/workbook.xml.rels' $rels.ToString()
        # styles: 0 normal, 1 bold header, 2 date, 3 date + time
        Add-ZipText 'xl/styles.xml' ($head + "<styleSheet xmlns=`"$ns`"><numFmts count=`"2`"><numFmt numFmtId=`"164`" formatCode=`"yyyy-mm-dd`"/><numFmt numFmtId=`"165`" formatCode=`"yyyy-mm-dd hh:mm:ss`"/></numFmts>" +
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
            '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
            '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
            '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')

        $numRe = New-Object regex '^-?(0|[1-9]\d{0,14})(\.\d+)?$'
        $dateRe = New-Object regex '^\d{4}-\d{2}-\d{2}$'
        $dtRe = New-Object regex '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
        $ctrlRe = New-Object regex '[\x00-\x08\x0B\x0C\x0E-\x1F]'
        $xmlSpecial = [char[]]@('<', '>', '&', '"', "'")
        for ($s = 0; $s -lt $sheetsOut.Count; $s++) {
            $so = $sheetsOut[$s]; $nc = $so.Headers.Count; $nr = $so.Rows
            # one type per column: number / date / datetime / text (anything mixed stays text)
            $ctype = New-Object string[] $nc; $letters = New-Object string[] $nc; $widths = New-Object int[] $nc
            for ($j = 0; $j -lt $nc; $j++) {
                $letters[$j] = Get-ColLetter $j
                $colv = $so.Columns[$j]
                $isNum = $true; $isDate = $true; $isDt = $true; $any = $false; $wmax = $so.Headers[$j].Length
                for ($i = 0; $i -lt $nr; $i++) {
                    $v = $colv[$i]; if (-not $v) { continue }; $any = $true
                    if ($isNum -and -not $numRe.IsMatch($v)) { $isNum = $false }
                    if ($isDate -and -not $dateRe.IsMatch($v)) { $isDate = $false }
                    if ($isDt -and -not $dtRe.IsMatch($v)) { $isDt = $false }
                    if ($i -lt 300 -and $v.Length -gt $wmax) { $wmax = $v.Length }
                }
                $ctype[$j] = if (-not $any) { 'text' } elseif ($isNum) { 'num' } elseif ($isDate) { 'date' } elseif ($isDt) { 'datetime' } else { 'text' }
                $widths[$j] = [math]::Min(60, [math]::Max(8, $wmax + 2))
            }
            $sb = New-Object System.Text.StringBuilder
            [void]$sb.Append($head).Append("<worksheet xmlns=`"$ns`" xmlns:r=`"$nsR`"><sheetViews><sheetView workbookViewId=`"0`"$(if ($s -eq 0) { ' tabSelected="1"' })><pane ySplit=`"1`" topLeftCell=`"A2`" activePane=`"bottomLeft`" state=`"frozen`"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight=`"15`"/><cols>")
            for ($j = 0; $j -lt $nc; $j++) { [void]$sb.Append("<col min=`"$($j + 1)`" max=`"$($j + 1)`" width=`"$($widths[$j])`" customWidth=`"1`"/>") }
            [void]$sb.Append('</cols><sheetData><row r="1">')
            for ($j = 0; $j -lt $nc; $j++) { [void]$sb.Append("<c r=`"$($letters[$j])1`" s=`"1`" t=`"inlineStr`"><is><t>$(ConvertTo-XmlText $so.Headers[$j])</t></is></c>") }
            [void]$sb.Append('</row>')
            # cell bodies column by column (one type decision per column, no function call per cell)
            $frag = New-Object 'object[]' $nc
            for ($j = 0; $j -lt $nc; $j++) {
                $colv = $so.Columns[$j]; $fa = New-Object string[] $nr; $ty = $ctype[$j]
                for ($i = 0; $i -lt $nr; $i++) {
                    $v = $colv[$i]
                    if (-not $v) { continue }
                    if ($ty -eq 'num') { $fa[$i] = '"><v>' + $v + '</v></c>' }
                    elseif ($ty -eq 'date') { $fa[$i] = '" s="2"><v>' + [datetime]::ParseExact($v, 'yyyy-MM-dd', $inv).ToOADate().ToString('R', $inv) + '</v></c>' }
                    elseif ($ty -eq 'datetime') { $fa[$i] = '" s="3"><v>' + [datetime]::ParseExact($v, 'yyyy-MM-dd HH:mm:ss', $inv).ToOADate().ToString('R', $inv) + '</v></c>' }
                    else {
                        if ($v.IndexOfAny($xmlSpecial) -ge 0 -or $ctrlRe.IsMatch($v)) { $v = [System.Security.SecurityElement]::Escape($ctrlRe.Replace($v, '')) }
                        $fa[$i] = '" t="inlineStr"><is><t xml:space="preserve">' + $v + '</t></is></c>'
                    }
                }
                $frag[$j] = $fa
            }
            for ($i = 0; $i -lt $nr; $i++) {
                $rn = [string]($i + 2)
                [void]$sb.Append('<row r="').Append($rn).Append('">')
                for ($j = 0; $j -lt $nc; $j++) {
                    $f = $frag[$j][$i]
                    if ($f) { [void]$sb.Append('<c r="').Append($letters[$j]).Append($rn).Append($f) }
                }
                [void]$sb.Append('</row>')
            }
            [void]$sb.Append("</sheetData><autoFilter ref=`"A1:$($letters[$nc - 1])$($nr + 1)`"/></worksheet>")
            Add-ZipText "xl/worksheets/sheet$($s + 1).xml" $sb.ToString()
        }
    } finally {
        $zip.Dispose(); $fs.Dispose()
    }
}

$xlsxName = $null
if ($Format -ne 'csv') {
    $xlsxName = if ($OutName) { $OutName } else { [System.IO.Path]::GetFileNameWithoutExtension($SchemaPath) + '_dummy' }
    if (-not $xlsxName.ToLowerInvariant().EndsWith('.xlsx')) { $xlsxName += '.xlsx' }
}
if (-not $PlanOnly -and $Format -ne 'csv') {
    $xlsxPath = [System.IO.Path]::GetFullPath((Join-Path (Resolve-Path $OutDir).Path $xlsxName))
    if ($xlsxPath -eq [System.IO.Path]::GetFullPath((Resolve-Path $SchemaPath).Path)) { throw "The output would overwrite the schema file $SchemaPath - choose another -OutDir or -OutName" }
    # sheets in schema order, not generation order
    $ordered = @($tableNames | ForEach-Object { $tn = $_; @($xlsxSheets | Where-Object { $_.Name -eq $tn })[0] })
    Write-Xlsx $xlsxPath $ordered
    $writtenFiles.Insert(0, $xlsxPath)
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
        sampleRows  = $keptSamples[$table]
        primaryKey  = $primaryKeyByTable[$table]
        foreignKeys = @($columnsByTable[$table] | ForEach-Object {
                $key = "$table.$($_.Name)"
                if ($nameLinks.ContainsKey($key)) { [ordered]@{ column = $_.Name; references = $nameLinks[$key]; via = 'name' } }
                elseif ($foreignKeys.ContainsKey($key) -and -not $_.Hidden) { [ordered]@{ column = $_.Name; references = $foreignKeys[$key] } }
            })
        columns     = @($columnsByTable[$table] | Where-Object { -not $_.Hidden } | ForEach-Object { [ordered]@{ name = $_.Name; kind = (Get-KindLabel $table $_) } })
    })
}

$result = [ordered]@{
    seed             = $Seed
    locale           = $Locale
    inputShape       = $inputShape
    endDate          = $periodEnd.ToString('yyyy-MM-dd', $inv)
    period           = '{0} .. {1}' -f $periodStart.ToString('yyyy-MM-dd', $inv), $periodEnd.ToString('yyyy-MM-dd', $inv)
    periodFrom       = $periodSource
    outDir           = $(if ($PlanOnly) { $OutDir } else { [string](Resolve-Path $OutDir) })
    format           = $Format
    files            = $(if ($PlanOnly) { @(@($xlsxName) + @($(if ($Format -ne 'xlsx') { $tableNames | ForEach-Object { "$_.csv" } })) | Where-Object { $_ }) } else { @($writtenFiles) })
    planOnly         = [bool]$PlanOnly
    tables           = $tableSummary.ToArray()
    unmatchedColumns = @($unmatched)
    hints            = @($hints)
    sampleWarnings   = @($sampleWarnings)
}
$result | ConvertTo-Json -Depth 6
