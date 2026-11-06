#requires -Version 5.1
<#
.SYNOPSIS
  Generates a deliberately messy, deterministic dataset with a known answer key (messy-dataset skill).

.DESCRIPTION
  All randomness comes from one System.Random($Seed). The same parameters always give byte-identical
  files. Dataset files (CSV + DATA_DICTIONARY.md + ENTITY_RELATIONSHIP_SUMMARY.md) go to -OutDir; the
  answer key (expected_findings.json + expected_values.json) goes to -AnswersDir and nowhere else.
  The seed always picks a domain and an error set first; -Domain and -Errors override them.

.PARAMETER Errors
  Error types from references/error-catalog.md, e.g. 1,3,5 (a string "1,3,5" also works when called
  with powershell -File). "none" gives a clean dataset. Default: 7-10 types chosen from the seed.

.PARAMETER Currency
  ISO currency code of all amounts (labels in the data dictionary and the "1234.50 <code>" amount
  format), e.g. USD, EUR, GBP, DKK. Default USD. It does not change the generated numbers.

.EXAMPLE
  .\New-MessyDataset.ps1 -Domain hotel -Seed 42 -Currency EUR -OutDir .\out\runs\x -AnswersDir .\out\answers\x

.EXAMPLE
  .\New-MessyDataset.ps1 -Seed 42 -PlanOnly      # prints the domain and errors the seed picks (JSON)
#>
[CmdletBinding()]
param(
    [ValidateSet('retail', 'hotel', 'saas')]
    [string]$Domain,
    [int]$Seed,
    [ValidateRange(200, 500000)]
    [int]$Rows = 20000,
    [string[]]$Errors,
    [string]$OutDir,
    [string]$AnswersDir,
    [string]$RunId,
    [ValidatePattern('^\d{4}-\d{2}$')]
    [string]$EndMonth = '2026-09',
    [ValidatePattern('^[A-Z]{3}$')]
    [string]$Currency = 'USD',
    [switch]$PlanOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$GeneratorVersion = '1.2.0'
$inv = [Globalization.CultureInfo]::InvariantCulture
$euNum = New-Object Globalization.NumberFormatInfo
$euNum.NumberDecimalSeparator = ','
$euNum.NumberGroupSeparator = '.'
$utf8 = New-Object Text.UTF8Encoding($false)

if (-not $PSBoundParameters.ContainsKey('Seed')) {
    $Seed = (New-Object System.Random).Next(1, 1000000)
    Write-Host "Seed not given - using random seed $Seed"
}
$rng = New-Object System.Random($Seed)

# ---------------------------------------------------------------- plan (always drawn first)
$domainNames = @('retail', 'hotel', 'saas')
$planDomain = $domainNames[$rng.Next(0, 3)]
$nErr = $rng.Next(7, 11)
$pool = [int[]](1..13)
for ($i = 0; $i -lt $nErr; $i++) { $j = $rng.Next($i, 13); $t = $pool[$i]; $pool[$i] = $pool[$j]; $pool[$j] = $t }
$planErrors = @($pool[0..($nErr - 1)] | Sort-Object)

if (-not $Domain) { $Domain = $planDomain }
if ($Errors) {
    $joined = ($Errors -join ',').Trim()
    if ($joined -match '^(?i)none$') { $errList = @() }
    else {
        $errList = @((($joined -split '[,;\s]+') | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ }) | Sort-Object -Unique)
        foreach ($e in $errList) { if ($e -lt 1 -or $e -gt 13) { throw "Error type $e is not in the catalog (1-13)." } }
    }
} else { $errList = $planErrors }
$errSet = @{}
foreach ($e in $errList) { $errSet[[int]$e] = $true }
function Has([int]$n) { return $script:errSet.ContainsKey($n) }
if (-not $RunId) { $RunId = "${Domain}_s$Seed" }

# index = error number (a plain array: an [ordered] dictionary with int keys indexes by position)
$errorKeys = @('', 'id_formats', 'mixed_formats', 'duplicates', 'orphans', 'bridge_fanout',
    'wide_table', 'status_revenue', 'amount_anomalies', 'bad_dates',
    'incomplete_month', 'scd_prices', 'source_conflict', 'lying_docs')

# ---------------------------------------------------------------- JSON writer (ordered, invariant)
function ConvertTo-JsonText($v, [int]$ind = 0) {
    $pad = '  ' * $ind; $pad2 = '  ' * ($ind + 1)
    if ($null -eq $v) { return 'null' }
    if ($v -is [string]) { return '"' + $v.Replace('\', '\\').Replace('"', '\"') + '"' }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    if ($v -is [int] -or $v -is [long] -or $v -is [decimal] -or $v -is [double]) { return $v.ToString($script:inv) }
    if ($v -is [Collections.IDictionary]) {
        if ($v.Count -eq 0) { return '{}' }
        $parts = foreach ($k in $v.Keys) { $pad2 + '"' + [string]$k + '": ' + (ConvertTo-JsonText $v[$k] ($ind + 1)) }
        return "{`n" + ($parts -join ",`n") + "`n$pad}"
    }
    if ($v -is [Collections.IEnumerable]) {
        $items = @($v)
        if ($items.Count -eq 0) { return '[]' }
        $simple = $true
        foreach ($x in $items) { if ($x -is [Collections.IDictionary] -or ($x -is [Collections.IEnumerable] -and -not ($x -is [string]))) { $simple = $false } }
        if ($simple) { return '[' + (($items | ForEach-Object { ConvertTo-JsonText $_ 0 }) -join ', ') + ']' }
        $parts = foreach ($x in $items) { $pad2 + (ConvertTo-JsonText $x ($ind + 1)) }
        return "[`n" + ($parts -join ",`n") + "`n$pad]"
    }
    return '"' + [string]$v + '"'
}

if ($PlanOnly) {
    $plan = [ordered]@{ run_id = $RunId; domain = $Domain; seed = $Seed; rows = $Rows; errors = @($errList) }
    Write-Output (ConvertTo-JsonText $plan)
    return
}

if (-not $OutDir -or -not $AnswersDir) { throw 'Give both -OutDir and -AnswersDir (or use -PlanOnly).' }
function Resolve-Full([string]$p) {
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).Path $p }
    return [IO.Path]::GetFullPath($p).TrimEnd('\')
}
$OutDir = Resolve-Full $OutDir
$AnswersDir = Resolve-Full $AnswersDir
if ($OutDir -eq $AnswersDir -or $AnswersDir.StartsWith($OutDir + '\') -or $OutDir.StartsWith($AnswersDir + '\')) {
    throw '-OutDir and -AnswersDir must be separate folders (neither inside the other).'
}
New-Item -ItemType Directory -Force -Path $OutDir, $AnswersDir | Out-Null

# ---------------------------------------------------------------- domain configuration
$domainCfg = @{
    retail = @{
        factTable = 'fact_orders'; noun = 'order'; factId = 'order_id'; factPrefix = 'ORD'
        dateCol = 'order_date'; dateLabel = 'Date the order was placed'
        qtyCol = 'quantity'; qtyLabel = 'Units ordered'; qtyMin = 1; qtyMax = 6
        priceCol = 'unit_price'; priceLabel = 'Unit price at the time of the order (DKK)'
        amountLabel = 'Order amount (DKK)'; boolCol = 'is_paid'; boolLabel = 'Whether the order has been paid'
        custTable = 'dim_customers'; custId = 'customer_id'; custPrefix = 'CUST'; custShort = 'C'; custNameCol = 'customer_name'; custNoun = 'customer'
        segments = @('Consumer', 'Business', 'VIP')
        prodTable = 'dim_products'; prodId = 'product_id'; prodPrefix = 'PROD'; prodShort = 'P'; prodNameCol = 'product_name'; prodNoun = 'product'
        catCol = 'category'; cats = @('Electronics', 'Home', 'Outdoor', 'Clothing', 'Toys', 'Books'); prodWord = 'Model'; nProd = 60; priceMin = 5; priceMax = 500
        locTable = 'dim_locations'; locId = 'location_id'; locPrefix = 'LOC'; locNameCol = 'location_name'; locWord = 'Store'; nLoc = 12
        bridgeTable = 'bridge_customer_sales_reps'; repId = 'sales_rep_id'; repName = 'sales_rep_name'; repPrefix = 'REP'; repNoun = 'sales rep'; nRep = 15; repKind = 'person'
        wideTable = 'wide_monthly_targets'; wideLabel = 'Monthly revenue target per store (DKK)'; wideKind = 'amount'
        histTable = 'hist_product_prices'; src2Table = 'erp_customers'; src2System = 'ERP'; src1System = 'CRM'
        rev = @('Completed', 'Shipped'); nonrev = @('Cancelled', 'Returned')
        statusNotes = 'Completed = delivered to the customer; Shipped = sent to the customer, not yet delivered; Cancelled = cancelled before shipping; Returned = sent back by the customer'
    }
    hotel  = @{
        factTable = 'fact_bookings'; noun = 'booking'; factId = 'booking_id'; factPrefix = 'BKG'
        dateCol = 'stay_date'; dateLabel = 'Arrival date of the stay'
        qtyCol = 'nights'; qtyLabel = 'Number of nights'; qtyMin = 1; qtyMax = 8
        priceCol = 'nightly_rate'; priceLabel = 'Rate per night at the time of the booking (DKK)'
        amountLabel = 'Booking amount, nights x rate (DKK)'; boolCol = 'is_prepaid'; boolLabel = 'Whether the guest prepaid'
        custTable = 'dim_guests'; custId = 'guest_id'; custPrefix = 'GST'; custShort = 'G'; custNameCol = 'guest_name'; custNoun = 'guest'
        segments = @('Leisure', 'Business', 'Group')
        prodTable = 'dim_room_types'; prodId = 'room_type_id'; prodPrefix = 'RT'; prodShort = 'R'; prodNameCol = 'room_type_name'; prodNoun = 'room type'
        catCol = 'room_class'; cats = @('Standard', 'Superior', 'Deluxe', 'Family', 'Suite'); prodWord = 'Room'; nProd = 20; priceMin = 600; priceMax = 3500
        locTable = 'dim_hotels'; locId = 'hotel_id'; locPrefix = 'HTL'; locNameCol = 'hotel_name'; locWord = 'Hotel'; nLoc = 8
        bridgeTable = 'bridge_guest_agencies'; repId = 'agency_id'; repName = 'agency_name'; repPrefix = 'AGY'; repNoun = 'travel agency'; nRep = 10; repKind = 'agency'
        wideTable = 'wide_occupancy_targets'; wideLabel = 'Monthly occupancy target per hotel (percent)'; wideKind = 'percent'
        histTable = 'hist_room_rates'; src2Table = 'pms_guests'; src2System = 'PMS'; src1System = 'CRM'
        rev = @('Checked-out', 'Invoiced'); nonrev = @('Cancelled', 'No-show')
        statusNotes = 'Checked-out = stay completed and paid; Invoiced = stay completed, invoice sent, not yet paid; Cancelled = cancelled before arrival; No-show = guest did not arrive'
    }
    saas   = @{
        factTable = 'fact_invoices'; noun = 'invoice line'; factId = 'invoice_id'; factPrefix = 'INV'
        dateCol = 'invoice_date'; dateLabel = 'Invoice date (one MRR line per account and plan)'
        qtyCol = 'seats'; qtyLabel = 'Licensed seats'; qtyMin = 1; qtyMax = 40
        priceCol = 'seat_price'; priceLabel = 'Monthly price per seat at the invoice date (DKK)'
        amountLabel = 'MRR amount, seats x seat price (DKK)'; boolCol = 'is_autorenew'; boolLabel = 'Whether the subscription renews automatically'
        custTable = 'dim_accounts'; custId = 'account_id'; custPrefix = 'ACC'; custShort = 'A'; custNameCol = 'account_name'; custNoun = 'account'
        segments = @('SMB', 'Mid-market', 'Enterprise')
        prodTable = 'dim_plans'; prodId = 'plan_id'; prodPrefix = 'PLN'; prodShort = 'P'; prodNameCol = 'plan_name'; prodNoun = 'plan'
        catCol = 'plan_tier'; cats = @('Starter', 'Growth', 'Pro', 'Enterprise'); prodWord = 'Plan'; nProd = 12; priceMin = 10; priceMax = 200
        locTable = 'dim_regions'; locId = 'region_id'; locPrefix = 'REG'; locNameCol = 'region_name'; locWord = 'Region'; nLoc = 6
        bridgeTable = 'bridge_account_managers'; repId = 'account_manager_id'; repName = 'account_manager_name'; repPrefix = 'AM'; repNoun = 'account manager'; nRep = 8; repKind = 'person'
        wideTable = 'wide_mrr_targets'; wideLabel = 'Monthly MRR target per region (DKK)'; wideKind = 'amount'
        histTable = 'hist_plan_prices'; src2Table = 'billing_accounts'; src2System = 'Billing'; src1System = 'CRM'
        rev = @('Paid', 'Invoiced'); nonrev = @('Refunded', 'Trial')
        statusNotes = 'Paid = invoice paid; Invoiced = invoice sent, not yet paid; Refunded = paid and refunded; Trial = free trial period'
    }
}
$c = $domainCfg[$Domain]
foreach ($k in @($c.Keys)) { if ($c[$k] -is [string]) { $c[$k] = $c[$k].Replace('(DKK)', "($Currency)") } }
$statusNames = @($c.rev[0], $c.rev[1], $c.nonrev[0], $c.nonrev[1])
$cats = $c.cats; $nCat = $cats.Count
$regions = @('North', 'South', 'East', 'West', 'Central')
$firstNames = @('Anna', 'Mads', 'Sofie', 'Lars', 'Emma', 'Jonas', 'Ida', 'Mikkel', 'Freja', 'Oliver', 'Clara', 'Noah', 'Laura', 'William', 'Maja', 'Lucas', 'Ella', 'Victor', 'Alma', 'Emil')
$lastNames = @('Jensen', 'Nielsen', 'Hansen', 'Pedersen', 'Andersen', 'Christensen', 'Larsen', 'Sorensen', 'Rasmussen', 'Jorgensen', 'Petersen', 'Madsen', 'Kristensen', 'Olsen', 'Thomsen', 'Poulsen', 'Johansen', 'Moller', 'Mortensen', 'Knudsen')
$companySuffix = @('ApS', 'A/S', 'Group', 'Labs', 'Systems', 'Partners')
$cityList = @(
    @('Copenhagen', 'Denmark'), @('Aarhus', 'Denmark'), @('Odense', 'Denmark'), @('Aalborg', 'Denmark'),
    @('Malmo', 'Sweden'), @('Gothenburg', 'Sweden'), @('Stockholm', 'Sweden'), @('Oslo', 'Norway'),
    @('Bergen', 'Norway'), @('Hamburg', 'Germany'), @('Berlin', 'Germany'), @('Helsinki', 'Finland'))
$saasRegions = @(@('Denmark', 'Copenhagen'), @('Sweden', 'Stockholm'), @('Norway', 'Oslo'), @('Finland', 'Helsinki'), @('Germany', 'Berlin'), @('Benelux', 'Amsterdam'))
$boolPairs = @(@('true', 'false'), @('TRUE', 'FALSE'), @('True', 'False'), @('yes', 'no'), @('Y', 'N'), @('1', '0'), @('T', 'F'), @('YES', 'NO'))
$dateFormatNames = @('yyyy-MM-dd', 'dd.MM.yyyy', 'yyyyMMdd', 'MMM d yyyy')
$amountFormatNames = @('1234.50', '"1,234.50"', "1234.50 $Currency", '"1.234,50"')
$idFormatNames = @('PREFIX-0001', 'PREFIX0001', 'X0001', '0001')

function Format-Id([string]$prefix, [string]$short, [int]$n, [int]$fmt, [int]$w) {
    $d = $n.ToString('D' + $w, $script:inv)
    switch ($fmt) { 0 { return "$prefix-$d" } 1 { return "$prefix$d" } 2 { return "$short$d" } default { return $d } }
}
function Format-Date([DateTime]$d, [int]$f) { return $d.ToString($script:dateFormatNames[$f], $script:inv) }
function Format-Amount([decimal]$a, [int]$f) {
    switch ($f) {
        0 { return $a.ToString('0.00', $script:inv) }
        1 { $s = $a.ToString('#,##0.00', $script:inv); if ($s.Contains(',')) { return '"' + $s + '"' } else { return $s } }
        2 { return $a.ToString('0.00', $script:inv) + ' ' + $script:Currency }
        default { return '"' + $a.ToString('#,##0.00', $script:euNum) + '"' }
    }
}
function Get-Name {
    return $script:firstNames[$script:rng.Next(0, $script:firstNames.Count)] + ' ' + $script:lastNames[$script:rng.Next(0, $script:lastNames.Count)]
}
function Write-Csv([string]$name, [string]$header, $lines) {
    $sb = New-Object Text.StringBuilder
    [void]$sb.Append($header).Append("`n")
    foreach ($l in $lines) { [void]$sb.Append($l).Append("`n") }
    [IO.File]::WriteAllText((Join-Path $script:OutDir "$name.csv"), $sb.ToString(), $script:utf8)
    $script:fileRows[$name] = @($lines).Count
}
$fileRows = [ordered]@{}
function R2([decimal]$x) { return [Math]::Round($x, 2) }

# ---------------------------------------------------------------- dates
$endY = [int]$EndMonth.Substring(0, 4); $endM = [int]$EndMonth.Substring(5, 2)
$nMonths = $rng.Next(24, 37)
$endFirst = New-Object DateTime($endY, $endM, 1)
$startDate = $endFirst.AddMonths( - ($nMonths - 1))
if (Has 10) { $lastDate = New-Object DateTime($endY, $endM, $rng.Next(3, 21)) }
else { $lastDate = $endFirst.AddMonths(1).AddDays(-1) }
$daySpan = ($lastDate - $startDate).Days + 1

# ---------------------------------------------------------------- products + price history
$nProd = $c.nProd
$prodCat = New-Object int[] $nProd
$verFrom = New-Object object[] $nProd
$verPrice = New-Object object[] $nProd
$scdChanged = 0; $scdVersions = 0
for ($p = 0; $p -lt $nProd; $p++) {
    if ($p -lt $nCat) { $ci = $p } else { $ci = $rng.Next(0, $nCat) }
    $prodCat[$p] = $ci
    $basePrice = R2 ([decimal]($c.priceMin + ($c.priceMax - $c.priceMin) * (($ci + $rng.NextDouble()) / $nCat)))
    $vf = New-Object 'System.Collections.Generic.List[int]'
    $vp = New-Object 'System.Collections.Generic.List[decimal]'
    $vf.Add(0); $vp.Add($basePrice)
    if ((Has 11) -and ($p -lt 3 -or $rng.NextDouble() -lt 0.4)) {
        $k = $rng.Next(1, 4)
        $set = New-Object 'System.Collections.Generic.SortedSet[int]'
        while ($set.Count -lt $k) { [void]$set.Add($rng.Next(30, $daySpan - 30)) }
        $prev = $basePrice
        foreach ($o in $set) {
            $np = R2 ($prev * [decimal](0.85 + 0.4 * $rng.NextDouble()))
            if ($np -eq $prev) { $np = $prev + 1 }
            $vf.Add($o); $vp.Add($np); $prev = $np
        }
        $scdChanged++
    }
    $scdVersions += $vf.Count
    $verFrom[$p] = $vf; $verPrice[$p] = $vp
}
function Get-PriceAt([int]$p, [int]$o) {
    $vf = $script:verFrom[$p]; $vp = $script:verPrice[$p]; $r = $vp[0]
    for ($k = 1; $k -lt $vf.Count; $k++) { if ($vf[$k] -le $o) { $r = $vp[$k] } else { break } }
    return $r
}

# ---------------------------------------------------------------- customers + second source
$nCust = [Math]::Max(50, [int][Math]::Floor($Rows / 15))
$custName = New-Object string[] ($nCust + 1)
$custSeg = New-Object string[] ($nCust + 1)
$custRegion = New-Object int[] ($nCust + 1)
$custSignup = New-Object DateTime[] ($nCust + 1)
for ($k = 1; $k -le $nCust; $k++) {
    if ($Domain -eq 'saas') { $custName[$k] = $lastNames[$rng.Next(0, $lastNames.Count)] + ' ' + $companySuffix[$rng.Next(0, $companySuffix.Count)] }
    else { $custName[$k] = Get-Name }
    $custSeg[$k] = $c.segments[$rng.Next(0, $c.segments.Count)]
    $custRegion[$k] = $rng.Next(0, $regions.Count)
    $custSignup[$k] = $startDate.AddDays( - $rng.Next(30, 1500))
}
$src2Region = New-Object int[] ($nCust + 1)
$conflicts = 0
for ($k = 1; $k -le $nCust; $k++) {
    $src2Region[$k] = $custRegion[$k]
    if ((Has 12) -and ($k -le 3 -or $rng.NextDouble() -lt 0.12)) {
        $src2Region[$k] = ($custRegion[$k] + 1 + $rng.Next(0, $regions.Count - 1)) % $regions.Count
        $conflicts++
    }
}

# ---------------------------------------------------------------- facts (base rows)
$extraIdent = 0; $extraShift = 0; $extraAmt = 0
if (Has 3) {
    $extraIdent = [int][Math]::Round($Rows * (0.008 + 0.004 * $rng.NextDouble()))
    $extraShift = [int][Math]::Round($Rows * (0.006 + 0.004 * $rng.NextDouble()))
    $extraAmt = [int][Math]::Round($Rows * (0.005 + 0.004 * $rng.NextDouble()))
}
$extraRows = $extraIdent + $extraShift + $extraAmt
$N = $Rows - $extraRows

$off = New-Object int[] $N
for ($i = 0; $i -lt $N; $i++) { $off[$i] = $rng.Next(0, $daySpan) }
[Array]::Sort($off)
$custNum = New-Object int[] $N; $prodIx = New-Object int[] $N; $locIx = New-Object int[] $N
$qty = New-Object int[] $N; $price = New-Object decimal[] $N; $amount = New-Object decimal[] $N
$statusIx = New-Object int[] $N; $boolV = New-Object bool[] $N
$anom = New-Object string[] $N; $dateKind = New-Object int[] $N; $futureDate = New-Object DateTime[] $N
$isOrphan = New-Object bool[] $N; $used = New-Object bool[] $N
$fmtDate = New-Object int[] $N; $fmtAmt = New-Object int[] $N; $fmtBool = New-Object int[] $N
$fmtCust = New-Object int[] $N; $fmtProd = New-Object int[] $N
for ($i = 0; $i -lt $N; $i++) {
    $custNum[$i] = $rng.Next(1, $nCust + 1)
    $p = $rng.Next(0, $nProd); $prodIx[$i] = $p
    $locIx[$i] = $rng.Next(0, $c.nLoc)
    $qty[$i] = $rng.Next($c.qtyMin, $c.qtyMax + 1)
    $price[$i] = Get-PriceAt $p $off[$i]
    $r = $rng.NextDouble()
    if ($r -lt 0.75) { $st = 0 } elseif ($r -lt 0.87) { $st = 1 } elseif ($r -lt 0.95) { $st = 2 } else { $st = 3 }
    $statusIx[$i] = $st
    $full = $qty[$i] * $price[$i]
    if ($st -ge 2 -and -not (Has 7)) { $amount[$i] = [decimal]0 } else { $amount[$i] = $full }
    $boolV[$i] = ($rng.NextDouble() -lt 0.7)
    $anom[$i] = ''
    if (Has 2) { $fmtDate[$i] = $rng.Next(0, 4); $fmtAmt[$i] = $rng.Next(0, 4); $fmtBool[$i] = $rng.Next(0, 8) }
    if (Has 1) { $fmtCust[$i] = $rng.Next(0, 4); $fmtProd[$i] = $rng.Next(0, 4) }
}

function Select-Rows([int]$k, [scriptblock]$ok) {
    $res = New-Object 'System.Collections.Generic.List[int]'
    $tries = 0
    while ($res.Count -lt $k -and $tries -lt ($k * 500 + 1000)) {
        $tries++
        $i = $script:rng.Next(0, $script:N)
        if (-not $script:used[$i] -and (& $ok $i)) { $script:used[$i] = $true; $res.Add($i) }
    }
    return , $res
}

# orphans (4) - independent of the "used" marks, may overlap other issues
$orphanFrom = $nCust + 101
$orphanIds = New-Object 'System.Collections.Generic.SortedSet[int]'
$orphanRowCount = 0
if (Has 4) {
    $nOrphanIds = $rng.Next(8, 26)
    $k = [Math]::Max($nOrphanIds, [int][Math]::Round($N * (0.010 + 0.010 * $rng.NextDouble())))
    $picked = New-Object 'System.Collections.Generic.HashSet[int]'
    $t = 0
    while ($picked.Count -lt $k) {
        $i = $rng.Next(0, $N)
        if ($picked.Add($i)) {
            if ($t -lt $nOrphanIds) { $id = $orphanFrom + $t } else { $id = $orphanFrom + $rng.Next(0, $nOrphanIds) }
            $custNum[$i] = $id; $isOrphan[$i] = $true; [void]$orphanIds.Add($id); $t++
        }
    }
    $orphanRowCount = $picked.Count
}

# amount anomalies (8)
$cntNeg = 0; $cntSpike = 0; $cntZero = 0
if (Has 8) {
    foreach ($i in (Select-Rows ([Math]::Max(3, [int][Math]::Round($N * 0.004))) { param($x) $statusIx[$x] -lt 2 })) { $amount[$i] = - ($qty[$i] * $price[$i]); $anom[$i] = 'negative'; $cntNeg++ }
    foreach ($i in (Select-Rows ([Math]::Max(3, [int][Math]::Round($N * 0.003))) { param($x) $statusIx[$x] -lt 2 })) { $amount[$i] = R2 ($qty[$i] * $price[$i] * [decimal](6 + 9 * $rng.NextDouble())); $anom[$i] = 'spike'; $cntSpike++ }
    foreach ($i in (Select-Rows ([Math]::Max(3, [int][Math]::Round($N * 0.003))) { param($x) $statusIx[$x] -eq 0 })) { $amount[$i] = [decimal]0; $anom[$i] = 'zero'; $cntZero++ }
}

# bad dates (9)
$cntMissing = 0; $cntFuture = 0
if (Has 9) {
    foreach ($i in (Select-Rows ([Math]::Max(3, [int][Math]::Round($N * 0.005))) { param($x) $true })) { $dateKind[$i] = 1; $cntMissing++ }
    foreach ($i in (Select-Rows ([Math]::Max(3, [int][Math]::Round($N * 0.003))) { param($x) $true })) { $dateKind[$i] = 2; $futureDate[$i] = $lastDate.AddDays($rng.Next(30, 900)); $cntFuture++ }
}

function Build-FactLine([int]$i, [int]$dOff, [decimal]$amt) {
    $cc = $script:c
    $id = $cc.factPrefix + '-' + ($i + 1).ToString('D6', $script:inv)
    if ($script:dateKind[$i] -eq 1) { $ds = '' }
    else {
        if ($script:dateKind[$i] -eq 2) { $d = $script:futureDate[$i] } else { $d = $script:startDate.AddDays($dOff) }
        $ds = Format-Date $d $script:fmtDate[$i]
    }
    $cs = Format-Id $cc.custPrefix $cc.custShort $script:custNum[$i] $script:fmtCust[$i] 4
    $ps = Format-Id $cc.prodPrefix $cc.prodShort ($script:prodIx[$i] + 1) $script:fmtProd[$i] 4
    $ls = Format-Id $cc.locPrefix '' ($script:locIx[$i] + 1) 0 3
    $pair = $script:boolPairs[$script:fmtBool[$i]]
    if ($script:boolV[$i]) { $bs = $pair[0] } else { $bs = $pair[1] }
    return ($id, $ds, $cs, $ps, $ls, $script:qty[$i].ToString($script:inv), $script:price[$i].ToString('0.00', $script:inv),
        (Format-Amount $amt $script:fmtAmt[$i]), $script:statusNames[$script:statusIx[$i]], $bs) -join ','
}

# duplicates (3) - inserted after the original, never before it
$extras = New-Object 'System.Collections.Generic.Dictionary[int,System.Collections.Generic.List[string]]'
function Add-Extra([int]$orig, [string]$line) {
    $j = $orig + $script:rng.Next(0, [Math]::Min(500, $script:N - $orig))
    if (-not $script:extras.ContainsKey($j)) { $script:extras[$j] = New-Object 'System.Collections.Generic.List[string]' }
    $script:extras[$j].Add($line)
}
if (Has 3) {
    foreach ($i in (Select-Rows $extraIdent { param($x) $true })) { Add-Extra $i (Build-FactLine $i $off[$i] $amount[$i]) }
    foreach ($i in (Select-Rows $extraShift { param($x) $true })) {
        $s = $rng.Next(1, 4); $no = $off[$i] + $s
        if ($no -ge $daySpan) { $no = $off[$i] - $s }
        Add-Extra $i (Build-FactLine $i $no $amount[$i])
    }
    foreach ($i in (Select-Rows $extraAmt { param($x) $amount[$x] -gt 0 })) {
        $f = [decimal](0.05 + 0.20 * $rng.NextDouble())
        if ($rng.Next(0, 2) -eq 0) { $f = - $f }
        $na = R2 ($amount[$i] * (1 + $f))
        if ($na -eq $amount[$i]) { $na = $amount[$i] + 1 }
        Add-Extra $i (Build-FactLine $i $off[$i] $na)
    }
}

$factLines = New-Object 'System.Collections.Generic.List[string]'
for ($i = 0; $i -lt $N; $i++) {
    $factLines.Add((Build-FactLine $i $off[$i] $amount[$i]))
    if ($extras.ContainsKey($i)) { foreach ($l in $extras[$i]) { $factLines.Add($l) } }
}
if ($factLines.Count -ne $Rows) { throw "Internal error: $($factLines.Count) fact lines, expected $Rows." }

# ---------------------------------------------------------------- reference values (answers-format.md)
$revByCust = @{}
$cleanRevenue = [decimal]0; $cleanRows = 0
$uniqueCust = New-Object 'System.Collections.Generic.HashSet[int]'
$revByCat = New-Object decimal[] $nCat
$revByMonth = New-Object 'System.Collections.Generic.SortedDictionary[string,decimal]'
$byStatusRows = New-Object int[] 4; $byStatusAmt = New-Object decimal[] 4
$undatedRevenue = [decimal]0; $orphanRevenue = [decimal]0
for ($i = 0; $i -lt $N; $i++) {
    $byStatusRows[$statusIx[$i]]++; $byStatusAmt[$statusIx[$i]] += $amount[$i]
    if ($statusIx[$i] -ge 2 -or $anom[$i] -ne '') { continue }
    $a = $amount[$i]
    $cleanRevenue += $a; $cleanRows++
    [void]$uniqueCust.Add($custNum[$i])
    $revByCat[$prodCat[$prodIx[$i]]] += $a
    if ($revByCust.ContainsKey($custNum[$i])) { $revByCust[$custNum[$i]] += $a } else { $revByCust[$custNum[$i]] = $a }
    if ($isOrphan[$i]) { $orphanRevenue += $a }
    if ($dateKind[$i] -ne 0) { $undatedRevenue += $a; continue }
    $mk = $startDate.AddDays($off[$i]).ToString('yyyy-MM', $inv)
    if ($revByMonth.ContainsKey($mk)) { $revByMonth[$mk] += $a } else { $revByMonth[$mk] = $a }
}
function Get-CustRevenue([int]$k) { if ($script:revByCust.ContainsKey($k)) { return [decimal]$script:revByCust[$k] } else { return [decimal]0 } }

# ---------------------------------------------------------------- bridge (5)
$repNames = New-Object string[] ($c.nRep + 1)
for ($k = 1; $k -le $c.nRep; $k++) {
    if ($c.repKind -eq 'agency') { $repNames[$k] = $lastNames[($k * 7) % $lastNames.Count] + ' ' + $cityList[$k % $cityList.Count][0] + ' Travel' }
    else { $repNames[$k] = Get-Name }
}
$bridgeLines = New-Object 'System.Collections.Generic.List[string]'
$fanDist = [ordered]@{ '1' = 0; '2' = 0; '3' = 0 }
$dupPairs = 0; $distinctPairs = 0; $naiveTotal = [decimal]0; $bridgeCorrect = [decimal]0
for ($k = 1; $k -le $nCust; $k++) {
    $nR = 1
    if (Has 5) { $r = $rng.NextDouble(); if ($r -lt 0.5) { $nR = 1 } elseif ($r -lt 0.85) { $nR = 2 } else { $nR = 3 } }
    $fanDist[[string]$nR]++
    $reps = New-Object 'System.Collections.Generic.SortedSet[int]'
    while ($reps.Count -lt $nR) { [void]$reps.Add($rng.Next(1, $c.nRep + 1)) }
    $rev = Get-CustRevenue $k
    $bridgeCorrect += $rev
    foreach ($rp in $reps) {
        $f = 0; if (Has 1) { $f = $rng.Next(0, 4) }
        $line = (Format-Id $c.custPrefix $c.custShort $k $f 4) + ',' + (Format-Id $c.repPrefix '' $rp 0 3) + ',' + $repNames[$rp]
        $bridgeLines.Add($line); $distinctPairs++; $naiveTotal += $rev
        if ((Has 5) -and $rng.NextDouble() -lt 0.04) { $bridgeLines.Add($line); $dupPairs++; $naiveTotal += $rev }
    }
}

# ---------------------------------------------------------------- wide targets (6)
$years = @($startDate.Year..$lastDate.Year)
$monthCols = @('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
$wideLines = New-Object 'System.Collections.Generic.List[string]'
$emptyCells = 0
$avgMonthLoc = $cleanRevenue / [decimal]($nMonths * $c.nLoc)
for ($l = 1; $l -le $c.nLoc; $l++) {
    foreach ($y in $years) {
        $vals = foreach ($m in 1..12) {
            if ($c.wideKind -eq 'percent') { $v = [string]$rng.Next(45, 96) }
            else { $v = ([Math]::Round($avgMonthLoc * [decimal](0.85 + 0.35 * $rng.NextDouble()) / 100, 0) * 100).ToString('0', $inv) }
            if ((Has 6) -and $rng.NextDouble() -lt 0.08) { $script:emptyCells++; '' } else { $v }
        }
        $wideLines.Add((Format-Id $c.locPrefix '' $l 0 3) + ',' + $y + ',' + ($vals -join ','))
    }
}
$wideRows = $wideLines.Count

# ---------------------------------------------------------------- write CSV files
$factHeader = ($c.factId, $c.dateCol, $c.custId, $c.prodId, $c.locId, $c.qtyCol, $c.priceCol, 'amount', 'status', $c.boolCol) -join ','
Write-Csv $c.factTable $factHeader $factLines

$lines = for ($k = 1; $k -le $nCust; $k++) {
    (Format-Id $c.custPrefix $c.custShort $k 0 4) + ',' + $custName[$k] + ',' + $custSeg[$k] + ',' + $regions[$custRegion[$k]] + ',' + $custSignup[$k].ToString('yyyy-MM-dd', $inv)
}
Write-Csv $c.custTable (($c.custId, $c.custNameCol, 'segment', 'region', 'signup_date') -join ',') $lines

$src2Fmt = 0; if (Has 1) { $src2Fmt = 1 }
$lines = for ($k = 1; $k -le $nCust; $k++) {
    (Format-Id $c.custPrefix $c.custShort $k $src2Fmt 4) + ',' + $custName[$k] + ',' + $regions[$src2Region[$k]]
}
Write-Csv $c.src2Table (($c.custId, $c.custNameCol, 'region') -join ',') $lines

$lines = for ($p = 0; $p -lt $nProd; $p++) {
    $cat = $cats[$prodCat[$p]]
    (Format-Id $c.prodPrefix $c.prodShort ($p + 1) 0 4) + ',' + "$cat $($c.prodWord) $(($p + 1).ToString('D2', $inv))" + ',' + $cat + ',' + $verPrice[$p][$verPrice[$p].Count - 1].ToString('0.00', $inv)
}
Write-Csv $c.prodTable (($c.prodId, $c.prodNameCol, $c.catCol, 'list_price') -join ',') $lines

$lines = foreach ($p in 0..($nProd - 1)) {
    $vf = $verFrom[$p]; $vp = $verPrice[$p]
    for ($k = 0; $k -lt $vf.Count; $k++) {
        $from = $startDate.AddDays($vf[$k]).ToString('yyyy-MM-dd', $inv)
        if ($k -lt $vf.Count - 1) { $to = $startDate.AddDays($vf[$k + 1] - 1).ToString('yyyy-MM-dd', $inv) } else { $to = '' }
        (Format-Id $c.prodPrefix $c.prodShort ($p + 1) 0 4) + ',' + $vp[$k].ToString('0.00', $inv) + ',' + $from + ',' + $to
    }
}
Write-Csv $c.histTable (($c.prodId, 'price', 'valid_from', 'valid_to') -join ',') $lines

$lines = for ($l = 1; $l -le $c.nLoc; $l++) {
    if ($Domain -eq 'saas') { $nm = "Region $($saasRegions[$l - 1][0])"; $city = $saasRegions[$l - 1][1]; $country = $saasRegions[$l - 1][0] }
    else { $city = $cityList[$l - 1][0]; $country = $cityList[$l - 1][1]; $nm = "$($c.locWord) $city" }
    (Format-Id $c.locPrefix '' $l 0 3) + ',' + $nm + ',' + $city + ',' + $country
}
Write-Csv $c.locTable (($c.locId, $c.locNameCol, 'city', 'country') -join ',') $lines

Write-Csv $c.bridgeTable (($c.custId, $c.repId, $c.repName) -join ',') $bridgeLines
Write-Csv $c.wideTable ((@($c.locId, 'year') + $monthCols) -join ',') $wideLines

# ---------------------------------------------------------------- lying docs (13)
$lie = $null
if (Has 13) {
    $cands = @()
    if (Has 4) { $cands += , @('orphans', [Math]::Round(100.0 * $orphanRowCount / $Rows, 2), "about {0} % of $($c.factTable) rows reference a $($c.custNoun) that is missing from $($c.custTable)") }
    if (Has 3) { $cands += , @('duplicates', [Math]::Round(100.0 * $extraRows / $Rows, 2), "duplicate rows make up about {0} % of $($c.factTable)") }
    if (Has 12) { $cands += , @('source_conflict', [Math]::Round(100.0 * $conflicts / $nCust, 2), "the region in $($c.src2Table) ($($c.src2System)) differs from $($c.custTable) ($($c.src1System)) for about {0} % of $($c.custNoun)s") }
    if (Has 8) { $cands += , @('amount_anomalies', [Math]::Round(100.0 * ($cntNeg + $cntSpike + $cntZero) / $Rows, 2), "about {0} % of $($c.factTable) rows have a suspicious amount") }
    if ($cands.Count -eq 0) { $cands += , @('duplicates', 0.0, "duplicate rows make up about {0} % of $($c.factTable)") }
    $pick = $cands[$rng.Next(0, $cands.Count)]
    $actual = [double]$pick[1]
    if ($actual -lt 0.5) { $claimed = [Math]::Round(2.0 + 2.0 * $rng.NextDouble(), 1) }
    else { $claimed = [Math]::Round($actual / (3.0 + 3.0 * $rng.NextDouble()), 1) }
    if ($claimed -eq [Math]::Round($actual, 1)) { $claimed = $claimed + 1.5 }
    $lie = [ordered]@{ topic = $pick[0]; claimed_pct = $claimed; actual_pct = $actual; text = ($pick[2] -f $claimed.ToString('0.0', $inv)) }
}

# ---------------------------------------------------------------- DATA_DICTIONARY.md + ENTITY_RELATIONSHIP_SUMMARY.md
$st = $statusNames -join ', '
$dd = New-Object Text.StringBuilder
function L([string]$s = '') { [void]$script:dd.Append($s).Append("`n") }
L "# Data dictionary - $Domain export"
L ''
L "Export from the source systems ($($c.src1System) and $($c.src2System)). All amounts are in $Currency. One CSV file per table, UTF-8, comma separated, header in the first line."
L ''
L "## $($c.factTable).csv"
L ''
L "One row per $($c.noun)."
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.factId) | Business key of the $($c.noun) |"
L "| $($c.dateCol) | $($c.dateLabel) |"
L "| $($c.custId) | The $($c.custNoun) -> $($c.custTable) |"
L "| $($c.prodId) | The $($c.prodNoun) -> $($c.prodTable) |"
L "| $($c.locId) | The $($c.locWord.ToLower()) -> $($c.locTable) |"
L "| $($c.qtyCol) | $($c.qtyLabel) |"
L "| $($c.priceCol) | $($c.priceLabel) |"
L "| amount | $($c.amountLabel) |"
L "| status | Status of the $($c.noun): $($c.statusNotes) |"
L "| $($c.boolCol) | $($c.boolLabel) |"
L ''
L "## $($c.custTable).csv ($($c.src1System))"
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.custId) | Key of the $($c.custNoun) |"
L "| $($c.custNameCol) | Name |"
L "| segment | $($c.segments -join ', ') |"
L "| region | Sales region ($($regions -join ', ')) |"
L "| signup_date | Date the $($c.custNoun) was created |"
L ''
L "## $($c.src2Table).csv ($($c.src2System))"
L ''
L "The same $($c.custNoun)s as maintained in $($c.src2System)."
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.custId) | Key of the $($c.custNoun) |"
L "| $($c.custNameCol) | Name |"
L "| region | Sales region |"
L ''
L "## $($c.prodTable).csv"
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.prodId) | Key of the $($c.prodNoun) |"
L "| $($c.prodNameCol) | Name |"
L "| $($c.catCol) | $($cats -join ', ') |"
L "| list_price | Current list price ($Currency) |"
L ''
L "## $($c.histTable).csv"
L ''
L "Price list history. valid_to is empty for the current price."
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.prodId) | The $($c.prodNoun) |"
L "| price | Price ($Currency) |"
L "| valid_from | First day the price applies |"
L "| valid_to | Last day the price applies |"
L ''
L "## $($c.locTable).csv"
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.locId) | Key |"
L "| $($c.locNameCol) | Name |"
L "| city | City |"
L "| country | Country |"
L ''
L "## $($c.bridgeTable).csv"
L ''
L "Which $($c.repNoun) handles which $($c.custNoun)."
L ''
L '| Column | Description |'
L '|---|---|'
L "| $($c.custId) | The $($c.custNoun) |"
L "| $($c.repId) | The $($c.repNoun) |"
L "| $($c.repName) | Name of the $($c.repNoun) |"
L ''
L "## $($c.wideTable).csv"
L ''
L "$($c.wideLabel). One row per $($c.locWord.ToLower()) and year, one column per month (jan-dec)."
L ''
if ($null -ne $lie) {
    L '## Data quality notes'
    L ''
    L "According to the source team, $($lie.text)."
    L ''
}
[IO.File]::WriteAllText((Join-Path $OutDir 'DATA_DICTIONARY.md'), $dd.ToString(), $utf8)

$dd = New-Object Text.StringBuilder
L "# Entity relationship summary - $Domain"
L ''
L '| From | Column | To | Expected cardinality |'
L '|---|---|---|---|'
L "| $($c.factTable) | $($c.custId) | $($c.custTable) | many-to-one |"
L "| $($c.factTable) | $($c.prodId) | $($c.prodTable) | many-to-one |"
L "| $($c.factTable) | $($c.locId) | $($c.locTable) | many-to-one |"
L "| $($c.histTable) | $($c.prodId) | $($c.prodTable) | many-to-one |"
L "| $($c.src2Table) | $($c.custId) | $($c.custTable) | one-to-one |"
L "| $($c.bridgeTable) | $($c.custId) | $($c.custTable) | many-to-one |"
L "| $($c.wideTable) | $($c.locId) | $($c.locTable) | many-to-one |"
L ''
L "$($c.custTable) and the $($c.repNoun)s in $($c.bridgeTable) can form a many-to-many relationship (a $($c.custNoun) may have several $($c.repNoun)s)."
L ''
L '```mermaid'
L 'erDiagram'
L "    $($c.custTable) ||--o{ $($c.factTable) : has"
L "    $($c.prodTable) ||--o{ $($c.factTable) : sold_as"
L "    $($c.locTable) ||--o{ $($c.factTable) : at"
L "    $($c.prodTable) ||--o{ $($c.histTable) : priced"
L "    $($c.custTable) ||--|| $($c.src2Table) : mirrors"
L "    $($c.custTable) ||--o{ $($c.bridgeTable) : handled_by"
L "    $($c.locTable) ||--o{ $($c.wideTable) : targets"
L '```'
[IO.File]::WriteAllText((Join-Path $OutDir 'ENTITY_RELATIONSHIP_SUMMARY.md'), $dd.ToString(), $utf8)

# ---------------------------------------------------------------- answers
$injected = [ordered]@{}
function Id-Formats([string]$prefix, [string]$short) { return @(0..3 | ForEach-Object { Format-Id $prefix $short 1 $_ 4 }) }
if (Has 1) {
    $injected['id_formats'] = [ordered]@{
        canonical = (Format-Id $c.custPrefix $c.custShort 1 0 4)
        tables    = [ordered]@{
            $c.factTable   = [ordered]@{ $c.custId = (Id-Formats $c.custPrefix $c.custShort); $c.prodId = (Id-Formats $c.prodPrefix $c.prodShort) }
            $c.bridgeTable = [ordered]@{ $c.custId = (Id-Formats $c.custPrefix $c.custShort) }
            $c.src2Table   = [ordered]@{ $c.custId = @(Format-Id $c.custPrefix $c.custShort 1 1 4) }
        }
    }
}
if (Has 2) {
    $cd = New-Object int[] 4; $ca = New-Object int[] 4; $cb = New-Object int[] 8
    for ($i = 0; $i -lt $N; $i++) { if ($dateKind[$i] -eq 0) { $cd[$fmtDate[$i]]++ }; $ca[$fmtAmt[$i]]++; $cb[$fmtBool[$i]]++ }
    # lists, not objects: true/false and TRUE/FALSE differ only by case, and JSON readers such as
    # PowerShell's ConvertFrom-Json reject keys that differ only by case
    $dv = @(for ($k = 0; $k -lt 4; $k++) { [ordered]@{ variant = $dateFormatNames[$k]; rows = $cd[$k] } })
    $av = @(for ($k = 0; $k -lt 4; $k++) { [ordered]@{ variant = $amountFormatNames[$k].Replace('"', ''); rows = $ca[$k] } })
    $bv = @(for ($k = 0; $k -lt 8; $k++) { [ordered]@{ variant = $boolPairs[$k][0] + '/' + $boolPairs[$k][1]; rows = $cb[$k] } })
    $injected['mixed_formats'] = [ordered]@{
        table = $c.factTable; counted_on = 'rows after dedupe'
        columns = [ordered]@{ $c.dateCol = $dv; amount = $av; $c.boolCol = $bv }
    }
}
if (Has 3) {
    $injected['duplicates'] = [ordered]@{ table = $c.factTable; business_key = $c.factId; identical = $extraIdent; shifted_date = $extraShift; other_amount = $extraAmt; extra_rows = $extraRows; has_timestamp = $false }
}
if (Has 4) {
    $injected['orphans'] = [ordered]@{
        table = $c.factTable; column = $c.custId; dimension = $c.custTable; rows = $orphanRowCount; ids = $orphanIds.Count
        id_range = @((Format-Id $c.custPrefix $c.custShort $orphanIds.Min 0 4), (Format-Id $c.custPrefix $c.custShort $orphanIds.Max 0 4))
        clean_revenue_on_orphans = $orphanRevenue
    }
}
if (Has 5) {
    $injected['bridge_fanout'] = [ordered]@{
        table = $c.bridgeTable; customers_by_rep_count = $fanDist; raw_rows = $bridgeLines.Count; distinct_pairs = $distinctPairs; duplicated_pairs = $dupPairs
        naive_total = $naiveTotal; correct_total = $bridgeCorrect
    }
}
if (Has 6) { $injected['wide_table'] = [ordered]@{ table = $c.wideTable; rows = $wideRows; month_columns = 12; empty_cells = $emptyCells; expected_long_rows = $wideRows * 12 - $emptyCells } }
if (Has 7) {
    $tot = [decimal]0; foreach ($x in $byStatusAmt) { $tot += $x }
    $bs = [ordered]@{}
    for ($k = 0; $k -lt 4; $k++) { $sh = 0; if ($tot -ne 0) { $sh = [Math]::Round(100 * $byStatusAmt[$k] / $tot, 2) }; $bs[$statusNames[$k]] = [ordered]@{ rows = $byStatusRows[$k]; amount = $byStatusAmt[$k]; share_pct = $sh } }
    $injected['status_revenue'] = [ordered]@{ revenue_statuses = @($c.rev); non_revenue_statuses = @($c.nonrev); counted_on = 'rows after dedupe'; by_status = $bs }
}
if (Has 8) { $injected['amount_anomalies'] = [ordered]@{ negative = $cntNeg; spike = $cntSpike; zero_on_status = $cntZero; zero_status = $c.rev[0]; spike_rule = "amount > 5 x $($c.qtyCol) x $($c.priceCol)" } }
if (Has 9) { $injected['bad_dates'] = [ordered]@{ column = $c.dateCol; missing = $cntMissing; future = $cntFuture; extract_end = $lastDate.ToString('yyyy-MM-dd', $inv) } }
if (Has 10) { $injected['incomplete_month'] = [ordered]@{ last_date = $lastDate.ToString('yyyy-MM-dd', $inv); last_complete_month = $endFirst.AddMonths(-1).ToString('yyyy-MM', $inv) } }
if (Has 11) { $injected['scd_prices'] = [ordered]@{ table = $c.histTable; products = $nProd; products_with_changes = $scdChanged; versions = $scdVersions } }
if (Has 12) { $injected['source_conflict'] = [ordered]@{ attribute = 'region'; sources = @($c.custTable, $c.src2Table); customers = $nCust; conflicts = $conflicts } }
if (Has 13) { $injected['lying_docs'] = [ordered]@{ file = 'DATA_DICTIONARY.md'; topic = $lie.topic; claimed_pct = $lie.claimed_pct; actual_pct = $lie.actual_pct } }

$notInjected = @(foreach ($k in 1..13) { if (-not (Has $k)) { $errorKeys[$k] } })
$findings = [ordered]@{
    run_id = $RunId; domain = $Domain; seed = $Seed; rows = $Rows; errors = @($errList)
    injected = $injected; not_injected = $notInjected; generator_version = $GeneratorVersion
}

$lastComplete = $endFirst.ToString('yyyy-MM', $inv)
if (Has 10) { $lastComplete = $endFirst.AddMonths(-1).ToString('yyyy-MM', $inv) }
$prevComplete = ([DateTime]::ParseExact($lastComplete + '-01', 'yyyy-MM-dd', $inv)).AddMonths(-1).ToString('yyyy-MM', $inv)
$monthObj = [ordered]@{}; foreach ($kv in $revByMonth.GetEnumerator()) { $monthObj[$kv.Key] = $kv.Value }
$catObj = [ordered]@{}; for ($k = 0; $k -lt $nCat; $k++) { $catObj[$cats[$k]] = $revByCat[$k] }
function MonthVal([string]$m) { if ($script:revByMonth.ContainsKey($m)) { return $script:revByMonth[$m] } else { return [decimal]0 } }

$values = [ordered]@{
    run_id = $RunId; domain = $Domain; seed = $Seed
    reference_rules = 'see references/answers-format.md in the messy-dataset skill'
    tables = $fileRows
    fact_rows_in_file = $Rows
    fact_rows_after_dedupe = $N
    revenue_statuses = @($c.rev)
    clean_rows = $cleanRows
    clean_revenue = $cleanRevenue
    unique_customers = $uniqueCust.Count
    customers_in_dimension = $nCust
    revenue_by_category = $catObj
    revenue_by_month = $monthObj
    revenue_without_valid_date = $undatedRevenue
    first_date = $startDate.ToString('yyyy-MM-dd', $inv)
    last_date = $lastDate.ToString('yyyy-MM-dd', $inv)
    latest_complete_month = $lastComplete
    revenue_latest_complete_month = (MonthVal $lastComplete)
    revenue_previous_month = (MonthVal $prevComplete)
    bridge = [ordered]@{ naive_total = $naiveTotal; correct_total = $bridgeCorrect; revenue_without_rep = ($cleanRevenue - $bridgeCorrect) }
    wide_long_rows = ($wideRows * 12 - $emptyCells)
}

[IO.File]::WriteAllText((Join-Path $AnswersDir 'expected_findings.json'), (ConvertTo-JsonText $findings) + "`n", $utf8)
[IO.File]::WriteAllText((Join-Path $AnswersDir 'expected_values.json'), (ConvertTo-JsonText $values) + "`n", $utf8)

$summary = [ordered]@{ run_id = $RunId; domain = $Domain; seed = $Seed; rows = $Rows; errors = @($errList); out_dir = $OutDir; answers_dir = $AnswersDir; files = $fileRows }
Write-Output (ConvertTo-JsonText $summary)
