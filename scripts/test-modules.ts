// Module entitlements, against the real control database.
//
// The pure arithmetic is covered by test:billing-periods. This suite proves the
// part that only shows up against a real table: that a downgrade keeps working
// until its date and then stops, that re-adding does not open a second row, and
// that the date predicate is inclusive at both ends.
//
// ── IT CLEANS UP AFTER ITSELF ──────────────────────────────────────────────
//
// Every row it writes carries a scratch site id far outside the real range and
// is deleted in a finally block. A leaked row here would show up as a phantom
// module on a real site's bill, and — worse — a leaked cp2_billing_accounts row
// would break the "one account per site" assertion in the next suite that
// counts them.
import { query, execute } from '../src/lib/db'
import { periodEnd } from '../src/lib/billing/period'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* Far outside any real cp2_sites.id, so a leak is obvious and can never collide
   with a customer's site. */
const SCRATCH_SITE = 990_001
const today = new Date().toISOString().slice(0, 10)

function isoPlus(days: number): string {
  const d = new Date(`${today}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The live-today predicate, exactly as modules.ts asks it. */
async function liveModules(siteId: number): Promise<string[]> {
  const rows = await query<{ module_key: string }>(
    `SELECT module_key FROM cp2_site_modules
      WHERE site_id = ? AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)
      ORDER BY module_key`,
    [siteId, today, today],
  )
  return rows.map((r) => String(r.module_key))
}

async function cleanup() {
  await execute('DELETE FROM cp2_site_modules WHERE site_id = ?', [SCRATCH_SITE])
  await execute('DELETE FROM cp2_module_change_log WHERE site_id = ?', [SCRATCH_SITE])
  await execute('DELETE FROM cp2_billing_account_sites WHERE site_id = ?', [SCRATCH_SITE])
  await execute("DELETE FROM cp2_billing_accounts WHERE name = 'ZZ scratch (test-modules)'", [])
}

async function main() {
  await cleanup() // in case a previous run died before its finally block

  try {
    // ── The catalogue is seeded and priced ───────────────────────────────
    const prices = await query<{ module_key: string; unit_price: string }>(
      'SELECT module_key, unit_price FROM cp2_module_prices ORDER BY module_key',
    )
    const keys = prices.map((p) => String(p.module_key))
    for (const expected of [
      'starter', 'inventory_advanced', 'multi_branch', 'customers',
      'online_store', 'loyalty', 'job_cards', 'pos_device',
    ]) {
      ok(`price book carries ${expected}`, keys.includes(expected))
    }

    // ── Every real site has an account and a Starter Pack ────────────────
    // The backfill is the statement that can break every customer at once, so
    // it is asserted on every run, not just the one where it was written.
    const orphanAccount = await query<{ id: number }>(
      `SELECT s.id FROM cp2_sites s
        WHERE s.status IN ('active','suspended')
          AND NOT EXISTS (SELECT 1 FROM cp2_billing_account_sites b WHERE b.site_id = s.id)`,
    )
    ok('*** every billable site has a billing account ***', orphanAccount.length === 0, `${orphanAccount.length} without one`)

    const orphanStarter = await query<{ id: number }>(
      `SELECT s.id FROM cp2_sites s
        WHERE s.status IN ('active','suspended')
          AND NOT EXISTS (
            SELECT 1 FROM cp2_site_modules m
             WHERE m.site_id = s.id AND m.module_key = 'starter'
               AND m.starts_on <= ? AND (m.ends_on IS NULL OR m.ends_on >= ?))`,
      [today, today],
    )
    ok('*** every billable site holds the Starter Pack ***', orphanStarter.length === 0, `${orphanStarter.length} without it`)

    const doubleBilled = await query<{ site_id: number }>(
      'SELECT site_id FROM cp2_billing_account_sites GROUP BY site_id HAVING COUNT(*) > 1',
    )
    ok('*** no site is billed to two accounts ***', doubleBilled.length === 0, `${doubleBilled.length} double-mapped`)

    // ── The live-today predicate, at both boundaries ─────────────────────
    // Inclusive at both ends. Off by one at either end costs the customer a
    // day they paid for, or gives away a day they did not.
    await execute(
      `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, ends_on, created_by) VALUES
         (?, 'starter',            ?, NULL, 'test'),
         (?, 'loyalty',            ?, ?,    'test'),
         (?, 'job_cards',          ?, ?,    'test'),
         (?, 'customers',          ?, NULL, 'test'),
         (?, 'inventory_advanced', ?, ?,    'test')`,
      [
        SCRATCH_SITE, today,
        SCRATCH_SITE, today, today,             // ends TODAY - still live
        SCRATCH_SITE, isoPlus(-60), isoPlus(-1), // ended YESTERDAY - gone
        SCRATCH_SITE, isoPlus(1),               // starts TOMORROW - not yet
        SCRATCH_SITE, isoPlus(-30), isoPlus(30), // squarely inside its window
      ],
    )

    const live = await liveModules(SCRATCH_SITE)
    ok('an open-ended row is live', live.includes('starter'))
    ok('a row ending TODAY is still live', live.includes('loyalty'), live.join(','))
    ok('a row that ended yesterday is gone', !live.includes('job_cards'), live.join(','))
    ok('a row starting tomorrow is not live yet', !live.includes('customers'), live.join(','))
    ok('a row inside its window is live', live.includes('inventory_advanced'))

    // ── A downgrade schedules, it does not delete ────────────────────────
    await execute(
      'UPDATE cp2_site_modules SET ends_on = ? WHERE site_id = ? AND module_key = ?',
      [periodEnd(today, 1), SCRATCH_SITE, 'inventory_advanced'],
    )
    const afterSchedule = await liveModules(SCRATCH_SITE)
    ok('a scheduled removal keeps the module live', afterSchedule.includes('inventory_advanced'))

    const stillThere = await query<{ id: number }>(
      'SELECT id FROM cp2_site_modules WHERE site_id = ? AND module_key = ?',
      [SCRATCH_SITE, 'inventory_advanced'],
    )
    ok('and the row survives as the record of it', stillThere.length === 1, `${stillThere.length} rows`)

    // ── Cancelling a downgrade does not open a second row ────────────────
    await execute(
      'UPDATE cp2_site_modules SET ends_on = NULL WHERE site_id = ? AND module_key = ?',
      [SCRATCH_SITE, 'inventory_advanced'],
    )
    const afterUndo = await query<{ id: number; ends_on: string | null }>(
      'SELECT id, ends_on FROM cp2_site_modules WHERE site_id = ? AND module_key = ?',
      [SCRATCH_SITE, 'inventory_advanced'],
    )
    ok('undoing a downgrade leaves ONE row', afterUndo.length === 1, `${afterUndo.length} rows`)
    ok('with no end date', afterUndo[0]?.ends_on === null, String(afterUndo[0]?.ends_on))

    // ── A lapsed module comes back as a NEW row at today's price ─────────
    // (agreed_price NULL, so the book applies — a re-purchase is a new sale.)
    await execute(
      `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, created_by)
       VALUES (?, 'job_cards', ?, 'test')`,
      [SCRATCH_SITE, today],
    )
    const jobRows = await query<{ starts_on: string; ends_on: string | null; agreed_price: string | null }>(
      'SELECT starts_on, ends_on, agreed_price FROM cp2_site_modules WHERE site_id = ? AND module_key = ? ORDER BY starts_on',
      [SCRATCH_SITE, 'job_cards'],
    )
    ok('re-buying a lapsed module adds a second row', jobRows.length === 2, `${jobRows.length} rows`)
    ok('and it is live again', (await liveModules(SCRATCH_SITE)).includes('job_cards'))
    ok('at the book price, not the old one', jobRows[1]?.agreed_price === null)

    // ── The unique key stops a same-day duplicate ────────────────────────
    let duplicateRejected = false
    try {
      await execute(
        `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, created_by)
         VALUES (?, 'loyalty', ?, 'test')`,
        [SCRATCH_SITE, today],
      )
    } catch {
      duplicateRejected = true
    }
    ok('a duplicate (site, module, start date) is refused', duplicateRejected)

    /* ── Re-buying on the SAME DAY it lapsed ──────────────────────────────
       A module that ended yesterday and is bought back today would collide
       with the unique key on a plain INSERT. addModule's ON DUPLICATE KEY
       clause revives the existing row instead, which is why a customer who
       changes their mind the morning after does not get an error page. */
    await execute(
      'UPDATE cp2_site_modules SET ends_on = ? WHERE site_id = ? AND module_key = ? AND starts_on = ?',
      [today, SCRATCH_SITE, 'loyalty', today],
    )
    await execute(
      `INSERT INTO cp2_site_modules (site_id, module_key, starts_on, created_by)
       VALUES (?, 'loyalty', ?, 'test')
       ON DUPLICATE KEY UPDATE ends_on = NULL`,
      [SCRATCH_SITE, today],
    )
    const revived = await query<{ id: number; ends_on: string | null }>(
      'SELECT id, ends_on FROM cp2_site_modules WHERE site_id = ? AND module_key = ? AND starts_on = ?',
      [SCRATCH_SITE, 'loyalty', today],
    )
    ok('re-buying the day it lapses revives the row', revived.length === 1 && revived[0].ends_on === null, JSON.stringify(revived))

    // ── Grandfathering survives the price book moving ────────────────────
    await execute(
      'UPDATE cp2_site_modules SET agreed_price = 99.00 WHERE site_id = ? AND module_key = ?',
      [SCRATCH_SITE, 'starter'],
    )
    const pinned = await query<{ agreed_price: string }>(
      'SELECT agreed_price FROM cp2_site_modules WHERE site_id = ? AND module_key = ?',
      [SCRATCH_SITE, 'starter'],
    )
    ok('an agreed price is stored as given', Number(pinned[0]?.agreed_price) === 99, String(pinned[0]?.agreed_price))

    // ── The change log records decisions, not just state ─────────────────
    await execute(
      `INSERT INTO cp2_module_change_log
         (site_id, module_key, action, effective_on, actor_name, actor_email)
       VALUES (?, 'loyalty', 'scheduled_removal', ?, 'Test Actor', 'test@example.com')`,
      [SCRATCH_SITE, periodEnd(today, 1)],
    )
    const log = await query<{ action: string; actor_name: string }>(
      'SELECT action, actor_name FROM cp2_module_change_log WHERE site_id = ?',
      [SCRATCH_SITE],
    )
    ok('a change is logged with who did it', log.length === 1 && log[0].actor_name === 'Test Actor', JSON.stringify(log))
  } finally {
    await cleanup()
    const leaked = await query<{ c: number }>(
      'SELECT COUNT(*) c FROM cp2_site_modules WHERE site_id = ?',
      [SCRATCH_SITE],
    )
    ok('scratch rows are cleaned up', Number(leaked[0]?.c) === 0, `${leaked[0]?.c} left behind`)
  }

  console.log(fails ? `\n${fails} failure(s)` : '\nall module entitlement checks passed')
  if (fails) process.exitCode = 1
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    // A suite that throws prints no **FAIL**, so say so loudly and fail the
    // exit code — the runner checks both signals for exactly this case.
    console.error('**FAIL**  test-modules crashed', err)
    process.exit(1)
  })
