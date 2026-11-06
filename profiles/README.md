# Report profiles

A profile decides how the dashboard looks in every run: colours, KPIs, sections and title. The format is
described in the pbip-layout skill's `profile.md` (`.claude/skills/pbip-layout/profile.md`).

- `default.json` is used automatically by `layout-applier` in every run. If it does not exist, the skill's
  *Standard* is used. `/messy-pipeline` can create it for you before a run ("Save as default").
- For one run: `/messy-pipeline` asks about colours, sections and title before the start and writes
  `runs/<run-id>/profile.json`.
- `example.json` is an example. Copy it to `default.json` and edit it to use it.

KPIs are given by `slot` (`KPI 1`–`KPI 4`, the proposal in layout.md), so they fit every domain (retail,
hotel, saas). A `measure` name fits only models that have a measure with that name.
