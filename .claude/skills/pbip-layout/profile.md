# Report profile

A profile saves the user's standing choices so they are not made again on every run: colours, which pages
they usually want, title, logo, names and texts. Example: [profile.example.json](profile.example.json).

```json
{
  "name": "my-style",
  "pages": ["exec", "map", "product", "customer", "tooltip"],
  "colors": { "dark": "#0B3D5C", "teal": "#F2A900", "gold": "#1C5A80" },
  "theme": true,
  "title": "Sales overview",
  "subtitle": "Latest complete month",
  "logo": "C:\\brand\\logo.png",
  "targetGrowth": 0.1,
  "labels": { "Measure Table[Total Profit]": "Gross margin" },
  "texts": { "Monthly Returns": "Monthly Customers" }
}
```

| Field | Meaning | If left out |
|---|---|---|
| `pages` | the pages the user usually wants (keys in layout.md). **Only a suggestion**: the user is still asked every time (SKILL.md step 3); in pipeline mode the orchestrator asks before the run | all pages pre-ticked |
| `colors` | colour keys ([colors.md](colors.md)) | the template's colours (*Standard*) |
| `theme` | `false` = do not register the colour theme | registered |
| `title` / `subtitle` | top-left of Exec Dashboard (where the source report has its logo) | "Sales overview" |
| `logo` | path to the user's own logo image (.png/.jpg) – shown instead of the title | the title |
| `targetGrowth` | growth for the targets when the model has none (measures.md "Targets") | asked; template 0.1 |
| `labels`, `texts` | names shown for fields; replaced titles and text boxes (layout.md) | the model's names; the template's texts |

How it is used:
- `colors`, `theme`, `title`, `subtitle`, `logo`, `labels` and `texts` are copied to config.json.
- `pages` pre-ticks the answers in the page question; what the user ticks goes into `config.pages`.
- The profile never changes the layout of a page – only which pages are built, their colours and texts.
