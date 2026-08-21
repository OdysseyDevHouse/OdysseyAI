/**
 * A store that shares ONLY the loyalty programme.
 *
 * The three flags are independent, and this is the combination nothing else
 * tests: customers and suppliers kept locally, loyalty pooled. It is also the
 * combination the plan expects to be common — separately owned shops running
 * one card scheme, which is why loyalty is exempt from the legal-entity gate.
 *
 * Two questions:
 *   1. Does the branch resolve loyalty to the PRIMARY while keeping customers
 *      and suppliers at home?
 *   2. Is training mode refused? Practice sales would otherwise earn real
 *      points on real members' cards in the group's live programme, and the
 *      watermark that removes practice data cannot see rows in another
 *      database.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-loyalty-only-sharing.ts
 */
import {
  customerOwnerSite, supplierOwnerSite, loyaltyOwnerSite,
  customerFileIsShared, supplierFileIsShared, loyaltyFileIsShared,
} from '../src/lib/storeGroups'
import { startTraining } from '../src/lib/site/trainingMode'
import { execute as controlExecute } from '../src/lib/db'

const PRIMARY = 33
const BRANCH = 34
const ACTOR = { userId: 1, userName: 'Sharing probe' }

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}

async function main() {
  await controlExecute(
    `UPDATE cp2_store_group_members SET shares_loyalty = 1 WHERE site_id IN (?,?)`,
    [PRIMARY, BRANCH],
  )
  console.log('\nLoyalty shared, customers and suppliers left alone.\n')

  try {
    const [cust, supp, loy] = await Promise.all([
      customerOwnerSite(BRANCH), supplierOwnerSite(BRANCH), loyaltyOwnerSite(BRANCH),
    ])
    ok('*** the branch reads loyalty from the PRIMARY ***', loy.siteId === PRIMARY,
       `resolved to ${loy.siteId}`)
    ok('  its customer file stays at home', cust.siteId === BRANCH, `${cust.siteId}`)
    ok('  and so does its supplier file', supp.siteId === BRANCH, `${supp.siteId}`)

    ok('*** loyaltyFileIsShared is true AT THE PRIMARY ***',
       await loyaltyFileIsShared(PRIMARY),
       'owner.siteId !== siteId would say false here — the classic inversion')
    ok('  and true at the branch', await loyaltyFileIsShared(BRANCH))
    ok('  while the customer file reports unshared', !(await customerFileIsShared(BRANCH)))
    ok('  and the supplier file too', !(await supplierFileIsShared(BRANCH)))

    const training = await startTraining(BRANCH, ACTOR)
    ok('*** training mode is REFUSED on a loyalty-sharing store ***', !training.ok,
       training.ok ? 'it started — practice points would hit real cards' : training.error)
    ok('  and the refusal explains why', !training.ok &&
       /loyalty programme/i.test(training.error ?? '') && /points/i.test(training.error ?? ''),
       training.ok ? '' : training.error)
  } finally {
    await controlExecute(
      `UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE site_id IN (?,?)`,
      [PRIMARY, BRANCH],
    )
    console.log('\nSharing switched back off.')
  }

  console.log(fails === 0 ? '\nLoyalty-only sharing holds.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(async (e) => {
  await controlExecute(
    `UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE site_id IN (?,?)`,
    [PRIMARY, BRANCH],
  ).catch(() => {})
  console.error(e)
  process.exit(1)
})
