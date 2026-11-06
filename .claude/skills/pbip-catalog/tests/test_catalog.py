"""
Regression tests for pbip-catalog.

    python -m unittest discover -s .claude/skills/pbip-catalog/tests -v

The unit tests need nothing but Python. The run tests use real pipeline runs and are skipped unless
PBIP_CATALOG_RUNS points at a folder with runs (…/Pipeline/runs). They check that lineage coverage
does not drop below what the runs reached on 2026-11-04.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from sql_lineage import SqlLineage            # noqa: E402
from build_catalog import diff_catalog, looks_english, merge_editable, needs_translation   # noqa: E402

SQL = """
create table gold.t1 (a int, b text);
create table bronze.orders (order_id text, amount text);
insert into bronze.orders
select r.f[1], r.f[2]
from (select string_to_array(line, ',') as f from bronze.raw_lines where file_name = 'fact_orders') r;
create or replace procedure p() language plpgsql as $$
begin
  create temporary table tmp_x on commit drop as
  select s.id, upper(s.name) as nm from silver.src s;
  insert into gold.t1 select id, nm from tmp_x;
  with c as (select id * 2 as dbl, name from silver.src2), d (k) as (select dbl from c)
  insert into gold.t2 (k2) select k from d;
  insert into gold.t3 with e as (select x.v from bronze.raw x) select v from e;
  insert into gold.t4 (dt)
  select coalesce(o.d, (select p.d from silver.prev p where p.id = o.id - 1)) from silver.cur o;
end $$;
create view gold.v as with w as (select q.z from silver.q q) select z from w;
create view gold.o as select order_id from bronze.orders;
"""


class SqlLineageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sl = SqlLineage()
        cls.sl.add_sql(SQL)

    def test_temp_table_with_on_commit_drop(self):
        self.assertEqual(self.sl.column_chain('gold.t1', 'a'), 'tmp_x.id ← silver.src.id')
        self.assertIn('tmp_x', self.sl.temp)

    def test_positional_insert(self):
        self.assertTrue(self.sl.column_chain('gold.t1', 'b').startswith('tmp_x.nm ← silver.src.name'))

    def test_cte_before_insert_with_column_list(self):
        self.assertEqual(self.sl.column_chain('gold.t2', 'k2'), 'silver.src2.id')

    def test_cte_after_insert(self):
        self.assertEqual(self.sl.column_chain('gold.t3', 'v'), 'bronze.raw.v')

    def test_cte_in_view(self):
        self.assertEqual(self.sl.column_chain('gold.v', 'z'), 'silver.q.z')

    def test_scalar_subquery_resolved_inside(self):
        chain = self.sl.column_chain('gold.t4', 'dt')
        self.assertIn('silver.cur.d', chain)
        self.assertIn('silver.prev.d', chain)
        self.assertNotIn('silver.cur.p', chain)   # the subquery alias is not a column

    def test_raw_lines_end_at_csv_column(self):
        self.assertTrue(self.sl.column_chain('gold.o', 'order_id').endswith('fact_orders.csv › order_id'))


class LanguageTests(unittest.TestCase):
    def test_english(self):
        for t in ['Revenue on paid invoice lines.', 'All measures. The column is a hidden placeholder.',
                  'Account to account manager (many-to-many).']:
            self.assertTrue(looks_english(t), t)

    def test_danish_needs_translation(self):
        for t in ['By hvor hotellet ligger.', 'Alle ordrer uanset status.', 'Omsætning i seneste hele måned.',
                  'Kunder med mindst én Completed/Shipped-ordre.', 'Antal ordrer pr. kunde']:
            self.assertFalse(looks_english(t), t)
            self.assertTrue(needs_translation(t), t)

    def test_english_needs_no_translation(self):
        for t in ['Revenue on paid invoice lines.', 'All measures. The column is a hidden placeholder.',
                  'Account to account manager (many-to-many).', 'Technical key.']:
            self.assertFalse(needs_translation(t), t)

    def test_english_model_text_is_kept(self):
        r = merge_editable('k', 'Revenue on paid lines.', {}, {})
        self.assertEqual((r['Status'], r['Description']), ('From model', 'Revenue on paid lines.'))

    def test_danish_model_text_is_flagged_then_replaced_by_ai(self):
        self.assertEqual(merge_editable('k', 'Omsætning af betalte linjer.', {}, {})['Status'], 'Translate')
        r = merge_editable('k', 'Omsætning af betalte linjer.', {'k': 'Revenue on paid lines.'}, {})
        self.assertEqual((r['Status'], r['Description']), ('AI suggestion', 'Revenue on paid lines.'))

    def test_own_edit_wins_over_translation(self):
        prev = {'k': {'Description': 'My text', 'Status': 'Approved'}}
        r = merge_editable('k', 'Omsætning af betalte linjer.', {'k': 'AI text'}, prev)
        self.assertEqual((r['Status'], r['Description']), ('Approved', 'My text'))


class DiffTests(unittest.TestCase):
    def test_new_and_changed(self):
        old = {'tables': [], 'columns': [], 'measures': [{'Key': 'm[A]', 'DAX': 'SUM(x)', 'Description': 'a'}]}
        new = {'tables': [], 'columns': [],
               'measures': [{'Key': 'm[A]', 'DAX': 'SUM(y)', 'Description': 'a'},
                            {'Key': 'm[B]', 'DAX': '1', 'Description': 'b'}]}
        rows = diff_catalog(old, new)
        self.assertIn(('Changed', 'm[A]', 'DAX'), [(r['Change'], r['Key'], r['Field']) for r in rows])
        self.assertIn(('New', 'm[B]'), [(r['Change'], r['Key']) for r in rows])


RUNS = os.environ.get('PBIP_CATALOG_RUNS')
# minimum gold columns traced to SQL / to a CSV column, reached on 2026-11-04
EXPECTED = {'2026-10-30_retail_s1': (49, 24), '2026-10-30_hotel_s42': (46, 39), '2026-10-30_saas_s7': (50, 43)}


@unittest.skipUnless(RUNS, 'set PBIP_CATALOG_RUNS to the Pipeline/runs folder')
class RunTests(unittest.TestCase):
    def test_sql_coverage(self):
        for run, (traced, csv) in EXPECTED.items():
            mig = Path(RUNS) / run / 'medallion' / 'supabase' / 'migrations'
            if not mig.is_dir():
                continue
            sl = SqlLineage().load([mig])
            gold = [k for k in sl.columns if '_gold.' in k[0]]
            chains = [sl.column_chain(t, c) for t, c in gold]
            with self.subTest(run=run):
                self.assertGreaterEqual(sum(1 for c in chains if c), traced)
                self.assertGreaterEqual(sum(1 for c in chains if '.csv' in c), csv)

    def test_build_with_html(self):
        run = Path(RUNS) / '2026-10-30_saas_s7'
        if not (run / 'pbip').is_dir():
            self.skipTest('saas run missing')
        with tempfile.TemporaryDirectory() as out:
            res = subprocess.run(
                [sys.executable, str(SCRIPTS / 'build_catalog.py'), str(run / 'pbip'), '--out', out,
                 '--layout-config', str(run / 'pbip' / 'docs' / 'layout-config.json'),
                 '--sql', str(run / 'medallion' / 'supabase' / 'migrations'), '--html'],
                capture_output=True, text=True, encoding='utf-8', env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            self.assertEqual(res.returncode, 0, res.stderr)
            summary = json.loads(res.stdout)
            self.assertGreaterEqual(summary['lineageHtml']['edges'], 60)
            self.assertLessEqual(summary['lineageHtml']['unused'], 1)
            html = (Path(out) / 'lineage.html').read_text(encoding='utf-8')
            self.assertNotIn('/*__DATA__*/{}', html)


if __name__ == '__main__':
    unittest.main()
