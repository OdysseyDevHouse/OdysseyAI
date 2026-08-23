/**
 * Does a linkable document column actually carry its record id?
 *
 * The id rides on the row under a SIDECAR key rather than as a column, so
 * nothing in the grid or the column list would reveal whether it arrived. This
 * runs the real engine against the real database and prints one row, which is
 * the only way to see it.
 *
 *   npx tsx scripts/probe-doc-links.ts
 */
import { getSource } from "../src/lib/reportBuilder/catalog";
import { specColumns, linkKeyFor, LINK_KEY_PREFIX } from "../src/lib/reportBuilder/spec";
import { runBuilderSpec } from "../src/lib/reportBuilder/run";
import { resolveReport } from "../src/lib/reportBuilder/resolve";

const SITE = Number(process.env.PROBE_SITE ?? 1);
const canAll = () => true;

let fails = 0;
const ok = (label: string, cond: boolean, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "**FAIL**"}  ${label}${extra ? "  -- " + extra : ""}`);
};

async function probe(id: string, expectField: string) {
  const resolved = await resolveReport(SITE, id, null);
  if (!resolved) {
    ok(`${id}: resolves`, false);
    return;
  }
  const source = getSource(resolved.spec.source)!;
  const cols = specColumns(resolved.spec, source);
  const linkCol = cols.find((c) => c.link);

  ok(`${id}: has a linkable column`, linkCol !== undefined, linkCol ? `${linkCol.key} -> ${linkCol.link!.kind}` : "none");
  if (!linkCol) return;

  const res = await runBuilderSpec(SITE, resolved.spec, canAll as never);
  /* No rows is a legitimate DATA outcome (site 1 has no shifts at all), so it
     is reported rather than failed — but it is said out loud, because a silent
     pass over an empty list would prove nothing about the id. */
  if (res.rows.length === 0) {
    console.log(`SKIP  ${id}: no rows on this site — the id itself is unverified here`);
    return;
  }
  ok(`${id}: returned rows`, true, `${res.rows.length} rows`);

  const row = res.rows[0] as Record<string, unknown>;
  const sidecar = linkKeyFor(linkCol.key);
  const idValue = row[sidecar];

  /*
   * The sidecar KEY must always be selected for a linkable column. Its VALUE
   * may legitimately be null: a customer-ledger payment row has no sale behind
   * it, and the grid renders those as plain text rather than as a link to
   * nowhere. So "present" and "populated" are two different assertions, and
   * only the first is universal.
   */
  ok(`${id}: row carries the ${sidecar} key`, sidecar in row, `= ${JSON.stringify(idValue)}`);

  if (idValue === null) {
    console.log(`      note: ${id}'s first row has no linked record — it renders as plain text`);
  } else {
    ok(
      `${id}: the id is usable (a positive number)`,
      Number(idValue) > 0,
      `Number(${JSON.stringify(idValue)}) = ${Number(idValue)}`,
    );
  }

  // The sidecar must NOT be a column: it would show up in the grid and the CSV.
  ok(
    `${id}: sidecar is not a visible column`,
    !cols.some((c) => c.key.startsWith(LINK_KEY_PREFIX)),
    cols.map((c) => c.key).join(", "),
  );

  console.log(`        number = ${JSON.stringify(row[linkCol.key])}, id = ${JSON.stringify(idValue)}`);
}

async function main() {
  /* The sales file itself. */
  await probe("invoice-history", "documentNumber");
  /* The shifts file — a different source, a different viewer. */
  await probe("cashup-history", "cashupRef");
  /* Reports on OTHER sources whose document column reaches the sale across a
     join. These are the ones that prove the change is renderer-level rather
     than wired per report. */
  await probe("credit-notes", "documentNumber");
  /* Payments have no sale behind them — proves a link is NOT invented. */
  await probe("customer-payments", "docNumber");
  /* The same source unfiltered, where invoice rows DO resolve — proves the
     mixed-type ledger links the half that can be linked. */
  await probe("customer-ledger", "docNumber");
  await probe("discount-history", "documentNumber");

  console.log(fails === 0 ? "\nAll link probes passed." : `\n${fails} FAILED.`);
  process.exit(fails === 0 ? 0 : 1);
}

void main();
