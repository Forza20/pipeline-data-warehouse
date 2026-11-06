<#
.SYNOPSIS
  Profiles CSV files and Excel workbooks (.xlsx/.xlsm) for the pipeline-power-bi skill and writes every
  finding as JSON.

.DESCRIPTION
  Read-only. A CSV file is one table; in a workbook every Excel table (ListObject) is one table, and every
  sheet without one is a table over its used range (hidden and empty sheets are reported, flagged).
  Excel does not need to be installed. For each table it detects the encoding, delimiter and header row, then measures every column
  (empty and null-like values, spaces, format variants for dates, numbers, booleans and ids, case variants,
  anomalies) and every table (empty rows, total rows, duplicates, wide period columns, malformed lines).
  Across files it proposes relationships and counts orphan keys. Each finding names the fix id from
  references/fix-catalog.md, the rows it affects and whether the fix is recommended.
  The per-cell work runs in a small C# class (compiled once per run), so 100,000 rows take seconds.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File Profile-Sources.ps1 -Path "C:\data\orders.csv,C:\data\customers.csv" -OutFile profile.json
  powershell -NoProfile -ExecutionPolicy Bypass -File Profile-Sources.ps1 -Path "C:\data" -OutFile profile.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [string]$OutFile,
    [string]$Today = (Get-Date -Format 'yyyy-MM-dd'),
    [int]$MaxExamples = 3
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
$inv = [Globalization.CultureInfo]::InvariantCulture
$todayDate = [datetime]::ParseExact($Today, 'yyyy-MM-dd', $inv)

# ---------------------------------------------------------------------------------------------------
# Inputs: files, comma-separated lists (powershell -File passes one string) or folders
# ---------------------------------------------------------------------------------------------------
$files = New-Object System.Collections.Generic.List[string]
foreach ($p in $Path) {
    foreach ($part in ($p -split ',')) {
        $q = $part.Trim().Trim('"')
        if (-not $q) { continue }
        if (Test-Path -LiteralPath $q -PathType Container) {
            Get-ChildItem -LiteralPath $q -File | Where-Object { $_.Extension -in '.csv', '.txt', '.xlsx', '.xlsm' -and $_.Name -notlike '~$*' } | Sort-Object Name | ForEach-Object { $files.Add($_.FullName) }
        } elseif (Test-Path -LiteralPath $q -PathType Leaf) {
            if ([IO.Path]::GetExtension($q) -eq '.xls') { throw "Old Excel format (.xls) is not supported: $q. Save it as .xlsx in Excel (File > Save As) and try again." }
            $files.Add((Resolve-Path -LiteralPath $q).Path)
        } else { throw "Not found: $q" }
    }
}
if ($files.Count -eq 0) { throw 'No CSV files found.' }

# ---------------------------------------------------------------------------------------------------
# Per-cell profiling in C# (C# 5 – the compiler that ships with Windows PowerShell 5.1)
# ---------------------------------------------------------------------------------------------------
if (-not ('PpbiProfile.Profiler' -as [type])) {
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace PpbiProfile {
    public class ColStats {
        public string Name;
        public bool IdName;
        public int NonEmpty, Empty, Spaces, DayFirst, MonthFirst, Int8Date, Future, Old;
        public bool Overflow;
        public Dictionary<string, int> NullLike = new Dictionary<string, int>();
        public Dictionary<string, int> Patterns = new Dictionary<string, int>();
        public Dictionary<string, string> PatEx = new Dictionary<string, string>();
        public Dictionary<string, int> Values = new Dictionary<string, int>();
        public Dictionary<string, int> Shapes = new Dictionary<string, int>();
        public Dictionary<string, int> Keys = new Dictionary<string, int>();
        public Dictionary<string, int> KeysP = new Dictionary<string, int>();
        public Dictionary<string, int> Prefixes = new Dictionary<string, int>();
        public Dictionary<string, int> Lower = new Dictionary<string, int>();
        public List<double> Nums = new List<double>();
        public DateTime? DateMin, DateMax;
        public int P(string k) { int v; return Patterns.TryGetValue(k, out v) ? v : 0; }
        public int SumPrefix(string p) { int s = 0; foreach (var kv in Patterns) if (kv.Key.StartsWith(p)) s += kv.Value; return s; }
        public int NullCount { get { int s = 0; foreach (var v in NullLike.Values) s += v; return s; } }
    }

    public class TableStats {
        public int DataRows, EmptyRows, TotalRows, WrongCount, DupRows;
        public string ContentHash;   // header + sorted data rows: finds copied sheets/files
        public List<string> TotalExamples = new List<string>();
        public ColStats[] Cols;
    }

    public static class Profiler {
        static List<KeyValuePair<string, Regex>> pats = new List<KeyValuePair<string, Regex>>();
        static Dictionary<string, string[]> dateFormats = new Dictionary<string, string[]>();
        static Regex nullLike, total, idName, idValue;
        static Regex money = new Regex(@"[$€£%]|kr\.?|,-$|[A-Z]{3}", RegexOptions.Compiled);
        static Regex ws = new Regex(@"\s", RegexOptions.Compiled);
        static Regex digit = new Regex(@"\d", RegexOptions.Compiled);
        static Regex commaCents = new Regex(@",\d{1,2}$", RegexOptions.Compiled);
        static CultureInfo inv = CultureInfo.InvariantCulture;
        static CultureInfo da = CultureInfo.GetCultureInfo("da-DK");

        public static void Reset() { pats.Clear(); dateFormats.Clear(); }
        public static void AddPattern(string name, string rx) { pats.Add(new KeyValuePair<string, Regex>(name, new Regex(rx, RegexOptions.Compiled))); }
        public static void AddDateFormats(string name, string[] formats) { dateFormats[name] = formats; }
        public static void SetRegexes(string nul, string tot, string idn, string idv) {
            nullLike = new Regex(nul, RegexOptions.Compiled); total = new Regex(tot, RegexOptions.Compiled);
            idName = new Regex(idn, RegexOptions.Compiled); idValue = new Regex(idv, RegexOptions.Compiled);
        }
        static void Inc(Dictionary<string, int> d, string k) { int v; d.TryGetValue(k, out v); d[k] = v + 1; }

        public static string Classify(string t) {
            foreach (var p in pats) if (p.Value.IsMatch(t)) return p.Key;
            return "text";
        }

        public static double? ToDouble(string s, string pat) {
            string t = ws.Replace(money.Replace(s, "").Trim(), "");
            switch (pat) {
                case "number decimal comma": t = t.Replace(",", "."); break;
                case "number US thousands": t = t.Replace(",", ""); break;
                case "number EU thousands": t = t.Replace(".", "").Replace(",", "."); break;
                case "number space thousands": t = t.Replace(",", "."); break;
                default:
                    if (commaCents.IsMatch(t)) t = t.Replace(".", "").Replace(",", "."); else t = t.Replace(",", "");
                    break;
            }
            double d;
            if (double.TryParse(t, NumberStyles.Float, inv, out d)) return d;
            return null;
        }

        public static DateTime? ToDate(string s, string pat) {
            string[] f;
            if (!dateFormats.TryGetValue(pat, out f)) return null;
            DateTime dt;
            if (DateTime.TryParseExact(s, f, inv, DateTimeStyles.None, out dt)) return dt;
            if (DateTime.TryParseExact(s, f, da, DateTimeStyles.None, out dt)) return dt;
            return null;
        }

        public static string NormalKey(string t) {
            Match m = idValue.Match(t);
            if (m.Success) {
                long n;
                if (long.TryParse(m.Groups[2].Value, out n)) return n.ToString(inv);
                return m.Groups[2].Value.TrimStart('0');
            }
            return t.ToLowerInvariant();
        }

        // 7 and 42 are the same format (a plain number); 0007 is padded and stays its own shape
        public static string Shape(string t) {
            if (t.Length > 0 && t[0] != '0' && t[0] != '-') {
                bool allDigits = true;
                foreach (char ch in t) if (ch < '0' || ch > '9') { allDigits = false; break; }
                if (allDigits) return "N";
            }
            return digit.Replace(t, "9");
        }

        // Letter prefix in upper case ("" for a plain number); used to tell variants (C / CUST) from groups (APP / ELE)
        public static string Prefix(string t) {
            Match m = idValue.Match(t);
            return m.Success ? m.Groups[1].Value.ToUpperInvariant() : "?";
        }

        public static TableStats Process(List<string[]> rows, int h, DateTime today, int maxEx, string delim) {
            string[] header = rows[h];
            int n = header.Length;
            var ts = new TableStats();
            ts.Cols = new ColStats[n];
            for (int c = 0; c < n; c++) ts.Cols[c] = new ColStats { Name = header[c], IdName = idName.IsMatch(header[c]) };
            var seen = new HashSet<string>();
            var lines = new List<string>();
            for (int r = h + 1; r < rows.Count; r++) {
                string[] f = rows[r];
                if (f.Length != n) { ts.WrongCount++; continue; }
                string first = "";
                foreach (string v in f) { if (v.Trim().Length > 0) { first = v.Trim(); break; } }
                if (first.Length == 0) { ts.EmptyRows++; continue; }
                if (total.IsMatch(first) && !char.IsDigit(first[0])) {
                    ts.TotalRows++;
                    if (ts.TotalExamples.Count < maxEx) ts.TotalExamples.Add(string.Join(delim, f));
                    continue;
                }
                ts.DataRows++;
                string line = string.Join("\u001f", f);
                lines.Add(line);
                if (!seen.Add(line)) ts.DupRows++;
                for (int c = 0; c < n; c++) AddValue(ts.Cols[c], f[c], today);
            }
            lines.Sort(StringComparer.Ordinal);
            using (var sha = System.Security.Cryptography.SHA256.Create()) {
                byte[] b = System.Text.Encoding.UTF8.GetBytes(string.Join("\u001f", header) + "\u001e" + string.Join("\u001e", lines));
                ts.ContentHash = BitConverter.ToString(sha.ComputeHash(b)).Replace("-", "").Substring(0, 16);
            }
            return ts;
        }

        static void AddValue(ColStats col, string v, DateTime today) {
            string t = v.Trim();
            if (t.Length == 0) { col.Empty++; return; }
            if (t != v) col.Spaces++;
            if (nullLike.IsMatch(t)) { Inc(col.NullLike, t); return; }
            col.NonEmpty++;
            if (!col.Overflow) { Inc(col.Values, t); if (col.Values.Count > 5000) col.Overflow = true; }
            string pat = Classify(t);
            Inc(col.Patterns, pat);
            if (!col.PatEx.ContainsKey(pat)) col.PatEx[pat] = t;
            if (pat.StartsWith("number")) {
                if (pat == "number integer" && t.Length == 8 && (t.StartsWith("19") || t.StartsWith("20")) && ToDate(t, "int8") != null) col.Int8Date++;
                double? d = ToDouble(t, pat);
                if (d.HasValue) col.Nums.Add(d.Value);
            }
            if (pat.StartsWith("date")) {
                if (pat == "date d/M/yyyy" || pat == "date d-M-yyyy" || pat == "date dd.MM.yyyy") {
                    string[] parts = t.Split('/', '.', '-');
                    int a, b;
                    if (int.TryParse(parts[0], out a) && int.TryParse(parts[1], out b)) {
                        if (a > 12) col.DayFirst++; else if (b > 12) col.MonthFirst++;
                    }
                }
                DateTime? dt = ToDate(t, pat);
                if (dt.HasValue) {
                    if (!col.DateMin.HasValue || dt.Value < col.DateMin.Value) col.DateMin = dt;
                    if (!col.DateMax.HasValue || dt.Value > col.DateMax.Value) col.DateMax = dt;
                    if (dt.Value > today) col.Future++;
                    if (dt.Value.Year < 1900) col.Old++;
                }
            }
            if (col.IdName || pat == "id prefixed") {
                Inc(col.Shapes, Shape(t));
                string nk = NormalKey(t), px = Prefix(t);
                Inc(col.Keys, nk);
                Inc(col.KeysP, px + "|" + nk);
                Inc(col.Prefixes, px);
            }
            if (!col.Overflow) Inc(col.Lower, t.ToLowerInvariant());
        }
    }
}
'@
}

# ---------------------------------------------------------------------------------------------------
# xlsx reader in C#: no Excel needed. One part per Excel table (ListObject); a sheet without a table is
# one part over its used range. Dates (by cell style) become yyyy-MM-dd text, numbers invariant text,
# so the same profiling runs on CSV and Excel.
# ---------------------------------------------------------------------------------------------------
if (-not ('PpbiProfile.Xlsx' -as [type])) {
Add-Type -Language CSharp -ReferencedAssemblies 'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Xml' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;

namespace PpbiProfile {
    public class XlsxPart {
        public string Sheet, Table, Ref;
        public bool Hidden;
        public List<string[]> Rows = new List<string[]>();
    }

    public static class Xlsx {
        static CultureInfo inv = CultureInfo.InvariantCulture;

        static XmlDocument Doc(ZipArchive z, string path) {
            var e = z.GetEntry(path);
            if (e == null) return null;
            var d = new XmlDocument();
            using (var s = e.Open()) d.Load(s);
            return d;
        }

        static string Attr(XmlNode n, string name) {
            var a = n.Attributes == null ? null : n.Attributes[name];
            return a == null ? null : a.Value;
        }

        static string Resolve(string baseDir, string target) {
            if (target.StartsWith("/")) return target.TrimStart('/');
            var parts = new List<string>(baseDir.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries));
            foreach (var p in target.Split('/')) {
                if (p == "..") { if (parts.Count > 0) parts.RemoveAt(parts.Count - 1); }
                else if (p != "." && p.Length > 0) parts.Add(p);
            }
            return string.Join("/", parts);
        }

        static Dictionary<string, string> Rels(ZipArchive z, string relsPath, string baseDir, string typeSuffix) {
            var map = new Dictionary<string, string>();
            var d = Doc(z, relsPath);
            if (d == null) return map;
            foreach (XmlNode n in d.GetElementsByTagName("Relationship")) {
                string type = Attr(n, "Type") ?? "";
                if (typeSuffix != null && !type.EndsWith(typeSuffix)) continue;
                map[Attr(n, "Id")] = Resolve(baseDir, Attr(n, "Target"));
            }
            return map;
        }

        static string InnerText(XmlReader r) {
            if (r.IsEmptyElement) return "";
            var sb = new StringBuilder();
            int depth = r.Depth;
            while (r.Read()) {
                if (r.NodeType == XmlNodeType.EndElement && r.Depth == depth) break;
                if (r.NodeType == XmlNodeType.Text || r.NodeType == XmlNodeType.SignificantWhitespace
                    || r.NodeType == XmlNodeType.Whitespace || r.NodeType == XmlNodeType.CDATA) sb.Append(r.Value);
            }
            return sb.ToString();
        }

        // Text of an <si> or <is> element: every <t>, except phonetic runs (<rPh>)
        static string RichText(XmlReader r) {
            if (r.IsEmptyElement) return "";
            var sb = new StringBuilder();
            int depth = r.Depth, phonetic = 0;
            while (r.Read()) {
                if (r.NodeType == XmlNodeType.EndElement && r.Depth == depth) break;
                if (r.NodeType == XmlNodeType.Element && r.LocalName == "rPh" && !r.IsEmptyElement) phonetic++;
                else if (r.NodeType == XmlNodeType.EndElement && r.LocalName == "rPh") phonetic--;
                else if (r.NodeType == XmlNodeType.Element && r.LocalName == "t" && phonetic == 0) sb.Append(InnerText(r));
            }
            return sb.ToString();
        }

        static List<string> Shared(ZipArchive z) {
            var list = new List<string>();
            var e = z.GetEntry("xl/sharedStrings.xml");
            if (e == null) return list;
            using (var s = e.Open())
            using (var r = XmlReader.Create(s)) {
                while (r.Read()) if (r.NodeType == XmlNodeType.Element && r.LocalName == "si") list.Add(RichText(r));
            }
            return list;
        }

        static bool IsDateFormat(int id, Dictionary<int, string> custom) {
            if ((id >= 14 && id <= 17) || id == 22 || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return true;
            string code;
            if (!custom.TryGetValue(id, out code)) return false;
            string c = Regex.Replace(code, "\"[^\"]*\"|\\[[^\\]]*\\]|\\\\.", "").ToLowerInvariant().Split(';')[0];
            if (c.Contains("y") || c.Contains("d")) return true;
            return c.Contains("m") && !c.Contains("h") && !c.Contains("s");
        }

        static HashSet<int> DateStyles(ZipArchive z) {
            var set = new HashSet<int>();
            var d = Doc(z, "xl/styles.xml");
            if (d == null) return set;
            var custom = new Dictionary<int, string>();
            foreach (XmlNode n in d.GetElementsByTagName("numFmt")) {
                int id;
                if (int.TryParse(Attr(n, "numFmtId"), out id)) custom[id] = Attr(n, "formatCode") ?? "";
            }
            var xfs = d.GetElementsByTagName("cellXfs");
            if (xfs.Count == 0) return set;
            int i = 0;
            foreach (XmlNode xf in xfs[0].ChildNodes) {
                if (xf.NodeType != XmlNodeType.Element) continue;
                int id = 0;
                int.TryParse(Attr(xf, "numFmtId") ?? "0", out id);
                if (IsDateFormat(id, custom)) set.Add(i);
                i++;
            }
            return set;
        }

        static void ParseCell(string a, out int row, out int col) {
            col = 0; int i = 0;
            while (i < a.Length && char.IsLetter(a[i])) { col = col * 26 + (char.ToUpperInvariant(a[i]) - 'A' + 1); i++; }
            row = i < a.Length ? int.Parse(a.Substring(i), inv) : 0;
        }

        static void ParseRef(string r, out int r1, out int c1, out int r2, out int c2) {
            string[] p = r.Split(':');
            ParseCell(p[0], out r1, out c1);
            if (p.Length > 1) ParseCell(p[1], out r2, out c2); else { r2 = r1; c2 = c1; }
        }

        static string ColName(int c) {
            string s = "";
            while (c > 0) { int m = (c - 1) % 26; s = (char)('A' + m) + s; c = (c - 1) / 26; }
            return s;
        }

        static string Convert(string v, string inline, string t, int style, List<string> shared, HashSet<int> dates, bool d1904) {
            if (t == "inlineStr") return inline ?? "";
            if (v == null) return "";
            switch (t) {
                case "s": { int i; return int.TryParse(v, out i) && i >= 0 && i < shared.Count ? shared[i] : ""; }
                case "b": return v == "1" ? "TRUE" : "FALSE";
                case "e": return v;
                case "str": return v;
                case "d": return v.Length >= 10 ? v.Substring(0, 10) : v;
            }
            double d;
            if (!double.TryParse(v, NumberStyles.Float, inv, out d)) return v;
            if (style >= 0 && dates.Contains(style) && d > -657435 && d < 2958466) {
                DateTime dt = DateTime.FromOADate(d1904 ? d + 1462 : d);
                return dt.TimeOfDay.Ticks == 0 ? dt.ToString("yyyy-MM-dd", inv) : dt.ToString("yyyy-MM-dd HH:mm", inv);
            }
            return d.ToString("0.###############", inv);
        }

        static Dictionary<long, string> ReadSheet(ZipArchive z, string path, List<string> shared, HashSet<int> dates, bool d1904,
                                                 out int minR, out int minC, out int maxR, out int maxC) {
            var cells = new Dictionary<long, string>();
            minR = int.MaxValue; minC = int.MaxValue; maxR = 0; maxC = 0;
            using (var s = z.GetEntry(path).Open())
            using (var r = XmlReader.Create(s)) {
                int row = 0, col = 0;
                while (r.Read()) {
                    if (r.NodeType != XmlNodeType.Element) continue;
                    if (r.LocalName == "row") {
                        string ra = r.GetAttribute("r");
                        row = ra != null ? int.Parse(ra, inv) : row + 1;
                        col = 0;
                    } else if (r.LocalName == "c") {
                        string ca = r.GetAttribute("r");
                        if (ca != null) { int rr, cc; ParseCell(ca, out rr, out cc); if (rr > 0) row = rr; col = cc; } else col++;
                        string t = r.GetAttribute("t");
                        int style = -1;
                        string sa = r.GetAttribute("s");
                        if (sa != null) int.TryParse(sa, out style);
                        string v = null, inline = null;
                        if (!r.IsEmptyElement) {
                            int depth = r.Depth;
                            while (r.Read()) {
                                if (r.NodeType == XmlNodeType.EndElement && r.Depth == depth) break;
                                if (r.NodeType != XmlNodeType.Element) continue;
                                if (r.LocalName == "v") v = InnerText(r);
                                else if (r.LocalName == "is") inline = RichText(r);
                            }
                        }
                        string val = Convert(v, inline, t, style, shared, dates, d1904);
                        if (!string.IsNullOrEmpty(val)) {
                            cells[(long)row * 20000 + col] = val;
                            if (row < minR) minR = row; if (col < minC) minC = col;
                            if (row > maxR) maxR = row; if (col > maxC) maxC = col;
                        }
                    }
                }
            }
            if (maxR == 0) { minR = 0; minC = 0; }
            return cells;
        }

        static List<string[]> ToRows(Dictionary<long, string> cells, int r1, int c1, int r2, int c2) {
            var rows = new List<string[]>();
            for (int r = r1; r <= r2; r++) {
                var a = new string[c2 - c1 + 1];
                for (int c = c1; c <= c2; c++) {
                    string v;
                    a[c - c1] = cells.TryGetValue((long)r * 20000 + c, out v) ? v : "";
                }
                rows.Add(a);
            }
            return rows;
        }

        public static List<XlsxPart> Read(string path) {
            var result = new List<XlsxPart>();
            using (var z = ZipFile.OpenRead(path)) {
                var shared = Shared(z);
                var dates = DateStyles(z);
                var wb = Doc(z, "xl/workbook.xml");
                if (wb == null) throw new Exception("Not an Excel workbook (xl/workbook.xml missing): " + path);
                bool d1904 = false;
                foreach (XmlNode n in wb.GetElementsByTagName("workbookPr")) {
                    string a = Attr(n, "date1904");
                    if (a == "1" || a == "true") d1904 = true;
                }
                var rels = Rels(z, "xl/_rels/workbook.xml.rels", "xl", null);
                foreach (XmlNode s in wb.GetElementsByTagName("sheet")) {
                    string name = Attr(s, "name"), rid = null;
                    foreach (XmlAttribute a in s.Attributes) if (a.LocalName == "id" && a.NamespaceURI.Contains("relationships")) rid = a.Value;
                    string state = Attr(s, "state");
                    bool hidden = state != null && state != "visible";
                    string target;
                    if (rid == null || !rels.TryGetValue(rid, out target) || z.GetEntry(target) == null || !target.Contains("worksheets/")) continue;
                    int minR, minC, maxR, maxC;
                    var cells = ReadSheet(z, target, shared, dates, d1904, out minR, out minC, out maxR, out maxC);
                    string dir = target.Substring(0, target.LastIndexOf('/'));
                    string file = target.Substring(target.LastIndexOf('/') + 1);
                    var tableRels = Rels(z, dir + "/_rels/" + file + ".rels", dir, "/table");
                    int found = 0;
                    foreach (var tp in tableRels.Values) {
                        var td = Doc(z, tp);
                        if (td == null) continue;
                        var root = td.DocumentElement;
                        var p = new XlsxPart { Sheet = name, Hidden = hidden, Table = Attr(root, "displayName") ?? Attr(root, "name"), Ref = Attr(root, "ref") };
                        int r1, c1, r2, c2;
                        ParseRef(p.Ref, out r1, out c1, out r2, out c2);
                        p.Rows = ToRows(cells, r1, c1, r2, c2);
                        if (Attr(root, "headerRowCount") == "0") {
                            var hdr = new string[c2 - c1 + 1];
                            for (int i = 0; i < hdr.Length; i++) hdr[i] = "Column" + (i + 1);
                            p.Rows.Insert(0, hdr);
                        }
                        result.Add(p);
                        found++;
                    }
                    if (found == 0) {
                        var p = new XlsxPart { Sheet = name, Hidden = hidden };
                        if (maxR > 0) { p.Ref = ColName(minC) + minR + ":" + ColName(maxC) + maxR; p.Rows = ToRows(cells, minR, minC, maxR, maxC); }
                        result.Add(p);
                    }
                }
            }
            return result;
        }
    }
}
'@
}

# ---------------------------------------------------------------------------------------------------
# Patterns. Order matters: the first match wins.
# ---------------------------------------------------------------------------------------------------
$patternList = @(
    @('date yyyy-MM-dd',          '^\d{4}-\d{1,2}-\d{1,2}$'),
    @('date yyyy-MM-dd HH:mm',    '^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2})?$'),
    @('date yyyy/MM/dd',          '^\d{4}/\d{1,2}/\d{1,2}$'),
    @('date dd.MM.yyyy',          '^\d{1,2}\.\d{1,2}\.\d{4}$'),
    @('date d/M/yyyy',            '^\d{1,2}/\d{1,2}/\d{4}$'),
    @('date d-M-yyyy',            '^\d{1,2}-\d{1,2}-\d{4}$'),
    @('date MMM d yyyy',          '^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$'),
    @('date d MMM yyyy',          '^\d{1,2}\.? [A-Za-z]{3,9}\.?,? \d{4}$'),
    @('bool word',                '^(?i:true|false|yes|no|y|n|t|f|ja|nej|j|sand|falsk)$'),
    @('id prefixed',              '^(?!(?i:usd|eur|dkk|gbp|sek|nok|chf|jpy|kr)[ .]?\d)[A-Za-z]{1,6}[-_]?\d+$'),
    @('number integer',           '^-?\d+$'),
    @('number decimal point',     '^-?\d*\.\d+$'),
    @('number US thousands',      '^-?\d{1,3}(,\d{3})+(\.\d+)?$'),
    @('number EU thousands',      '^-?\d{1,3}(\.\d{3})+(,\d+)?$'),
    @('number decimal comma',     '^-?\d+,(\d{1,2}|\d{4,})$'),
    @('number space thousands',   '^-?\d{1,3}( \d{3})+([.,]\d+)?$'),
    @('number with currency',     '^(?:[$€£]|[A-Z]{3}|kr\.?)\s?-?\d[\d.,\s]*$|^-?\d[\d.,\s]*\s?(?:[$€£]|[A-Z]{3}|kr\.?|,-)$'),
    @('number percent',           '^-?\d[\d.,]*\s?%$')
)
[PpbiProfile.Profiler]::Reset()
foreach ($pp in $patternList) { [PpbiProfile.Profiler]::AddPattern($pp[0], $pp[1]) }
$dateFormats = @{
    'date yyyy-MM-dd'       = @('yyyy-M-d')
    'date yyyy-MM-dd HH:mm' = @('yyyy-M-d H:mm', 'yyyy-M-d H:mm:ss', 'yyyy-M-dTH:mm', 'yyyy-M-dTH:mm:ss')
    'date yyyy/MM/dd'       = @('yyyy/M/d')
    'date dd.MM.yyyy'       = @('d.M.yyyy')
    'date d/M/yyyy'         = @('d/M/yyyy', 'M/d/yyyy')
    'date d-M-yyyy'         = @('d-M-yyyy', 'M-d-yyyy')
    'date MMM d yyyy'       = @('MMM d yyyy', 'MMM d, yyyy', 'MMMM d yyyy', 'MMMM d, yyyy', 'MMM. d yyyy')
    'date d MMM yyyy'       = @('d MMM yyyy', 'd. MMM yyyy', 'd MMMM yyyy', 'd. MMMM yyyy', 'd MMM, yyyy')
    'int8'                  = @('yyyyMMdd')
}
foreach ($k in $dateFormats.Keys) { [PpbiProfile.Profiler]::AddDateFormats($k, [string[]]$dateFormats[$k]) }
[PpbiProfile.Profiler]::SetRegexes(
    '^(?i:null|nil|n/?a|#n/?a|none|nan|-|--|\?|missing|unknown|ukendt|ingen)$',
    '^(?i:total|totals|grand total|subtotal|sub-total|sum|i alt|samlet|totalt)\b',
    '(?i:^id$|_id$|^key$|_key$|nr$|_no$|number$|nummer$|code$|kode$)|[a-z]ID$|[a-z]Id$',
    '^([A-Za-z]*)[-_ ]?0*(\d+)$')

$rxIdName   = New-Object regex('(?i:^id$|_id$|^key$|_key$|nr$|_no$|number$|nummer$|code$|kode$)|[a-z]ID$|[a-z]Id$')
$rxTechName = New-Object regex('(?i)^(_.*|.*hash.*|checksum|row_?version|etl_.*|.*_?etl|load_?(ts|date|time|id)|loaded_?at|ingest.*|batch_?id|source_?(id|system|key)|src_?id|record_?source|meta_.*)$')
$rxPiiName  = New-Object regex('(?i)(e-?mail|^mail|phone|telefon|^tlf|mobil|cpr|ssn|social_?security|birth|f(oe|ø)dsel|contact_?name|kontaktperson|^street|gade|^address(line)?\d?$|adresse$|ip_?address|passport|iban|account_?number)')
$textStore = @{}
# A whole field that says test/dummy/placeholder, or a name containing one of those phrases
$rxTestRow  = New-Object regex('(?i)(^|\x1f)\s*(test|testing|dummy|do not use|don''t use|dont use|placeholder|sample|demo|delete( me)?|deleted|ignore|xxx+|tbd)\s*(\x1f|$)|\b(test (account|customer|user|product|item|order|record|data)|do not use|dummy (account|customer|product|record)|placeholder)\b')
# Ids that are typical placeholders: 9999, 99999, 0, -1, ZZZ-…, XXX…, TEST…
$rxTestId   = New-Object regex('(?i)^(9{4,}|0+|-1|(zzz|xxx|tst|test|dummy)[-_ ]?\w*)$')
$rxCodeName = New-Object regex('(?i)(code|channel|type|status|kind|class|group|level|flag|segment|tier|grade|reason|source|method|mode|kode|kanal|gruppe)$')
$rxPrimaryName = New-Object regex('(?i)(primary|main|default|principal|is_?main|hoved|prim(æ|ae)r)')
$rxMonthCol = New-Object regex('(?i)^(jan|feb|mar|apr|may|maj|jun|jul|aug|sep|oct|okt|nov|dec)[a-z]*\.?$|^(19|20)\d{2}[-_ ]?(0[1-9]|1[0-2])$|^q[1-4]$')
$rxAmtName  = New-Object regex('(?i)(amount|price|revenue|sales|total|value|cost|beløb|belob|pris|omsætning|salg|qty|quantity|antal)')
$rxDateName = New-Object regex('(?i)(date|dato|day|dag|time|tid|_at$|_on$)')
$rxBoolName = New-Object regex('(?i)(^is_|^has_|^is[A-Z]|flag|paid|active|aktiv|betalt)')
$boolSet = @('true', 'false', 'yes', 'no', 'y', 'n', 't', 'f', '1', '0', 'ja', 'nej', 'j', 'sand', 'falsk')

# ---------------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------------
function Get-FileEncoding([string]$file) {
    $fs = [IO.File]::OpenRead($file)
    try { $buf = New-Object byte[] 1048576; $n = $fs.Read($buf, 0, $buf.Length); $full = ($fs.Length -le $buf.Length) } finally { $fs.Close() }
    if ($n -ge 3 -and $buf[0] -eq 0xEF -and $buf[1] -eq 0xBB -and $buf[2] -eq 0xBF) { return @{ Name = 'UTF-8 (BOM)'; CodePage = 65001; Encoding = (New-Object Text.UTF8Encoding($true)) } }
    if ($n -ge 2 -and $buf[0] -eq 0xFF -and $buf[1] -eq 0xFE) { return @{ Name = 'UTF-16 LE'; CodePage = 1200; Encoding = [Text.Encoding]::Unicode } }
    if ($n -ge 2 -and $buf[0] -eq 0xFE -and $buf[1] -eq 0xFF) { return @{ Name = 'UTF-16 BE'; CodePage = 1201; Encoding = [Text.Encoding]::BigEndianUnicode } }
    $len = $n
    if (-not $full) { while ($len -gt 0 -and (($buf[$len - 1] -band 0xC0) -eq 0x80)) { $len-- }; if ($len -gt 0) { $len-- } }
    try {
        $strict = New-Object Text.UTF8Encoding($false, $true)
        [void]$strict.GetString($buf, 0, $len)
        $ascii = $true; for ($i = 0; $i -lt $len; $i++) { if ($buf[$i] -gt 127) { $ascii = $false; break } }
        return @{ Name = $(if ($ascii) { 'UTF-8 (ASCII only)' } else { 'UTF-8' }); CodePage = 65001; Encoding = (New-Object Text.UTF8Encoding($false)) }
    } catch {
        return @{ Name = 'Windows-1252'; CodePage = 1252; Encoding = [Text.Encoding]::GetEncoding(1252) }
    }
}

function Get-CountOutsideQuotes([string]$line, [char]$d) {
    $c = 0; $inQ = $false
    foreach ($ch in $line.ToCharArray()) { if ($ch -eq '"') { $inQ = -not $inQ } elseif (-not $inQ -and $ch -eq $d) { $c++ } }
    return $c
}

function Get-Delimiter([string]$file, $enc) {
    $sr = New-Object IO.StreamReader($file, $enc, $true)
    $lines = New-Object System.Collections.Generic.List[string]
    try { while ($lines.Count -lt 30 -and -not $sr.EndOfStream) { $l = $sr.ReadLine(); if ($l.Trim()) { $lines.Add($l) } } } finally { $sr.Close() }
    $best = ','; $bestScore = -1
    foreach ($d in @([char]',', [char]';', [char]"`t", [char]'|')) {
        $counts = @(foreach ($l in $lines) { Get-CountOutsideQuotes $l $d })
        $mode = $counts | Group-Object | Sort-Object Count -Descending | Select-Object -First 1
        if (-not $mode -or [int]$mode.Name -eq 0) { continue }
        $score = $mode.Count * 1000 + [int]$mode.Name
        if ($score -gt $bestScore) { $bestScore = $score; $best = [string]$d }
    }
    return $best
}

function Get-ReadableName([string]$name) {
    $t = $name.Trim() -replace '[_]+', ' ' -creplace '([a-z])([A-Z])', '$1 $2'
    $t = ($t -replace '\s+', ' ').Trim()
    if (-not $t) { return $name }
    $t = $t.ToLowerInvariant() -replace '\bid\b', 'ID'
    return $t.Substring(0, 1).ToUpperInvariant() + $t.Substring(1)
}

function New-Finding($table, $fix, $column, $count, $detail, $examples, $recommended, $variant) {
    [pscustomobject]@{ fix = $fix; table = $table; column = $column; rows = $count; detail = $detail; examples = @($examples); recommended = $recommended; variant = $variant }
}

# ---------------------------------------------------------------------------------------------------
# Profile each file
# ---------------------------------------------------------------------------------------------------
$tables = New-Object System.Collections.Generic.List[object]
$keyStore = @{}

# Sources: one per CSV file; per Excel workbook one per Excel table, or per sheet when it has no table
$sources = New-Object System.Collections.Generic.List[object]
foreach ($file in $files) {
    $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
    if ($ext -eq '.xlsx' -or $ext -eq '.xlsm') {
        foreach ($part in [PpbiProfile.Xlsx]::Read($file)) {
            $sources.Add([pscustomobject]@{
                name = $(if ($part.Table) { $part.Table } else { $part.Sheet }); file = $file
                kind = $(if ($part.Table) { 'excel table' } else { 'sheet' }); sheet = $part.Sheet; excelTable = $part.Table
                range = $part.Ref; hidden = $part.Hidden; rows = $part.Rows; malformed = 0; malformedLines = @()
                encoding = 'xlsx'; codePage = $null; delimiter = $null
            })
        }
        continue
    }
    $enc = Get-FileEncoding $file
    $delim = Get-Delimiter $file $enc.Encoding
    $parser = New-Object Microsoft.VisualBasic.FileIO.TextFieldParser($file, $enc.Encoding)
    $parser.TextFieldType = [Microsoft.VisualBasic.FileIO.FieldType]::Delimited
    $parser.SetDelimiters($delim)
    $parser.HasFieldsEnclosedInQuotes = $true
    $parser.TrimWhiteSpace = $false
    $rows = New-Object 'System.Collections.Generic.List[string[]]'
    $malformed = 0; $malformedLines = New-Object System.Collections.Generic.List[long]
    try {
        while (-not $parser.EndOfData) {
            try { $f = $parser.ReadFields(); if ($null -ne $f) { $rows.Add([string[]]$f) } }
            catch [Microsoft.VisualBasic.FileIO.MalformedLineException] { $malformed++; if ($malformedLines.Count -lt $MaxExamples) { $malformedLines.Add($parser.ErrorLineNumber) } }
        }
    } finally { $parser.Close() }
    $sources.Add([pscustomobject]@{
        name = [IO.Path]::GetFileNameWithoutExtension($file); file = $file; kind = 'csv'; sheet = $null; excelTable = $null
        range = $null; hidden = $false; rows = $rows; malformed = $malformed; malformedLines = @($malformedLines)
        encoding = $enc.Name; codePage = $enc.CodePage; delimiter = $delim
    })
}
# Same name from two files (two workbooks with a "Sheet1"): prefix the file name
$dupNamesAll = @($sources | Group-Object name | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
foreach ($s in $sources) { if ($dupNamesAll -contains $s.name) { $s.name = [IO.Path]::GetFileNameWithoutExtension($s.file) + ' - ' + $s.name } }

foreach ($src in $sources) {
    $tableName = $src.name; $file = $src.file; $rows = $src.rows
    $malformed = $src.malformed; $malformedLines = $src.malformedLines
    $delim = $(if ($src.delimiter) { $src.delimiter } else { ',' })
    $sourceInfo = [ordered]@{
        name = $tableName; file = $file; kind = $src.kind; sheet = $src.sheet; excelTable = $src.excelTable; range = $src.range; hidden = $src.hidden
        encoding = $src.encoding; codePage = $src.codePage; delimiter = $(if ($src.delimiter -eq "`t") { 'tab' } else { $src.delimiter })
    }
    if ($null -eq $rows -or $rows.Count -eq 0) {
        $empty = [pscustomobject]$sourceInfo
        $empty | Add-Member -NotePropertyMembers @{ isEmpty = $true; dataRows = 0; columnsCount = 0; columns = @(); findings = (New-Object System.Collections.Generic.List[object]); monthCandidate = $null }
        $tables.Add($empty); continue
    }

    if ($src.kind -eq 'csv') {
        # Header = first line with the most common field count (title lines above it have fewer fields)
        $fieldCounts = @{}; foreach ($r in $rows) { $k = $r.Length; if ($fieldCounts.ContainsKey($k)) { $fieldCounts[$k]++ } else { $fieldCounts[$k] = 1 } }
        $modal = ($fieldCounts.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
        $h = 0; while ($h -lt $rows.Count -and $rows[$h].Length -ne $modal) { $h++ }
    } elseif ($src.kind -eq 'excel table') {
        $h = 0
    } else {
        # Sheet rows all have the same width: header = first row with at least 60 % of the fullest row's cells
        $limit = [Math]::Min(30, $rows.Count); $ne = @(for ($i = 0; $i -lt $limit; $i++) { @($rows[$i] | Where-Object { $_.Trim() }).Count })
        $maxNe = ($ne | Measure-Object -Maximum).Maximum
        $need = [Math]::Max(1, [Math]::Ceiling(0.6 * $maxNe))
        $h = 0; while ($h -lt $limit -and $ne[$h] -lt $need) { $h++ }
    }
    $header = $rows[$h]
    $nCol = $header.Length

    $ts = [PpbiProfile.Profiler]::Process($rows, $h, $todayDate, $MaxExamples, $delim)
    $cols = $ts.Cols
    $dataRows = $ts.DataRows; $dupRows = $ts.DupRows

    # -----------------------------------------------------------------------------------------------
    # Column kinds and column findings
    # -----------------------------------------------------------------------------------------------
    $findings = New-Object System.Collections.Generic.List[object]
    $colOut = New-Object System.Collections.Generic.List[object]
    foreach ($col in $cols) {
        $ne = $col.NonEmpty
        $pc = $col.Patterns
        $cname = $col.Name
        $dates = $col.SumPrefix('date')
        $numbers = $col.SumPrefix('number')
        $distinct = $col.Values.Count
        $lowerVals = @{}; foreach ($k in $col.Values.Keys) { $lowerVals[$k.ToLowerInvariant()] = 1 }
        $allBoolish = ($distinct -gt 0 -and -not $col.Overflow -and @($lowerVals.Keys | Where-Object { $boolSet -notcontains $_ }).Count -eq 0)
        $int8 = $(if ($dates -gt 0 -or $rxDateName.IsMatch($cname)) { $col.Int8Date } else { 0 })

        $kind = 'text'
        if ($ne -eq 0) { $kind = 'empty' }
        elseif (($dates + $int8) -ge 0.8 * $ne) { $kind = 'date' }
        elseif ($allBoolish -and ($pc.ContainsKey('bool word') -or $rxBoolName.IsMatch($cname))) { $kind = 'bool' }
        elseif ($col.IdName -and (($col.P('id prefixed') + $col.P('number integer')) -ge 0.9 * $ne)) { $kind = 'id' }
        elseif ($col.P('id prefixed') -ge 0.9 * $ne) { $kind = 'id' }
        elseif ($numbers -ge 0.9 * $ne) { $kind = $(if ($col.P('number integer') -eq $ne) { 'integer' } else { 'decimal' }) }
        elseif ($distinct -le 50 -and -not $col.Overflow -and $distinct -lt 0.5 * $ne) { $kind = 'category' }

        $nullCount = $col.NullCount

        if ($kind -eq 'empty') { $findings.Add((New-Finding $tableName 'F19' $cname ($col.Empty + $nullCount) 'Column is empty in every row' @() $true $null)) }
        if ($col.Spaces -gt 0) { $findings.Add((New-Finding $tableName 'F05' $cname $col.Spaces 'Values with leading or trailing spaces' @() $true $null)) }
        if ($nullCount -gt 0 -and $kind -ne 'empty') {
            $findings.Add((New-Finding $tableName 'F06' $cname $nullCount ('Text that means "no value": ' + ((@($col.NullLike.Keys) | ForEach-Object { "'$_' $($col.NullLike[$_])" }) -join ', ')) @($col.NullLike.Keys) $true $null))
        }
        if ($kind -eq 'date') {
            $datePats = @($pc.Keys | Where-Object { $_ -like 'date*' })
            if ($int8 -gt 0) { $datePats += 'number integer' }
            $ex = @($datePats | ForEach-Object { $col.PatEx[$_] })
            $detailParts = @($datePats | ForEach-Object { $nm = $(if ($_ -eq 'number integer') { 'yyyyMMdd' } else { $_ -replace '^date ', '' }); "$nm $(if ($_ -eq 'number integer') { $int8 } else { $pc[$_] })" })
            $nonIso = $ne - $col.P('date yyyy-MM-dd') - $col.P('date yyyy-MM-dd HH:mm')
            $order = ''
            if ($col.DayFirst -gt 0 -or $col.MonthFirst -gt 0) { $order = "; day-first evidence $($col.DayFirst), month-first evidence $($col.MonthFirst)" }
            $variant = $(if ($col.MonthFirst -gt $col.DayFirst) { 'month-first' } else { 'day-first' })
            if ($datePats.Count -gt 1 -or $col.P('date d/M/yyyy') -gt 0 -or $col.P('date d-M-yyyy') -gt 0) {
                $findings.Add((New-Finding $tableName 'F08' $cname $nonIso ("$($datePats.Count) date format(s): " + ($detailParts -join ' | ') + $order) $ex $true $variant))
            }
            $other = $ne - $dates - $int8
            if ($other -gt 0) { $findings.Add((New-Finding $tableName 'F15' $cname $other 'Values in a date column that are not dates' @() $true 'flag')) }
            if ($col.Future -gt 0) { $findings.Add((New-Finding $tableName 'F15' $cname $col.Future "Dates after $Today" @() $true 'flag')) }
            if ($col.Old -gt 0) { $findings.Add((New-Finding $tableName 'F15' $cname $col.Old 'Dates before 1900' @() $true 'flag')) }
        }
        if ($kind -eq 'decimal' -or $kind -eq 'integer') {
            $numPats = @($pc.Keys | Where-Object { $_ -like 'number*' })
            $odd = @($numPats | Where-Object { $_ -notin @('number integer', 'number decimal point') })
            if ($odd.Count -gt 0) {
                $plain = $col.P('number integer') + $col.P('number decimal point')
                $findings.Add((New-Finding $tableName 'F09' $cname ($ne - $plain) ('Number formats: ' + (($numPats | ForEach-Object { "$($_ -replace '^number ', '') $($pc[$_])" }) -join ' | ')) @($numPats | ForEach-Object { $col.PatEx[$_] }) $true $null))
            }
            $other = $ne - $numbers
            if ($other -gt 0) { $findings.Add((New-Finding $tableName 'F09' $cname $other 'Values in a number column that are not numbers' @() $true 'flag')) }
            if ($rxAmtName.IsMatch($cname) -and $col.Nums.Count -gt 0) {
                $neg = 0; $zero = 0; $posList = New-Object System.Collections.Generic.List[double]
                foreach ($x in $col.Nums) { if ($x -lt 0) { $neg++ } elseif ($x -eq 0) { $zero++ } else { $posList.Add($x) } }
                $spike = 0; $median = $null
                if ($posList.Count -ge 20) { $posList.Sort(); $median = $posList[[int][Math]::Floor($posList.Count / 2)]; foreach ($x in $posList) { if ($x -gt 10 * $median) { $spike++ } } }
                if ($neg -gt 0) { $findings.Add((New-Finding $tableName 'F14' $cname $neg 'Negative values' @() $true 'flag')) }
                if ($zero -gt 0) { $findings.Add((New-Finding $tableName 'F14' $cname $zero 'Zero values' @() $false 'flag')) }
                if ($spike -gt 0) { $findings.Add((New-Finding $tableName 'F14' $cname $spike ('Values above 10 x the median ({0:N2})' -f $median) @() $true 'flag')) }
            }
        }
        if ($kind -eq 'bool' -and $distinct -gt 2) {
            $findings.Add((New-Finding $tableName 'F10' $cname $ne ("$distinct spellings of true/false: " + ((@($col.Values.Keys) | Select-Object -First 16) -join ', ')) @(@($col.Values.Keys) | Select-Object -First $MaxExamples) $true $null))
        }
        # Letter prefixes are spelling variants of one key (CUST / C / none) when they share a first
        # letter; otherwise they are groups that belong to the key (APP-001 and ELE-001 are two products)
        $px = @($col.Prefixes.Keys | Where-Object { $_ -and $_ -ne '?' })
        $prefixIsPart = (@($px | ForEach-Object { $_.Substring(0, 1) } | Select-Object -Unique).Count -gt 1)
        if ($kind -eq 'id' -and $col.Shapes.Count -gt 1 -and -not $prefixIsPart) {
            $top = @($col.Shapes.GetEnumerator() | Sort-Object Value -Descending)
            $canon = $top[0].Key
            $findings.Add((New-Finding $tableName 'F11' $cname ($ne - $col.Shapes[$canon]) ("$($col.Shapes.Count) id formats: " + (($top | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ' | ')) @($top | Select-Object -First $MaxExamples | ForEach-Object { $_.Key }) $true $canon))
        }
        if (($kind -eq 'category' -or $kind -eq 'text') -and -not $col.Overflow -and $lowerVals.Count -lt $distinct) {
            $groups = @(@($col.Values.Keys) | Group-Object { $_.ToLowerInvariant() } | Where-Object { $_.Count -gt 1 })
            $affected = 0
            foreach ($g in $groups) { $vals = @($g.Group | ForEach-Object { $col.Values[$_] } | Sort-Object -Descending); $affected += ($vals | Measure-Object -Sum).Sum - $vals[0] }
            $findings.Add((New-Finding $tableName 'F07' $cname $affected ("$($groups.Count) value(s) written in more than one case: " + (($groups | Select-Object -First 3 | ForEach-Object { ($_.Group -join ' / ') }) -join '; ')) @() $true $null))
        }

        $min = $null; $max = $null; $sumAll = $null
        if ($col.Nums.Count -gt 0 -and ($kind -eq 'decimal' -or $kind -eq 'integer')) { $m = $col.Nums | Measure-Object -Minimum -Maximum -Sum; $min = $m.Minimum; $max = $m.Maximum; $sumAll = [Math]::Round($m.Sum, 2) }
        if ($kind -eq 'date' -and $col.DateMin) { $min = $col.DateMin.ToString('yyyy-MM-dd'); $max = $col.DateMax.ToString('yyyy-MM-dd') }
        $patOut = [ordered]@{}; foreach ($k in ($pc.Keys | Sort-Object)) { $patOut[$k] = $pc[$k] }
        $colOut.Add([pscustomobject]@{
            name = $cname; readable = (Get-ReadableName $cname); kind = $kind; nonEmpty = $ne; empty = $col.Empty; nullLike = $nullCount
            distinct = $(if ($col.Overflow) { '>5000' } else { $distinct }); min = $min; max = $max; sum = $sumAll
            patterns = $patOut; examples = @(@($col.Values.Keys) | Select-Object -First $MaxExamples)
        })
        if ($kind -eq 'id' -or $col.IdName) {
            $topShape = $(if ($col.Shapes.Count) { (@($col.Shapes.GetEnumerator() | Sort-Object Value -Descending))[0].Key } else { '' })
            $kc = $(if ($prefixIsPart) { $col.KeysP } else { $col.Keys })
            $keyStore["$tableName|$cname"] = @{ table = $tableName; column = $cname; counts = $kc; shapes = $col.Shapes; raw = $col.Values
                prefix = $(if ($prefixIsPart) { '' } else { ([regex]::Match($topShape, '^[A-Za-z]+').Value).ToUpperInvariant() })
                prefixIsPart = $prefixIsPart; unique = ($kc.Count -eq $ne -and $ne -gt 0); nonEmpty = $ne; first = ($cname -eq $cols[0].Name) }
        } elseif (($kind -eq 'text' -or $kind -eq 'category') -and -not $col.Overflow -and $ne -gt 0) {
            # Text keys (CustomerName, CityName …): matched on the same column name, ignoring case and spaces
            $textStore["$tableName|$cname"] = @{ table = $tableName; column = $cname; counts = $col.Lower
                unique = ($col.Lower.Count -eq $ne); nonEmpty = $ne; first = ($cname -eq $cols[0].Name) }
        }

        # F25 technical columns (hash, load stamps, source ids)
        if ($rxTechName.IsMatch($cname.Trim())) {
            $findings.Add((New-Finding $tableName 'F25' $cname $dataRows 'Technical column from the source system (hash, load stamp or source id) - usually not needed in a report' @() $true $null))
        }
        # F26 personal data – by name, or values that look like e-mail addresses
        $emailLike = 0; if (-not $col.Overflow) { foreach ($k in $col.Values.Keys) { if ($k -match '^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$') { $emailLike += $col.Values[$k] } } }
        if ($ne -gt 0 -and ($rxPiiName.IsMatch($cname) -or $emailLike -ge 0.8 * $ne)) {
            $findings.Add((New-Finding $tableName 'F26' $cname $ne 'Personal data (name, e-mail, phone or address) - decide whether the report needs it' @() $true 'hide'))
        }
        # F23 two values in one column (electronics|phones)
        if (($kind -eq 'text' -or $kind -eq 'category') -and -not $col.Overflow -and $ne -ge 3) {
            foreach ($sep in @('|', ' > ', '>', ' / ', ' - ', '::', ';')) {
                $withSep = 0; foreach ($k in $col.Values.Keys) { if ($k.Contains($sep) -and ($k.Split(@($sep), [StringSplitOptions]::None).Count -eq 2) -and $k -notmatch '@|https?:') { $withSep += $col.Values[$k] } }
                if ($withSep -ge 0.9 * $ne) {
                    $parts = @(([regex]::Matches($cname, '[A-Z][a-z]+|[a-z]+|[0-9]+') | ForEach-Object { $_.Value }))
                    $names = $(if ($parts.Count -eq 2) { @(($parts[0].Substring(0, 1).ToUpper() + $parts[0].Substring(1)), ($parts[1].Substring(0, 1).ToUpper() + $parts[1].Substring(1))) } else { @("$cname 1", "$cname 2") })
                    $findings.Add((New-Finding $tableName 'F23' $cname $withSep ("Two values in one column, separated by '$sep' - split into " + ($names -join ' and ')) @(@($col.Values.Keys) | Select-Object -First $MaxExamples) $true ([pscustomobject]@{ separator = $sep; names = $names })))
                    break
                }
            }
        }
        # F24 a list in one cell (A-1, B-2, C-3)
        if (($kind -eq 'text' -or $kind -eq 'category') -and -not $col.Overflow -and $ne -ge 2) {
            $listCells = 0; $items = 0; $maxItems = 0
            foreach ($k in $col.Values.Keys) {
                $p = @($k -split '\s*[,;]\s*' | Where-Object { $_ })
                if ($p.Count -ge 2 -and @($p | Where-Object { $_ -match '\s' }).Count -eq 0) { $listCells += $col.Values[$k]; $items += $p.Count * $col.Values[$k]; if ($p.Count -gt $maxItems) { $maxItems = $p.Count } }
            }
            if ($listCells -ge 0.5 * $ne -and $maxItems -ge 3) {
                $findings.Add((New-Finding $tableName 'F24' $cname $listCells ("Lists in one cell ($items items in $listCells cells) - split into one row per item") @() $true $null))
            }
        }
    }

    # -----------------------------------------------------------------------------------------------
    # Rows that do not belong in a report (F27): test, dummy and placeholder records
    # -----------------------------------------------------------------------------------------------
    $idIdx = @(); for ($c = 0; $c -lt $nCol; $c++) { if ($colOut[$c].kind -eq 'id') { $idIdx += $c } }
    $testRows = 0; $testEx = New-Object System.Collections.Generic.List[string]
    for ($r = $h + 1; $r -lt $rows.Count; $r++) {
        $f = $rows[$r]
        if ($f.Length -ne $nCol) { continue }
        $hit = $rxTestRow.IsMatch([string]::Join([string][char]31, $f))
        if (-not $hit) { foreach ($c in $idIdx) { if ($rxTestId.IsMatch($f[$c].Trim())) { $hit = $true; break } } }
        if ($hit) { $testRows++; if ($testEx.Count -lt $MaxExamples) { $testEx.Add((@($f | Where-Object { $_.Trim() } | Select-Object -First 3) -join ' | ')) } }
    }
    # A few rows (at most 2, or up to 20 % in larger tables) – more than that is the data itself, not test rows
    if ($testRows -gt 0 -and $testRows -le [Math]::Max(2, 0.2 * $dataRows) -and $testRows -lt $dataRows) {
        $findings.Add((New-Finding $tableName 'F27' $null $testRows 'Test, dummy or placeholder rows (TEST, DO NOT USE, 9999, ZZZ- …) - remove them before they reach totals and lists' @($testEx) $true 'remove'))
    }

    # Code columns (F28): small whole numbers that stand for names (channel 10/20/30, type 1/2/3)
    foreach ($co in $colOut) {
        $cs = $cols | Where-Object { $_.Name -eq $co.name } | Select-Object -First 1
        if ($co.kind -eq 'integer' -and -not $cs.Overflow -and $cs.Values.Count -ge 2 -and $cs.Values.Count -le 20 -and $dataRows -ge 10 -and
            $rxCodeName.IsMatch($co.name) -and -not $rxAmtName.IsMatch($co.name)) {
            $findings.Add((New-Finding $tableName 'F28' $co.name $co.nonEmpty ("Code column: $($cs.Values.Count) numbers that stand for names (" + ((@($cs.Values.Keys) | Sort-Object { [double]$_ } | Select-Object -First 8) -join ', ') + ') - add their names') @() $true 'ask-names'))
        }
    }

    # Primary flag in a detail table (F29): several rows per key, one marked primary/main/default
    $boolPrimary = $colOut | Where-Object { $_.kind -eq 'bool' -and $rxPrimaryName.IsMatch($_.name) } | Select-Object -First 1
    $detailKey = $colOut | Where-Object { $rxIdName.IsMatch($_.name) -and $_.kind -eq 'id' } | Select-Object -First 1
    if ($boolPrimary -and $detailKey) {
        $ksd = $cols | Where-Object { $_.Name -eq $detailKey.name } | Select-Object -First 1
        if ($ksd.Keys.Count -lt $ksd.NonEmpty) {
            $findings.Add((New-Finding $tableName 'F29' $boolPrimary.name $ksd.Keys.Count ("$($ksd.NonEmpty) rows for $($ksd.Keys.Count) $($detailKey.name) values; $($boolPrimary.name) marks one per $($detailKey.name) - keep only those rows when the table is merged into its dimension") @() $true 'keep-primary'))
        }
    }

    # Attributes repeated per key (M02): columns whose value is fixed by another column in the same table
    # (CampaignName -> Channel, StartDate, Budget) belong in a dimension, not on every row
    $dependencies = New-Object System.Collections.Generic.List[object]
    if ($dataRows -ge 20 -and $dataRows -le 50000 -and $nCol -le 40) {
        $cand = @(for ($c = 0; $c -lt $nCol; $c++) {
            $cs = $cols[$c]; $kd = $colOut[$c].kind
            if (($kd -in 'text', 'category', 'id') -and -not $cs.Overflow -and $cs.Values.Count -ge 2 -and $cs.Values.Count * 3 -le $dataRows) { $c }   # each value at least 3 times on average
        }) | Select-Object -First 5
        foreach ($k in $cand) {
            $attrs = New-Object System.Collections.Generic.List[string]
            for ($c = 0; $c -lt $nCol; $c++) {
                if ($c -eq $k -or $cols[$c].Values.Count -lt 2 -or $cols[$c].Overflow) { continue }
                if ($cols[$c].Values.Count -gt $cols[$k].Values.Count) { continue }
                $pairs = New-Object 'System.Collections.Generic.HashSet[string]'
                for ($r = $h + 1; $r -lt $rows.Count; $r++) { $f = $rows[$r]; if ($f.Length -eq $nCol -and $f[$k].Trim()) { [void]$pairs.Add($f[$k].Trim() + [char]31 + $f[$c].Trim()) } }
                if ($pairs.Count -eq $cols[$k].Values.Count) { $attrs.Add($cols[$c].Name) }
            }
            if ($attrs.Count -ge 2) {
                $dependencies.Add([pscustomobject]@{ key = $cols[$k].Name; distinct = $cols[$k].Values.Count; attributes = @($attrs) })
            }
        }
    }
    foreach ($dep in $dependencies) {
        $findings.Add((New-Finding $tableName 'M02' $dep.key $dep.distinct ("$($dep.attributes.Count) column(s) repeat the same value for every $($dep.key) (" + ($dep.attributes -join ', ') + ") - candidates for a $($dep.key) dimension") @($dep.attributes) $true $null))
    }

    # -----------------------------------------------------------------------------------------------
    # Table findings
    # -----------------------------------------------------------------------------------------------
    if ($h -gt 0) { $findings.Insert(0, (New-Finding $tableName 'F01' $null $h "$h line(s) above the header row" @() $true $null)) }
    $badNames = @($header | Where-Object { $_ -ne $_.Trim() -or -not $_.Trim() })
    $dupNames = @($header | Group-Object | Where-Object { $_.Count -gt 1 } | ForEach-Object { $_.Name })
    $renames = @($colOut | Where-Object { $_.readable -cne $_.name })
    if ($badNames.Count -gt 0 -or $dupNames.Count -gt 0 -or $renames.Count -gt 0) {
        $d = "$($renames.Count) of $nCol names can be made readable (e.g. " + (($renames | Select-Object -First 3 | ForEach-Object { "$($_.name) -> $($_.readable)" }) -join ', ') + ')'
        if ($badNames.Count) { $d += "; $($badNames.Count) blank or with spaces" }
        if ($dupNames.Count) { $d += '; duplicate names: ' + ($dupNames -join ', ') }
        $findings.Add((New-Finding $tableName 'F02' $null $renames.Count $d @() $true $null))
    }
    if ($ts.EmptyRows -gt 0) { $findings.Add((New-Finding $tableName 'F03' $null $ts.EmptyRows 'Rows where every field is empty' @() $true $null)) }
    if ($ts.TotalRows -gt 0) { $findings.Add((New-Finding $tableName 'F04' $null $ts.TotalRows 'Total/sum rows inside the data' @($ts.TotalExamples) $true $null)) }
    if ($dupRows -gt 0) { $findings.Add((New-Finding $tableName 'F12' $null $dupRows 'Rows that are exact copies of an earlier row' @() $true $null)) }
    $keyCol = $colOut | Where-Object { $rxIdName.IsMatch($_.name) } | Select-Object -First 1
    if ($keyCol) {
        $ks = $keyStore["$tableName|$($keyCol.name)"]
        if ($ks -and $ks.counts.Count -ge 0.9 * $ks.nonEmpty -and $ks.counts.Count -lt $ks.nonEmpty) {
            $extra = $ks.nonEmpty - $ks.counts.Count - $dupRows
            if ($extra -gt 0) { $findings.Add((New-Finding $tableName 'F13' $keyCol.name $extra "Rows that repeat a $($keyCol.name) with other values (not exact copies)" @() $true 'keep-first')) }
        }
    }
    $monthCols = @($header | Where-Object { $rxMonthCol.IsMatch($_.Trim()) })
    if ($monthCols.Count -ge 3) {
        $emptyCells = 0; foreach ($cc in $cols) { if ($monthCols -contains $cc.Name) { $emptyCells += $cc.Empty + $cc.NullCount } }
        $findings.Add((New-Finding $tableName 'F16' ($monthCols -join ', ') ($dataRows * $monthCols.Count - $emptyCells) "$($monthCols.Count) period columns side by side; $emptyCells empty cells" @() $true $null))
    }
    if ($ts.WrongCount + $malformed -gt 0) {
        $findings.Add((New-Finding $tableName 'F20' $null ($ts.WrongCount + $malformed) "Lines with another number of fields than the header ($nCol)" @($malformedLines) $true $null))
    }
    $findings.Add((New-Finding $tableName 'F17' $null $nCol 'Set a data type on every column (text, whole number, decimal, date, true/false)' @() $true $null))

    # The date column that runs furthest (a daily Date beats a StartDate of the same rows)
    $dateCol = $colOut | Where-Object { $_.kind -eq 'date' -and $_.max } | Sort-Object @{ e = { $_.max }; Descending = $true }, @{ e = { $_.nonEmpty }; Descending = $true } | Select-Object -First 1
    if ($dateCol -and $dataRows -ge 100) {
        $ld = [datetime]::ParseExact($dateCol.max, 'yyyy-MM-dd', $inv)
        $dim = [datetime]::DaysInMonth($ld.Year, $ld.Month)
        # Kept only for tables that no other table points at (facts) - decided after the relations below
        if ($ld.Day -lt $dim - 1) { $monthCandidate = New-Finding $tableName 'M01' $dateCol.name 0 "Last date $($dateCol.max) - the month $($ld.ToString('yyyy-MM')) is not complete" @() $true $null } else { $monthCandidate = $null }
    } else { $monthCandidate = $null }

    $entry = [pscustomobject]$sourceInfo
    $entry | Add-Member -NotePropertyMembers ([ordered]@{
        isEmpty = $false; headerRow = $h + 1; headerCells = @($header | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -First 3)
        columnsCount = $nCol; dataRows = $dataRows; emptyRows = $ts.EmptyRows; totalRows = $ts.TotalRows
        exactDuplicates = $dupRows; malformedLines = $ts.WrongCount + $malformed; columns = $colOut; findings = $findings
        monthCandidate = $monthCandidate; contentHash = $ts.ContentHash
    })
    $tables.Add($entry)
}

# ---------------------------------------------------------------------------------------------------
# Across tables: copies (F22) and tables split by period or source that belong together (F21)
# ---------------------------------------------------------------------------------------------------
$copyOf = @{}
foreach ($t in $tables) {
    if ($t.isEmpty) { continue }
    $orig = $tables | Where-Object { -not $_.isEmpty -and $_.contentHash -eq $t.contentHash -and $_.name -ne $t.name -and -not $copyOf.ContainsKey($_.name) } | Select-Object -First 1
    if ($orig -and [array]::IndexOf($tables.ToArray(), $orig) -lt [array]::IndexOf($tables.ToArray(), $t) -or ($orig -and $t.name -match '^(sheet|ark|tabel|table)\d*$')) {
        $copyOf[$t.name] = $orig.name
        $t.findings.Insert(0, [pscustomobject]@{ fix = 'F22'; table = $t.name; column = $null; rows = $t.dataRows
            detail = "Exact copy of $($orig.name) (same columns and the same $($t.dataRows) rows) - leave it out"; examples = @(); recommended = $true; variant = $orig.name })
    }
}
$done = @{}
foreach ($a in $tables) {
    if ($a.isEmpty -or $copyOf.ContainsKey($a.name) -or $a.columnsCount -lt 3) { continue }
    $an = @($a.columns | ForEach-Object { $_.name.Trim().ToLowerInvariant() })
    foreach ($b in $tables) {
        if ($b.isEmpty -or $b.name -eq $a.name -or $copyOf.ContainsKey($b.name) -or $b.columnsCount -lt 3 -or $done.ContainsKey("$($b.name)|$($a.name)")) { continue }
        $bn = @($b.columns | ForEach-Object { $_.name.Trim().ToLowerInvariant() })
        $common = @($an | Where-Object { $bn -contains $_ })
        $union = @($an + $bn | Select-Object -Unique)
        if ($common.Count -ge 3 -and $common.Count -ge 0.7 * $union.Count) {
            $done["$($a.name)|$($b.name)"] = 1
            $onlyA = @($an | Where-Object { $bn -notcontains $_ }); $onlyB = @($bn | Where-Object { $an -notcontains $_ })
            $d = "Same layout as $($b.name) ($($common.Count) shared columns) - append the two into one table"
            if ($onlyA.Count) { $d += "; only in $($a.name): " + ($onlyA -join ', ') }
            if ($onlyB.Count) { $d += "; only in $($b.name): " + ($onlyB -join ', ') }
            $a.findings.Insert(0, [pscustomobject]@{ fix = 'F21'; table = $a.name; column = $null; rows = $a.dataRows + $b.dataRows
                detail = $d; examples = @(); recommended = $true; variant = $b.name })
        }
    }
}

# ---------------------------------------------------------------------------------------------------
# Relationships and orphans across files
# ---------------------------------------------------------------------------------------------------
$relations = New-Object System.Collections.Generic.List[object]
$colsOf = @{}; foreach ($t in $tables) { $colsOf[$t.name] = $t.columnsCount }

# The "home" of a key: the table where it is unique. Preferred: the key is the table's first column,
# the table is named after the key (Address <- AddressID, cities <- CityName, CUST_MASTER <- CustomerID),
# a dim_/d_ name, then the widest table. Its most common format is the target for every other table.
function Get-Stem([string]$c) { (($c.ToLowerInvariant() -replace '[^a-z]', '') -replace '(id|key|code|nr|no|number|name|navn)$', '') }
function Get-TableNorm([string]$t) { ((($t.ToLowerInvariant() -replace '^(dim|d|tbl|tab)_', '') -replace '[^a-z]', '') -replace 'ies$', 'y') -replace 's$', '' }
function Test-NameMatch([string]$table, [string]$column) {
    $st = Get-Stem $column; $tn = Get-TableNorm $table
    if ($st.Length -lt 3 -or -not $tn) { return $false }
    return ($tn.Contains($st.Substring(0, [Math]::Min(4, $st.Length))) -or $st.Contains($tn))
}
function Get-HomeRank($ks) {
    ([int]$ks.first * 400000) + ([int](Test-NameMatch $ks.table $ks.column) * 200000) + ([int]($ks.table -match '^(dim|d)_') * 100000) + [int]$colsOf[$ks.table]
}
# Copied tables (F22) take no part in relationships
foreach ($store in @($keyStore, $textStore)) { foreach ($k in @($store.Keys)) { if ($copyOf.ContainsKey($store[$k].table)) { $store.Remove($k) } } }
$pairSeen = @{}
$homes = @{}
foreach ($ks in $keyStore.Values) {
    if (-not $ks.unique) { continue }
    $key = $ks.column.ToLowerInvariant()
    if (-not $homes.ContainsKey($key) -or (Get-HomeRank $ks) -gt (Get-HomeRank $homes[$key])) { $homes[$key] = $ks }
}

foreach ($a in $keyStore.Values) {
    $key = $a.column.ToLowerInvariant()
    $t = $tables | Where-Object { $_.name -eq $a.table }

    # Candidate targets: a unique key in another table with the same column name (≥ 50 % of the ids
    # match) or another name whose values cover ≥ 80 % of the ids (Kunde -> KundeID)
    $cands = @(foreach ($b in $keyStore.Values) {
        if ($a.table -eq $b.table -or -not $b.unique -or $a.counts.Count -eq 0) { continue }
        $same = ($b.column.ToLowerInvariant() -eq $key)
        $hit = 0; foreach ($k in $a.counts.Keys) { if ($b.counts.ContainsKey($k)) { $hit++ } }
        $ratio = $hit / $a.counts.Count
        # Other name: the normalised numbers alone are not enough (LOC-01 and PROD-01 are both "1") –
        # also the same letter prefix, or the raw values themselves match
        $valueOk = $false
        if (-not $same -and $ratio -ge 0.8 -and $a.counts.Count -ge 3) {
            if ($a.prefix -and $a.prefix -eq $b.prefix) { $valueOk = $true }
            else { $rawHit = 0; foreach ($k in $a.raw.Keys) { if ($b.raw.ContainsKey($k)) { $rawHit++ } }; if ($a.raw.Count -and $rawHit / $a.raw.Count -ge 0.8) { $valueOk = $true } }
        }
        if (($same -and $ratio -ge 0.5) -or $valueOk) {
            [pscustomobject]@{ b = $b; same = $same; ratio = $ratio; rank = (Get-HomeRank $b) }
        }
    })
    if ($cands.Count -eq 0) { continue }

    # Home of the key: the same-name home, else the best value match. A table that is itself the home
    # of its key keeps its own format.
    $homeKs = $null
    if ($homes.ContainsKey($key)) { $homeKs = $homes[$key] }
    if (-not $homeKs) { $homeKs = ($cands | Sort-Object @{ e = { $_.rank }; Descending = $true }, @{ e = { $_.ratio }; Descending = $true } | Select-Object -First 1).b }
    if ($homeKs.table -ne $a.table) {
        $canon = (@($homeKs.shapes.GetEnumerator() | Sort-Object Value -Descending))[0].Key
        # Id formats: one target format per key, taken from its home table
        $own = $t.findings | Where-Object { $_.fix -eq 'F11' -and $_.column -eq $a.column }
        $offShape = 0; foreach ($s in $a.shapes.Keys) { if ($s -cne $canon) { $offShape += $a.shapes[$s] } }
        if ($own) { $own.variant = $canon; $own.rows = $offShape }
        elseif ($offShape -gt 0) {
            $t.findings.Add([pscustomobject]@{ fix = 'F11'; table = $a.table; column = $a.column; rows = $offShape
                detail = "Id format differs from $($homeKs.table)[$($homeKs.column)]: " + ((@($a.shapes.Keys) | Select-Object -First 3) -join ', ') + " vs $canon"
                examples = @(); recommended = $true; variant = $canon })
        }
    }

    # The table this key points at: its home – or, when the key is its own home (UserID only exists in
    # user_details), the best other table its values match (CUST_MASTER[CustomerID])
    $relHome = $homeKs
    if ($homeKs.table -eq $a.table) { $relHome = ($cands | Sort-Object @{ e = { $_.rank }; Descending = $true }, @{ e = { $_.ratio }; Descending = $true } | Select-Object -First 1).b }
    foreach ($c in $cands) {
        $b = $c.b
        $preferred = ($b.table -eq $relHome.table -and $b.column -eq $relHome.column)
        if ($a.unique -and $b.unique -and -not $preferred) { continue }   # one-to-one: only towards the home table
        $pairKey = @("$($a.table)[$($a.column)]", "$($b.table)[$($b.column)]") | Sort-Object
        if ($a.unique -and $b.unique) {
            # One-to-one: list it once, pointing at the main table (higher rank: Customer, not its detail table)
            if ((Get-HomeRank $b) -lt (Get-HomeRank $a)) { continue }
            if ($pairSeen.ContainsKey($pairKey -join '|')) { continue }; $pairSeen[$pairKey -join '|'] = 1
        }
        $orphanIds = 0; $orphanRows = 0; $ex = New-Object System.Collections.Generic.List[string]
        foreach ($k in $a.counts.Keys) { if (-not $b.counts.ContainsKey($k)) { $orphanIds++; $orphanRows += $a.counts[$k]; if ($ex.Count -lt $MaxExamples) { $ex.Add($k) } } }
        $matched = $a.counts.Count - $orphanIds
        $relations.Add([pscustomobject]@{
            from = "$($a.table)[$($a.column)]"; to = "$($b.table)[$($b.column)]"
            cardinality = $(if ($a.unique) { 'one-to-one' } else { 'many-to-one' }); preferred = $preferred
            matchedBy = $(if ($c.same) { 'name' } else { 'values' })
            matchedIds = $matched; orphanIds = $orphanIds; orphanRows = $orphanRows; orphanExamples = @($ex)
        })
        if ($orphanIds -gt 0 -and $preferred -and -not $a.unique) {
            $t.findings.Add([pscustomobject]@{ fix = 'F18'; table = $a.table; column = $a.column; rows = $orphanRows
                detail = "$orphanIds $($a.column) value(s) on $orphanRows row(s) are missing in $($b.table)"; examples = @($ex); recommended = $true; variant = 'add-members'; target = $b.table })
        }
    }
}

# Text keys: the same column name in two tables (ORDERS[CustomerName] -> CUST_MASTER[CustomerName]),
# unique in the target, ≥ 80 % of the values found there (ignoring case and spaces)
# Home = the fullest list of values (most distinct values), then the usual rank. A list that is almost
# unique (a few names twice) still counts, with an F13 finding: those names must be made unique first.
$textHomes = @{}
foreach ($ks in $textStore.Values) {
    $dupes = $ks.nonEmpty - $ks.counts.Count
    $ks.dupes = $dupes
    if ($ks.nonEmpty -lt 2 -or $dupes -gt [Math]::Max(2, 0.05 * $ks.nonEmpty)) { continue }
    $key = $ks.column.ToLowerInvariant()
    if (-not $textHomes.ContainsKey($key)) { $textHomes[$key] = $ks; continue }
    $cur = $textHomes[$key]
    if ($ks.counts.Count -gt $cur.counts.Count -or ($ks.counts.Count -eq $cur.counts.Count -and (Get-HomeRank $ks) -gt (Get-HomeRank $cur))) { $textHomes[$key] = $ks }
}
$dupeNoted = @{}
foreach ($a in $textStore.Values) {
    $key = $a.column.ToLowerInvariant()
    if (-not $textHomes.ContainsKey($key)) { continue }
    $b = $textHomes[$key]
    if ($b.table -eq $a.table -or $a.counts.Count -eq 0) { continue }
    $orphanIds = 0; $orphanRows = 0; $ex = New-Object System.Collections.Generic.List[string]
    foreach ($k in $a.counts.Keys) { if (-not $b.counts.ContainsKey($k)) { $orphanIds++; $orphanRows += $a.counts[$k]; if ($ex.Count -lt $MaxExamples) { $ex.Add($k) } } }
    $matched = $a.counts.Count - $orphanIds
    if ($matched -lt 0.8 * $a.counts.Count) { continue }
    if ($b.dupes -gt 0 -and -not $dupeNoted.ContainsKey($b.table + '|' + $b.column)) {
        $dupeNoted[$b.table + '|' + $b.column] = 1
        $bt = $tables | Where-Object { $_.name -eq $b.table }
        $bt.findings.Add([pscustomobject]@{ fix = 'F13'; table = $b.table; column = $b.column; rows = $b.dupes
            detail = "$($b.dupes) $($b.column) value(s) appear more than once, but other tables look rows up by $($b.column) - keep one row per value (or make the names unique in the source)"
            examples = @(); recommended = $true; variant = 'keep-first' })
    }
    $relations.Add([pscustomobject]@{
        from = "$($a.table)[$($a.column)]"; to = "$($b.table)[$($b.column)]"
        cardinality = $(if ($a.unique) { 'one-to-one' } else { 'many-to-one' }); preferred = $true; matchedBy = 'text'
        needsUniqueTarget = ($b.dupes -gt 0)
        matchedIds = $matched; orphanIds = $orphanIds; orphanRows = $orphanRows; orphanExamples = @($ex)
    })
    if ($orphanIds -gt 0 -and -not $a.unique) {
        $t = $tables | Where-Object { $_.name -eq $a.table }
        $t.findings.Add([pscustomobject]@{ fix = 'F18'; table = $a.table; column = $a.column; rows = $orphanRows
            detail = "$orphanIds $($a.column) value(s) on $orphanRows row(s) are missing in $($b.table)"; examples = @($ex); recommended = $true; variant = 'add-members'; target = $b.table })
    }
}

# Incomplete last month: only for tables that no relation points at (facts)
$targets = @{}; foreach ($r in $relations) { $targets[($r.to -replace '\[.*$', '')] = 1 }
foreach ($t in $tables) {
    if ($t.monthCandidate -and -not $targets.ContainsKey($t.name)) { $t.findings.Add($t.monthCandidate) }
    $t.PSObject.Properties.Remove('monthCandidate')
}

$result = [pscustomobject]@{
    generated = (Get-Date -Format s); today = $Today; files = $files.Count
    tables = $tables; relations = $relations
    summary = @($tables | ForEach-Object { [pscustomobject]@{ table = $_.name; rows = $_.dataRows; columns = $_.columnsCount; findings = @($_.findings | Where-Object { $_.fix -ne 'F17' }).Count } })
}
$json = $result | ConvertTo-Json -Depth 8
if ($OutFile) {
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile), $json, (New-Object Text.UTF8Encoding($false)))
    $result.summary | Format-Table -AutoSize | Out-String | Write-Output
    "Relations: $($relations.Count). Profile written to $OutFile"
} else { $json }
