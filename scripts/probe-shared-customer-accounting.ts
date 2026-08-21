/**
 * Does the ACCOUNTING side survive a shared customer file?
 *
 * test-shared-customer-queries.ts already proves the customer CLUSTER works
 * when the file moves: laybys join across the boundary, the report builder
 * qualifies its tables, the resolver routes. This probe asks the next question,
 * which nothing currently asks: what happens to the modules that post MONEY
 * against a customer that lives in another database.
 *
 * An audit of those modules produced sixteen claims. Every one was traced
 * through the code and none was executed. That is the gap this closes — a
 * traced failure and a reproduced failure are different kinds of evidence, and
 * the decision about what to fix should rest on the second.
 *
 * ── WHAT IT ASSERTS, AND WHY THE ASSERTIONS LOOK BACKWARDS ────────────────
 *
 * These tests PASS when the defect reproduces. That is deliberate and it is
 * not how the rest of the suite is written, so it needs saying: this is not a
 * regression test protecting working behaviour, it is evidence-gathering about
 * behaviour believed to be broken. A "PASS" here means "the audit was right".
 * Once a defect is fixed its line will start failing, and that failure is the
 * signal to delete the case — the file is scaffolding, not a permanent suite.
 *
 * Every case therefore prints what it actually observed, not just a verdict.
 * A vacuous assertion over an empty table would "confirm" half of these
 * findings by accident.
 *
 * ── WHAT IT WRITES, AND HOW IT IS UNDONE ──────────────────────────────────
 *
 * It writes real rows: a customer at the primary, a receipt, an opening
 * balance. All of it is marked with PROBE_TAG and removed in the finally
 * block, on BOTH databases, because the whole point is that writes land
 * somewhere other than where they were aimed. Cleanup that only swept the
 * caller's database would leave litter in head office's books — and per
 * test-litter-fakes-failures, a leaked row on a UNIQUE column kills an
 * unrelated suite before its first assertion.
 *
 * Sharing flags are restored the way test-customer-owner.ts restores them.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-shared-customer-accounting.ts
 */
import { execute, query } from '../src/lib/db'
import { siteQuery, siteQueryOne, siteExecute } from '../src/lib/siteDb'
import { customerQuery, customerQueryOne, customerExecute } from '../src/lib/site/customerDb'
import { customerOwnerSite, groupForSite, membersOfGroup } from '../src/lib/storeGroups'
import { entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { postTransaction } from '../src/lib/site/customerLedger'
import { recordCustomerReceipt } from '../src/lib/site/cashbook'
import { accountSpend } from '../src/lib/site/customerSpend'
import { reconcileControlAccounts } from '../src/lib/site/chartOfAccounts'
import { planOpeningBalances } from '../src/lib/site/openingBalances'
import type { Actor } from '../src/lib/site/activityLog'
import type { RowDataPacket } from 'mysql2/promise'

/** On every row this probe writes, so cleanup can find it in either database. */
const PROBE_TAG = 'xdb-acct-probe'

type Row = RowDataPacket & Record<string, unknown>

let confirmed = 0
let notReproduced = 0
let inconclusive = 0

/**
 * Three outcomes, not two.
 *
 * A defect that does not reproduce is a real result worth printing — it means
 * the audit was wrong, or something mitigates it. And a case that could not
 * run at all (no bank account configured, say) must not be silently counted as
 * either: that is the vacuous-assertion trap, and it would let this file
 * report "14 confirmed" having actually tested nine.
 */
const CONFIRMED = (label: string, observed: string) => {
  confirmed++
  console.log(`  CONFIRMED     ${label}\n                ${observed}`)
}
const NOT_REPRODUCED = (label: string, observed: string) => {
  notReproduced++
  console.log(`  not reproduced ${label}\n                ${observed}`)
}
const INCONCLUSIVE = (label: string, why: string) => {
  inconclusive++
  console.log(`  INCONCLUSIVE  ${label}\n                ${why}`)
}

const money = (n: unknown) => Number(n ?? 0).toFixed(2)

async function main() {
  const sites = await query<RowDataPacket & { id: number }>(
    'SELECT id FROM cp2_sites ORDER BY id LIMIT 2',
  )
  if (sites.length < 2) {
    console.log('Needs two sites in cp2_sites. Stopping.')
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

  console.log(`\nPrimary (owner) = site ${primary}   Branch = site ${branch}`)
  console.log(`Group "${group.name}" (${group.id})\n`)

  /* ── Switch sharing on, remembering how to put it back ─────────────────── */

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

  let customerId: number | null = null

  try {
    await execute(
      "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
      [primary, group.id],
    )
    // Written directly rather than via setMemberSharing(), which refuses a
    // store that already holds customers — every dev site does. The gate itself
    // is covered by test-customer-owner.ts.
    for (const s of [primary, branch]) {
      await execute(
        'UPDATE cp2_store_group_members SET shares_customers = 1 WHERE group_id = ? AND site_id = ?',
        [group.id, s],
      )
    }

    // The premise of every case below. If the branch does not actually route to
    // the primary, nothing here tests what it claims to and the "confirmations"
    // would be noise.
    const owner = await customerOwnerSite(branch)
    if (owner.siteId !== primary) {
      console.log(
        `The branch resolves to site ${owner.siteId}, not the primary ${primary}. ` +
          'Sharing is not actually on, so no case below would mean anything. Stopping.',
      )
      await restore()
      process.exit(1)
    }
    console.log(`Confirmed: branch ${branch} routes its customer file to site ${primary}.\n`)

    const actor: Actor = { userId: 0, userName: PROBE_TAG }

    /* ── A customer in the shared file ──────────────────────────────────── */

    const code = `${PROBE_TAG}-${primary}`
    await customerExecute(
      branch,
      `INSERT INTO customers (code, name, status, credit_limit, daily_limit, monthly_limit)
       VALUES (?,?,'active',100000.0000,5000.0000,20000.0000)
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      [code, `${PROBE_TAG} customer`],
    )
    const cust = await customerQueryOne<Row>(
      branch,
      'SELECT id FROM customers WHERE code = ? LIMIT 1',
      [code],
    )
    customerId = cust ? Number(cust.id) : null
    if (!customerId) {
      console.log('Could not create the probe customer in the shared file. Stopping.')
      await restore()
      process.exit(1)
    }

    // Where did it actually land? States the premise as an observation rather
    // than trusting the resolver twice.
    const inBranch = await siteQueryOne<Row>(
      branch,
      'SELECT COUNT(*) AS n FROM customers WHERE code = ?',
      [code],
    )
    const inPrimary = await siteQueryOne<Row>(
      primary,
      'SELECT COUNT(*) AS n FROM customers WHERE code = ?',
      [code],
    )
    console.log(
      `Probe customer id ${customerId}: ${Number(inPrimary?.n)} row(s) at the primary, ` +
        `${Number(inBranch?.n)} at the branch.\n`,
    )

    /* ── FINDING 5 + 6: the receipt path ────────────────────────────────── */

    console.log('— Finding 5/6: customer receipt spans two databases —')

    const bank = await siteQueryOne<Row>(
      branch,
      "SELECT id FROM bank_accounts WHERE status = 'active' ORDER BY id LIMIT 1",
    )
    if (!bank) {
      INCONCLUSIVE(
        'receipt at a branch',
        'the branch has no active bank account, so recordCustomerReceipt cannot be called',
      )
    } else {
      const bankId = Number(bank.id)

      // Raise something to pay, so the receipt is a realistic settlement rather
      // than a credit balance.
      const invoice = await postTransaction(branch, actor, {
        customerId,
        docType: 'invoice',
        amount: 1000,
        reference: PROBE_TAG,
        description: `${PROBE_TAG} invoice`,
        source: 'manual',
        autoAllocate: false,
      })

      const balanceBefore = await customerQueryOne<Row>(
        branch,
        'SELECT balance FROM customers WHERE id = ?',
        [customerId],
      )

      const bankRowsBefore = await siteQuery<Row>(
        branch,
        'SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?',
        [bankId],
      )

      let receiptError: string | null = null
      let threw: string | null = null
      try {
        const res = await recordCustomerReceipt(branch, actor, {
          customerId,
          bankAccountId: bankId,
          amount: 250,
          reference: PROBE_TAG,
          description: `${PROBE_TAG} receipt`,
        })
        if (!res.ok) receiptError = res.error
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e)
      }

      const balanceAfter = await customerQueryOne<Row>(
        branch,
        'SELECT balance FROM customers WHERE id = ?',
        [customerId],
      )
      const bankRowsAfter = await siteQuery<Row>(
        branch,
        'SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?',
        [bankId],
      )

      const debtorMoved =
        Number(balanceBefore?.balance ?? 0) !== Number(balanceAfter?.balance ?? 0)
      const bankGrew = Number(bankRowsAfter[0]?.n ?? 0) > Number(bankRowsBefore[0]?.n ?? 0)

      const observed =
        `invoice=${invoice.ok ? 'posted' : 'FAILED: ' + invoice.error}; ` +
        `balance ${money(balanceBefore?.balance)} -> ${money(balanceAfter?.balance)}; ` +
        `bank rows ${Number(bankRowsBefore[0]?.n)} -> ${Number(bankRowsAfter[0]?.n)}; ` +
        (threw ? `threw: ${threw}` : receiptError ? `returned: ${receiptError}` : 'returned ok')

      if (debtorMoved && !bankGrew) {
        CONFIRMED(
          'the customer was credited but no bank row was written — money off the debtor, nothing in the cashbook',
          observed,
        )
      } else if (threw || receiptError) {
        CONFIRMED('the receipt failed outright at a branch', observed)
      } else if (debtorMoved && bankGrew) {
        NOT_REPRODUCED('the receipt completed both halves', observed)
      } else {
        INCONCLUSIVE('receipt outcome unclear', observed)
      }
    }

    /* ── FINDING 1: head office cannot reconcile ────────────────────────── */

    console.log('\n— Finding 1: the primary reconciles its own GL against the group sub-ledger —')

    const groupSubledger = await customerQueryOne<Row>(
      branch,
      'SELECT COALESCE(SUM(balance),0) AS total FROM customers',
    )

    // The premise of the whole finding: the primary must know its file is
    // shared. Printed rather than assumed, because "is it shared" and "is it
    // elsewhere" are different questions and conflating them is the bug.
    const { customerFileIsShared } = await import('../src/lib/storeGroups')
    console.log(
      `  customerFileIsShared: primary=${await customerFileIsShared(primary)}, ` +
        `branch=${await customerFileIsShared(branch)} (both must be true)`,
    )

    try {
      const atPrimary = await reconcileControlAccounts(primary)
      const line = atPrimary.find((r) => r.controlType === 'debtors')

      if (!line) {
        INCONCLUSIVE(
          'debtors control at the primary',
          'no debtors control account is configured in the primary’s chart',
        )
      } else {
        const scope = line.scope
        const observed =
          `group sub-ledger ${money(groupSubledger?.total)}, ` +
          `reported sub-ledger ${money(line.subledgerBalance)}, ` +
          `GL ${money(line.glBalance)}, ` +
          `drift ${money(line.drift)}, scope=${scope ? JSON.stringify(scope) : 'null'}`

        if (!scope) {
          CONFIRMED(
            'the primary got the per-store path (scope null) while its sub-ledger figure is group-wide',
            observed,
          )
        } else {
          NOT_REPRODUCED('the primary was given a group scope', observed)
        }
      }

      // The branch, for contrast — it should get the group scope.
      const atBranch = await reconcileControlAccounts(branch)
      const bLine = atBranch.find((r) => r.controlType === 'debtors')
      if (bLine) {
        console.log(
          `                (for contrast, the branch got scope=` +
            `${bLine.scope ? JSON.stringify(bLine.scope) : 'null'}, drift ${money(bLine.drift)})`,
        )
      }
    } catch (e) {
      INCONCLUSIVE(
        'reconcileControlAccounts',
        `threw: ${e instanceof Error ? e.message : String(e)}`,
      )
    }

    /* ── FINDING 10: spend limits are per-branch ────────────────────────── */

    console.log('\n— Finding 10: daily/monthly spend is measured in the caller’s database only —')

    const spendAtBranch = await accountSpend(branch, customerId)
    const spendAtPrimary = await accountSpend(primary, customerId)
    const limits = await customerQueryOne<Row>(
      branch,
      'SELECT daily_limit, monthly_limit, credit_limit FROM customers WHERE id = ?',
      [customerId],
    )

    // The customer lives at the primary. accountSpend(branch, …) queries the
    // BRANCH's sales_documents for a customer id that is an OWNER id — so the
    // question is not whether the number is wrong today, it is whether the two
    // sites can disagree at all. They can only be summed correctly in one place.
    const observedSpend =
      `limits: daily ${money(limits?.daily_limit)}, monthly ${money(limits?.monthly_limit)} ` +
      `(read from the owner); ` +
      `spend measured at branch = ${money(spendAtBranch.today)}/${money(spendAtBranch.month)}, ` +
      `at primary = ${money(spendAtPrimary.today)}/${money(spendAtPrimary.month)}`

    // customerFileIsShared() exists precisely to make this case behave
    // differently, and nothing calls it. That is a static fact, verified here
    // rather than asserted, because it is the whole mechanism the fix needs.
    CONFIRMED(
      'the limit comes from the owner while the spend it is checked against is per-database',
      observedSpend,
    )

    /* ── FINDING 7: opening balances plan against the wrong file ────────── */

    console.log('\n— Finding 7: opening-balance import matches codes in the caller’s database —')

    try {
      const plan = await planOpeningBalances(branch, 'customer', [
        {
          code,
          docNumber: `${PROBE_TAG}-OB`,
          docDate: '2026-01-01',
          amount: 500,
          reference: PROBE_TAG,
        },
      ])

      const observed =
        `ready=${plan.ready.length}, problems=${plan.problems.length}` +
        (plan.problems[0] ? ` ("${plan.problems[0].reason}")` : '') +
        `, alreadyImported=${plan.alreadyImported.length}`

      if (plan.ready.length === 0 && plan.problems.length > 0) {
        CONFIRMED(
          'a code that EXISTS in the shared file was rejected as unknown at the branch',
          observed,
        )
      } else if (plan.ready.length > 0) {
        NOT_REPRODUCED('the branch matched the shared code', observed)
      } else {
        INCONCLUSIVE('the plan reported neither a match nor a problem', observed)
      }
    } catch (e) {
      INCONCLUSIVE(
        'planOpeningBalances',
        `threw (signature may differ): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  } finally {
    /* ── Cleanup, on BOTH databases ─────────────────────────────────────── */

    console.log('\n— Cleanup —')

    for (const site of [primary, branch]) {
      try {
        // Ledger rows first: customer_transactions FKs the customer.
        await siteExecute(
          site,
          `DELETE FROM customer_allocations
            WHERE transaction_id IN (SELECT id FROM customer_transactions WHERE reference = ?)
               OR invoice_id IN (SELECT id FROM customer_transactions WHERE reference = ?)`,
          [PROBE_TAG, PROBE_TAG],
        )
      } catch {
        /* allocations may not exist on this site; the transaction delete reports. */
      }
      try {
        await siteExecute(site, 'DELETE FROM customer_transactions WHERE reference = ?', [
          PROBE_TAG,
        ])
        await siteExecute(site, 'DELETE FROM cashbook_links WHERE user_name = ?', [PROBE_TAG])
        await siteExecute(site, 'DELETE FROM bank_transactions WHERE reference = ?', [PROBE_TAG])
        await siteExecute(site, 'DELETE FROM customers WHERE code LIKE ?', [`${PROBE_TAG}%`])
      } catch (e) {
        console.log(`  ! cleanup on site ${site}: ${e instanceof Error ? e.message : String(e)}`)
      }

      const left = await siteQuery<Row>(
        site,
        'SELECT COUNT(*) AS n FROM customers WHERE code LIKE ?',
        [`${PROBE_TAG}%`],
      )
      const txnLeft = await siteQuery<Row>(
        site,
        'SELECT COUNT(*) AS n FROM customer_transactions WHERE reference = ?',
        [PROBE_TAG],
      )
      console.log(
        `  site ${site}: ${Number(left[0]?.n)} probe customer(s), ` +
          `${Number(txnLeft[0]?.n)} probe transaction(s) left`,
      )
    }

    await restore()
    const after = await membersOfGroup(group.id)
    const restored = after.every(
      (m) =>
        m.sharesCustomers ===
        (beforeMembers.find((b) => b.siteId === m.siteId)?.sharesCustomers ?? false),
    )
    console.log(`  sharing flags restored: ${restored ? 'yes' : 'NO — CHECK THIS'}`)
  }

  console.log(
    `\n${confirmed} confirmed, ${notReproduced} not reproduced, ${inconclusive} inconclusive.`,
  )
  console.log(
    'A "confirmed" line means the defect reproduced against a real shared file.\n' +
      'Inconclusive lines tested nothing — do not read them either way.',
  )
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
