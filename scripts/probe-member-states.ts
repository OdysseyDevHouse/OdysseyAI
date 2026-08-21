/**
 * The four member/customer states, from decision 1 of the plan.
 *
 *   | Member | Customer | Means                                              |
 *   | yes    | null     | A walk-in who joined. Never a debtor.              |
 *   | yes    | set      | An account holder who is also on the programme.    |
 *   | null   | set      | An account holder who never joined.                |
 *   | null   | null     | A walk-in sale.                                    |
 *
 * The plan asks for a test of exactly these, because three of the four were
 * impossible before: membership WAS a customer row, so "member with no
 * customer" could not be represented and "customer who never joined" could not
 * be distinguished from one holding zero points.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-member-states.ts
 */
import {
  enrolMember, memberIdForCustomer, customerIdForMember, linkMemberToCustomer,
  getLoyaltySettings, saveLoyaltySettings, getMember,
} from '../src/lib/site/loyalty'
import { siteExecute } from '../src/lib/siteDb'
import { loyaltyQueryOne } from '../src/lib/site/loyaltyDb'

const SITE = 1
const ACTOR = { userId: 1, userName: 'States probe' }
const stamp = String(Date.now()).slice(-8)

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}

async function newCustomer(tag: string): Promise<number> {
  const r = await siteExecute(
    SITE,
    `INSERT INTO customers (code, name, status, account_type) VALUES (?,?,'active','cash')`,
    [`MS${tag}${stamp}`, `States ${tag} ${stamp}`],
  )
  return r.insertId
}

async function main() {
  const s = await getLoyaltySettings(SITE)
  await saveLoyaltySettings(SITE, ACTOR, { ...s, enabled: true })

  const created: number[] = []
  const customers: number[] = []

  console.log('\n── yes / null — a walk-in who joined ──────────────────────\n')
  const walkIn = await enrolMember(SITE, ACTOR, { name: `Walkin ${stamp}`, phone: `081${stamp}` })
  ok('a member exists with no customer', walkIn.ok, walkIn.ok ? '' : walkIn.error)
  if (!walkIn.ok) return
  created.push(walkIn.memberId)
  ok('  and resolves to no customer', (await customerIdForMember(SITE, walkIn.memberId)) === null)
  const wm = await getMember(SITE, walkIn.memberId)
  ok('  while still being a real member with a balance', wm !== null && wm.points === 0,
     `${wm?.points}`)

  console.log('\n── yes / set — an account holder on the programme ─────────\n')
  const cA = await newCustomer('A'); customers.push(cA)
  const both = await enrolMember(SITE, ACTOR, { name: `Both ${stamp}`, customerId: cA })
  ok('a member exists linked to a customer', both.ok, both.ok ? '' : both.error)
  if (!both.ok) return
  created.push(both.memberId)
  ok('  customer → member resolves', (await memberIdForCustomer(SITE, cA)) === both.memberId)
  ok('  member → customer resolves', (await customerIdForMember(SITE, both.memberId)) === cA)

  console.log('\n── null / set — a customer who never joined ───────────────\n')
  const cB = await newCustomer('B'); customers.push(cB)
  ok('*** the customer has NO member ***', (await memberIdForCustomer(SITE, cB)) === null,
     'distinguishable from a member holding zero points, which it was not before')

  console.log('\n── null / null — a walk-in sale ───────────────────────────\n')
  ok('nothing to resolve, and nothing breaks',
     (await memberIdForCustomer(SITE, 999999)) === null)

  console.log('\n── Moving between the states ──────────────────────────────\n')
  const link = await linkMemberToCustomer(SITE, ACTOR, walkIn.memberId, cB)
  ok('a walk-in member can be linked to an account later', link.ok)
  ok('  and is then found from that customer',
     (await memberIdForCustomer(SITE, cB)) === walkIn.memberId)

  const steal = await linkMemberToCustomer(SITE, ACTOR, both.memberId, cB)
  ok('*** a customer already linked cannot be taken by another member ***', !steal.ok,
     steal.ok ? 'it allowed two members on one account' : steal.error)

  const unlink = await linkMemberToCustomer(SITE, ACTOR, walkIn.memberId, null)
  ok('unlinking returns them to walk-in', unlink.ok)
  ok('  and BOTH columns clear together',
     await (async () => {
       const r = await loyaltyQueryOne<Record<string, unknown>>(
         SITE,
         'SELECT customer_id, customer_origin_site_id FROM loyalty_members WHERE id = ?',
         [walkIn.memberId],
       )
       return r?.customer_id === null && r?.customer_origin_site_id === null
     })(),
     'a site set with a null id would make a walk-in look like it belongs to a file')

  for (const id of created) {
    await siteExecute(SITE, 'DELETE FROM loyalty_ledger WHERE member_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM loyalty_members WHERE id = ?', [id])
  }
  for (const id of customers) await siteExecute(SITE, 'DELETE FROM customers WHERE id = ?', [id])

  console.log(fails === 0 ? '\nAll four states hold, and the moves between them.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
