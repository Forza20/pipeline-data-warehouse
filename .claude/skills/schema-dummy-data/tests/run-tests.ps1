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
    $callParams = @{ SchemaPath = $schemaPath; OutDir = $outDir }
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

Write-Host ""
Write-Host "=== Results: $passed passed, $failed failed ==="
if ($failed -gt 0) {
    Write-Host ""
    Write-Host "Failures:"
    foreach ($f in $failures) { Write-Host "  - $f" }
}
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
exit ($(if ($failed -gt 0) { 1 } else { 0 }))
