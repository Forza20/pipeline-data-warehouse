// The filter contract of a measure (build-spec.md → measures[].filters) as DAX checks, each with expected 0.
// Used by build-docs.js (checks.dax, against the saved model) and measure-test.js (a DEFINE test before saving).
//   ignore: ["Date[Month]"]           a filter on the column must not change the value
//   keep:   ["Product[Category]"]     a filter on the column must change it (when more than one member has data)
//   additive: true                    the values per keep member add up to the total
// The value filtered on is the first member with data (FIRSTNONBLANK over ALL), so no value is guessed.
'use strict';
const q = (n) => `'${String(n).replace(/'/g, "''")}'`;
const ref = (s) => { const m = String(s).match(/^'?(.+?)'?\[(.+)\]$/); return m ? { table: m[1].replace(/''/g, "'"), column: m[2] } : null; };
const measuresTable = (B) => B.measuresTable || (B.naming === 'snake_case' ? '_measures' : '_Measures');
const mref = (B, n) => `${q(measuresTable(B))}[${String(n).replace(/]/g, ']]')}]`;
const cref = (r) => `${q(r.table)}[${r.column.replace(/]/g, ']]')}]`;

function contractChecks(B, m, warnings = []) {
  const f = m.filters;
  if (!f) return [];
  const M = mref(B, m.name);
  const out = [];
  for (const x of f.ignore || []) {
    const r = ref(x);
    if (!r) { warnings.push(`${m.name}: filters.ignore "${x}" is not Table[Column]`); continue; }
    out.push({ name: `${m.name} ignores a ${x} filter`, dax: `ROUND ( CALCULATE ( ${M}, FIRSTNONBLANK ( ALL ( ${cref(r)} ), ${M} ) ) - ${M}, 2 ) + 0`,
      expected: 0, assumes: `filter contract: ${x} does not change the value` });
  }
  for (const x of f.keep || []) {
    const r = ref(x);
    if (!r) { warnings.push(`${m.name}: filters.keep "${x}" is not Table[Column]`); continue; }
    out.push({ name: `${m.name} follows a ${x} filter`,
      dax: `IF ( COUNTROWS ( FILTER ( ALL ( ${cref(r)} ), NOT ISBLANK ( ${M} ) ) ) > 1 && CALCULATE ( ${M}, FIRSTNONBLANK ( ALL ( ${cref(r)} ), ${M} ) ) = ${M}, 1, 0 )`,
      expected: 0, assumes: `filter contract: ${x} changes the value (1 = the filter is ignored)` });
    if (f.additive) {
      out.push({ name: `${m.name} adds up over ${x}`, dax: `ROUND ( SUMX ( ALL ( ${cref(r)} ), ${M} ) - ${M}, 2 ) + 0`,
        expected: 0, assumes: `filter contract: additive over ${x}` });
    }
  }
  return out;
}

module.exports = { contractChecks, measuresTable, mref, cref, ref, q };
