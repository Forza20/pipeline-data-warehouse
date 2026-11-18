#!/usr/bin/env node
// build-dax-guide.js – the run's own HTML guide to checks.dax and grounded-answers.dax (step 9, mandatory).
//
//   node build-dax-guide.js runs/<run-id> [--lang da|en] [--downloads [<dir>]]
//
// Reads the run folder: choices.json (name, run_id, checks[], dax_guide), checks.dax, questions.json,
// cleaning-log.md. Writes runs/<run-id>/checks.dax_grounded-answers.dax guide.html with the run's own numbers: number of
// checks, the key expected values and why, every grounded question with its expected answer.
// --downloads copies the guide (same name), checks.dax and grounded-answers.dax
// to the Downloads folder (default ~/Downloads) and the guide then names those paths.
//
// Optional text from Claude in the user's language, choices.json → dax_guide:
//   { "lang": "da", "why": { "<check name>": "text" }, "questions": { "1": "short question" },
//     "key_checks": ["<check name>", …] }
// Without it: lang from report_language, why from checks[].assumes, the question text from questions.json.
// Prints JSON: { ok, file, downloads: [paths], lang, checks, keyChecks, questions }.

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const runDir = args.find((a) => !a.startsWith('--'));
if (!runDir) { console.error('usage: node build-dax-guide.js runs/<run-id> [--lang da|en] [--downloads [<dir>]]'); process.exit(2); }
const opt = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const readText = (f) => { try { return fs.readFileSync(path.join(runDir, f), 'utf8'); } catch { return null; } };

const choices = readJson('choices.json');
if (!choices) { console.error(`no choices.json in ${runDir}`); process.exit(2); }
const g = choices.dax_guide || {};
let lang = (opt('--lang') || g.lang || choices.user_language || choices.report_language || 'en').slice(0, 2).toLowerCase();
if (!['da', 'en'].includes(lang)) lang = 'en';
const NAME = choices.name || 'Report';
const RUN = choices.run_id || path.basename(path.resolve(runDir));

// ---- checks.dax: ( "name", <dax>, <expected> ) rows
const checksDax = readText('checks.dax');
const checks = [];
for (const line of (checksDax || '').split(/\r?\n/)) {
  const m = line.match(/^\s*\(\s*"((?:[^"]|"")*)"\s*,.*,\s*(-?[0-9.]+(?:[eE][-+]?\d+)?)\s*\)\s*,?\s*$/);
  if (m) checks.push({ name: m[1].replace(/""/g, '"'), expected: Number(m[2]) });
}
const assumes = Object.fromEntries((choices.checks || []).map((c) => [c.name, c.assumes]));
const isFilterCheck = (n) => / follows a .* filter$| adds up over /.test(n);
let key = Array.isArray(g.key_checks) && g.key_checks.length
  ? g.key_checks.map((n) => checks.find((c) => c.name === n)).filter(Boolean)
  : [...checks.filter((c) => !isFilterCheck(c.name) && !/ rows without /.test(c.name) && (
      /^Rows fact_/.test(c.name) || (assumes[c.name] && assumes[c.name] !== '-' && !/^Rows dim_/.test(c.name)))).slice(0, 10),
     ...checks.filter((c) => / rows without /.test(c.name) && c.expected !== 0)]; // a key without a match that is expected: say why it is not 0
const hasFilterChecks = checks.some((c) => isFilterCheck(c.name));

// ---- grounded questions
const qs = readJson('questions.json');
const questions = Array.isArray(qs) ? qs : (qs && Array.isArray(qs.questions) ? qs.questions : []);
const hasGrounded = questions.length > 0 && fs.existsSync(path.join(runDir, 'grounded-answers.dax'));
const roleRows = /– as /.test(readText('grounded-answers.dax') || '');

// ---- number of kept cleaning steps
const log = readText('cleaning-log.md') || '';
const steps = (log.match(/\|\s*kept\s*\|/g) || []).length;

// ---- downloads
const dlFlag = args.includes('--downloads');
const dlDir = dlFlag ? (opt('--downloads') || path.join(os.homedir(), 'Downloads')) : null;
const guideName = 'checks.dax_grounded-answers.dax guide.html';
// Full paths, so the guide is clear wherever it is opened from.
const RUN_ABS = path.resolve(runDir).replace(/^[a-z]:/, (d) => d.toUpperCase());
const PBIP_ABS = path.join(RUN_ABS, 'pbip', `${NAME}.pbip`);
const fileRef = (f) => path.join(dlDir || RUN_ABS, f);

// ---- formatting
const loc = lang === 'da' ? 'da-DK' : 'en-US';
const num = (v) => v.toLocaleString(loc, { maximumFractionDigits: 6 }).replace(/^-/, '−');
const pct = (v) => (v * 100).toLocaleString(loc, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).replace(/^-/, '−') + ' %';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const isPct = (q) => /pct|percent|_%/i.test(q.measure || '') && Math.abs(q.expected) < 10;

const T = {
  da: {
    title: 'Sådan bruger du checks.dax og grounded-answers.dax',
    lead: `Til rapporten <b>${esc(NAME)}</b> (kørsel <code>${esc(RUN)}</code>). De to filer viser, om Power BI-modellen giver de samme tal som dine kildefiler.`,
    nav: ['Hvorfor', 'Før du starter', 'checks.dax', 'grounded-answers.dax', 'Hvis Difference ikke er 0'],
    why: 'Hvorfor skal du bruge dem?',
    whyP: `Modellen er bygget automatisk og har renset data${steps ? ` i ${steps} trin` : ''}. Tallene på dashboardet er kun til at stole på, hvis modellen faktisk gør det, som rensningen lovede. Derfor er de forventede tal regnet ud direkte fra kildefilerne, uden om modellen, og de to filer sammenligner dem med det, Power BI regner frem.`,
    card1: `Kontrollerer <b>totalerne</b> i ${checks.length} rækker: antal rækker pr. tabel, de vigtigste mål, nøgler uden match${hasFilterChecks ? ' og om målene reagerer rigtigt på filtre' : ''}.`,
    card2: `Kontrollerer <b>rigtige forretningsspørgsmål</b>: ${questions.length} spørgsmål, som en bruger af rapporten kunne stille, med det svar, kildefilerne giver.`,
    where: dlDir ? `Begge filer ligger i Overførsler: <code class="path">${esc(fileRef('checks.dax'))}</code> og <code class="path">${esc(fileRef('grounded-answers.dax'))}</code>. Åbn dem i Notesblok for at kopiere indholdet.`
      : `Begge filer ligger i kørselsmappen <code class="path">${esc(RUN_ABS + path.sep)}</code>. Åbn dem i Notesblok for at kopiere indholdet.`,
    before: 'Før du starter',
    b: [`Åbn <code class="path">${esc(PBIP_ABS)}</code> i Power BI Desktop.`, 'Klik <b>Refresh</b> (Opdater) på fanen Home. Godkend adgangen til mappen, hvis Power BI spørger.', 'Vent, til opdateringen er færdig. Uden en opdatering er modellen tom, og alle tal bliver forkerte.'],
    runC: 'Kør checks.dax',
    c: ['Klik på ikonet <b>DAX query view</b> i venstre side (det nederste af de fire ikoner).', 'Åbn <code>checks.dax</code> i Notesblok, markér alt (Ctrl+A), kopiér (Ctrl+C) og indsæt det i DAX query view (Ctrl+V).', 'Klik <b>Run</b>. Du får en tabel med fire kolonner:'],
    colH: ['Kolonne', 'Betyder'],
    cols: [['Check', 'Hvad der kontrolleres'], ['In Power BI', 'Tallet, som modellen regner frem'], ['Expected', 'Tallet regnet fra kildefilerne'], ['Difference', 'In Power BI minus Expected, afrundet til 2 decimaler. <span class="ok">Skal være 0 i alle rækker.</span>']],
    keyP: 'De vigtigste forventede tal:', keyH: ['Check', 'Expected', 'Hvorfor netop det tal'],
    orphan: (n) => `Her er Expected ${n}, ikke 0, og det er korrekt`,
    filterP: 'Rækker, der slutter med <i>follows a … filter</i> eller <i>adds up over …</i>, tester, at målene reagerer rigtigt, når du filtrerer. Der er både Expected og Difference 0.',
    runG: 'Kør grounded-answers.dax',
    gs: ['Ryd DAX query view (Ctrl+A og Delete), eller åbn en ny fane med <b>+</b> nederst.', 'Indsæt indholdet af <code>grounded-answers.dax</code>, og klik <b>Run</b>.', 'Du får kolonnerne <b>No · Question · Value · Expected · Difference</b>.'],
    qH: ['No', 'Spørgsmål', 'Expected'],
    tol: 'Difference afrundes ikke her. Ved procenter er en rest under <b>0,00001</b> bare afrunding og tæller som 0.',
    roles: 'Rækker med „– as &lt;rolle&gt;“ tester sikkerhedsroller. Bekræft dem én gang med Modeling → <b>View as</b> → rollen + <i>Other user</i>.',
    noQ: 'Kørslen har endnu ingen grounded-answers.dax. Den kommer, når forretningsspørgsmålene er skrevet (trin 8.9).',
    diff: 'Hvis Difference ikke er 0',
    d: ['<b>Mange rækker er forkerte, eller alle er tomme:</b> modellen er sandsynligvis ikke opdateret. Klik Refresh og kør igen.', '<b>Fejlmeddelelse i stedet for en tabel:</b> læs meddelelsen. Den nævner ofte et rensetrin, f.eks. <code>F08 Parse order_date</code>. Send fejlen til Claude.', '<b>Kun en enkelt række afviger:</b> skriv Check-navnet og begge tal til Claude. Claude bruger så <i>reconcile</i>-skillen til at dele afvigelsen op, indtil de rækker, der giver forskellen, er fundet.'],
    note: 'Du skal ikke skrive tallene ind selv. Højreklik på resultatet, vælg <b>Copy table</b>, og indsæt det i chatten (gør det for begge filer). Claude skriver så tallene, Difference og én resultatlinje i <code>expected-values.md</code> og <code>grounded-answers.md</code>, fx „✅ 41/41 checks og 4/4 grounded answers: Difference 0 – ingen fejl“. Er Power BI Desktop forbundet til Claude, kører Claude filerne selv.',
  },
  en: {
    title: 'How to use checks.dax and grounded-answers.dax',
    lead: `For the report <b>${esc(NAME)}</b> (run <code>${esc(RUN)}</code>). The two files show whether the Power BI model gives the same numbers as your source files.`,
    nav: ['Why', 'Before you start', 'checks.dax', 'grounded-answers.dax', 'When a Difference is not 0'],
    why: 'Why use them?',
    whyP: `The model was built automatically and cleaned the data${steps ? ` in ${steps} steps` : ''}. The dashboard numbers can only be trusted if the model does what the cleaning promised. So the expected numbers were computed straight from the source files, not from the model, and the two files compare them with what Power BI computes.`,
    card1: `Checks the <b>totals</b> in ${checks.length} rows: row counts per table, the headline measures, keys without a match${hasFilterChecks ? ' and whether the measures react correctly to filters' : ''}.`,
    card2: `Checks <b>real business questions</b>: ${questions.length} questions a report user could ask, with the answer the source files give.`,
    where: dlDir ? `Both files are in Downloads: <code class="path">${esc(fileRef('checks.dax'))}</code> and <code class="path">${esc(fileRef('grounded-answers.dax'))}</code>. Open them in Notepad to copy the text.`
      : `Both files are in the run folder <code class="path">${esc(RUN_ABS + path.sep)}</code>. Open them in Notepad to copy the text.`,
    before: 'Before you start',
    b: [`Open <code class="path">${esc(PBIP_ABS)}</code> in Power BI Desktop.`, 'Click <b>Refresh</b> on the Home tab. Approve the folder access if Power BI asks.', 'Wait until the refresh is done. Without a refresh the model is empty and every number is wrong.'],
    runC: 'Run checks.dax',
    c: ['Click the <b>DAX query view</b> icon in the left bar (the lowest of the four icons).', 'Open <code>checks.dax</code> in Notepad, select all (Ctrl+A), copy (Ctrl+C) and paste it into DAX query view (Ctrl+V).', 'Click <b>Run</b>. You get a table with four columns:'],
    colH: ['Column', 'Meaning'],
    cols: [['Check', 'What is checked'], ['In Power BI', 'The number the model computes'], ['Expected', 'The number computed from the source files'], ['Difference', 'In Power BI minus Expected, rounded to 2 decimals. <span class="ok">Must be 0 in every row.</span>']],
    keyP: 'The key expected numbers:', keyH: ['Check', 'Expected', 'Why this number'],
    orphan: (n) => `Expected is ${n} here, not 0, and that is correct`,
    filterP: 'Rows ending in <i>follows a … filter</i> or <i>adds up over …</i> test that the measures react correctly when you filter. Both Expected and Difference are 0 there.',
    runG: 'Run grounded-answers.dax',
    gs: ['Clear DAX query view (Ctrl+A and Delete), or open a new tab with <b>+</b> at the bottom.', 'Paste the text of <code>grounded-answers.dax</code> and click <b>Run</b>.', 'You get the columns <b>No · Question · Value · Expected · Difference</b>.'],
    qH: ['No', 'Question', 'Expected'],
    tol: 'Difference is not rounded here. For percentages a rest below <b>0.00001</b> is rounding and counts as 0.',
    roles: 'Rows with "– as &lt;role&gt;" test security roles. Confirm them once with Modeling → <b>View as</b> → the role + <i>Other user</i>.',
    noQ: 'The run has no grounded-answers.dax yet. It comes when the business questions are written (step 8.9).',
    diff: 'When a Difference is not 0',
    d: ['<b>Many rows are wrong, or all are empty:</b> the model is probably not refreshed. Click Refresh and run again.', '<b>An error instead of a table:</b> read the message. It often names a cleaning step, e.g. <code>F08 Parse order_date</code>. Send the error to Claude.', '<b>Only one row differs:</b> give Claude the Check name and both numbers. Claude then uses the <i>reconcile</i> skill to split the difference until the rows behind it are found.'],
    note: 'You do not type the numbers in yourself. Right-click the result, choose <b>Copy table</b> and paste it into the chat (for both files). Claude then writes the numbers, the Difference and one result line into <code>expected-values.md</code> and <code>grounded-answers.md</code>, e.g. "✅ 41/41 checks and 4/4 grounded answers: Difference 0 – no errors". When Power BI Desktop is connected to Claude, Claude runs the files itself.',
  },
}[lang];

const whyText = (c) => {
  let w = (g.why || {})[c.name] || assumes[c.name] || '';
  if (w === '-') w = '';
  if (/ rows without /.test(c.name) && c.expected !== 0) w = (w ? w + '. ' : '') + T.orphan(num(c.expected));
  return w;
};
const tr = (cells, cls = []) => '<tr>' + cells.map((x, i) => `<td${cls[i] ? ` class="${cls[i]}"` : ''}>${x}</td>`).join('') + '</tr>';
const th = (cells, cls = []) => '<tr>' + cells.map((x, i) => `<th${cls[i] ? ` class="${cls[i]}"` : ''}>${x}</th>`).join('') + '</tr>';

const qRows = questions.map((q, i) => {
  const no = i + 1;
  const text = (g.questions || {})[String(no)] || q.question;
  const v = Number(q.expected);
  const shown = isPct(q) ? `${num(v)} (${pct(v)})` : num(v);
  return tr([no, esc(text), shown], ['', '', 'n']);
}).join('\n');

const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${lang === 'da' ? 'DAX-kontrolfiler' : 'DAX check files'}</title>
<style>
:root{--bg:#f7f6f2;--card:#ffffff;--ink:#1d1d1b;--muted:#5f5e58;--line:#e2dfd6;--accent:#b4532a;--ok:#2f7d4f;--warn:#a35b00;--code:#f0ede5}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#17181a;--card:#202226;--ink:#ecebe6;--muted:#a6a59f;--line:#34363b;--accent:#e2875d;--ok:#6cc58f;--warn:#e0a54a;--code:#2a2c31}}
:root[data-theme="dark"]{--bg:#17181a;--card:#202226;--ink:#ecebe6;--muted:#a6a59f;--line:#34363b;--accent:#e2875d;--ok:#6cc58f;--warn:#e0a54a;--code:#2a2c31}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:1.9rem;line-height:1.2;margin:0 0 8px}
h2{font-size:1.3rem;margin:40px 0 12px;padding-top:8px;border-top:1px solid var(--line)}
p.lead{color:var(--muted);margin:0 0 20px}
nav a{color:var(--accent);margin-right:14px;white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.card h3{margin:0 0 6px;font-size:1.05rem}
code{background:var(--code);padding:1px 6px;border-radius:5px;font-size:.92em}
ol li{margin-bottom:8px}
.tbl{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:.95rem}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ok{color:var(--ok);font-weight:600}.warn{color:var(--warn);font-weight:600}
.note{background:var(--card);border-left:4px solid var(--accent);padding:12px 16px;border-radius:6px;margin:16px 0}
.path{word-break:break-all}
</style>
</head>
<body>
<main>
<h1>${T.title}</h1>
<p class="lead">${T.lead}</p>
<nav><a href="#why">${T.nav[0]}</a><a href="#before">${T.nav[1]}</a><a href="#checks">${T.nav[2]}</a><a href="#grounded">${T.nav[3]}</a><a href="#diff">${T.nav[4]}</a></nav>

<h2 id="why">${T.why}</h2>
<p>${T.whyP}</p>
<div class="cards">
 <div class="card"><h3>checks.dax</h3>${T.card1}</div>
 <div class="card"><h3>grounded-answers.dax</h3>${hasGrounded ? T.card2 : T.noQ}</div>
</div>
<p>${T.where}</p>

<h2 id="before">${T.before}</h2>
<ol>${T.b.map((x) => `\n <li>${x}</li>`).join('')}
</ol>

<h2 id="checks">${T.runC}</h2>
<ol>${T.c.map((x) => `\n <li>${x}</li>`).join('')}
</ol>
<div class="tbl"><table>
${th(T.colH)}
${T.cols.map((r) => tr(r)).join('\n')}
</table></div>
${key.length ? `<p>${T.keyP}</p>
<div class="tbl"><table>
${th(T.keyH, ['', 'n', ''])}
${key.map((c) => tr([esc(c.name), num(c.expected), esc(whyText(c))], ['', 'n', ''])).join('\n')}
</table></div>` : ''}
${hasFilterChecks ? `<p>${T.filterP}</p>` : ''}

<h2 id="grounded">${T.runG}</h2>
${hasGrounded ? `<ol>${T.gs.map((x) => `\n <li>${x}</li>`).join('')}
</ol>
<div class="tbl"><table>
${th(T.qH, ['', '', 'n'])}
${qRows}
</table></div>
<p>${T.tol}</p>${roleRows ? `\n<p>${T.roles}</p>` : ''}` : `<p>${T.noQ}</p>`}

<h2 id="diff">${T.diff}</h2>
<ol>${T.d.map((x) => `\n <li>${x}</li>`).join('')}
</ol>
<div class="note">${T.note}</div>
</main>
</body>
</html>
`;

const out = path.join(runDir, guideName);
fs.writeFileSync(out, html, 'utf8');
const downloads = [];
if (dlDir) {
  fs.mkdirSync(dlDir, { recursive: true });
  const copy = (src, name) => { if (fs.existsSync(src)) { const d = path.join(dlDir, name); fs.copyFileSync(src, d); downloads.push(d); } };
  copy(out, guideName);
  copy(path.join(runDir, 'checks.dax'), 'checks.dax');
  copy(path.join(runDir, 'grounded-answers.dax'), 'grounded-answers.dax');
}
const warnings = [];
if (!checksDax) warnings.push('no checks.dax – run build-docs.js first');
if (!hasGrounded) warnings.push('no grounded questions yet – the guide says so');
console.log(JSON.stringify({ ok: !!checksDax, file: out, downloads, lang, checks: checks.length, keyChecks: key.length, questions: hasGrounded ? questions.length : 0, warnings: warnings.length, notes: warnings }, null, 1));
process.exit(checksDax ? 0 : 1);
