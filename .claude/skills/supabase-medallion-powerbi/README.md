# Supabase Medallion → Power BI (PBIP/TMDL)

**From a folder of CSV files to a tested Supabase data warehouse and a version-controlled Power BI
report – without the day of debugging in between.**

## What it does

This skill guides your coding agent through a complete, proven analytics build:

1. **Profiles your CSV files** and agrees the star schema with you (grain, keys, facts vs dimensions).
   Then it interviews you about the purpose and shape of the project (see below).
2. **Builds a medallion warehouse in Supabase Postgres**
   - *Bronze*: raw, replayable copies of every file.
   - *Silver*: one load procedure that trims, standardises codes, deduplicates, parses dates and repairs
     inconsistent values.
   - *Gold*: a star schema materialised as tables with stable surrogate keys.
3. **Tests every layer** with zero-error quality checks and expected row counts.
4. **Secures Power BI access** with a read-only role, correct RLS policies and advisor-clean procedures.
5. **Connects Power BI** through the Supabase session pooler – including the certificate step most
   guides miss.
6. **Writes the Power BI Project (PBIP) as text**: TMDL model with parameters, import queries, a
   generated date table, inactive relationships and a measure table (revenue, margin, YTD, YoY,
   latest-complete-month cards, top-N text).
7. **Hands over** row counts, a refresh procedure, optional `pg_cron` scheduling and a clean Git commit.

## It interviews you – about your data

A pipeline is easy to copy; the decisions behind the numbers are not. At four points (before building,
after silver, after gold, before hand-over) the skill **grills you**, one question at a time, about the
choices that change headline figures in *your* data:

- Should margin use today's cost or the cost at the time of sale?
- May missing dates be derived – and is there a pattern in your data that proves it?
- Which system wins when CRM and ERP disagree?
- Do category breakdowns of order counts add up to the total – and how should they be labelled?
- Are the first and last months complete, or will the trend chart show a fake collapse?
- Which order statuses count as revenue – or are cancelled and returned orders inflating it?
- When a customer has three sales reps, who gets the credit – without counting the revenue three times?
- Which duplicate wins when there is no timestamp, and what happens to negative amounts and spikes?
- Does the public repo reveal your project ref, host and user names?

Before each question it runs queries on your data and shows the evidence (rows affected, share of
revenue, how much a KPI moves), offers lettered options and recommends one. You answer with a letter or
"your recommendation". Every decision goes into a decision log in your project, so anyone can see why
the numbers are what they are. Questions that don't apply to your data are skipped.

## Why it saves time

Most of the effort in this kind of project goes into a handful of non-obvious failures. The skill knows
them and fixes them up front:

- Table Editor CSV imports silently failing on **upper-case headers**.
- **RLS without a policy** making Power BI return **0 rows** while the login succeeds.
- The pooler rejecting logins without the **`user.project-ref`** user name.
- *"The remote certificate is invalid"* – the **Supabase root certificate** Windows does not trust.
- TMDL load errors such as **descriptions on relationships**, spaces instead of tabs and duplicate
  lineage tags.
- Reports crashing on open because they have **no base theme**.
- Dark KPI tiles rendering **white** because of the card visual's inner fill.
- "This month vs last month" cards showing a fake drop because the **data ends mid-month**.
- **Many-to-many joins** (customer ↔ sales rep) inflating rep totals – handled with an allocated bridge.
- **No psql or Python** on the machine – a token-protected upload endpoint that is removed after the load.
- Cards showing **"1tusind"**, cut-off values and alphabetical bars – formatting defaults applied up front.

A full error → cause → fix table is included.

## Who it is for

Analysts, BI developers and consultants who want a real warehouse behind their Power BI reports, use
(or want to use) Supabase, and like their models in Git.

## Requirements

- A Supabase project (SQL Editor and Table Editor, or the Supabase MCP server for your agent).
- Power BI Desktop on Windows.
- Optional: `psql` for scripted loads (without it: `curl`, included with Git for Windows); a PBIR tool
  such as the `powerbi-report-author` CLI (Node.js) for validating and previewing report pages
  (without it: a PowerShell reference check).

## What's included

```
supabase-medallion-powerbi/
├── SKILL.md                       # the workflow, phase by phase, with checks and interview rounds
├── README.md                      # this description
└── references/
    ├── decision-interview.md      # interview protocol, decision log, question bank with detection SQL
    ├── sql-templates.md           # bronze, loading, silver, gold, point-in-time values, derived dates,
    │                              # quality checks, security, pg_cron
    ├── tmdl-templates.md          # PBIP layout, parameters, partitions, date table, measures, report
    └── troubleshooting.md         # every error we hit, with cause and fix
```

## Installation

Unzip into your agent's skills folder, for example:

- Claude Code: `~/.claude/skills/supabase-medallion-powerbi/`
- Other agents: the folder your agent reads `SKILL.md` skills from.

## Example prompts

- "I have six CSV exports from our CRM and ERP in `data/`. Load them into Supabase with bronze, silver
  and gold layers and give me a Power BI model on top."
- "Power BI connects to Supabase but every table is empty."
- "Getting 'remote certificate is invalid' when connecting Power BI to Supabase."
- "Turn the gold schema into a PBIP with a date table and the usual sales measures."

## Limitations

- Power BI Desktop is Windows-only, so the Power BI phases assume Windows.
- The skill does not ship Microsoft's report theme files; it tells the agent how to copy one from a
  project saved by your own Power BI Desktop.
- Scheduled refresh in the Power BI Service (gateway, credentials) is out of scope.
- Examples use a generic CRM/ERP sales dataset; adapt table and column names to your sources.

## Safety

The skill never writes passwords to files, migrations or chat – you set the database password
yourself. It only creates read-only access for Power BI and asks before deleting anything.
