#Requires -Version 5.1
<#
Smoke tests for New-DummyData.ps1, against the fixtures in tests\fixtures.
No external modules (same convention as the rest of this repo's skills).

Run:
  powershell -NoProfile -ExecutionPolicy Bypass -File .claude\skills\schema-dummy-data\tests\run-tests.ps1
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here '..\scripts\New-DummyData.ps1'
$fixtures = Join-Path $here 'fixtures'
$work = Join-Path $here '_work'
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Path $work -Force | Out-Null

$passed = 0
$failed = 0
$failures = New-Object System.Collections.Generic.List[string]

function Assert([bool]$condition, [string]$message) {
    if ($condition) { $script:passed++ }
    else { $script:failed++; $script:failures.Add($message) }
}

function Run-Generator([string]$schemaPath, [string]$outDir, [hashtable]$extraParams = @{}) {
    # CSV unless a test asks for XLSX: the older tests read the CSV files directly
    $callParams = @{ SchemaPath = $schemaPath; OutDir = $outDir; Format = 'csv' }
    foreach ($k in $extraParams.Keys) { $callParams[$k] = $extraParams[$k] }
    $json = & $script @callParams
    return ($json -join "`n") | ConvertFrom-Json
}

Write-Host "=== schema-dummy-data smoke tests ==="

# -- Test 1: basic CSV schema -> roles, keys, row counts, foreign keys -------
$out1 = Join-Path $work 'basic'
$r1 = Run-Generator (Join-Path $fixtures 'schema_basic.csv') $out1 @{ Seed = 42; RowsFact = 10; RowsDim = 4 }

$tCustomer = $r1.tables | Where-Object { $_.table -eq 'dim_customer' }
$tProduct = $r1.tables | Where-Object { $_.table -eq 'dim_product' }
$tOrders = $r1.tables | Where-Object { $_.table -eq 'fact_orders' }

Assert ($tCustomer.role -eq 'dimension') "dim_customer should be classified 'dimension', got '$($tCustomer.role)'"
Assert ($tOrders.role -eq 'fact') "fact_orders should be classified 'fact' (has a date + an amount column), got '$($tOrders.role)'"
Assert ($tCustomer.primaryKey -eq 'customer_id') "dim_customer's primary key should be 'customer_id', got '$($tCustomer.primaryKey)'"
Assert ($tCustomer.rows -eq 4) "dim_customer should have 4 rows (RowsDim), got $($tCustomer.rows)"
Assert ($tOrders.rows -eq 10) "fact_orders should have 10 rows (RowsFact), got $($tOrders.rows)"
$ordersFks = @($tOrders.foreignKeys | ForEach-Object { $_.column })
Assert (($ordersFks -contains 'customer_id') -and ($ordersFks -contains 'product_id')) "fact_orders should have foreign keys on customer_id and product_id, got: $($ordersFks -join ', ')"
Assert (-not ($r1.unmatchedColumns -contains 'dim_product.product_name')) "dim_product.product_name should get product names from the word bank (not unmatched), got: $($r1.unmatchedColumns -join ', ')"
Assert ($tOrders.primaryKey -eq 'order_id') "fact_orders's primary key should be 'order_id' (fact_ prefix stripped), got '$($tOrders.primaryKey)'"

# -- Test 2: CSV files are actually written, with the right header and row count
$customerCsv = Join-Path $out1 'dim_customer.csv'
$ordersCsv = Join-Path $out1 'fact_orders.csv'
Assert (Test-Path $customerCsv) "dim_customer.csv should exist in the output folder"
Assert (Test-Path $ordersCsv) "fact_orders.csv should exist in the output folder"
if (Test-Path $customerCsv) {
    $lines = Get-Content $customerCsv -Encoding UTF8
    Assert ($lines[0] -eq 'customer_id,customer_name,email,city,country') "dim_customer.csv header should match the schema's column order, got '$($lines[0])'"
    Assert ($lines.Count -eq 5) "dim_customer.csv should have 1 header + 4 data rows, got $($lines.Count) lines"
}
if (Test-Path $ordersCsv) {
    $orderLines = Get-Content $ordersCsv -Encoding UTF8
    $firstDataRow = $orderLines[1] -split ','
    $custId = [int]$firstDataRow[2]
    $prodId = [int]$firstDataRow[3]
    Assert ($custId -ge 1 -and $custId -le 4) "fact_orders.customer_id should sample from dim_customer's 4 generated keys (1-4), got $custId"
    Assert ($prodId -ge 1 -and $prodId -le 4) "fact_orders.product_id should sample from dim_product's 4 generated keys (1-4), got $prodId"
}

# -- Test 3: Danish characters round-trip correctly (UTF-8, no BOM mojibake) -
$out3 = Join-Path $work 'danish'
Run-Generator (Join-Path $fixtures 'schema_basic.csv') $out3 @{ Seed = 1; Locale = 'da'; RowsDim = 30 } | Out-Null
$customerText = Get-Content (Join-Path $out3 'dim_customer.csv') -Raw -Encoding UTF8
Assert ($customerText -notmatch 'Ã[¸¦¥]') "Danish letters (æøå) must not come out as mojibake (Ã¸/Ã¦/Ã¥) - check the .ps1 file still has a UTF-8 BOM"
Assert ($customerText -match 'København|Aarhus|Odense|Århus|Næstved|Søren|Lars Sørensen|Sørensen' ) "a 30-row Danish run should contain at least one of the known Danish city/surname fixtures"

# -- Test 4: determinism - same seed, byte-identical files --------------------
$outA = Join-Path $work 'det_a'
$outB = Join-Path $work 'det_b'
Run-Generator (Join-Path $fixtures 'schema_basic.csv') $outA @{ Seed = 7; RowsFact = 15; RowsDim = 5 } | Out-Null
Run-Generator (Join-Path $fixtures 'schema_basic.csv') $outB @{ Seed = 7; RowsFact = 15; RowsDim = 5 } | Out-Null
$hashA = (Get-FileHash (Join-Path $outA 'fact_orders.csv')).Hash
$hashB = (Get-FileHash (Join-Path $outB 'fact_orders.csv')).Hash
Assert ($hashA -eq $hashB) "same seed should produce byte-identical fact_orders.csv (got different hashes: $hashA vs $hashB)"

# -- Test 5: semicolon-delimited schema (Danish Excel CSV export) -----------
$out5 = Join-Path $work 'semicolon'
$r5 = Run-Generator (Join-Path $fixtures 'schema_semicolon.csv') $out5 @{ Seed = 5; RowsFact = 6; RowsDim = 3 }
$tRegion = $r5.tables | Where-Object { $_.table -eq 'dim_region' }
$tSales = $r5.tables | Where-Object { $_.table -eq 'fact_sales' }
Assert ($null -ne $tRegion) "semicolon-delimited schema should still be parsed into tables (dim_region missing)"
Assert ($tRegion.rows -eq 3) "dim_region should get 3 rows (RowsDim) from the semicolon schema, got $($tRegion.rows)"
Assert ($tSales.primaryKey -eq 'sale_id') "fact_sales's primary key should be 'sale_id' from the semicolon schema, got '$($tSales.primaryKey)'"

# -- Test 6: a business key named after its table (region_code on dim_region)
#    becomes the key, and the fact's region_code links to it --------------
Assert ($tRegion.primaryKey -eq 'region_code') "dim_region has no id column; its business key region_code should be the primary key, got '$($tRegion.primaryKey)'"
Assert ($tSales.foreignKeys.GetType().IsArray) "foreignKeys must be a JSON array even with a single foreign key"
Assert ((@($tSales.foreignKeys)[0].references) -eq 'dim_region') "fact_sales.region_code should reference dim_region, got '$(@($tSales.foreignKeys)[0].references)'"
$salesCsv = Join-Path $out5 'fact_sales.csv'
Assert (Test-Path $salesCsv) "fact_sales.csv should be written"
if (Test-Path $salesCsv) {
    $salesLines = Get-Content $salesCsv -Encoding UTF8
    Assert ($salesLines.Count -eq 7) "fact_sales.csv should have 1 header + 6 data rows, got $($salesLines.Count) lines"
    $regionCodes = @(Import-Csv (Join-Path $out5 'dim_region.csv') -Encoding UTF8 | ForEach-Object { $_.region_code })
    $badCodes = @(Import-Csv $salesCsv -Encoding UTF8 | Where-Object { $regionCodes -notcontains $_.region_code })
    Assert ($badCodes.Count -eq 0) "every fact_sales.region_code should exist in dim_region ($($badCodes.Count) orphans)"
}

# -- Test 7: XLSX schema input (first sheet, Danish headers tabel/kolonne) --
$out7 = Join-Path $work 'xlsx'
$r7 = Run-Generator (Join-Path $fixtures 'schema_basic.xlsx') $out7 @{ Seed = 3; RowsFact = 6; RowsDim = 3 }
$tKunde = $r7.tables | Where-Object { $_.table -eq 'dim_kunde' }
$tSalg = $r7.tables | Where-Object { $_.table -eq 'fact_salg' }
Assert ($null -ne $tKunde) "XLSX schema (tabel/kolonne headers) should produce a dim_kunde table"
Assert ($tKunde.primaryKey -eq 'kunde_id') "dim_kunde's primary key from the XLSX schema should be 'kunde_id', got '$($tKunde.primaryKey)'"
Assert ($tSalg.role -eq 'fact') "fact_salg (dato + beløb) should be classified 'fact' from the XLSX schema, got '$($tSalg.role)'"
$kundeFile = Join-Path $out7 'dim_kunde.csv'
if (Test-Path $kundeFile) {
    $kundeText = Get-Content $kundeFile -Raw -Encoding UTF8
    Assert ($kundeText -notmatch 'Ã[¸¦¥]') "the XLSX-sourced 'beløb'/Danish-name columns must decode without mojibake"
}

# -- Test 8: -PlanOnly writes no files -----------------------------------
$out8 = Join-Path $work 'planonly'
Run-Generator (Join-Path $fixtures 'schema_basic.csv') $out8 @{ Seed = 1; PlanOnly = $true } | Out-Null
Assert (-not (Test-Path (Join-Path $out8 'dim_customer.csv'))) "-PlanOnly should not write any CSV files"

# -- Test 9: realism - keys, lookups, derived numbers, dates, people, examples --
$out9 = Join-Path $work 'realism'
$r9 = Run-Generator (Join-Path $fixtures 'schema_realism.csv') $out9 @{ Seed = 11; RowsFact = 400; RowsDim = 25; EndDate = '2026-10-31' }
$tFact = $r9.tables | Where-Object { $_.table -eq 'fact_sales' }
$tDate = $r9.tables | Where-Object { $_.table -eq 'dim_date' }
Assert ($tFact.primaryKey -eq 'sale_id') "fact_sales's key should be sale_id even though customer_id comes first, got '$($tFact.primaryKey)'"
$factFks = @($tFact.foreignKeys | ForEach-Object { "$($_.column)->$($_.references)" })
foreach ($fk in @('customer_id->dim_customer', 'product_id->dim_product', 'employee_id->dim_employee', 'date_key->dim_date')) {
    Assert ($factFks -contains $fk) "fact_sales should have foreign key $fk, got: $($factFks -join ', ')"
}
$empFks = @(($r9.tables | Where-Object { $_.table -eq 'dim_employee' }).foreignKeys | ForEach-Object { "$($_.column)->$($_.references)" })
Assert ($empFks -contains 'manager_id->dim_employee') "dim_employee.manager_id should be a self-reference, got: $($empFks -join ', ')"
Assert ($tDate.role -eq 'date' -and $tDate.rows -eq 730) "dim_date should be a date table with one row per day of the 2-year period (730), got role '$($tDate.role)', $($tDate.rows) rows"
Assert (@($r9.unmatchedColumns).Count -eq 0) "the realism schema should have no unmatched columns, got: $($r9.unmatchedColumns -join ', ')"

$inv = [System.Globalization.CultureInfo]::InvariantCulture
$facts = @(Import-Csv (Join-Path $out9 'fact_sales.csv') -Encoding UTF8)
$products = @{}; Import-Csv (Join-Path $out9 'dim_product.csv') -Encoding UTF8 | ForEach-Object { $products[$_.product_id] = $_ }
$badTotal = 0; $badLookup = 0; $badProfit = 0; $badCost = 0; $badShip = 0; $badKey = 0; $outOfPeriod = 0
foreach ($f in $facts) {
    $q = [double]::Parse($f.quantity, $inv); $p = [double]::Parse($f.unit_price, $inv); $d = [double]::Parse($f.discount_pct, $inv)
    $t = [double]::Parse($f.total_amount, $inv); $c = [double]::Parse($f.cost, $inv); $pr = [double]::Parse($f.profit, $inv)
    if ([math]::Abs($t - [math]::Round($q * $p * (1 - $d / 100), 2)) -gt 0.011) { $badTotal++ }
    if ($products[$f.product_id].unit_price -ne $f.unit_price) { $badLookup++ }
    if ([math]::Abs($pr - ($t - $c)) -gt 0.011) { $badProfit++ }
    if ($t -gt 0 -and ($c / $t -lt 0.44 -or $c / $t -gt 0.76)) { $badCost++ }
    if ($f.ship_date -lt $f.order_date) { $badShip++ }
    if ($f.date_key -ne $f.order_date.Replace('-', '')) { $badKey++ }
    if ($f.order_date -lt '2024-11-01' -or $f.order_date -gt '2026-10-31') { $outOfPeriod++ }
}
Assert ($badTotal -eq 0) "total_amount should equal quantity x unit_price x (1 - discount) on every row ($badTotal rows off)"
Assert ($badLookup -eq 0) "fact_sales.unit_price should be copied from dim_product.unit_price of the same product ($badLookup rows off)"
Assert ($badProfit -eq 0) "profit should equal total_amount - cost ($badProfit rows off)"
Assert ($badCost -eq 0) "cost should be 45-75% of total_amount ($badCost rows off)"
Assert ($badShip -eq 0) "ship_date should never be before order_date ($badShip rows off)"
Assert ($badKey -eq 0) "date_key should be the row's order_date as yyyyMMdd ($badKey rows off)"
Assert ($outOfPeriod -eq 0) "order_date should stay within 2024-11-01..2026-10-31 ($outOfPeriod rows outside)"
$firstHalf = @($facts | Where-Object { $_.order_date -lt '2025-11-01' }).Count
Assert ($firstHalf -lt ($facts.Count - $firstHalf)) "fact dates should grow over time (first year $firstHalf rows vs. second year $($facts.Count - $firstHalf))"
Assert (@($facts | Where-Object { $_.created_by -notmatch '^\S+ \S+$' }).Count -eq 0) "created_by should be a person's 'First Last' name, not a date"
Assert (@($facts | Where-Object { $_.store_name -notlike 'Butik *' }).Count -eq 0) "store_name should be a store ('Butik <city>'), not a person"
Assert (@($facts | Where-Object { $_.order_ref -notmatch '^SO-\d{5}$' }).Count -eq 0) "order_ref should follow its example pattern SO-#####"

$emps = @(Import-Csv (Join-Path $out9 'dim_employee.csv') -Encoding UTF8)
$badMgr = @($emps | Where-Object { $_.manager_id -and ([int]$_.manager_id -ge [int]$_.employee_id) })
Assert ($badMgr.Count -eq 0) "manager_id should be empty or point to an earlier employee ($($badMgr.Count) rows off)"
Assert (@($emps | Where-Object { @('Sælger', 'Konsulent', 'Chef') -notcontains $_.job_title }).Count -eq 0) "job_title should only use its example values (and decode æ correctly)"

$custs = @(Import-Csv (Join-Path $out9 'dim_customer.csv') -Encoding UTF8)
$badMail = @($custs | Where-Object { $_.email -ne (($_.customer_name.ToLowerInvariant().Replace('æ', 'ae').Replace('ø', 'oe').Replace('å', 'aa').Replace(' ', '.')) + '@example.com') })
Assert ($badMail.Count -eq 0) "email should match customer_name on the same row ($($badMail.Count) rows off)"
Assert (@($custs | Select-Object -ExpandProperty customer_name -Unique).Count -eq $custs.Count) "customer names in a dimension should be distinct"
$dates = @(Import-Csv (Join-Path $out9 'dim_date.csv') -Encoding UTF8)
Assert ($dates[0].date -eq '2024-11-01' -and $dates[-1].date -eq '2026-10-31' -and $dates[0].date_key -eq '20241101' -and $dates[0].month_name -eq 'november') "dim_date should run day by day 2024-11-01..2026-10-31 with matching key and Danish month name"

# -- Test 10: English locale keeps city and country on the same row consistent --
$out10 = Join-Path $work 'english'
Run-Generator (Join-Path $fixtures 'schema_realism.csv') $out10 @{ Seed = 3; Locale = 'en'; RowsFact = 20; RowsDim = 40; EndDate = '2026-10-31' } | Out-Null
$enCusts = @(Import-Csv (Join-Path $out10 'dim_customer.csv') -Encoding UTF8)
$expectedCountry = @{ 'London' = 'United Kingdom'; 'Berlin' = 'Germany'; 'New York' = 'United States'; 'Sydney' = 'Australia'; 'Toronto' = 'Canada'; 'Paris' = 'France' }
$badCountry = @($enCusts | Where-Object { $expectedCountry.ContainsKey($_.city) -and $expectedCountry[$_.city] -ne $_.country })
Assert ($badCountry.Count -eq 0) "country should match city on the same row ($($badCountry.Count) rows off)"

# -- Test 11: adding a column does not reshuffle the other columns ----------
$schemaPlus = Join-Path $work 'schema_plus.csv'
$basicLines = Get-Content (Join-Path $fixtures 'schema_basic.csv') -Encoding UTF8
$plusLines = @($basicLines[0..2]) + @('dim_customer,phone,string') + @($basicLines[3..($basicLines.Count - 1)])
[System.IO.File]::WriteAllLines($schemaPlus, [string[]]$plusLines)
$outP = Join-Path $work 'plus'
Run-Generator $schemaPlus $outP @{ Seed = 7; RowsFact = 15; RowsDim = 5 } | Out-Null
$amountsA = (Import-Csv (Join-Path $outA 'fact_orders.csv') | ForEach-Object { $_.amount }) -join ','
$amountsP = (Import-Csv (Join-Path $outP 'fact_orders.csv') | ForEach-Object { $_.amount }) -join ','
Assert ($amountsA -eq $amountsP) "adding a column to dim_customer must not change fact_orders.amount for the same seed"

# -- Test 12-15: sheet-per-table XLSX with the client's sample rows ----------
# Built here (no binary fixture): inline strings, plain numbers and a date+time cell
# stored the way Excel stores it (serial number + date style), so the reader's date
# conversion is tested too. All values are made up.
function New-TestXlsx([string]$path, $sheetDefs) {
    Add-Type -AssemblyName System.IO.Compression
    $ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    $enc = New-Object System.Text.UTF8Encoding($false)
    $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Create)
    $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    function Add-Part([string]$name, [string]$text) { $st = $zip.CreateEntry($name).Open(); $b = $enc.GetBytes($text); $st.Write($b, 0, $b.Length); $st.Dispose() }
    $over = ''; $sheetsXml = ''; $relsXml = ''
    for ($s = 1; $s -le $sheetDefs.Count; $s++) {
        $over += "<Override PartName=`"/xl/worksheets/sheet$s.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml`"/>"
        $sheetsXml += "<sheet name=`"$($sheetDefs[$s - 1].Name)`" sheetId=`"$s`" r:id=`"rId$s`"/>"
        $relsXml += "<Relationship Id=`"rId$s`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet`" Target=`"worksheets/sheet$s.xml`"/>"
    }
    Add-Part '[Content_Types].xml' "<Types xmlns=`"http://schemas.openxmlformats.org/package/2006/content-types`"><Default Extension=`"rels`" ContentType=`"application/vnd.openxmlformats-package.relationships+xml`"/><Default Extension=`"xml`" ContentType=`"application/xml`"/><Override PartName=`"/xl/workbook.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml`"/><Override PartName=`"/xl/styles.xml`" ContentType=`"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml`"/>$over</Types>"
    Add-Part '_rels/.rels' '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    Add-Part 'xl/workbook.xml' "<workbook xmlns=`"$ns`" xmlns:r=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships`"><sheets>$sheetsXml</sheets></workbook>"
    Add-Part 'xl/_rels/workbook.xml.rels' "<Relationships xmlns=`"http://schemas.openxmlformats.org/package/2006/relationships`">$relsXml<Relationship Id=`"rId99`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles`" Target=`"styles.xml`"/></Relationships>"
    Add-Part 'xl/styles.xml' "<styleSheet xmlns=`"$ns`"><cellXfs count=`"2`"><xf numFmtId=`"0`"/><xf numFmtId=`"22`" applyNumberFormat=`"1`"/></cellXfs></styleSheet>"
    for ($s = 1; $s -le $sheetDefs.Count; $s++) {
        $rowsXml = ''; $rn = 0
        foreach ($rowVals in $sheetDefs[$s - 1].Rows) {
            $rn++; $rowsXml += "<row r=`"$rn`">"
            for ($j = 0; $j -lt $rowVals.Count; $j++) {
                $v = $rowVals[$j]; $ref = [string][char](65 + $j) + $rn
                if ($null -eq $v -or $v -eq '') { continue }
                if ($v -is [datetime]) { $rowsXml += "<c r=`"$ref`" s=`"1`"><v>$($v.ToOADate().ToString('R', [cultureinfo]::InvariantCulture))</v></c>" }
                elseif ($v -is [double] -or $v -is [int]) { $rowsXml += "<c r=`"$ref`"><v>$(([double]$v).ToString('R', [cultureinfo]::InvariantCulture))</v></c>" }
                else { $rowsXml += "<c r=`"$ref`" t=`"inlineStr`"><is><t>$([System.Security.SecurityElement]::Escape([string]$v))</t></is></c>" }
            }
            $rowsXml += '</row>'
        }
        Add-Part "xl/worksheets/sheet$s.xml" "<worksheet xmlns=`"$ns`"><sheetData>$rowsXml</sheetData></worksheet>"
    }
    $zip.Dispose(); $fs.Dispose()
}

$hex = @('40181c6e9a8cfa3c5283aac7bc0a6a5d', 'd248a9a7ac1aa554c3c75611ffe3fa49', '7135f221a6c9537f84dad06a7872bdeb', '5913f9d3785299f4175ba98df8140102', '6961929e546e035a292bd156db946570', '0964fbbf8cd321b0c2b01cfdd045dd1c')
$custRows = @(
    , @('CustomerID', 'CustomerName', 'Segment', 'AccountManager', 'PaymentTerms', 'hash_key', 'source_id')
    , @(1001, 'Meridian Group', 'Enterprise', 'Sarah Lin', 'Net 30', $hex[0], 'SAP-200000')
    , @(1002, 'Cascade Industries', 'Mid-Market', 'Tom Reyes', 'Net 60', $hex[1], 'SAP-200001')
    , @(1003, 'Nova Retail', 'SMB', 'Mei Chen', 'Net 15', $hex[2], 'SAP-200002')
    , @(1004, 'Atlas Holdings', 'Mid-Market', 'Sarah Lin', 'Prepaid', $hex[3], 'SAP-200003')
    , @(1005, 'Zenith Partners', 'Enterprise', 'Tom Reyes', 'Net 30', $hex[4], 'SAP-200004')
    , @(1006, 'Apex Trading', 'Mid-Market', 'Mei Chen', 'Net 30', $hex[5], 'SAP-200005')
)
$ordRows = @(
    , @('OrderID', 'CustomerName', 'CustomerCity', 'RegionName', 'ShipToCity', 'OrderDate', 'OrderChannel', 'Status', 'Priority', 'OrderTotal', 'OrderNotes', 'GiftMessage')
    , @('ORD00001', 'Meridian Group', 'London', 'Europe', 'Paris', (Get-Date '2026-01-15 10:30:00'), 10, 'Delivered', 'Standard|Express', 1250.5, 'Fragile items, add extra padding and mark the box.', '')
    , @('ORD00002', 'Nova Retail', 'Berlin', 'Europe', 'Berlin', (Get-Date '2026-02-03 14:05:00'), 20, 'Shipped', '', 980, '', '')
    , @('ORD00003', 'Atlas Holdings', 'Toronto', 'North America', 'Chicago', (Get-Date '2026-03-21 09:12:00'), 10, 'Delivered', '', 15000.75, 'Customer asked for delivery before noon.', '')
    , @('ORD00004', 'Meridian Group', 'London', 'Europe', 'London', (Get-Date '2026-04-09 16:45:00'), 10, 'Processing', '', 4300.2, '', '')
    , @('ORD00005', 'Zenith Partners', 'Sydney', 'Asia Pacific', 'Sydney', (Get-Date '2026-05-30 11:00:00'), 20, 'Delivered', '', 2210, 'Fragile items, add extra padding and mark the box.', '')
    , @('ORD00006', 'Apex Trading', 'Madrid', 'Europe', 'Madrid', (Get-Date '2026-07-14 13:20:00'), 10, 'Shipped', '', 7600.4, 'Customer asked for delivery before noon.', '')
    , @('ORD00007', 'Cascade Industries', 'Paris', 'Europe', 'Amsterdam', (Get-Date '2026-08-02 08:50:00'), 20, 'Delivered', '', 3150, 'Fragile items, add extra padding and mark the box.', '')
    , @('ORD00008', 'Unknown Ltd', 'Chicago', 'North America', 'Chicago', (Get-Date '2026-09-20 15:35:00'), 10, 'Delivered', '', 5400, '', '')
)
$wideXlsx = Join-Path $work 'wide_samples.xlsx'
New-TestXlsx $wideXlsx @(@{ Name = 'CUST_MASTER'; Rows = $custRows }, @{ Name = 'ORDERS_2026'; Rows = $ordRows })

$out12 = Join-Path $work 'wide'
$r12 = Run-Generator $wideXlsx $out12 @{ Seed = 21; Locale = 'en'; RowsFact = 300; RowsDim = 25; Format = 'both'; KeepSampleRows = $true }
$tc = $r12.tables | Where-Object { $_.table -eq 'CUST_MASTER' }
$to = $r12.tables | Where-Object { $_.table -eq 'ORDERS_2026' }
Assert ($r12.inputShape -eq 'sheet-per-table') "a workbook without table/column headers should be read as one sheet per table, got '$($r12.inputShape)'"
Assert ($tc.role -eq 'dimension' -and $to.role -eq 'fact') "CUST_MASTER should be a dimension and ORDERS_2026 a fact, got '$($tc.role)' / '$($to.role)'"
Assert ($tc.sampleRows -eq 6 -and $to.sampleRows -eq 8 -and $tc.rows -eq 25 -and $to.rows -eq 300) "sample rows 6/8 and row counts 25/300 expected, got $($tc.sampleRows)/$($to.sampleRows) and $($tc.rows)/$($to.rows)"
$nameFk = @($to.foreignKeys)[0]
Assert ($nameFk.column -eq 'CustomerName' -and $nameFk.references -eq 'CUST_MASTER' -and $nameFk.via -eq 'name') "ORDERS_2026 has no CustomerID, so CustomerName should link to CUST_MASTER by name"
Assert ($r12.period -eq '2026-01-01 .. 2026-09-30' -and $r12.periodFrom -eq 'sample rows') "the period should come from the sample order dates (Jan-Sep 2026), got '$($r12.period)' from '$($r12.periodFrom)'"
Assert (@($r12.sampleWarnings | Where-Object { $_ -like '*Unknown Ltd*' }).Count -eq 1) "a sample order whose customer is not in CUST_MASTER should be reported, got: $($r12.sampleWarnings -join ' / ')"
Assert (@($r12.files | Where-Object { $_ -like '*wide_samples_dummy.xlsx' }).Count -eq 1) "Format both should write <schema>_dummy.xlsx, got: $($r12.files -join ', ')"

$cust = @(Import-Csv (Join-Path $out12 'CUST_MASTER.csv') -Encoding UTF8)
$ord = @(Import-Csv (Join-Path $out12 'ORDERS_2026.csv') -Encoding UTF8)
Assert ($cust[0].CustomerName -eq 'Meridian Group' -and $cust[5].source_id -eq 'SAP-200005' -and $ord[0].OrderID -eq 'ORD00001' -and $ord[0].Priority -eq 'Standard|Express') "the client's sample rows should be the first rows, exactly as written"
Assert ($ord[0].OrderDate -eq '2026-01-15 10:30:00') "a date+time cell stored as an Excel serial should be read back as '2026-01-15 10:30:00', got '$($ord[0].OrderDate)'"
$genCust = @($cust | Select-Object -Skip 6); $genOrd = @($ord | Select-Object -Skip 8)
Assert ($genCust[0].CustomerID -eq '1007' -and @($cust | Select-Object -ExpandProperty CustomerID -Unique).Count -eq 25) "generated CustomerIDs should continue after the samples (1007 ...) and stay unique"
Assert ($genCust[0].source_id -eq 'SAP-200006' -and @($cust | Select-Object -ExpandProperty source_id -Unique).Count -eq 25) "source_id should continue the sample numbering (SAP-200006 ...) and stay unique"
Assert (@($genCust | Where-Object { $_.hash_key -notmatch '^[0-9a-f]{32}$' }).Count -eq 0) "hash_key should be 32 lower-case hex characters like the samples"
Assert (@($cust | Select-Object -ExpandProperty CustomerName -Unique).Count -eq 25) "customer names should be distinct, including against the sample names"
Assert (@($genCust | Where-Object { $_.CustomerName -notmatch ' (Group|Industries|Retail|Holdings|Partners|Trading)( \d+)?$' }).Count -eq 0) "generated company names should reuse the samples' suffixes (Group, Holdings ...)"
Assert (@($genCust | Where-Object { @('Enterprise', 'Mid-Market', 'SMB') -notcontains $_.Segment }).Count -eq 0) "Segment should only use the sample values"
Assert ($genOrd[0].OrderID -eq 'ORD00009' -and @($ord | Select-Object -ExpandProperty OrderID -Unique).Count -eq 300) "OrderID should continue the sample format (ORD00009 ...) and stay unique, got '$($genOrd[0].OrderID)'"
$custNames = @{}; foreach ($c in $cust) { $custNames[$c.CustomerName] = $true }
Assert (@($genOrd | Where-Object { -not $custNames.ContainsKey($_.CustomerName) }).Count -eq 0) "every generated order's CustomerName should exist in CUST_MASTER (name link)"
Assert (@($genOrd | Where-Object { $_.OrderDate -notmatch '^2026-0[1-9]-\d{2} (0[89]|1[0-7]):\d{2}:\d{2}$' }).Count -eq 0) "generated OrderDate should be Jan-Sep 2026 with a working-hours time, like the samples"
Assert (@($genOrd | Where-Object { @('10', '20') -notcontains $_.OrderChannel }).Count -eq 0) "OrderChannel should only use the sample codes 10/20"
Assert (@($genOrd | Where-Object { @('Standard', 'Express') -notcontains $_.Priority }).Count -eq 0) "Priority should use the 'Standard|Express' list, never empty"
Assert (@($genOrd | Where-Object { @('Delivered', 'Shipped', 'Processing') -notcontains $_.Status }).Count -eq 0) "Status should only use the sample values"
Assert (@($genOrd | Where-Object { [double]::Parse($_.OrderTotal, $inv) -lt 980 -or [double]::Parse($_.OrderTotal, $inv) -gt 15000.75 }).Count -eq 0) "OrderTotal should stay within the sample range 980..15000.75"
Assert (@($ord | Where-Object { $_.GiftMessage }).Count -eq 0) "GiftMessage is empty in every sample row, so it should stay empty"
$emptyNotes = @($genOrd | Where-Object { -not $_.OrderNotes }).Count
Assert ($emptyNotes -gt 0 -and $emptyNotes -lt $genOrd.Count) "OrderNotes is empty in 3 of 8 samples, so some (not all) generated notes should be empty, got $emptyNotes of $($genOrd.Count)"
Assert (@($genOrd | Where-Object { $_.ShipToCity -ne $_.CustomerCity }).Count -gt 0) "ShipToCity should not always equal CustomerCity"
$regionOf = @{ 'London' = 'Europe'; 'Berlin' = 'Europe'; 'New York' = 'North America'; 'Chicago' = 'North America'; 'Sydney' = 'Asia Pacific'; 'Toronto' = 'North America' }
Assert (@($genOrd | Where-Object { $regionOf.ContainsKey($_.CustomerCity) -and $regionOf[$_.CustomerCity] -ne $_.RegionName }).Count -eq 0) "RegionName should follow CustomerCity (the row's first city), not ShipToCity"
Assert (@(Get-ChildItem $out12 -Filter '*.csv' | Where-Object { (Get-Content $_.FullName -TotalCount 1) -like '*__link*' }).Count -eq 0) "the hidden name-link key must not be written out"

# -- Test 13: the XLSX itself - one sheet per table, typed cells, deterministic --
$xlsxOut = Join-Path $out12 'wide_samples_dummy.xlsx'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($xlsxOut)
function Get-ZipText($zp, $name) { $sr = New-Object System.IO.StreamReader($zp.GetEntry($name).Open()); try { $sr.ReadToEnd() } finally { $sr.Dispose() } }
$wbText = Get-ZipText $z 'xl/workbook.xml'; $s2 = Get-ZipText $z 'xl/worksheets/sheet2.xml'
$z.Dispose()
Assert ($wbText -match 'name="CUST_MASTER"' -and $wbText -match 'name="ORDERS_2026"') "the XLSX should have a sheet per table, named after the table"
Assert (([regex]::Matches($s2, '<row ')).Count -eq 301) "the ORDERS_2026 sheet should have 1 header + 300 rows"
Assert ($s2 -match '<c r="F2" s="3"><v>46037\.4375</v></c>') "OrderDate should be a real Excel date+time cell (serial 46037.4375 = 2026-01-15 10:30)"
Assert ($s2 -match '<c r="J2"><v>1250\.5</v></c>') "OrderTotal should be a number cell, not text"
$out12b = Join-Path $work 'wide_b'
Run-Generator $wideXlsx $out12b @{ Seed = 21; Locale = 'en'; RowsFact = 300; RowsDim = 25; Format = 'xlsx'; KeepSampleRows = $true } | Out-Null
Assert ((Get-FileHash $xlsxOut).Hash -eq (Get-FileHash (Join-Path $out12b 'wide_samples_dummy.xlsx')).Hash) "same seed should give a byte-identical XLSX"
Assert (@(Get-ChildItem $out12b -Filter '*.csv').Count -eq 0) "Format xlsx (the default) should write no CSV files"

# -- Test 14: default - inspiration only, none of the client's rows --
$out14 = Join-Path $work 'wide_exclude'
Run-Generator $wideXlsx $out14 @{ Seed = 21; Locale = 'en'; RowsFact = 50; RowsDim = 10 } | Out-Null
$cust14 = @(Import-Csv (Join-Path $out14 'CUST_MASTER.csv') -Encoding UTF8)
$ord14 = @(Import-Csv (Join-Path $out14 'ORDERS_2026.csv') -Encoding UTF8)
Assert ($cust14[0].CustomerID -eq '1001' -and $ord14[0].OrderID -eq 'ORD00001') "without sample rows the key format should start where the samples start (1001, ORD00001)"
Assert (@($cust14 | Where-Object { @('Meridian Group', 'Cascade Industries', 'Nova Retail') -contains $_.CustomerName }).Count -eq 0 -and $cust14.Count -eq 10) "by default the skill should leave out the client's rows"

# -- Test 15: headers only (no sample rows) behaves like a schema without examples --
$headersOnly = Join-Path $work 'headers_only.xlsx'
New-TestXlsx $headersOnly @(@{ Name = 'CUST_MASTER'; Rows = @(, $custRows[0]) }, @{ Name = 'ORDERS_2026'; Rows = @(, $ordRows[0]) })
$r15 = Run-Generator $headersOnly (Join-Path $work 'headers_only') @{ Seed = 2; Locale = 'en'; RowsFact = 40; RowsDim = 8; PlanOnly = $true }
$cols15 = @(($r15.tables | Where-Object { $_.table -eq 'ORDERS_2026' }).columns)
Assert ((@($cols15 | Where-Object { $_.name -eq 'OrderDate' })[0].kind) -eq 'date' -and (@($cols15 | Where-Object { $_.name -eq 'Status' })[0].kind) -eq 'status') "with headers only, kinds come from the column names (OrderDate=date, Status=status)"
Assert (@($r15.tables | Where-Object { $_.sampleRows -ne 0 }).Count -eq 0) "a headers-only workbook has no sample rows"

Write-Host ""
Write-Host "=== Results: $passed passed, $failed failed ==="
if ($failed -gt 0) {
    Write-Host ""
    Write-Host "Failures:"
    foreach ($f in $failures) { Write-Host "  - $f" }
}
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
exit ($(if ($failed -gt 0) { 1 } else { 0 }))
