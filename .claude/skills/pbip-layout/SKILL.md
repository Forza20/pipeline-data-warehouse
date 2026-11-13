---
name: pbip-layout
description: Builds the AdventureWorks report template (Exec Dashboard, Map, Product Detail, Customer Detail, Category Tooltip, Q&A, Decomposition Tree, Key Influencers – taken from adventureworks_report.pbix with its colours, navigation, bookmarks and layout) into a Power BI PBIP project and connects every page to the project's own measures and columns. The user always chooses which pages to include; colours can come from hex codes or a screenshot and change colours only. ALWAYS trigger when the user writes `apply "layout.md"` (also without quotes, e.g. "apply layout.md") together with a PBIP file/folder or a PBIP project open in Power BI Desktop, and when a pipeline agent (e.g. `layout-applier`) is asked to apply the layout – see "Pipeline mode".
---

# Apply the report template to a PBIP project

The template is a real report taken apart into [templates/adventureworks/](templates/adventureworks/)
(pages, visuals, bookmarks, icons; every colour a colour key). [layout.md](layout.md) describes the
pages and every template field with what it should be and its fallback. [scripts/gen-report.js](scripts/gen-report.js)
builds the chosen pages from a config ([config.example.json](config.example.json)). Measures and
parameters the pages need: [measures.md](measures.md). Colours: [colors.md](colors.md). Standing choices:
a profile ([profile.md](profile.md)).

Work with the user in their language (English by default).

## Prerequisites
- Load the skills `powerbi-authoring:semantic-model-authoring` (measures) and
  `powerbi-authoring:powerbi-report-cli` (PBIR, validate, preview) and follow their rules.
- `powerbi-report-author` CLI installed (`npm install -g @microsoft/powerbi-report-authoring-cli@latest`).
- The project must be PBIP in PBIR format (`<Name>.Report/definition/pages`). A .pbix: ask the user for
  File → Save as → *.pbip, and stop.

## Workflow

1. **Find the project.** The uploaded/named path, otherwise search for `*.pbip`. Note the `.Report` folder.

2. **Connect to the model.** Open in Power BI Desktop: powerbi-modeling-mcp (`ListLocalInstances` →
   `Connect`); otherwise `ConnectFolder` on `<Name>.SemanticModel/definition`. List tables, columns,
   measures and relationships (without MCP: read the TMDL, "Without powerbi-modeling-mcp"). Read the
   user's profile if there is one; say which choices come from it.

3. **The pages – always ask, even with a profile.** Use AskUserQuestion with two multiSelect questions,
   each option = a page, its description = what it shows and what the model has or lacks for it
   (layout.md → Pages):
   - "Which dashboard pages should the report have?" – Exec Dashboard, Map, Product Detail, Customer Detail
   - "Which analysis pages should the report have?" – Category Tooltip, Q&A, Decomposition Tree, Key Influencers
   A profile's `pages` are marked "(usually chosen)" in the labels; recommend nothing the model cannot
   fill (a map without a location column). The answer is `config.pages`. Nothing chosen: stop and ask again.

4. **Colours (only with a user present).** Ask whether the user has colour codes (hex, a `.md` file) or a
   screenshot of a website or brand. With neither: *Standard* – the template's own colours.
   - **A colour choice changes colours only.** Hex codes or a screenshot only fill `colors` (and `theme`)
     in config.json – pages, fields, texts, fonts, number formats and positions stay exactly as with
     *Standard*. The generator refuses unknown keys and anything that is not `#RRGGBB`;
     `node "<skill folder>/tests/colors-only.test.js"` proves it – run it after changing `gen-report.js`.
   - **Screenshot:** measure the colours instead of guessing:
     `powershell -NoProfile -ExecutionPolicy Bypass -File "<skill folder>/scripts/palette.ps1" -Path "<image>"`
     → `suggestion` has every colour key; mention `accentAdjusted`. The path of a pasted image is in the
     message (`[Image: source: …]`); without a file, read the colours visually and say they are estimated.
   - Hex codes: map them to the keys (colors.md → "From hex codes"); check the contrast (colors.md).
   - At most 2 variants (e.g. *Standard* and *Brand*); they differ in colours only.
   *In pipeline mode:* the profile's colours, otherwise *Standard*.

5. **Map the template fields.** For every field the chosen pages use (template.json → `fields`, each with
   its pages), find the model's best match with layout.md's tables: the expected content first, then the
   fallback, `null` when nothing fits. Run DAX to know the values (totals, categories, latest month).
   Check meanings: is a "line total" before or after discount; is a rate "high = bad" (template: return
   rate). When a fallback changes the meaning, set `labels` and `texts` (template.json → `pages[].texts`
   has every text exactly). `node gen-report.js … --preview` lists every unmapped field.

6. **Measures and parameters the pages need** (measures.md): last month, targets, gaps, price adjustment,
   revenue per customer, the field parameters. Targets: the model's own when it has them; otherwise ask the
   user for the growth over last month (profile `targetGrowth`, template 10 %). In a pipeline-power-bi run
   they go into `choices.json → build` and `rebuild.js` rebuilds the model – never by hand into the TMDL there.

7. **Show the mapping and a preview, and get approval.** Write config.json (step 8) and
   ```
   node "<skill folder>/scripts/gen-report.js" - "<config.json>" --preview "<scratchpad>/layout-preview.html"
   ```
   (a wireframe of the chosen pages: positions, sizes, background colours, titles and fields; Power BI
   draws the visuals). Show a table: page → template field → model field → value, the new measures, and
   what will be left out (`dropped`). Publish the preview as a private page when the Artifact tool is
   there, otherwise give the path. Ask with AskUserQuestion about the mapping and the colours, **and every
   decision** (below); build only after approval. *In pipeline mode:* no preview, no question – the table
   goes to `layout-mapping.md`, the decisions to `layout-decisions.json`.

   **Decisions – the user decides, with your recommendation.** Whatever the data leaves open is not chosen
   silently and not only noted: it is a decision with your recommendation and the alternatives. Typical:
   - a fallback that changes the meaning (margin % where the template has a return rate): the colour scale's
     direction (`reverseScales`), the texts (`texts`), or another measure;
   - targets: the model's own, or last month + a growth (5 / 10 / 15 %);
   - a template field with no match (`null`): leave the field or visual out, or use a named alternative;
   - a page the model cannot fill well (a map with cities only, Key Influencers with few attributes);
   - a visible column that holds personal data on a page (top customers).
   Ask with AskUserQuestion, at most 4 per call: per decision one question that stands on its own (what the
   data shows, why it matters), the recommendation first with "(Recommended)" and its reason in the
   description, then 1–3 alternatives with their effect; the user can always write their own ("Other").
   Apply the answers to config.json (or measures) before building.

8. **config.json** (scratchpad) like [config.example.json](config.example.json): `template`, `pages`,
   `fields` (`Table[Field]` or `null`), `labels`, `texts`, `reverseScales` (template fields whose colour
   scales run the other way), `title`/`subtitle` or `logo`, `colors`, `theme`.
   Save a copy as `<project folder>/docs/layout-config.json` (create `docs/`), so pbip-catalog can tag the
   fields with their page.

9. **Generate and check.**
   ```
   node "<skill folder>/scripts/gen-report.js" "<.Report folder>" "<config.json>"
   node "<skill folder>/scripts/check-fields.js" "<.Report folder>" "<.SemanticModel folder>"
   powerbi-report-author validate "<.Report folder>"
   ```
   `gen-report.js` prints the pages (with their ids), the bookmarks, `dropped` (visuals left out and why)
   and `notes` (fields left out of a visual, base theme changed). `check-fields.js` must say `ok: true`:
   every field the report uses exists in the model. Validation findings that come from the template's
   source report itself (Desktop wrote them) and are expected: `PBIR_FORMATTING_PROP_NESTED` on
   `anomalyDetection` (the revenue trend), `PBIR_FILTER_NAME_DUPLICATE_GLOBAL`, `PBIR_VISUAL_TYPE_DEPRECATED`
   (`map`, `qnaVisual`), `PBIR_DRILLTHROUGH_BACK_BUTTON_MISSING`, `PBIR_JSON_FILE_NO_SCHEMA` on
   `.pbip`/`definition.pbir`, `PBIR_SCHEMA_UNREACHABLE` offline. Fix every other error. A rerun replaces
   the pages of the earlier run (same ids) and leaves the report's own pages alone.

10. **Show it in Desktop and take a screenshot** following powerbi-report-cli's preview rules (`--status` →
    open/reload → `--screenshot`), one per page. With `hasUnsavedChanges: true`: ask the user to save
    (Ctrl+S) – Desktop may then overwrite the report files, so run step 9 again afterwards. Check: no empty
    visual or error icon, the tiles in `dark` with `teal` numbers, navigation buttons to the chosen pages
    only, the slicer panel opens with the filter icon, the drillthrough to Product Detail works.
    *In pipeline mode:* ask nothing – stop and report back (see below).

11. **Report** briefly: the pages built, which model field is where, new measures and parameters, what was
    left out, the colours. Offer to save the choices as a profile (profile.md), e.g. `profiles/<name>.json`.

12. **Offer a data catalog** (`pbip-catalog`, reads `docs/layout-config.json`). *In pipeline mode:* do not
    ask – note in `layout-mapping.md` that the catalog can run afterwards.

## Fixed rules
- Pages are 1280 × 720 and keep the template's layout, formats and display units (K, M).
- The user chooses the pages, every time. Never build a page the user did not choose.
- Never change the report's own pages. What the generator changes besides its pages: `pages.json` (its
  pages first), bookmarks of its pages, its icons and a logo, the base theme (→ the template's) and the
  colour theme `pbip-layout-theme.json` (colours only).
- Never publish to Fabric without an explicit instruction.

## Pipeline mode (run by an agent without a user)

When a subagent runs the skill (`layout-applier` in `/messy-pipeline`, a pipeline-power-bi run) or the task
says "pipeline mode":

- **Pages:** the orchestrator asked the user before the run – the pages are in `run.json` → `layout_pages`
  (or the task). **No pages given: do not choose them yourself** – finish with status `waiting_for_user`
  and the reason "pages not chosen"; the orchestrator asks.
- **Profile:** `run.json` → `profile` gives colours, title, labels, texts, target growth. Otherwise
  *Standard*; the target growth is a decision (below).
- **No AskUserQuestion** – but no silent choices either. Every decision (step 7) goes to
  `layout-decisions.json` in the run folder and the **recommendation is applied**, so the run finishes:
  ```json
  [ { "id": "return-rate-scale", "question": "The data has no returns; margin % stands where the template shows the return rate. Which way should its colour scale run?",
      "why": "In the template high = red (bad); for margin high is good.",
      "options": [ { "label": "High margin = light, low = red", "recommended": true, "effect": "reverseScales: [\"Measure Table[Return Rate]\"]" },
                   { "label": "Keep the template's direction", "effect": "no change" } ],
      "applied": "High margin = light, low = red" } ]
  ```
  The orchestrator (`/messy-pipeline`, pipeline-power-bi's hand-over) asks the user these questions with
  AskUserQuestion; an answer other than the applied one changes config.json and `gen-report.js` runs again.
- **Mapping:** write `layout-mapping.md` in the run folder: page → template field → model field → value →
  fallback used; new measures and parameters; `dropped`; the decisions with what was applied. The first
  match in layout.md wins; a fallback only when the model lacks the data.
- **Desktop (step 10):** check that Desktop is closed before writing. If Desktop is open with unsaved
  changes, or opening/the screenshot fails (memory, sign-in): do not retry, do not write further, finish
  with `waiting_for_user` and the reason.
- **Skills:** load `powerbi-authoring:semantic-model-authoring` and `powerbi-authoring:powerbi-report-cli`
  with the Skill tool; if they are missing, follow this file alone and note it.

### Without powerbi-modeling-mcp

- **Model:** read tables, columns, measures and relationships in `<Name>.SemanticModel/definition/tables/*.tmdl`.
- **Values (step 5):** if DAX cannot run, take control values from the source (`expected-values.md`, or SQL
  on the gold schema for a supabase-medallion-powerbi project).
- **New measures (step 6):** outside a pipeline-power-bi run, write them in the measure table's TMDL with
  **Desktop closed**: tab indentation, a new GUID per `lineageTag`, names in quotes when they contain
  spaces. Check that no lineageTag repeats.
- **Test:** open in Desktop (step 10) and compare the KPI tiles with the control values.

## Making a template from another report

`node "<skill folder>/scripts/extract-template.js" "<Name.Report>" "<skill folder>/templates/<key>"` turns
a report saved as PBIP (PBIR) into a template. It stops on a colour it has no key for (add it to
`classify()`), removes per-value formatting and the logo, and writes template.json (pages, fields, texts,
colours, icons). Then describe its pages and fields in layout.md and run the test.
