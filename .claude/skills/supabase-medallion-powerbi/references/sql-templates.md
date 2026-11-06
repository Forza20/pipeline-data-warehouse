# SQL templates (Supabase / Postgres)

Replace the example tables (`crm_customers`, `crm_products`, `crm_sales`, `erp_locations`) and columns
with the user's sources. Every block is safe to rerun.

## Contents
1. Schemas
2. Bronze tables
3. Loading bronze
   - psql · Table Editor · Loading without psql (token-protected RPC + curl) · Row-count check
4. Silver procedure
   - Parsing helpers · Flag amount anomalies · Dedupe by quality score · Unpivot wide files
5. Gold star schema + load procedure
   - Point-in-time value (e.g. unit cost at the order date)
   - Derived date with flag
   - Inferred members · Bridge with allocation
6. Quality checks (incl. source-conflict info check)
7. Security (read-only role, RLS)
8. Scheduling with pg_cron

---

## 1. Schemas

```sql
create schema if not exists bronze;
create schema if not exists silver;
create schema if not exists gold;
```

## 2. Bronze tables

One table per CSV. Column order = CSV header order, names in lower case.

```sql
-- source: crm/customers.csv
create table if not exists bronze.crm_customers (
    cst_id             integer,
    cst_key            text,
    cst_firstname      text,
    cst_lastname       text,
    cst_marital_status text,
    cst_gndr           text,
    cst_create_date    date
);

-- source: crm/sales.csv  (dates delivered as integers yyyymmdd)
create table if not exists bronze.crm_sales (
    sls_ord_num  text,
    sls_prd_key  text,
    sls_cust_id  integer,
    sls_order_dt integer,
    sls_ship_dt  integer,
    sls_due_dt   integer,
    sls_sales    integer,
    sls_quantity integer,
    sls_price    integer
);
```

## 3. Loading bronze

### psql through the session pooler (PowerShell)

psql may be installed without being on PATH – call it by full path. The password lives in the user's
password file, never in a script, an environment variable in a committed file, or the chat:
`%APPDATA%\postgresql\pgpass.conf` (Windows) / `~/.pgpass`, one line
`<pooler-host>:5432:postgres:<role>.<project-ref>:<password>` (escape `:` and `\` in the password as `\:`, `\\`).

```powershell
$psql = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'          # or (Get-Command psql).Source
$conn = 'host=aws-0-<region>.pooler.supabase.com port=5432 dbname=postgres user=<role>.<project-ref> sslmode=require'
& $psql $conn -w -c "select current_user"                       # -w: fail instead of prompting for a password

& $psql $conn -w -v ON_ERROR_STOP=1 -c "truncate bronze.crm_customers"
& $psql $conn -w -v ON_ERROR_STOP=1 -c "\copy bronze.crm_customers from 'C:/data/crm/customers.csv' with (format csv, header true)"
& $psql $conn -w -tAc "select count(*) from bronze.crm_customers"
```

**Table with RLS** (Supabase enables it on new tables): `\copy … from` fails for a role that is not the
owner. Load into a temp table in the same session instead (one `-f` script or several `-c` in one call):

```sql
create temp table s (like bronze.raw_lines including defaults);
\copy s from 'C:/data/stage/fact_orders.tsv' with (format text, encoding 'UTF8')
insert into bronze.raw_lines select * from s;
```

### Loader role (least privilege for psql loads)

A login that can do nothing until it is granted one run's bronze table, so the main `postgres` password is
never used for loading. The user sets the password and the password-file line themselves.

```sql
create role bronze_loader login noinherit connection limit 3;
alter role bronze_loader set statement_timeout = '10min';
-- before the load (run as owner):
grant usage on schema bronze to bronze_loader;
grant select, insert, delete, truncate on bronze.raw_lines to bronze_loader;
create policy bronze_loader_load on bronze.raw_lines for all to bronze_loader using (true) with check (true);
-- after the load:
drop policy bronze_loader_load on bronze.raw_lines;
revoke all on bronze.raw_lines from bronze_loader;
revoke usage on schema bronze from bronze_loader;
```

When the grants have to be repeated per run (or the MCP connection declines `grant`), wrap them in two
`security definer` functions with a name guard and call them with `select` – see the pipeline example
`mp_grant_loader` / `mp_revoke_loader`.

### Table Editor
Lower-case the header line first (columns are matched by exact name). Example in PowerShell:

```powershell
$src = 'C:\data\erp\LOC_A101.csv'; $dst = 'C:\data\import\erp_locations.csv'
$lines = Get-Content $src
@($lines[0].ToLower()) + $lines[1..($lines.Count-1)] | Set-Content $dst -Encoding utf8
```

### Loading without psql (token-protected RPC + curl)

Use only when psql, Python and the Table Editor are not options (e.g. files too big for MCP, no
installs allowed). Ask the user first: the function is a write endpoint on the public API while it
exists. Tested with 50,000 + 6,300 lines in 5,000-line batches.

**1. Staging table and splitter (keep – part of bronze, in a migration):**

```sql
create table if not exists bronze.raw_lines (
    file_name text not null, line_no int not null, line text not null,
    primary key (file_name, line_no)
);
alter table bronze.raw_lines enable row level security;

-- Split one CSV line into fields (quoted fields may contain commas; no escaped quotes assumed)
create or replace function bronze.split_csv_line(p_line text)
returns text[] language sql immutable set search_path = '' as $$
  select array_agg(nullif(trim(both '"' from m[1]), '') order by ord)
  from regexp_matches(p_line || ',', '("[^"]*"|[^,]*),', 'g') with ordinality as r(m, ord)
$$;

-- load_bronze(): truncate the per-file tables, then for each file:
-- insert into bronze.<file> select line_no, f[1], f[2], ...
-- from (select line_no, bronze.split_csv_line(line) f from bronze.raw_lines
--       where file_name = '<file>' and line_no > 1) s;
```

Check the field count before trusting the split:
`select count(*) from bronze.raw_lines where line_no > 1 and cardinality(bronze.split_csv_line(line)) <> <columns>;` → 0.

**2. Temporary endpoint (NOT a migration – run via SQL, drop after the load):**

```sql
create table bronze._ingest_token (token text primary key, expires_at timestamptz not null);
alter table bronze._ingest_token enable row level security;

create or replace function public.bronze_ingest(p_token text, p_file text, p_start int, p_lines text[])
returns int language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from bronze._ingest_token t where t.token = p_token and t.expires_at > now()) then
    raise exception 'denied';
  end if;
  if p_file not in ('<file1>', '<file2>') then raise exception 'unknown file'; end if;   -- whitelist
  insert into bronze.raw_lines (file_name, line_no, line)
  select p_file, p_start + u.ord - 1, u.l from unnest(p_lines) with ordinality as u(l, ord)
  on conflict (file_name, line_no) do update set line = excluded.line;
  return coalesce(array_length(p_lines, 1), 0);
end $$;
revoke all on function public.bronze_ingest(text, text, int, text[]) from public, authenticated;
grant execute on function public.bronze_ingest(text, text, int, text[]) to anon;

-- Generate the token locally (random 32 bytes, hex); keep it in the scratchpad, never in the repo
insert into bronze._ingest_token values ('<token>', now() + interval '1 hour');
```

**3. Upload (bash; `curl` ships with Git for Windows).** The URL and publishable key come from the
MCP tools `get_project_url` and `get_publishable_keys`.

```bash
CH=5000
for f in file1 file2; do
  n=$(wc -l < "$DIR/$f.csv"); start=1
  while [ $start -le $n ]; do
    tr -d '\r' < "$DIR/$f.csv" | awk -v s=$start -v e=$((start+CH-1)) -v tok="$TOK" -v file="$f" '
      NR==s{printf "{\"p_token\":\"%s\",\"p_file\":\"%s\",\"p_start\":%d,\"p_lines\":[", tok, file, s}
      NR>=s && NR<=e{gsub(/"/,"\\\""); printf "%s\"%s\"", (NR>s?",":""), $0}
      END{printf "]}"}' > body.json
    r=$(curl -s -X POST "$URL/rest/v1/rpc/bronze_ingest" -H "apikey: $KEY" \
          -H "Content-Type: application/json" --data-binary @body.json)
    case "$r" in ''|*[!0-9]*) echo "$f chunk $start FAILED: $r"; exit 1;; esac
    start=$((start+CH))
  done
done
```

Check first that the files contain no backslashes (`grep -cF '\' *.csv` → 0); otherwise escape them
too. A PGRST202 error ("could not find the function") usually means the JSON body is malformed.

**4. Clean up and verify** – immediately after the upload:

```sql
drop function if exists public.bronze_ingest(text, text, int, text[]);
drop table if exists bronze._ingest_token;
select count(*) from pg_proc where proname = 'bronze_ingest';   -- 0
```

If the `drop` is declined by the user's permission settings, first neutralise the endpoint
(`update bronze._ingest_token set expires_at = now();`) and give the user the drop statements to run.

### Row-count check

```sql
select table_name,
       (xpath('/row/c/text()', query_to_xml(
           format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as rows
from information_schema.tables
where table_schema in ('bronze', 'silver', 'gold')
order by table_schema, table_name;
```

## 4. Silver procedure

Create the silver tables with clean types first (same columns, `date` instead of integer dates, plus
an optional `dwh_create_date timestamptz default now()`). Intermediate steps go in named staging
tables (`silver.stg_<name>`, truncated at the start) or subqueries – never `create temp table` inside
the procedure (see *Dedupe by quality score*). Then:

```sql
create or replace procedure silver.load_silver()
language plpgsql
set search_path = ''
as $$
declare
    v_rows bigint;
begin
    -- Customers: trim, standardise codes, keep the latest row per customer
    truncate table silver.crm_customers;
    insert into silver.crm_customers (cst_id, cst_key, cst_firstname, cst_lastname,
                                      cst_marital_status, cst_gndr, cst_create_date)
    select cst_id,
           trim(cst_key),
           trim(cst_firstname),
           trim(cst_lastname),
           case upper(trim(cst_marital_status)) when 'S' then 'Single' when 'M' then 'Married' else 'n/a' end,
           case upper(trim(cst_gndr))           when 'F' then 'Female' when 'M' then 'Male'    else 'n/a' end,
           cst_create_date
    from (
        select *, row_number() over (partition by cst_id order by cst_create_date desc) as rn
        from bronze.crm_customers
        where cst_id is not null
    ) t
    where rn = 1;
    get diagnostics v_rows = row_count;
    raise notice 'silver.crm_customers: % rows', v_rows;

    -- Sales: parse yyyymmdd integers, repair inconsistent sales/price
    truncate table silver.crm_sales;
    insert into silver.crm_sales (sls_ord_num, sls_prd_key, sls_cust_id, sls_order_dt, sls_ship_dt,
                                  sls_due_dt, sls_sales, sls_quantity, sls_price)
    select sls_ord_num,
           sls_prd_key,
           sls_cust_id,
           case when sls_order_dt <= 0 or length(sls_order_dt::text) <> 8 then null
                else to_date(sls_order_dt::text, 'YYYYMMDD') end,
           case when sls_ship_dt  <= 0 or length(sls_ship_dt::text)  <> 8 then null
                else to_date(sls_ship_dt::text,  'YYYYMMDD') end,
           case when sls_due_dt   <= 0 or length(sls_due_dt::text)   <> 8 then null
                else to_date(sls_due_dt::text,   'YYYYMMDD') end,
           case when sls_sales is null or sls_sales <= 0 or sls_sales <> sls_quantity * abs(sls_price)
                then sls_quantity * abs(sls_price) else sls_sales end,
           sls_quantity,
           case when sls_price is null or sls_price <= 0
                then sls_sales / nullif(sls_quantity, 0) else sls_price end
    from bronze.crm_sales;

    -- Locations: normalise country variants and key format
    truncate table silver.erp_locations;
    insert into silver.erp_locations (cid, cntry)
    select replace(cid, '-', ''),
           case when trim(cntry) = 'DE' then 'Germany'
                when trim(cntry) in ('US', 'USA') then 'United States'
                when trim(cntry) = '' or cntry is null then 'n/a'
                else trim(cntry) end
    from bronze.erp_locations;

    -- Versioned dimension: end date = next start date - 1 day
    -- prd_end_dt = lead(prd_start_dt) over (partition by prd_key order by prd_start_dt) - interval '1 day'
exception
    when others then
        raise notice 'load_silver failed: %', sqlerrm;
        raise;   -- re-raise so the caller sees the failure
end;
$$;
```

Run with `call silver.load_silver();`.

### Parsing helpers (messy text columns)

```sql
create or replace function silver.key_no(p text) returns int
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(p, '\D', '', 'g'), '')::int            -- CUST-0001 / C0001 / 0001 -> 1
$$;
create or replace function silver.parse_date(p text) returns date
language sql immutable set search_path = '' as $$
  select case when p ~ '^\d{4}-\d{2}-\d{2}$'       then to_date(p, 'YYYY-MM-DD')
              when p ~ '^\d{2}/\d{2}/\d{4}$'       then to_date(p, 'MM/DD/YYYY')   -- check first: no part > 12 in position 1
              when p ~ '^\d{2}-[A-Za-z]{3}-\d{4}$' then to_date(p, 'DD-Mon-YYYY') end
$$;
create or replace function silver.parse_money(p text) returns numeric
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(p, '[$,\s]', '', 'g'), '')::numeric     -- $1,200.00 / 1,200 / -$5 -> numeric
$$;
create or replace function silver.parse_bool(p text) returns boolean
language sql immutable set search_path = '' as $$
  select case upper(trim(p)) when 'TRUE' then true when 'YES' then true when 'Y' then true when '1' then true
                             when 'FALSE' then false when 'NO' then false when 'N' then false when '0' then false end
$$;
```

Only strip digits from keys after checking that no number means two different things across formats.

### Flag amount anomalies (decision R2-6)

```sql
case
  when amount is null                                     then 'missing'
  when amount < 0                                         then 'negative'
  when amount = 0 and status = 'Completed'                then 'zero on completed'
  when quantity = 0 and status = 'Completed'              then 'zero quantity on completed'
  when quantity > 0 and price > 0 and amount > 5 * quantity * price then 'spike (>5x expected)'
  else 'ok'
end as amount_issue,
case when order_date is null then 'missing'
     when order_date > v_extract_end then 'future'         -- v_extract_end = max(ship_date)
     else 'ok' end as order_date_status
```

Gold then sets `revenue = case when amount_issue = 'ok' then amount end`, keeping `amount_raw`.

### Dedupe by quality score (decision R2-5, no timestamp)

Use a named staging table, not `create temp table … on commit drop`: a temp table inside the procedure
hides the step from lineage tools and fails when the procedure runs twice in one transaction.

```sql
-- once, next to the other silver tables:
--   create table silver.stg_orders (like parsed_orders, quality_score int, rn int, versions int);
truncate silver.stg_orders;
-- List every column (no p.* / s.*), so lineage tools can follow each one back to bronze.
insert into silver.stg_orders (source_line, order_no, order_date, ship_date, quantity, amount,
                               order_date_status, amount_issue, quality_score, rn, versions)
select s.source_line, s.order_no, s.order_date, s.ship_date, s.quantity, s.amount,
       s.order_date_status, s.amount_issue, s.quality_score,
       row_number() over (partition by s.order_no order by s.quality_score desc, s.source_line) as rn,
       count(*)     over (partition by s.order_no)                                            as versions
from (
  select p.source_line, p.order_no, p.order_date, p.ship_date, p.quantity, p.amount,
         p.order_date_status, p.amount_issue,
         (p.order_date_status = 'ok')::int + (p.amount_issue = 'ok')::int
         + (p.order_date is null or p.ship_date is null or p.ship_date >= p.order_date)::int
         + (p.quantity is not null)::int as quality_score
  from parsed_orders p
) s;

insert into silver.orders select ... from silver.stg_orders where rn = 1;

-- Keep the evidence: one row per removed version and why it differed
insert into silver.order_duplicates_removed (source_line, order_no, kept_source_line, duplicate_type)
select d.source_line, d.order_no, k.source_line,
       case when d.row_hash = k.row_hash then 'identical'
            when d.amount is not distinct from k.amount then 'same amount, other date/fields'
            else 'different amount' end
from silver.stg_orders d join silver.stg_orders k on k.order_no = d.order_no and k.rn = 1
where d.rn > 1;
```

`row_hash` = `md5(concat_ws('|', <parsed columns>))`, computed on parsed values so that the same date in
two formats counts as identical. Test: `bronze rows = silver rows + removed rows`.

### Unpivot wide files (one column per month)

```sql
insert into silver.monthly_targets (customer_no, month_start, target_amount)
select no, make_date(yr, m, 1), max(amt)
from (select silver.key_no(t.cust_id) no, t.year::int yr, v.m, silver.parse_money(v.val) amt
      from bronze.wide_monthly_targets t
      cross join lateral (values (1, t.jan_target), (2, t.feb_target), (3, t.mar_target), (4, t.apr_target),
                                 (5, t.may_target), (6, t.jun_target), (7, t.jul_target), (8, t.aug_target),
                                 (9, t.sep_target), (10, t.oct_target), (11, t.nov_target), (12, t.dec_target)) v(m, val)) x
where amt is not null          -- an empty cell means "no target", not 0
group by no, yr, m;
```

## 5. Gold star schema + load procedure

```sql
create table if not exists gold.dim_customers (
    customer_key    integer primary key,
    customer_id     integer not null,
    customer_number text,
    first_name      text,
    last_name       text,
    country         text,
    marital_status  text,
    gender          text,
    birthdate       date,
    create_date     date
);

create table if not exists gold.dim_products (
    product_key    integer primary key,
    product_id     integer not null,
    product_number text,
    product_name   text,
    category       text,
    subcategory    text,
    cost           integer,       -- unit cost
    product_line   text,
    start_date     date
);

create table if not exists gold.fact_sales (
    order_number  text,
    product_key   integer references gold.dim_products (product_key),
    customer_key  integer references gold.dim_customers (customer_key),
    order_date    date,
    shipping_date date,
    due_date      date,
    sales_amount  integer,
    quantity      integer,
    price         integer
);

create index if not exists fact_sales_product_key_idx  on gold.fact_sales (product_key);
create index if not exists fact_sales_customer_key_idx on gold.fact_sales (customer_key);
create index if not exists fact_sales_order_date_idx   on gold.fact_sales (order_date);

create or replace procedure gold.load_gold()
language plpgsql
set search_path = ''
as $$
begin
    truncate table gold.fact_sales, gold.dim_customers, gold.dim_products;

    insert into gold.dim_customers (customer_key, customer_id, customer_number, first_name, last_name,
                                    country, marital_status, gender, birthdate, create_date)
    select row_number() over (order by c.cst_id) as customer_key,
           c.cst_id                   as customer_id,
           c.cst_key                  as customer_number,
           c.cst_firstname            as first_name,
           c.cst_lastname             as last_name,
           coalesce(l.cntry, 'n/a')   as country,
           c.cst_marital_status       as marital_status,
           c.cst_gndr                 as gender,
           null::date                 as birthdate,
           c.cst_create_date          as create_date
    from silver.crm_customers c
    left join silver.erp_locations l on l.cid = c.cst_key;

    insert into gold.dim_products (product_key, product_id, product_number, product_name, category,
                                   subcategory, cost, product_line, start_date)
    select row_number() over (order by p.prd_start_dt, p.prd_key) as product_key,
           p.prd_id       as product_id,
           p.prd_key      as product_number,
           p.prd_nm       as product_name,
           x.cat          as category,
           x.subcat       as subcategory,
           p.prd_cost     as cost,
           p.prd_line     as product_line,
           p.prd_start_dt as start_date
    from silver.crm_products p
    left join silver.erp_categories x on x.id = p.cat_id
    where p.prd_end_dt is null;            -- current version only

    insert into gold.fact_sales (order_number, product_key, customer_key, order_date, shipping_date,
                                 due_date, sales_amount, quantity, price)
    select s.sls_ord_num  as order_number,
           p.product_key,
           c.customer_key,
           s.sls_order_dt as order_date,
           s.sls_ship_dt  as shipping_date,
           s.sls_due_dt   as due_date,
           s.sls_sales    as sales_amount,
           s.sls_quantity as quantity,
           s.sls_price    as price
    from silver.crm_sales s
    left join gold.dim_products  p on p.product_number = s.sls_prd_key
    left join gold.dim_customers c on c.customer_id    = s.sls_cust_id;
end;
$$;
```

**Name the target columns and alias computed values** in every gold `insert` (e.g.
`case when s.amount_issue = 'ok' then s.amount end as revenue`). It keeps the load readable, a column
added to the table cannot silently shift the others, and lineage tools (pbip-catalog's
`sql_lineage.py`) can follow each gold column back to silver and bronze. Without it, 6 of 10 gold
tables in a test stopped at the gold layer in the data catalog. For the same reason, **no CTEs in gold
inserts** (`insert … with x as (…) select …`): put the helper query in a subquery in `FROM` instead
(example: *Inferred members* below).

Run with `call gold.load_gold();`. If a gold table is read by a role that gets RLS, see section 7.

### Point-in-time value (e.g. unit cost at the order date)

Use when a dimension attribute is versioned (decision R2-1, option C). Add `unit_cost integer` to
`gold.fact_sales` and fill it in the fact insert. The lateral lookup picks the version that started
most recently on or before the order date; if the order predates every version (a gap), it takes the
first version.

```sql
insert into gold.fact_sales (order_number, product_key, customer_key, order_date, shipping_date,
                             due_date, sales_amount, quantity, price, unit_cost)
select s.sls_ord_num, p.product_key, c.customer_key,
       s.sls_order_dt, s.sls_ship_dt, s.sls_due_dt,
       s.sls_sales, s.sls_quantity, s.sls_price,
       v.prd_cost
from silver.crm_sales s
left join gold.dim_products  p on p.product_number = s.sls_prd_key
left join gold.dim_customers c on c.customer_id    = s.sls_cust_id
left join lateral (
    select h.prd_cost
    from silver.crm_products h
    where h.prd_key = s.sls_prd_key
    order by (h.prd_start_dt <= s.sls_order_dt) desc,                              -- versions in effect first
             case when h.prd_start_dt <= s.sls_order_dt then h.prd_start_dt end desc nulls last,
             h.prd_start_dt asc                                                    -- gap: first version
    limit 1
) v on true;
```

Derive missing order dates first (next template): a row with a NULL order date falls through to the
first version. Tested on a 60k-line sales set: every line got a cost, and margin moved from 39.8%
(current cost) to 42.2% (point-in-time).

Margin then becomes `SUMX ( fact_sales, fact_sales[sales_amount] - fact_sales[quantity] * fact_sales[unit_cost] )`.
Before switching, show the user margin with current vs point-in-time cost – the difference is the
evidence for the decision.

### Derived date with flag

Use when a date is missing but recoverable (decision R2-2, option B). In silver, after parsing:

```sql
-- 1) prove the pattern first: the lag must be constant (or near-constant) on all complete rows
select min(sls_ship_dt - sls_order_dt), max(sls_ship_dt - sls_order_dt)
from silver.crm_sales where sls_order_dt is not null and sls_ship_dt is not null;

-- 2) fill: sibling lines in the same order first, then the proven lag; flag every derived value
update silver.crm_sales s
set sls_order_dt = coalesce(
        (select max(t.sls_order_dt) from silver.crm_sales t
         where t.sls_ord_num = s.sls_ord_num and t.sls_order_dt is not null),
        s.sls_ship_dt - 7),                -- replace 7 with the proven lag
    sls_order_dt_derived = true
where s.sls_order_dt is null;
```

Add `sls_order_dt_derived boolean not null default false` to the silver table and carry it to gold as
`order_date_derived`, so derived rows can be filtered or shown.

### Inferred members (decision R2-4)

One dimension row per id that appears in the fact but not in the source dimension:

```sql
insert into gold.dim_customer (customer_key, customer_no, full_name, segment, region, is_inferred)
select row_number() over (order by i.customer_no)  as customer_key,
       i.customer_no                                as customer_no,
       coalesce(c.full_name, 'Unknown customer')    as full_name,
       coalesce(c.segment, 'n/a')                   as segment,
       coalesce(c.region, 'n/a')                    as region,
       i.inferred                                   as is_inferred
from (select customer_no, false as inferred from silver.customers
      union
      select distinct o.customer_no, true from silver.orders o
      where o.customer_no is not null
        and not exists (select 1 from silver.customers c where c.customer_no = o.customer_no)) i
left join silver.customers c on c.customer_no = i.customer_no;
```

Use a subquery in `FROM`, not `insert … with ids as (…) select …`: lineage tools (pbip-catalog's
`sql_lineage.py`) do not follow CTEs, so every column of a CTE-loaded table stops at the gold layer (all 8
columns of `dim_guest` in a test run).

The fact can then use an inner join to the dimension without losing rows. Test: orders on inferred
customers = the expected orphan count (computed on silver, after dedupe).

### Bridge with allocation (many-to-many, decision R3-6)

```sql
create table if not exists gold.bridge_customer_rep (
    customer_key int not null references gold.dim_customer (customer_key),
    rep_key      int not null references gold.dim_rep (rep_key),
    allocation   numeric not null,                   -- 1 / reps per customer, not rounded
    primary key (customer_key, rep_key)
);

insert into gold.bridge_customer_rep
select c.customer_key, r.rep_key, 1.0 / count(*) over (partition by c.customer_key)
from (select distinct customer_no, rep_no from silver.customer_rep) b     -- the source had duplicate pairs
join gold.dim_customer c on c.customer_no = b.customer_no
join gold.dim_rep      r on r.rep_no      = b.rep_no;
```

Tests: `select customer_key from gold.bridge_customer_rep group by 1 having abs(sum(allocation) - 1) > 0.0001` → 0 rows;
allocated total = revenue of customers that have a rep, within a tolerance of 1 currency unit. Do not
round the allocation: `numeric(6,5)` with `round(…, 5)` left 56 DKK unallocated in a test dataset.
Unrounded `numeric` keeps the sum exact enough. DAX: `tmdl-templates.md` → *Bridge measures*.

## 6. Quality checks (expect 0 everywhere)

```sql
select 'dim_customers: duplicate key' as check_name, count(*) as errors
from (select customer_key from gold.dim_customers group by 1 having count(*) > 1) x
union all
select 'dim_products: duplicate key', count(*)
from (select product_key from gold.dim_products group by 1 having count(*) > 1) x
union all
select 'fact_sales: orphan customer_key', count(*)
from gold.fact_sales f left join gold.dim_customers c using (customer_key) where c.customer_key is null
union all
select 'fact_sales: orphan product_key', count(*)
from gold.fact_sales f left join gold.dim_products p using (product_key) where p.product_key is null
union all
select 'silver sales: sales <> quantity * price', count(*)
from silver.crm_sales where sls_sales <> sls_quantity * sls_price
union all
select 'silver sales: order after ship/due', count(*)
from silver.crm_sales where sls_order_dt > sls_ship_dt or sls_order_dt > sls_due_dt
union all
select 'info: fact rows without order_date', count(*)
from gold.fact_sales where order_date is null;

-- Info: conflicts between sources for the same attribute (decision R2-3); not an error, but tracked
select 'info: gender differs between CRM and ERP' as check_name, count(*) as rows
from silver.crm_customers c
join silver.erp_customers e on e.cid = c.cst_key
where c.cst_gndr <> 'n/a' and e.gen <> 'n/a' and c.cst_gndr <> e.gen;

-- Distinct values of standardised columns
select 'gender' as col, string_agg(distinct gender, ', ') from gold.dim_customers
union all select 'country', string_agg(distinct country, ', ') from gold.dim_customers;
```

Two traps when writing checks and summary tables:

- **Expected values from the same layer.** Compute every expected count on the layer the test reads.
  Orphans counted in the raw CSV (2,015 rows) were 1,965 orders in gold after deduplication.
- **`null` in the first branch of a `union all` is typed `text`.** A later numeric branch then fails
  with *UNION types text and numeric cannot be matched*. Cast it: `select 10, 'Orders', count(*), null::numeric, ...`.

A `data_quality` table in gold (one row per rule: rows affected, amount affected, handling) gives the
report a data-quality page that explains every difference between source and model.

### `docs/quality-results.md` (fixed format)

Write the output of the checks above to this file, one row per check, numbered in query order.
`ERR` = must be 0; `INFO` = accepted exception, with the decision id that accepts it.

```markdown
# Quality results – <schema prefix>, <date>

| # | Type | Check | Result |
|---|------|-------|--------|
| 1 | ERR  | dim_customers: duplicate key | 0 |
| 2 | ERR  | fact_sales: orphan customer_key | 0 |
| 7 | INFO | fact rows without order_date | 19 (R2-2) |

ERR total: 0 · INFO rows: 1
```

Keep the column names and order. Tools and later runs parse the table, so do not add columns.

## 7. Security (read-only role, RLS)

```sql
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'powerbi_reader') then
        create role powerbi_reader login nosuperuser nocreatedb nocreaterole noinherit connection limit 10;
    end if;
end
$$;

alter role powerbi_reader set default_transaction_read_only = on;

grant usage  on schema gold to powerbi_reader;
grant select on all tables in schema gold to powerbi_reader;
alter default privileges for role postgres in schema gold
    grant select on tables to powerbi_reader;

-- RLS: only needed when RLS is enabled on the table (check pg_class.relrowsecurity).
-- Without a policy, RLS is default-deny and Power BI sees 0 rows.
drop policy if exists powerbi_reader_select on gold.fact_sales;
create policy powerbi_reader_select on gold.fact_sales for select to powerbi_reader using (true);
-- repeat for every gold table

-- The user sets the password themselves:
--   alter role powerbi_reader with password '<password>';
-- Power BI user name via the pooler: powerbi_reader.<project-ref>
```

Check which gold tables have RLS:

```sql
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'gold' and c.relkind = 'r';
```

## 8. Scheduling with pg_cron (optional)

```sql
create extension if not exists pg_cron;
select cron.schedule('nightly-medallion', '0 2 * * *',
                     $$call silver.load_silver(); call gold.load_gold();$$);
```
