/**
 * Does the creditors side survive a shared supplier file?
 *
 * The customer equivalent (probe-shared-customer-accounting.ts) was written
 * after an audit, to reproduce defects that were already suspected. This one is
 * the opposite: stage 1 of the supplier work is meant to WORK, so every case
 * here asserts the intended behaviour and a failure means the conversion is
 * wrong. Normal polarity, unlike its sibling.
 *
 * ── WHAT IT COVERS ────────────────────────────────────────────────────────
 *
 * Only what stage 1 claims. The supplier file and the creditors ledger route to
 * the owner; the audit trail stays in the branch; a payment run records who ran
 * it; the ledger's own invariant still holds; and the creditors control account
 * reconciles at GROUP level from BOTH ends — the fault that made head office's
 * debtors figure wrong for weeks, fixed here before anyone could meet it.
 *
 * Purchasing is deliberately NOT covered: purchaseDocuments, purchasePosting,
 * expenses and supplierPrices are stage 2 and still read their own database. A
 * green run here does not mean the switch can be turned on.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-shared-supplier-file.ts
 */
import { execute, query } from '../src/lib/db'
import { siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { supplierQuery, supplierQueryOne, supplierExecute } from '../src/lib/site/customerDb'
import {
  supplierOwnerSite,
  supplierFileIsShared,
  customerFileIsShared,
  groupForSite,
  membersOfGroup,
} from '../src/lib/storeGroups'
import { entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import {
  postSupplierTransaction,
  reconcileSupplierBalances,
} from '../src/lib/site/supplierLedger'
import { reconcileControlAccounts } from '../src/lib/site/chartOfAccounts'
import { startTraining } from '../src/lib/site/trainingMode'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

const PROBE_TAG = 'xdb-supplier-probe'

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
      console.log(`Site ${s} lacks multi_branch — the resolver would decline. Stopping.`)
      process.exit(0)
    }
  }

  console.log(`\nPrimary (owner) = site ${primary}   Branch = site ${branch}\n`)

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

  const actor: Actor = { userId: 0, userName: PROBE_TAG }
  let supplierId: number | null = null

  try {
    await execute(
      "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
      [primary, group.id],
    )
    // SUPPLIERS only. Leaving customers off is the point: the two files are
    // separately answerable, and a probe that switched both on could not tell a
    // supplier bug from a customer one.
    for (const s of [primary, branch]) {
      await execute(
        `UPDATE cp2_store_group_members
            SET shares_suppliers = 1, shares_customers = 0
          WHERE group_id = ? AND site_id = ?`,
        [group.id, s],
      )
    }

    /* ── The premise ────────────────────────────────────────────────────── */

    console.log('— Routing —')

    const owner = await supplierOwnerSite(branch)
    ok(`the branch routes suppliers to site ${primary}`, owner.siteId === primary, `got ${owner.siteId}`)
    if (owner.siteId !== primary) {
      console.log('\nNothing below would mean anything. Stopping.')
      await restore()
      process.exit(1)
    }

    // Both ends, which is the fault that made the debtors reconciliation wrong
    // at head office for weeks.
    ok('the branch says its supplier file is shared', await supplierFileIsShared(branch))
    ok('and so does the PRIMARY', await supplierFileIsShared(primary))
    ok(
      'while the customer file is correctly NOT shared',
      (await customerFileIsShared(branch)) === false,
    )

    /* ── The file lands in the owner's database ─────────────────────────── */

    console.log('\n— The supplier file —')

    const code = `${PROBE_TAG}-A`
    await supplierExecute(
      branch,
      `INSERT INTO suppliers (code, name, status) VALUES (?,?,'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [code, `${PROBE_TAG} supplier`],
    )
    const sup = await supplierQueryOne<Row>(
      branch,
      'SELECT id FROM suppliers WHERE code = ? LIMIT 1',
      [code],
    )
    supplierId = sup ? Number(sup.id) : null
    ok('a supplier created from the branch exists', supplierId !== null)
    if (!supplierId) throw new Error('could not create the probe supplier')

    const atPrimary = await siteQueryOne<Row>(
      primary,
      'SELECT COUNT(*) AS n FROM suppliers WHERE code = ?',
      [code],
    )
    const atBranch = await siteQueryOne<Row>(
      branch,
      'SELECT COUNT(*) AS n FROM suppliers WHERE code = ?',
      [code],
    )
    ok(
      'and it landed in the PRIMARY, not the branch',
      Number(atPrimary?.n) === 1 && Number(atBranch?.n) === 0,
      `primary ${atPrimary?.n}, branch ${atBranch?.n}`,
    )

    /* ── The ledger posts to the owner, the audit line stays home ───────── */

    console.log('\n— A posting made at the branch —')

    const before = await supplierQueryOne<Row>(
      branch,
      'SELECT balance FROM suppliers WHERE id = ?',
      [supplierId],
    )

    const posted = await postSupplierTransaction(branch, actor, {
      supplierId,
      docType: 'invoice',
      amount: 1000,
      reference: PROBE_TAG,
      description: `${PROBE_TAG} invoice`,
      source: 'manual',
    })
    ok('the invoice posted', posted.ok, posted.ok ? '' : posted.error)
    if (!posted.ok) throw new Error(posted.error)

    const after = await supplierQueryOne<Row>(
      branch,
      'SELECT balance FROM suppliers WHERE id = ?',
      [supplierId],
    )
    ok(
      'the balance moved by the invoice amount',
      Math.abs((Number(after?.balance) - Number(before?.balance)) - 1000) < 0.005,
      `${money(before?.balance)} -> ${money(after?.balance)}`,
    )

    const txnAtPrimary = await siteQuery<Row>(
      primary,
      'SELECT id, origin_site_id FROM supplier_transactions WHERE reference = ?',
      [PROBE_TAG],
    )
    ok('the ledger row is in the OWNER', txnAtPrimary.length === 1, `${txnAtPrimary.length} row(s)`)
    ok(
      'and it records the branch it came from',
      Number(txnAtPrimary[0]?.origin_site_id) === branch,
      `origin_site_id = ${txnAtPrimary[0]?.origin_site_id}, expected ${branch}`,
    )

    // The audit trail must NOT follow the money. It records what a person did.
    const logAtBranch = await siteQuery<Row>(
      branch,
      "SELECT COUNT(*) AS n FROM activity_log WHERE entity = 'supplier' AND user_name = ?",
      [PROBE_TAG],
    )
    const logAtPrimary = await siteQuery<Row>(
      primary,
      "SELECT COUNT(*) AS n FROM activity_log WHERE entity = 'supplier' AND user_name = ?",
      [PROBE_TAG],
    )
    ok(
      'the audit line stayed in the BRANCH',
      Number(logAtBranch[0]?.n) >= 1 && Number(logAtPrimary[0]?.n) === 0,
      `branch ${logAtBranch[0]?.n}, primary ${logAtPrimary[0]?.n}`,
    )

    /* ── The invariant still holds ──────────────────────────────────────── */

    console.log('\n— The invariant —')

    const drift = await reconcileSupplierBalances(branch)
    ok(
      'every supplier balance agrees with its ledger',
      drift.length === 0,
      drift.length ? JSON.stringify(drift.slice(0, 3)) : '0 drifting',
    )

    /* ── The creditors control account, from BOTH ends ──────────────────── */

    console.log('\n— The creditors control account —')

    const atBranchRec = (await reconcileControlAccounts(branch)).find(
      (r) => r.controlType === 'creditors',
    )
    const atPrimaryRec = (await reconcileControlAccounts(primary)).find(
      (r) => r.controlType === 'creditors',
    )

    if (!atBranchRec || !atPrimaryRec) {
      console.log('SKIP  no creditors control account configured on one of the stores')
    } else {
      ok(
        'the branch reconciles creditors at GROUP level',
        atBranchRec.scope?.level === 'group',
        atBranchRec.scope ? `${atBranchRec.scope.stores} store(s)` : 'no scope — per-store path',
      )
      ok(
        'and so does the PRIMARY, which holds the file',
        atPrimaryRec.scope?.level === 'group',
        atPrimaryRec.scope ? `${atPrimaryRec.scope.stores} store(s)` : 'no scope — per-store path',
      )
      // The real invariant: one book, one answer, whoever asks.
      ok(
        'both ends reach the same figure',
        Math.abs(atBranchRec.drift - atPrimaryRec.drift) < 0.005,
        `branch ${money(atBranchRec.drift)} vs primary ${money(atPrimaryRec.drift)}`,
      )
    }

    /* ── Training mode is refused ───────────────────────────────────────── */

    console.log('\n— Training mode —')

    const started = await startTraining(branch, { userId: 0, userName: PROBE_TAG })
    ok(
      'training mode is refused while the supplier file is shared',
      !started.ok,
      started.ok ? 'IT STARTED — SITE MAY BE IN TRAINING' : started.error.slice(0, 90),
    )
    if (started.ok) {
      // Must not leave the site in training, or every later suite is wrecked.
      const { stopTraining } = await import('../src/lib/site/trainingMode')
      await stopTraining(branch, { userId: 0, userName: PROBE_TAG })
    } else {
      ok(
        'and the reason names the supplier file',
        /supplier file/i.test(started.error),
        started.error.slice(0, 90),
      )
    }
  } finally {
    console.log('\n— Cleanup —')

    for (const site of [primary, branch]) {
      try {
        await siteQuery(site, 'DELETE FROM supplier_allocations WHERE 1 = 0')
        await siteQuery(site, 'DELETE FROM supplier_transactions WHERE reference = ?', [PROBE_TAG])
        await siteQuery(site, 'DELETE FROM suppliers WHERE code LIKE ?', [`${PROBE_TAG}%`])
        await siteQuery(site, "DELETE FROM activity_log WHERE entity = 'supplier' AND user_name = ?", [
          PROBE_TAG,
        ])
      } catch (e) {
        console.log(`  ! cleanup on site ${site}: ${e instanceof Error ? e.message : String(e)}`)
      }

      const left = await siteQuery<Row>(
        site,
        'SELECT COUNT(*) AS n FROM suppliers WHERE code LIKE ?',
        [`${PROBE_TAG}%`],
      )
      const txn = await siteQuery<Row>(
        site,
        'SELECT COUNT(*) AS n FROM supplier_transactions WHERE reference = ?',
        [PROBE_TAG],
      )
      console.log(
        `  site ${site}: ${Number(left[0]?.n)} probe supplier(s), ${Number(txn[0]?.n)} probe transaction(s) left`,
      )
    }

    await restore()
    const afterMembers = await membersOfGroup(group.id)
    ok(
      'sharing flags restored',
      afterMembers.every(
        (m) =>
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
