/**
 * Every built-in report, run against a live site database.
 *
 * A report template is data, not code, so the compiler cannot tell you that a
 * field key was renamed or that a filter names a column the source does not
 * have. validateSpec DROPS anything it does not recognise — which is right for
 * a saved report surviving a rename, but means a typo in a template degrades
 * silently into a report missing a column nobody notices is gone.
 *
 * So this checks two different things:
 *
 *   NOTHING WAS DROPPED. Every column, grouping, filter and sort a template
 *   asks for still resolves against the catalog. This is the check that catches
 *   a typo the day it is written rather than the day someone runs the report.
 *
 *   THE SQL EXECUTES. Each template is actually run. A spec can be perfectly
 *   valid and still produce SQL the database rejects — a grouping on a field
 *   whose expression is not groupable, a join that was never declared.
 *
 * Row counts are NOT asserted: a site with no purchases legitimately returns
 * nothing, and a test that demands data would fail on a clean install.
 *
 *   npm run test:report-templates
 */
import { TEMPLATES, templateSpec } from "../src/lib/reportBuilder/templates";
import { resolveReport } from "../src/lib/reportBuilder/resolve";
import { getSource } from "../src/lib/reportBuilder/catalog";
import { validateSpec, ROW_COUNT_FIELD } from "../src/lib/reportBuilder/spec";
import { runBuilderSpec } from "../src/lib/reportBuilder/run";

const SITE = 1;
let fails = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(
    `${cond ? "PASS" : "**FAIL**"}  ${label}${extra ? "  -- " + extra : ""}`,
  );
};

/** The templates assume a full-access reader; per-capability hiding is run.ts's own test. */
const canAll = () => true;

/**
 * Every runnable spec: each template, plus each CUT of one that offers them.
 *
 * A variant's spec is not reachable from `TEMPLATES[].spec`, so iterating the
 * templates alone would leave every cut but the default unchecked — they would
 * stop being verified against the live schema on the very day they stopped
 * being top-level entries. A cut is a report somebody opens; it gets the same
 * validation and the same live run as any other.
 */
function runnable() {
  return TEMPLATES.flatMap((t) => {
    const base = { id: t.id, spec: t.spec, name: t.name };
    const cuts = (t.variants ?? []).map((v) => ({
      id: `${t.id}?cut=${v.key}`,
      spec: v.spec,
      name: v.name,
    }));
    /* A template WITH cuts has its own spec duplicated by the default cut — see
       the note on ReportTemplate.variants — so checking both would report every
       result twice. The cuts are the truth; the base spec is only what renders
       before anyone chooses, and the first cut is asserted equal to it below. */
    return cuts.length > 0 ? cuts : [base];
  });
}

async function main() {
  const units = runnable();
  console.log(
    `\n${TEMPLATES.length} built-in reports, ${units.length} runnable specs\n`,
  );

  const ids = TEMPLATES.map((t) => t.id);
  ok("every template id is unique", new Set(ids).size === ids.length);

  /* A retired id must never collide with a live one, and every cut claiming one
     must be resolvable — that is what keeps a shop's schedules and the public
     API working after a consolidation. */
  const legacyIds = TEMPLATES.flatMap((t) =>
    (t.variants ?? []).map((v) => v.legacyId).filter((x): x is string => !!x),
  );
  ok(
    "no retired id collides with a live template",
    legacyIds.every((l) => !ids.includes(l)),
    legacyIds.filter((l) => ids.includes(l)).join(", "),
  );
  ok(
    "every retired id is unique",
    new Set(legacyIds).size === legacyIds.length,
  );

  /*
   * A retired id still RESOLVES, to its own cut and under its own name.
   *
   * The two checks above only prove the ids are distinct; this proves they still
   * work. It is the whole promise of a consolidation: a shop's favourite, its
   * 06:00 schedule and an API caller naming 'sales-by-product' must each get the
   * report they have always got, keeping their own id so their stored columns
   * come with them — never redirected to the consolidated tile, whose default cut
   * would quietly be a different set of figures.
   */
  for (const t of TEMPLATES) {
    for (const v of t.variants ?? []) {
      if (!v.legacyId) continue;
      const r = await resolveReport(SITE, v.legacyId);
      ok(
        `${v.legacyId}: still resolves, as "${v.name}"`,
        r?.name === v.name,
        r ? r.name : "null",
      );
      ok(
        `${v.legacyId}: keeps its own id and columns`,
        r?.id === v.legacyId && r?.prefsId === v.legacyId,
      );
      /* No switch on a retired id: offering the other cuts would turn a stable
         integration key into a different report the moment someone clicked. */
      ok(`${v.legacyId}: offers no switch`, r?.variants.length === 0);
    }
  }

  /* The default cut IS the base spec: the report has to render before anyone has
     chosen a cut, and if the two drift the first thing a reader sees is not the
     thing the tab says is selected. */
  for (const t of TEMPLATES.filter((x) => x.variants?.length)) {
    ok(
      `${t.id}: the first cut matches the report's own spec`,
      JSON.stringify(t.variants![0].spec) === JSON.stringify(t.spec),
    );
  }

  for (const t of units) {
    const source = getSource(t.spec.source);
    if (!source) {
      ok(`${t.id}: source exists`, false, `no such source: ${t.spec.source}`);
      continue;
    }

    // ── nothing silently dropped ────────────────────────────────────────────
    const runSpec = { ...t.spec, name: t.name };
    const checked = validateSpec(runSpec);
    if (!checked.ok) {
      ok(`${t.id}: spec is valid`, false, checked.error);
      continue;
    }
    const got = checked.spec;

    const wantCols = t.spec.columns
      .map((c) => c.field)
      .filter((f) => f !== ROW_COUNT_FIELD);
    const gotCols = new Set(got.columns.map((c) => c.field));
    const lostCols = wantCols.filter((f) => !gotCols.has(f));

    const lostGroups = (t.spec.groupFields ?? []).filter(
      (f) => !got.groupFields.includes(f),
    );
    const lostFilters = (t.spec.filters ?? [])
      .filter(
        (f) => !got.filters.some((x) => x.field === f.field && x.op === f.op),
      )
      .map((f) => `${f.field} ${f.op}`);
    // Total filters only survive on a summarised spec — that is validateSpec's
    // rule, not a fault, so only check them where they can apply.
    const lostTotals =
      got.groupFields.length > 0
        ? (t.spec.totalFilters ?? [])
            .filter((f) => !got.totalFilters.some((x) => x.key === f.key))
            .map((f) => f.key)
        : [];
    const lostSort = t.spec.sort && !got.sort ? t.spec.sort.key : null;

    const dropped = [
      ...lostCols.map((f) => `column ${f}`),
      ...lostGroups.map((f) => `group ${f}`),
      ...lostFilters.map((f) => `filter ${f}`),
      ...lostTotals.map((f) => `total filter ${f}`),
      ...(lostSort ? [`sort ${lostSort}`] : []),
    ];
    ok(
      `${t.id}: nothing dropped by the catalog`,
      dropped.length === 0,
      dropped.join(", "),
    );

    // ── the SQL actually runs ───────────────────────────────────────────────
    try {
      const result = await runBuilderSpec(SITE, runSpec, canAll, { limit: 5 });
      ok(
        `${t.id}: runs (${result.rows.length} row${result.rows.length === 1 ? "" : "s"}, ${result.columns.length} cols)`,
        result.columns.length > 0,
        result.columns.length === 0 ? "report produced no columns" : "",
      );
    } catch (err) {
      ok(
        `${t.id}: runs`,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /* ── The ledger's own identities, through the engine ─────────────────────
     gl-by-account is only trustworthy if the builder's SUMs preserve the one
     fact every posted batch guarantees: debits equal credits. Run over a wide
     window with no row cap on the aggregate and assert the totals agree. */
  const glTemplate = TEMPLATES.find((t) => t.id === "gl-by-account");
  if (glTemplate) {
    try {
      const result = await runBuilderSpec(
        SITE,
        { ...templateSpec(glTemplate), period: { key: "thisYear" } },
        canAll,
      );
      let debits = 0;
      let credits = 0;
      for (const row of result.rows) {
        debits += Number(row.debit_sum ?? 0);
        credits += Number(row.credit_sum ?? 0);
      }
      ok(
        "gl-by-account: total debits equal total credits",
        Math.abs(debits - credits) < 0.01,
        `${debits.toFixed(2)} vs ${credits.toFixed(2)}`,
      );
    } catch (err) {
      ok(
        "gl-by-account: total debits equal total credits",
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  console.log(fails ? `\n${fails} FAILED\n` : "\nAll report templates run.\n");
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
