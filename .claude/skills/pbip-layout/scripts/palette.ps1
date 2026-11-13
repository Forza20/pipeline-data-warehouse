# Measures the colours in a screenshot (website, brand page) and suggests the dashboard's "colors".
# Usage: powershell -NoProfile -File palette.ps1 -Path "<image.png|jpg>" [-Top 10]
# Output (JSON): the most used colours with their share, and a suggestion per colour key (colors.md)
# with the contrast of the text pairs. Windows PowerShell 5.1, no extra modules.
param([Parameter(Mandatory = $true)][string]$Path, [int]$Top = 10)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Path))
$scale = [Math]::Min(1.0, 240.0 / [Math]::Max($src.Width, $src.Height))
$w = [Math]::Max(1, [int]($src.Width * $scale)); $h = [Math]::Max(1, [int]($src.Height * $scale))
$bmp = New-Object System.Drawing.Bitmap $src, $w, $h
$src.Dispose()

# bucket every pixel (4 bits per channel) and keep the real average per bucket
$b = @{}
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.A -lt 128) { continue }
    $k = (($c.R -shr 4) -shl 8) -bor (($c.G -shr 4) -shl 4) -bor ($c.B -shr 4)
    if (-not $b.ContainsKey($k)) { $b[$k] = @(0, 0, 0, 0) }
    $v = $b[$k]; $v[0] += $c.R; $v[1] += $c.G; $v[2] += $c.B; $v[3]++
  }
}
$bmp.Dispose()
$total = ($b.Values | ForEach-Object { $_[3] } | Measure-Object -Sum).Sum

function Lum($r, $g, $bl) {            # relative luminance (WCAG)
  $f = { param($v) $s = $v / 255.0; if ($s -le 0.03928) { $s / 12.92 } else { [Math]::Pow(($s + 0.055) / 1.055, 2.4) } }
  0.2126 * (& $f $r) + 0.7152 * (& $f $g) + 0.0722 * (& $f $bl)
}
function Contrast($a, $c) { $l1 = [Math]::Max($a.lum, $c.lum); $l2 = [Math]::Min($a.lum, $c.lum); [Math]::Round(($l1 + 0.05) / ($l2 + 0.05), 2) }
function Hex($r, $g, $bl) { '#{0:X2}{1:X2}{2:X2}' -f [int]$r, [int]$g, [int]$bl }
function Col($r, $g, $bl) {
  $mx = [Math]::Max($r, [Math]::Max($g, $bl)) / 255.0; $mn = [Math]::Min($r, [Math]::Min($g, $bl)) / 255.0
  $sat = if ($mx -eq 0) { 0 } else { ($mx - $mn) / $mx }
  [pscustomobject]@{ hex = (Hex $r $g $bl); r = [int]$r; g = [int]$g; b = [int]$bl; lum = (Lum $r $g $bl); sat = [Math]::Round($sat, 2); share = 0.0 }
}
function Mix($a, $c, $t) { Col ($a.r + ($c.r - $a.r) * $t) ($a.g + ($c.g - $a.g) * $t) ($a.b + ($c.b - $a.b) * $t) }

# merge buckets into colours, then merge colours closer than ~6 % per channel
$cols = foreach ($v in $b.Values) { $o = Col ($v[0] / $v[3]) ($v[1] / $v[3]) ($v[2] / $v[3]); $o.share = $v[3] / $total; $o }
$cols = $cols | Sort-Object share -Descending
$merged = New-Object System.Collections.ArrayList
foreach ($c in $cols) {
  $hit = $merged | Where-Object { [Math]::Abs($_.r - $c.r) + [Math]::Abs($_.g - $c.g) + [Math]::Abs($_.b - $c.b) -lt 46 } | Select-Object -First 1
  if ($hit) { $hit.share += $c.share } else { [void]$merged.Add($c) }
}
$all = $merged | Sort-Object share -Descending | Where-Object { $_.share -ge 0.0003 }   # text is small: keep it here
$pal = $all | Where-Object { $_.share -ge 0.002 }

# nudge a colour towards white (dark background) or black (light background) until it is readable
function Readable($fg, $bgc, [double]$target) {
  $toward = if ($bgc.lum -lt 0.18) { Col 255 255 255 } else { Col 0 0 0 }
  $c = $fg
  for ($t = 0.1; (Contrast $c $bgc) -lt $target -and $t -le 1.0; $t += 0.1) { $c = Mix $fg $toward $t }
  $c
}

# roles: background = the largest area; ink = strongest contrast to it among the neutrals;
# accent (teal) = the most used saturated colour; dark = a dark brand colour for tiles and the rail
$bg = $pal[0]
$darkSite = $bg.lum -lt 0.18
$accent = $pal | Where-Object { $_.sat -ge 0.35 -and $_.lum -gt 0.05 -and $_.lum -lt 0.75 } | Select-Object -First 1
if ($darkSite) {
  $panel = $pal | Where-Object { $_.hex -ne $bg.hex -and $_.lum -lt 0.25 -and $_.sat -lt 0.5 } | Select-Object -First 1
  if (-not $panel) { $panel = Mix $bg (Col 255 255 255) 0.06 }
  $darkC = $pal | Where-Object { $_.lum -lt 0.08 -and $_.hex -ne $bg.hex -and $_.hex -ne $panel.hex } | Select-Object -First 1
  if (-not $darkC) { $darkC = Mix $bg (Col 0 0 0) 0.35 }
} else {
  $darkC = $pal | Where-Object { $_.lum -lt 0.08 -and $_.hex -ne $bg.hex } | Select-Object -First 1
  # light site: boxes are white (small text and shadows make "light grey" unreliable after scaling)
  $panel = Col 255 255 255
  if (-not $darkC) { $darkC = if ($accent -and $accent.lum -lt 0.12) { $accent } else { Col 0x33 0x33 0x33 } }
}
$accentFound = [bool]$accent
if (-not $accent) { $accent = Col 0x1F 0xC8 0xC0 }   # no saturated colour in the image: Standard's turquoise
# text: the colour (also small text) with the strongest contrast to the boxes
#   (neutral colours first, so a photo in the screenshot does not set the text colour)
$inkPool = @($all | Where-Object { $_.sat -lt 0.25 }); if (-not $inkPool.Count) { $inkPool = @($all) }
$ink = $inkPool | Sort-Object { - (Contrast $_ $panel) } | Select-Object -First 1
$ink = Readable $ink $panel 7      # body text: stricter than 4.5, since scaled-down text looks lighter than it is
$white = Col 255 255 255
$onDark = if ((Contrast $white $darkC) -ge 4.5) { $white } else { Col 0x11 0x11 0x11 }
$accentRaw = $accent
$accent = Readable $accent $darkC 4.5        # KPI numbers sit on the dark tiles
$sub = Readable (Mix $ink $panel 0.38) $panel 4.5
$border = Mix $panel $ink 0.18
# a second saturated colour (another hue than the accent) becomes the template's second series colour
function Hue($x) { [System.Drawing.Color]::FromArgb([int]$x.r, [int]$x.g, [int]$x.b).GetHue() }
function HueGap($a, $b) { $d = [Math]::Abs((Hue $a) - (Hue $b)); [Math]::Min($d, 360 - $d) }
$second = $pal | Where-Object { $_.sat -ge 0.35 -and $_.lum -gt 0.05 -and $_.lum -lt 0.85 -and $_.hex -ne $accentRaw.hex -and
  (HueGap $_ $accentRaw) -gt 40 -and (HueGap $_ (Col 0xDE 0x6A 0x73)) -gt 25 } | Select-Object -First 1   # not the red of "worse"
# keys of the template (templates/<key>/template.json → colors); bad/badDark keep their meaning (red = worse)
$suggest = [ordered]@{
  dark = $darkC.hex; muted = $sub.hex; teal = $accent.hex; onDark = $onDark.hex; panel = $panel.hex
  soft = (Mix $panel $ink 0.1).hex; bar = (Mix $panel $ink 0.2).hex; axis = $ink.hex
  bad = '#DE6A73'; badDark = '#A1343C'; gold = $(if ($second) { $second.hex } else { '#E1C233' })
}
$checks = [ordered]@{
  'ink on panel' = (Contrast $ink $panel); 'sub on panel' = (Contrast $sub $panel)
  'teal on dark' = (Contrast $accent $darkC); 'onDark on dark' = (Contrast $onDark $darkC)
}
[ordered]@{
  image = (Resolve-Path $Path).Path
  siteIsDark = $darkSite
  accentFromImage = $(if ($accentFound) { $accentRaw.hex } else { $null })
  accentAdjusted = ($accentRaw.hex -ne $accent.hex)
  colors = @($pal | Select-Object -First $Top | ForEach-Object { [ordered]@{ hex = $_.hex; share = [Math]::Round($_.share * 100, 1); saturation = $_.sat } })
  suggestion = $suggest
  contrast = $checks
  contrastOk = (@($checks.Values | Where-Object { $_ -lt 4.5 }).Count -eq 0)
} | ConvertTo-Json -Depth 4
