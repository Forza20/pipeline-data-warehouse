# Model health

Model: `pbip` · 20 columns · 2 relationships · facts: fact_orders

**7 warnings, 1 info.**

| | Finding | Where | Why / what to do |
|---|---|---|---|
| ⚠ | unused column | fact_orders[beloeb] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[beloeb_issue] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[betalt] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[dato_status] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[kanal] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[ordrenr] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ⚠ | unused column | fact_orders[region] | not used by a measure, relationship, RLS rule or the report – remove it from the build spec |
| ℹ | text key | fact_orders[kunde_id] → dim_customers[kunde_id] | relationship on a text column – an integer surrogate key is smaller and faster |
