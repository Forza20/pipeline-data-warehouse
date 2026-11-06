# PBIP Governance Inspector — Claude Skill

A Claude skill for analyzing Power BI Project (PBIP) files, producing governance documentation, data lineage, and Azure DevOps wiki bundles.

## What's included

```
pbip-governance/
├── SKILL.md                          ← Main skill definition Claude reads
├── README.md                         ← This file
├── scripts/
│   ├── parse_pbip.py                 ← TMDL + PBIR parser (Python)
│   └── generate_azdo_wiki.py         ← Wiki bundle generator
├── references/
│   └── pii_patterns.md               ← DA/EN PII heuristic patterns
└── assets/
    └── pbip-inspector.html           ← Standalone browser fallback
```

## Installation (Claude.ai / Cowork)

1. **Zip the folder.** The zip must contain `pbip-governance/` as its root, not a subfolder. From this folder's parent directory:
   ```bash
   zip -r pbip-governance.zip pbip-governance/
   ```

2. **Enable Skills** in Claude settings:
   - Free/Pro/Max: Customize → Skills → toggle "Code execution and file creation"
   - Team: enabled by default at the org level
   - Enterprise: ask your org owner to enable both "Code execution and file creation" and "Skills"

3. **Upload the skill:**
   - In Claude Cowork: Customize → Skills → click the `+` → upload `pbip-governance.zip`
   - In claude.ai: Settings → Customize → Skills → Upload custom skill

4. **Test it.** Start a new conversation and say something like:
   > "Analyze this PBIP project and generate an Azure DevOps wiki bundle: /path/to/MyProject"

   Claude should auto-detect that the skill is relevant and load it.

## Usage examples

Once installed, trigger the skill with prompts like:

- "Document the PBIP folder I uploaded — governance + handover"
- "Generate an Azure DevOps wiki for this Power BI project"
- "Audit my semantic model for potential PII columns"
- "Show me the data lineage for this PBIP"

For users without the skill installed, the standalone `assets/pbip-inspector.html` can be used in any browser:
1. Open the HTML file in Chrome/Edge
2. Drag the PBIP folder onto the dropzone
3. Navigate tabs → Export → Download Azure DevOps Wiki (.zip)

## Limitations

- **PBIX binary files are not supported.** Save your `.pbix` as a PBIP via Power BI Desktop → File → Save As → Power BI Project first.
- **No transitive DAX dependency graph in v1.** Measure-to-measure dependencies are not computed.
- **No VertiPaq statistics.** Column cardinality and storage size require Analysis Services access, which filesystem-only parsing cannot provide.
- **M expression parsing is regex-based**, not a full M parser — unusual source functions may be flagged as "Other".

## Related

- Azure DevOps wiki Markdown reference: https://learn.microsoft.com/en-us/azure/devops/project/wiki/markdown-guidance
- PBIP format: https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-overview
- TMDL language: https://learn.microsoft.com/en-us/analysis-services/tmdl/tmdl-overview
