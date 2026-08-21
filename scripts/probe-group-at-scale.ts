/**
 * The shared files at TWENTY stores, not two.
 *
 * Two documents have carried the same warning since the customer work shipped:
 *
 *   "Everything above is reasoned from two dev sites. Ids collide far more
 *    readily at ten, and a third store is the cheapest way to find what two
 *    hid — two stores can agree by accident where ten cannot."
 *                                    docs/cross-store-id-conflicts.md
 *
 *   "Ten branches is the actual use case, and things that hold at two
 *    sometimes do not at ten — the group reconciliation fans out one query per
 *    member, and the resolver caches per request."
 *                                    docs/shared-customer-file-origin-site.md
 *
 * Odyssey Cafe (scripts/seed-odyssey-cafe.mjs) is twenty stores, so this is the
 * probe those notes asked for.
 *
 * ── THE FIXTURE HAD TO BE MADE ADVERSARIAL FIRST ──────────────────────────
 *
 * Seeded straight, all twenty stores ended up with "Bakery" as department 10
 * and CAF0001 as product 1 — measured, on the first run. Identical ids make the
 * entire collision class INVISIBLE: a bug reading store 7's id against store
 * 3's table gets the right answer by accident, which is precisely the trap the
 * first note names. The seed now pushes each store's AUTO_INCREMENT apart on
 * coprime strides, so today one store's "Bakery" id names a DIFFERENT
 * department in nineteen others.
 *
 * That is asserted here rather than assumed, because a fixture that quietly
 * stops diverging would turn every case below green while testing nothing.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-group-at-scale.ts
 */
import { execute, query } from '../src/lib/db'
import { siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { customerQueryOne, supplierQueryOne } from '../src/lib/site/customerDb'
import { customerOwnerSite, supplierOwnerSite, membersOfGroup } from '../src/lib/storeGroups'
import { listCustomers } from '../src/lib/site/customers'
import { listSuppliers } from '../src/lib/site/suppliers'
import { postTransaction } from '../src/lib/site/customerLedger'
import { postSupplierTransaction } from '../src/lib/site/supplierLedger'
import { reconcileControlAccounts } from '../src/lib/site/chartOfAccounts'
import { customerAging } from '../src/lib/site/aging'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

const TAG = 'scale-probe'
const actor: Actor = { userId: 1, userName: TAG }
type Row = RowDataPacket & Record<string, unknown>

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const grp = await query<RowDataPacket & { id: number; primary_site_id: number }>(
    "SELECT id, primary_site_id FROM cp2_store_groups WHERE name = 'Odyssey Cafe' LIMIT 1",
  )
  if (!grp.length) {
    console.log('No Odyssey Cafe group. Run scripts/seed-odyssey-cafe.mjs first.')
    process.exit(0)
  }
  const groupId = Number(grp[0].id)
  const head = Number(grp[0].primary_site_id)

  const members = await membersOfGroup(groupId)
  const ids = members.map((m) => m.siteId)
  const last = ids[ids.length - 1]

  console.log(`\n${ids.length} stores, head office = site ${head}\n`)

  // Remember the flags so a run leaves the group as it found it.
  const before = members.map((m) => ({
    siteId: m.siteId,
    c: m.sharesCustomers,
    s: m.sharesSuppliers,
  }))

  try {
    await execute(
      'UPDATE cp2_store_group_members SET shares_customers = 1, shares_suppliers = 1 WHERE group_id = ?',
      [groupId],
    )

    /* ── The fixture is adversarial ──────────────────────────────────────── */

    console.log('— The fixture —')

    const deptIds = new Map<number, number>()
    for (const id of ids) {
      const d = await siteQueryOne<Row>(id, "SELECT id FROM departments WHERE name = 'Bakery' LIMIT 1")
      if (d) deptIds.set(id, Number(d.id))
    }
    ok(
      `all ${ids.length} stores hold a DIFFERENT id for the same department`,
      new Set(deptIds.values()).size === ids.length,
      `${new Set(deptIds.values()).size} distinct of ${ids.length}`,
    )

    /*
     * The sharper question, and the one the whole fixture exists for: taking
     * EACH store's "Bakery" id and looking it up in EVERY other store, how
     * often does it land on a different department?
     *
     * Checking only one store's id against the rest would understate this
     * badly — the strides are coprime, so a low id may exist nowhere else
     * while a high one collides everywhere. The full matrix is 380 lookups
     * and the honest measure.
     */
    let landsElsewhere = 0
    let landsWrong = 0
    for (const from of ids) {
      const theirId = deptIds.get(from)!
      for (const to of ids) {
        if (to === from) continue
        const other = await siteQueryOne<Row>(to, 'SELECT name FROM departments WHERE id = ?', [theirId])
        if (other) {
          landsElsewhere++
          if (String(other.name) !== 'Bakery') landsWrong++
        }
      }
    }
    ok(
      'a store’s department id lands on a DIFFERENT department in other stores',
      landsWrong > 0,
      `${landsWrong} wrong of ${landsElsewhere} that resolve, over ${ids.length * (ids.length - 1)} pairs`,
    )

    /* ── Every branch routes, and sees the shared files ──────────────────── */

    console.log('\n— Routing and visibility across all twenty —')

    let routed = 0
    for (const id of ids) {
      const c = await customerOwnerSite(id)
      const s = await supplierOwnerSite(id)
      if (c.siteId === head && s.siteId === head) routed++
    }
    ok(`all ${ids.length} branches route both files to head office`, routed === ids.length, `${routed}/${ids.length}`)

    const t0 = Date.now()
    let sees = 0
    for (const id of ids) {
      const c = await listCustomers(id, { limit: 500 })
      const s = await listSuppliers(id, { limit: 500 })
      if (c.total > 0 && s.total > 0 && c.total === 25 && s.total === 12) sees++
    }
    ok(
      `and every one sees the same 25 customers and 12 suppliers`,
      sees === ids.length,
      `${sees}/${ids.length}, ${Date.now() - t0}ms total`,
    )

    /* ── A posting from the far end of the group ─────────────────────────── */

    console.log('\n— Writing from the twentieth store —')

    const cust = await customerQueryOne<Row>(last, "SELECT id FROM customers WHERE code = 'ACC001' LIMIT 1")
    const sup = await supplierQueryOne<Row>(last, "SELECT id FROM suppliers WHERE code = 'SUP001' LIMIT 1")
    ok('the far branch can resolve a shared customer and supplier', !!cust && !!sup)
    if (!cust || !sup) throw new Error('fixture missing ACC001 / SUP001')

    const inv = await postTransaction(last, actor, {
      customerId: Number(cust.id),
      docType: 'invoice',
      amount: 1500,
      reference: TAG,
      description: `${TAG} sale`,
      source: 'manual',
    })
    const bill = await postSupplierTransaction(last, actor, {
      supplierId: Number(sup.id),
      docType: 'invoice',
      amount: 2500,
      reference: TAG,
      description: `${TAG} bill`,
      source: 'manual',
    })
    ok('both postings succeeded', inv.ok && bill.ok, inv.ok ? '' : (inv as { error: string }).error)

    const cBal = await siteQueryOne<Row>(head, 'SELECT balance FROM customers WHERE id = ?', [Number(cust.id)])
    const sBal = await siteQueryOne<Row>(head, 'SELECT balance FROM suppliers WHERE id = ?', [Number(sup.id)])
    ok('head office holds the debtor', Number(cBal?.balance) === 1500, String(cBal?.balance))
    ok('head office holds the creditor', Number(sBal?.balance) === 2500, String(sBal?.balance))

    // And the origin is recorded, which is what stops branch 20's document id
    // being confused with branch 3's.
    const origin = await siteQueryOne<Row>(
      head,
      'SELECT origin_site_id FROM supplier_transactions WHERE reference = ? LIMIT 1',
      [TAG],
    )
    ok(
      'the creditors row records which branch raised it',
      Number(origin?.origin_site_id) === last,
      `origin_site_id ${origin?.origin_site_id}, expected ${last}`,
    )

    /* ── THE ONE THAT ONLY MATTERS AT SCALE ──────────────────────────────── */

    console.log('\n— The group reconciliation, from all twenty ends —')

    // It fans out ONE QUERY PER MEMBER. At two that is invisible. Every end
    // must reach the same figure with a scope naming all twenty; a single
    // member resolving differently shows up as a second distinct answer.
    const answers = new Map<string, number>()
    const t1 = Date.now()
    for (const id of ids) {
      const r = await reconcileControlAccounts(id)
      const d = r.find((x) => x.controlType === 'debtors')
      if (d) {
        answers.set(
          `${d.drift.toFixed(2)}|${d.scope?.stores ?? 'none'}|${d.scope?.unreadable.length ?? '-'}`,
          (answers.get(`${d.drift.toFixed(2)}|${d.scope?.stores ?? 'none'}|${d.scope?.unreadable.length ?? '-'}`) ?? 0) + 1,
        )
      }
    }
    const elapsed = Date.now() - t1
    for (const [k, n] of answers) console.log(`    ${n} store(s) answered  drift|stores|unreadable = ${k}`)

    ok('every end reaches ONE answer', answers.size === 1, `${answers.size} distinct`)
    const only = [...answers.keys()][0] ?? ''
    ok(
      `and its scope covers all ${ids.length} stores with none unreadable`,
      only.endsWith(`|${ids.length}|0`),
      only,
    )
    console.log(
      `    ${ids.length} reconciliations in ${elapsed}ms (${Math.round(elapsed / ids.length)}ms each)`,
    )

    /* ── A read that joins across the boundary, from a far branch ────────── */

    console.log('\n— Reads across the boundary at scale —')

    const aged = await customerAging(last, {})
    ok('the age analysis runs from the far branch', Array.isArray(aged.rows), `${aged.rows.length} row(s)`)

    /*
     * A report over `sales` returns nothing on this fixture — the cafes have a
     * catalogue and no trading history — so it would prove only that the SQL
     * parses. The customer and supplier SOURCES are owner-side, so they read
     * the shared file directly and have 25 and 12 rows to find; a wrong
     * qualifier there returns zero rather than throwing, which is exactly the
     * silent failure worth catching.
     */
    for (const [label, source, expected] of [
      ['the shared customer file', 'customers', 25],
      ['the shared supplier file', 'suppliers', 12],
    ] as const) {
      try {
        const res = await runBuilderSpec(
          last,
          {
            source,
            columns: [{ field: 'code' }, { field: 'name' }],
            filters: [],
            period: { kind: 'all' },
            limit: 100,
          } as never,
          () => true,
          { limit: 100 },
        )
        ok(
          `a report from the far branch reads ${label}`,
          res.rows.length === expected,
          `${res.rows.length} row(s), expected ${expected}`,
        )
      } catch (e) {
        ok(`a report from the far branch reads ${label}`, false, String(e).slice(0, 120))
      }
    }
  } finally {
    console.log('\n— Cleanup —')

    for (const site of [head, last]) {
      await siteQuery(site, 'DELETE FROM customer_transactions WHERE reference = ?', [TAG]).catch(() => undefined)
      await siteQuery(site, 'DELETE FROM supplier_transactions WHERE reference = ?', [TAG]).catch(() => undefined)
      await siteQuery(site, 'DELETE FROM activity_log WHERE user_name = ?', [TAG]).catch(() => undefined)
    }
    // The balances were moved by the postings above and nothing else touches
    // them on a fixture, so they go back to zero rather than being recomputed.
    await siteQuery(head, "UPDATE customers SET balance = 0 WHERE code = 'ACC001'").catch(() => undefined)
    await siteQuery(head, "UPDATE suppliers SET balance = 0 WHERE code = 'SUP001'").catch(() => undefined)

    const leftC = await siteQueryOne<Row>(head, 'SELECT COUNT(*) AS n FROM customer_transactions WHERE reference = ?', [TAG])
    const leftS = await siteQueryOne<Row>(head, 'SELECT COUNT(*) AS n FROM supplier_transactions WHERE reference = ?', [TAG])
    console.log(`  probe rows left: ${Number(leftC?.n) + Number(leftS?.n)}`)

    for (const m of before) {
      await execute(
        'UPDATE cp2_store_group_members SET shares_customers = ?, shares_suppliers = ? WHERE group_id = ? AND site_id = ?',
        [m.c ? 1 : 0, m.s ? 1 : 0, groupId, m.siteId],
      )
    }
    console.log('  sharing flags restored')
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} failure(s).`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
