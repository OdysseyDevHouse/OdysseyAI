/**
 * Does the member file actually work, end to end?
 *
 * The port is large and typecheck-clean, which proves nothing about SQL. Column
 * names that no longer exist compile perfectly — three of them were found by
 * reading, after `tsc` had been green for an hour. This runs the real functions
 * against a real database.
 *
 * What it asks, in the order the answers depend on each other:
 *
 *   1. Can somebody JOIN — with an account, and without one? A walk-in member
 *      is the case the whole change exists for.
 *   2. Does a sale to a member EARN, and does the ledger drive the balance?
 *   3. Is an unaffordable redemption REFUSED BEFORE THE SALE OPENS? This is the
 *      contract that replaced the roll-back, and the one thing that must not
 *      silently sell goods for points nobody has.
 *   4. Does an affordable redemption actually MOVE the balance? A pre-flight
 *      check that passes and then never spends is the failure mode of the new
 *      arrangement, and it would look exactly like success from the till.
 *   5. Does the till find a member from the customer, so a cashier scans once?
 *
 *   npx tsx --env-file=.env scripts/probe-member-sale.ts
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import { saveDraft } from '../src/lib/site/salesDocuments'
import { finaliseDocument } from '../src/lib/site/salesPosting'
import { getTenderByCode } from '../src/lib/site/tenderTypes'
import {
  enrolMember,
  getLoyaltySettings,
  saveLoyaltySettings,
  memberIdForCustomer,
  tillMemberForCustomer,
  linkMemberToCustomer,
  redeemableFor,
} from '../src/lib/site/loyalty'
import { loyaltyQueryOne } from '../src/lib/site/loyaltyDb'

const SITE = Number(process.env.PROBE_SITE ?? 1)
const ACTOR = { userId: 1, userName: 'Probe' }

let pass = 0
let fail = 0
function ok(label: string, condition: boolean, detail = '') {
  if (condition) {
    pass++
    console.log(`  ok    ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

const stamp = String(Date.now()).slice(-8)
let productCode = ''
let customerId = 0

/** SUM over the ledger. The only balance that counts. */
async function ledgerBalance(memberId: number): Promise<number> {
  const row = await loyaltyQueryOne<{ points: string }>(
    SITE,
    'SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE member_id = ?',
    [memberId],
  )
  return Number(row?.points ?? 0)
}

async function sell(opts: {
  incl: number
  customerId?: number | null
  memberId?: number | null
  tenders: { code: string; amount: number }[]
}) {
  const draft = await saveDraft(SITE, ACTOR, {
    docType: 'invoice',
    customerId: opts.customerId ?? null,
    customerName: 'Probe',
    lines: [
      {
        productCode,
        description: 'Probe line',
        productType: 'service',
        qty: 1,
        unitPriceIncl: opts.incl,
        // vatRatePct, not a tax-rate id. Without it the VAT is undefined and
        // the document total arrives as the string 'NaN'.
        vatRatePct: 15,
        unitCostExcl: 10,
      } as never,
    ],
  })
  if (!draft.ok) throw new Error(`draft failed: ${draft.error}`)

  const tenders = []
  for (const t of opts.tenders) {
    const type = await getTenderByCode(SITE, t.code)
    if (!type) throw new Error(`no tender ${t.code}`)
    tenders.push({ tenderTypeId: type.id, amount: t.amount })
  }

  return finaliseDocument(SITE, ACTOR, {
    documentId: draft.id,
    tenders,
    customerId: opts.customerId ?? null,
    memberId: opts.memberId,
    voucherCodes: [],
  })
}

async function main() {
  console.log(`\n── Setup (site ${SITE}) ────────────────────────────────────\n`)

  const settings = await getLoyaltySettings(SITE)
  await saveLoyaltySettings(SITE, ACTOR, { ...settings, enabled: true, earnRate: 1, redeemRate: 10 })
  await siteExecute(SITE, `UPDATE tender_types SET is_active = 1 WHERE integration_key = 'loyalty'`)

  const dept = await siteQueryOne<{ id: number }>(SITE, 'SELECT id FROM departments ORDER BY id LIMIT 1')
  productCode = `PM${stamp}`
  await siteExecute(
    SITE,
    `INSERT INTO products (code, description, product_type, department_id) VALUES (?,?,'stock',?)`,
    [productCode, `Probe product ${stamp}`, dept ? Number(dept.id) : null],
  )

  const cust = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type) VALUES (?,?,'active','cash')`,
    [`PC${stamp}`, `Probe Customer ${stamp}`],
  )
  customerId = cust.insertId
  ok('a test customer exists', customerId > 0)

  console.log('\n── 1. Joining ─────────────────────────────────────────────\n')

  const walkIn = await enrolMember(SITE, ACTOR, {
    name: `Walk-in ${stamp}`,
    phone: `082${stamp}`,
  })
  ok('*** a walk-in can join with no customer account ***', walkIn.ok,
     walkIn.ok ? '' : walkIn.error)
  if (!walkIn.ok) return

  ok('  and gets an allocated member number', /^M\d{6}$/.test(walkIn.memberNumber),
     walkIn.memberNumber)

  const linked = await enrolMember(SITE, ACTOR, {
    name: `Account holder ${stamp}`,
    customerId,
  })
  ok('an account holder can join', linked.ok, linked.ok ? '' : linked.error)
  if (!linked.ok) return

  ok('  and the two numbers differ', walkIn.memberNumber !== linked.memberNumber,
     `${walkIn.memberNumber} vs ${linked.memberNumber}`)

  const again = await enrolMember(SITE, ACTOR, { name: 'Duplicate', customerId })
  ok('*** the same customer cannot join twice ***', !again.ok,
     again.ok ? 'it allowed a second membership' : again.error)

  console.log('\n── 2. Earning ─────────────────────────────────────────────\n')

  const sale = await sell({
    incl: 500,
    customerId,
    memberId: linked.memberId,
    tenders: [{ code: 'CASH', amount: 500 }],
  })
  ok('a cash sale to a member posts', sale.ok, sale.ok ? '' : sale.error)

  const earned = await ledgerBalance(linked.memberId)
  ok('*** it earned 500 points ***', earned === 500, `got ${earned}`)

  const walkInSale = await sell({
    incl: 300,
    customerId: null,
    memberId: walkIn.memberId,
    tenders: [{ code: 'CASH', amount: 300 }],
  })
  ok('a sale to a WALK-IN member posts', walkInSale.ok, walkInSale.ok ? '' : walkInSale.error)
  const walkInEarned = await ledgerBalance(walkIn.memberId)
  ok('*** a member with no customer account earns ***', walkInEarned === 300,
     `got ${walkInEarned}`)

  console.log('\n── 3. An overdraw is refused BEFORE the sale ──────────────\n')

  const { maxRand } = await redeemableFor(SITE, linked.memberId, 1000)
  ok('  500 points are worth R50', maxRand === 50, `${maxRand}`)

  const before = await ledgerBalance(linked.memberId)
  const overdrawn = await sell({
    incl: 400,
    customerId,
    memberId: linked.memberId,
    // R200 of points against a R50 balance.
    tenders: [{ code: 'CASH', amount: 200 }, { code: 'LOYALTY_POINTS', amount: 200 }],
  })
  ok('*** an unaffordable redemption is REFUSED ***', !overdrawn.ok,
     overdrawn.ok ? 'the sale went through' : overdrawn.error)
  ok('  and the refusal names the shortfall',
     !overdrawn.ok && /not enough points/i.test(overdrawn.error ?? ''),
     overdrawn.ok ? '' : overdrawn.error)
  ok('*** the balance did not move ***', (await ledgerBalance(linked.memberId)) === before,
     `${before} → ${await ledgerBalance(linked.memberId)}`)

  console.log('\n── 4. An affordable redemption actually spends ────────────\n')

  const spend = await sell({
    incl: 400,
    customerId,
    memberId: linked.memberId,
    tenders: [{ code: 'CASH', amount: 380 }, { code: 'LOYALTY_POINTS', amount: 20 }],
  })
  ok('an affordable redemption posts', spend.ok, spend.ok ? '' : spend.error)

  const after = await ledgerBalance(linked.memberId)
  // R20 at 10 points per rand = 200 points spent; the R380 cash earns 380.
  // 500 - 200 + 380 = 680.
  ok('*** the points were actually DEDUCTED ***', after === 680, `expected 680, got ${after}`)

  console.log('\n── 5. The till finds the member from the customer ─────────\n')

  const found = await memberIdForCustomer(SITE, customerId)
  ok('*** attaching a customer finds their member ***', found === linked.memberId,
     `${found} vs ${linked.memberId}`)

  const tillMember = await tillMemberForCustomer(SITE, customerId)
  ok('  and the till shape carries the number', tillMember?.number === linked.memberNumber,
     tillMember?.number)

  const unlink = await linkMemberToCustomer(SITE, ACTOR, linked.memberId, null)
  ok('a member can be unlinked from their account', unlink.ok)
  ok('*** and is then NOT found from that customer ***',
     (await memberIdForCustomer(SITE, customerId)) === null)

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
