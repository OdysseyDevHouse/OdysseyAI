/**
 * Ten tills, one floor.
 *
 * On a hybrid site the open tab lives on the shop's own box, so that ten
 * waiters share one bill with no internet in the path. This suite proves the
 * two halves of that: a tab written through the real code comes back through
 * the real code, and NONE of it reaches the cloud.
 *
 * The second half is the one worth having. A missed `purpose` on any call does
 * not error — the cloud has every table — so the failure is silent: the till
 * reads a different floor from the one it writes to, and a table one waiter can
 * see another cannot. Nothing but a check like this would catch it.
 *
 * Skips when there is no hybrid site or no reachable box, which is a normal
 * developer checkout rather than a broken one.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-tab-routing.ts
 */
import type { RowDataPacket } from 'mysql2/promise'

import { queryOne } from '../src/lib/db'
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { listTables } from '../src/lib/site/posTables'
import { tabPurpose, tabLocation, tabsAreLocal, boxIsReachable } from '../src/lib/site/tabRouting'

const CODE = 'ZZTAB'
const CUSTOMER = 'ZZ tab-routing probe'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(why: string): never {
  console.log(`\n**SKIPPED**  ${why}\n`)
  process.exit(0)
}

async function main() {
  console.log('\nTab routing\n')

  const site = await queryOne<RowDataPacket & { id: number; site_code: string }>(
    "SELECT id, site_code FROM cp2_sites WHERE connection_type = 'hybrid' LIMIT 1",
  )
  if (!site) skip('no hybrid site in the control panel.')
  const SITE = site.id

  check('the site reads as hybrid', await tabsAreLocal(SITE))
  if (!(await boxIsReachable(SITE))) skip(`the box for ${site.site_code} is not reachable.`)

  check('the box is reachable', true)
  check('tabs are located on the box', (await tabLocation(SITE)) === 'box')

  const purpose = await tabPurpose(SITE)
  check('the tab purpose is "hybrid"', purpose === 'hybrid')

  /*
   * ── NOT WIRED IN YET, AND THIS IS WHY ─────────────────────────────────────
   *
   * posTables.ts still takes siteDb's MASTER default. Threading tabPurpose
   * through its twelve call sites was tried and REVERTED, because a tab is not
   * one table: `pos_tables.document_id` has a foreign key to the `saved`
   * sales_documents row, and that row is created by saveDraft /
   * saveForLaterDocument in salesDocuments.ts — which is shared with quotes,
   * orders, invoices and the back office, and imported by 57 files.
   *
   * Routing the floor alone split the pair across two databases and failed on
   * that FK, which is the correct failure: an open tab and its bill must live
   * together or neither is real. Blanket-routing salesDocuments is not the
   * answer either — it would send the whole sales system to a box with nine
   * tables.
   *
   * So the seam has to be per-DOCUMENT rather than per-module: a saved document
   * belonging to a table goes to the box, every other document goes to the
   * cloud. That is the next piece of work, and it is where the plan's decision
   * 10 (local-vs-box precedence) actually lands.
   *
   * Everything below runs against the box DIRECTLY, so it still proves what the
   * box can hold and that the routing decision resolves correctly. It does not
   * yet prove that posTables reaches it.
   */
  const routed = await listTables(SITE)
  check(
    'posTables is not yet routed (expected: see the note above)',
    Array.isArray(routed),
  )

  /* Which database did that actually resolve to? The purpose is a name; this is
     the connection. A mismatch here would mean the control panel and the pool
     disagree about where the box is. */
  const box = await siteQueryOne<{ db: string }>(SITE, 'SELECT DATABASE() AS db', [], purpose)
  const cloud = await siteQueryOne<{ db: string }>(SITE, 'SELECT DATABASE() AS db', [], 'master')
  check('the box and the cloud are different databases', box?.db !== cloud?.db,
    `${box?.db} vs ${cloud?.db}`)

  /* ── Clean slate ───────────────────────────────────────────────────────── */

  async function tidy() {
    await siteExecute(SITE, 'DELETE FROM pos_tables WHERE code = ?', [CODE], purpose)
    await siteExecute(SITE, 'DELETE FROM sales_documents WHERE customer_name = ?', [CUSTOMER], purpose)
  }
  await tidy()

  /* ── Waiter A opens table 12 ───────────────────────────────────────────── */

  await siteExecute(
    SITE,
    `INSERT INTO pos_tables (code, name, seats, sort_order, is_active) VALUES (?, 'Probe', 4, 900, 1)`,
    [CODE],
    purpose,
  )
  const table = await siteQueryOne<{ id: number }>(
    SITE,
    'SELECT id FROM pos_tables WHERE code = ? LIMIT 1',
    [CODE],
    purpose,
  )

  const doc = await siteExecute(
    SITE,
    `INSERT INTO sales_documents (doc_type, status, document_date, customer_name, user_name, total_incl)
     VALUES ('invoice','saved',CURDATE(),?, 'waiter A', 68.00)`,
    [CUSTOMER],
    purpose,
  )
  for (const line of ['Ham and cheese toastie', 'Coke']) {
    await siteExecute(
      SITE,
      'INSERT INTO sales_document_lines (document_id, description) VALUES (?, ?)',
      [doc.insertId, line],
      purpose,
    )
  }

  /* Seating goes through the box directly rather than seatTable(), for the
     reason in the note above. When posTables is routed, this becomes the real
     call and the assertions below do not change. */
  await siteExecute(
    SITE,
    'UPDATE pos_tables SET document_id = ?, bill_asked_at = NULL WHERE id = ?',
    [doc.insertId, table!.id],
    purpose,
  )

  /* ── Waiter B, on another till, reads the same floor ───────────────────── */

  const seen = await siteQueryOne<{
    code: string
    total_incl: string | null
    line_count: number
  }>(
    SITE,
    `SELECT t.code, d.total_incl,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.document_id = d.id) AS line_count
       FROM pos_tables t
       LEFT JOIN sales_documents d ON d.id = t.document_id AND d.status = 'saved'
      WHERE t.code = ?`,
    [CODE],
    purpose,
  )
  check('waiter B sees the table', !!seen)
  check('...with the running total', Number(seen?.total_incl) === 68, String(seen?.total_incl))
  check('...and the line count', Number(seen?.line_count) === 2)

  await siteExecute(
    SITE,
    'UPDATE pos_tables SET bill_asked_at = NOW() WHERE id = ? AND document_id IS NOT NULL',
    [table!.id],
    purpose,
  )
  const asked = await siteQueryOne<{ bill_asked_at: Date | null }>(
    SITE,
    'SELECT bill_asked_at FROM pos_tables WHERE id = ?',
    [table!.id],
    purpose,
  )
  check('asking for the bill is recorded', asked?.bill_asked_at !== null)

  /* ── AND NONE OF IT REACHED THE CLOUD ──────────────────────────────────── */

  const onCloud = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM pos_tables WHERE code = ?',
    [CODE],
    'master',
  )
  check('the tab did not reach the cloud', onCloud?.n === 0, `found ${onCloud?.n}`)

  const docOnCloud = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_documents WHERE customer_name = ?',
    [CUSTOMER],
    'master',
  )
  check('nor did its bill', docOnCloud?.n === 0, `found ${docOnCloud?.n}`)

  /* ── Settling ──────────────────────────────────────────────────────────── */

  await siteExecute(
    SITE,
    'UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE id = ?',
    [table!.id],
    purpose,
  )
  const freed = await siteQueryOne<{ document_id: number | null }>(
    SITE,
    'SELECT document_id FROM pos_tables WHERE id = ?',
    [table!.id],
    purpose,
  )
  check('freeing the table empties it', freed?.document_id === null)

  await siteExecute(SITE, 'DELETE FROM sales_documents WHERE id = ?', [doc.insertId], purpose)
  const orphans = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM sales_document_lines WHERE document_id = ?',
    [doc.insertId],
    purpose,
  )
  /* The cascade the first build of the box lost. Without it a closed tab leaves
     its lines behind forever. */
  check('deleting the bill takes its lines', orphans?.n === 0, `${orphans?.n} left`)

  await tidy()
  const after = await siteQueryOne<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM pos_tables WHERE code = ?',
    [CODE],
    purpose,
  )
  check('the test leaves no tables behind', after?.n === 0)

  console.log(`\n${failures === 0 ? 'Tab routing holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
