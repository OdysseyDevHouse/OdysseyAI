/**
 * Both master files shared at once.
 *
 * The customer probe shares customers and leaves suppliers alone; the supplier
 * probe does the reverse. Each does that deliberately — a probe with both on
 * cannot tell a customer bug from a supplier one. The consequence is that the
 * combination has never executed, and it is the configuration a real group
 * doing central admin would actually choose.
 *
 * ── WHAT I EXPECTED TO FIND HERE, AND WHY IT IS NOT THAT ─────────────────
 *
 * I flagged this as "the three-database case": branch, customer owner and
 * supplier owner all in play, with the four prefix helpers having to keep them
 * apart. That was wrong, and measuring it is what showed it.
 *
 * cp2_store_groups has ONE primary_site_id, and both customerOwnerSite and
 * supplierOwnerSite resolve to it. So the two files always land in the same
 * database and there are only ever TWO — the branch and the primary. A group
 * cannot split its files across two different owners, whatever the two
 * independent flags suggest.
 *
 * That makes this probe smaller than planned, and worth keeping anyway: the
 * four prefixes are still resolved by four different code paths keyed on two
 * different owners, and "they happen to agree" is a fact that could stop being
 * true the day somebody adds a per-file primary. This is what would catch that.
 *
 * ── WHAT IT ASSERTS ──────────────────────────────────────────────────────
 *
 * That with both flags on, a branch can still do the ordinary things — read a
 * customer, read a supplier, post to both ledgers, run a report joining sales
 * to a customer and purchases to a supplier — and that documents and comments
 * for the two entities land where partyStore says they should.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-both-files-shared.ts
 */
import { execute, query } from '../src/lib/db'
import { siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  customerQueryOne,
  customerExecute,
  supplierQueryOne,
  supplierExecute,
  customerDbPrefix,
  supplierDbPrefix,
  branchDbPrefix,
  supplierBranchDbPrefix,
} from '../src/lib/site/customerDb'
import {
  customerOwnerSite,
  supplierOwnerSite,
  customerFileIsShared,
  supplierFileIsShared,
  groupForSite,
  membersOfGroup,
} from '../src/lib/storeGroups'
import { entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { postTransaction } from '../src/lib/site/customerLedger'
import { postSupplierTransaction } from '../src/lib/site/supplierLedger'
import { reconcileControlAccounts } from '../src/lib/site/chartOfAccounts'
import { createComment, removeCommentsFor } from '../src/lib/site/partyComments'
import { partyDb } from '../src/lib/site/partyStore'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

const TAG = 'xdb-both-probe'
type Row = RowDataPacket & Record<string, unknown>

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}
const money = (n: unknown) => Number(n ?? 0).toFixed(2)

async function main() {
  const sites = await query<RowDataPacket & { id: number }>(
    'SELECT id FROM cp2_sites ORDER BY id LIMIT 2',
  )
  if (sites.length < 2) {
    console.log('Needs two sites. Stopping.')
    process.exit(0)
  }
  const [primary, branch] = sites.map((s) => Number(s.id))

  const group = await groupForSite(primary)
  if (!group) {
    console.log('Needs a store group. Stopping.')
    process.exit(0)
  }
  for (const s of [primary, branch]) {
    if (!hasModule(await entitlementsForSite(s), 'multi_branch')) {
      console.log(`Site ${s} lacks multi_branch. Stopping.`)
      process.exit(0)
    }
  }

  console.log(`\nPrimary = site ${primary}   Branch = site ${branch}\n`)

  const beforeMembers = await membersOfGroup(group.id)
  const beforePrimary = group.primarySiteId
  const beforeEntity = group.legalEntity

  const restore = async () => {
    for (const m of beforeMembers) {
      await execute(
        `UPDATE cp2_store_group_members
            SET shares_customers = ?, shares_suppliers = ?
          WHERE group_id = ? AND site_id = ?`,
        [m.sharesCustomers ? 1 : 0, m.sharesSuppliers ? 1 : 0, group.id, m.siteId],
      )
    }
    await execute(
      'UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = ? WHERE id = ?',
      [beforePrimary, beforeEntity, group.id],
    )
  }

  const actor: Actor = { userId: 0, userName: TAG }
  let customerId: number | null = null
  let supplierId: number | null = null

  try {
    await execute(
      "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
      [primary, group.id],
    )
    // BOTH. This is the whole point of the file.
    for (const s of [primary, branch]) {
      await execute(
        `UPDATE cp2_store_group_members
            SET shares_customers = 1, shares_suppliers = 1
          WHERE group_id = ? AND site_id = ?`,
        [group.id, s],
      )
    }

    /* ── How many databases are actually in play ────────────────────────── */

    console.log('— The shape of it —')

    const cOwner = await customerOwnerSite(branch)
    const sOwner = await supplierOwnerSite(branch)
    ok('both files are shared', (await customerFileIsShared(branch)) && (await supplierFileIsShared(branch)))
    ok(
      'and both resolve to the SAME owner — one primary per group',
      cOwner.siteId === sOwner.siteId && cOwner.siteId === primary,
      `customer ${cOwner.siteId}, supplier ${sOwner.siteId}`,
    )

    const [cdb, sdb, bdb, sbdb] = await Promise.all([
      customerDbPrefix(branch),
      supplierDbPrefix(branch),
      branchDbPrefix(branch),
      supplierBranchDbPrefix(branch),
    ])
    // The four are computed by four different code paths keyed on two different
    // owners. They agree today because there is one primary; asserting it is
    // what would catch the day that stops being true.
    ok('the two owner prefixes agree', cdb === sdb, `"${cdb}" vs "${sdb}"`)
    ok('the two branch prefixes agree', bdb === sbdb, `"${bdb}" vs "${sbdb}"`)
    ok('and owner is not branch', cdb !== bdb && cdb !== '' && bdb !== '', `owner "${cdb}", branch "${bdb}"`)

    /* ── Both files usable from the branch ──────────────────────────────── */

    console.log('\n— Both files, from one branch —')

    const cCode = `${TAG}-C`
    await customerExecute(
      branch,
      `INSERT INTO customers (code, name, status, credit_limit) VALUES (?,?,'active',50000)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [cCode, `${TAG} customer`],
    )
    const cRow = await customerQueryOne<Row>(branch, 'SELECT id FROM customers WHERE code = ?', [cCode])
    customerId = cRow ? Number(cRow.id) : null

    const sCode = `${TAG}-S`
    await supplierExecute(
      branch,
      `INSERT INTO suppliers (code, name, status) VALUES (?,?,'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [sCode, `${TAG} supplier`],
    )
    const sRow = await supplierQueryOne<Row>(branch, 'SELECT id FROM suppliers WHERE code = ?', [sCode])
    supplierId = sRow ? Number(sRow.id) : null

    ok('a customer and a supplier were both created', customerId !== null && supplierId !== null)
    if (!customerId || !supplierId) throw new Error('could not create both parties')

    const bothAtPrimary = await siteQueryOne<Row>(
      primary,
      `SELECT (SELECT COUNT(*) FROM customers WHERE code = ?) AS c,
              (SELECT COUNT(*) FROM suppliers WHERE code = ?) AS s`,
      [cCode, sCode],
    )
    ok(
      'and both landed in the owner',
      Number(bothAtPrimary?.c) === 1 && Number(bothAtPrimary?.s) === 1,
      `customers ${bothAtPrimary?.c}, suppliers ${bothAtPrimary?.s}`,
    )

    /* ── Both ledgers, from one branch ──────────────────────────────────── */

    console.log('\n— Both ledgers —')

    const debtor = await postTransaction(branch, actor, {
      customerId,
      docType: 'invoice',
      amount: 500,
      reference: TAG,
      description: `${TAG} sale`,
      source: 'manual',
    })
    ok('a debtors posting succeeded', debtor.ok, debtor.ok ? '' : debtor.error)

    const creditor = await postSupplierTransaction(branch, actor, {
      supplierId,
      docType: 'invoice',
      amount: 700,
      reference: TAG,
      description: `${TAG} bill`,
      source: 'manual',
    })
    ok('a creditors posting succeeded', creditor.ok, creditor.ok ? '' : creditor.error)

    // Both audit lines belong to the BRANCH even though both ledgers are remote.
    const logs = await siteQuery<Row>(
      branch,
      'SELECT entity, COUNT(*) AS n FROM activity_log WHERE user_name = ? GROUP BY entity',
      [TAG],
    )
    const byEntity = new Map(logs.map((r) => [String(r.entity), Number(r.n)]))
    ok(
      'both audit trails stayed in the branch',
      (byEntity.get('customer') ?? 0) >= 1 && (byEntity.get('supplier') ?? 0) >= 1,
      JSON.stringify([...byEntity]),
    )
    const logsAtOwner = await siteQuery<Row>(
      primary,
      'SELECT COUNT(*) AS n FROM activity_log WHERE user_name = ?',
      [TAG],
    )
    ok('and none leaked to the owner', Number(logsAtOwner[0]?.n) === 0, `${logsAtOwner[0]?.n}`)

    /* ── Both control accounts reconcile at group level ─────────────────── */

    console.log('\n— Both control accounts —')

    const atBranch = await reconcileControlAccounts(branch)
    const atPrimary = await reconcileControlAccounts(primary)
    for (const type of ['debtors', 'creditors'] as const) {
      const b = atBranch.find((r) => r.controlType === type)
      const p = atPrimary.find((r) => r.controlType === type)
      if (!b || !p) {
        console.log(`SKIP  no ${type} control account configured`)
        continue
      }
      ok(`${type}: both ends use the group scope`, b.scope?.level === 'group' && p.scope?.level === 'group')
      ok(
        `${type}: both ends reach the same figure`,
        Math.abs(b.drift - p.drift) < 0.005,
        `${money(b.drift)} vs ${money(p.drift)}`,
      )
    }

    /* ── Documents and comments split three ways ────────────────────────── */

    console.log('\n— partyStore, with both owners the same database —')

    await createComment(branch, actor, 'customer', customerId, `${TAG} customer note`)
    await createComment(branch, actor, 'supplier', supplierId, `${TAG} supplier note`)
    await createComment(branch, actor, 'job_card', 999001, `${TAG} job note`)

    const cAt = await siteQueryOne<Row>(primary, 'SELECT COUNT(*) AS n FROM customer_comments WHERE body LIKE ?', [`${TAG}%`])
    const sAt = await siteQueryOne<Row>(primary, 'SELECT COUNT(*) AS n FROM supplier_comments WHERE body LIKE ?', [`${TAG}%`])
    const jAt = await siteQueryOne<Row>(branch, 'SELECT COUNT(*) AS n FROM job_comments WHERE body LIKE ?', [`${TAG}%`])
    const jAtOwner = await siteQueryOne<Row>(primary, 'SELECT COUNT(*) AS n FROM job_comments WHERE body LIKE ?', [`${TAG}%`])

    ok('a customer comment went to the owner', Number(cAt?.n) === 1, `${cAt?.n}`)
    ok('a supplier comment went to the owner', Number(sAt?.n) === 1, `${sAt?.n}`)
    ok(
      'a job comment stayed in the branch',
      Number(jAt?.n) === 1 && Number(jAtOwner?.n) === 0,
      `branch ${jAt?.n}, owner ${jAtOwner?.n}`,
    )

    /* ── A report that spans both files ─────────────────────────────────── */

    console.log('\n— Reports across both boundaries —')

    const canAll = () => true
    for (const [label, spec] of [
      [
        // accountCode, NOT customerName: the name is a snapshot column on
        // sales_documents and resolves without touching the shared file. The
        // account code comes through the {C} join, so it is the one that
        // actually crosses.
        'sales joined to the shared customer file',
        {
          source: 'sales',
          columns: [{ field: 'documentNumber' }, { field: 'accountCode' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 5,
        },
      ],
      [
        'purchases joined to the shared supplier file',
        {
          source: 'purchases',
          columns: [{ field: 'documentNumber' }, { field: 'supplierStatus' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 5,
        },
      ],
      [
        'the creditors ledger, an owner-side source',
        {
          source: 'supplierTransactions',
          columns: [{ field: 'docNumber' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 5,
        },
      ],
    ] as const) {
      try {
        const res = await runBuilderSpec(branch, spec as never, canAll, { limit: 5 })
        ok(`report: ${label}`, true, `${res.rows.length} row(s)`)
      } catch (e) {
        ok(`report: ${label}`, false, e instanceof Error ? e.message.slice(0, 130) : String(e))
      }
    }
  } finally {
    console.log('\n— Cleanup —')

    for (const e of ['customer', 'supplier', 'job_card'] as const) {
      try {
        const id = e === 'customer' ? customerId : e === 'supplier' ? supplierId : 999001
        if (id) await partyDb(e).transaction(branch, async (tx) => removeCommentsFor(tx, e, id))
      } catch {
        /* the sweep below is the real cleanup */
      }
    }

    for (const site of [primary, branch]) {
      for (const sql of [
        'DELETE FROM customer_comments WHERE body LIKE ?',
        'DELETE FROM supplier_comments WHERE body LIKE ?',
        'DELETE FROM job_comments WHERE body LIKE ?',
      ]) {
        await siteQuery(site, sql, [`${TAG}%`]).catch(() => undefined)
      }
      for (const sql of [
        'DELETE FROM customer_transactions WHERE reference = ?',
        'DELETE FROM supplier_transactions WHERE reference = ?',
        'DELETE FROM customers WHERE code LIKE ?',
        'DELETE FROM suppliers WHERE code LIKE ?',
        'DELETE FROM activity_log WHERE user_name = ?',
      ]) {
        const param = sql.includes('LIKE') ? `${TAG}%` : TAG
        await siteQuery(site, sql, [param]).catch(() => undefined)
      }

      const left = await siteQueryOne<Row>(
        site,
        `SELECT (SELECT COUNT(*) FROM customers WHERE code LIKE ?) AS c,
                (SELECT COUNT(*) FROM suppliers WHERE code LIKE ?) AS s`,
        [`${TAG}%`, `${TAG}%`],
      )
      console.log(`  site ${site}: ${Number(left?.c)} customer(s), ${Number(left?.s)} supplier(s) left`)
    }

    await restore()
    const after = await membersOfGroup(group.id)
    ok(
      'sharing flags restored',
      after.every(
        (m) =>
          m.sharesCustomers ===
            (beforeMembers.find((b) => b.siteId === m.siteId)?.sharesCustomers ?? false) &&
          m.sharesSuppliers ===
            (beforeMembers.find((b) => b.siteId === m.siteId)?.sharesSuppliers ?? false),
      ),
    )
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} failure(s).`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
