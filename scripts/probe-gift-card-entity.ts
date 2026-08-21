/**
 * Separate companies: the programme is shared, the money is not.
 *
 * A companion to probe-shared-gift-cards.ts, and a SEPARATE PROCESS on purpose.
 * giftCardOwnerSite is cache()-wrapped and React's cache is per-request, which
 * a script is one of — so a probe that flips the flags mid-run gets the first
 * answer for the rest of its life. Each arrangement needs its own process, and
 * this one owns the arrangement the other cannot test.
 *
 * The case: loyalty ON, legal_entity 'several', shares_gift_cards OFF. Loyalty
 * is exempt from the entity gate, so the programme is shared. Gift cards are
 * cash the shopper handed over, so they must NOT be — otherwise turning loyalty
 * on would silently pool two taxpayers' liabilities.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-gift-card-entity.ts
 */
import { execute as controlExecute, queryOne as controlQueryOne } from '../src/lib/db'
import { giftCardOwnerSite, loyaltyOwnerSite, giftCardRefusalForGroup,
         setGroupGiftCards } from '../src/lib/storeGroups'

const GROUP = 4
const PRIMARY = 33
const BRANCH = 34

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}

async function main() {
  const before = await controlQueryOne<{ legal_entity: string }>(
    'SELECT legal_entity FROM cp2_store_groups WHERE id = ?', [GROUP])

  try {
    // Every flag set BEFORE the first resolution — see the header.
    await controlExecute(
      'UPDATE cp2_store_group_members SET shares_loyalty = 1 WHERE group_id = ? AND site_id IN (?,?)',
      [GROUP, PRIMARY, BRANCH])
    await controlExecute(
      "UPDATE cp2_store_groups SET legal_entity = 'several', shares_gift_cards = 0 WHERE id = ?",
      [GROUP])

    console.log('\n── Separate companies, value NOT pooled ───────────────────\n')

    const loyalty = await loyaltyOwnerSite(BRANCH)
    ok('*** the PROGRAMME is still shared ***', loyalty.siteId === PRIMARY,
       'loyalty is exempt from the legal-entity gate, which is the franchise case')

    const cards = await giftCardOwnerSite(BRANCH)
    ok('*** but the CARDS stay with the branch ***', cards.siteId === BRANCH,
       `resolved to ${cards.siteId} — pooling here would put one company's money in another's hands`)

    const refusal = await giftCardRefusalForGroup(BRANCH)
    ok('  and a cashier is told WHY, not just "no such card"', refusal !== null)
    ok('  naming the company boundary', !!refusal && /separate companies/i.test(refusal), refusal ?? '')
    ok('  and where to change it', !!refusal && /Linked stores/i.test(refusal))
    ok('  while making clear points still work', !!refusal && /points/i.test(refusal))

    console.log('\n── The owner agrees to pool it ────────────────────────────\n')
    await setGroupGiftCards(GROUP, true)
    const stored = await controlQueryOne<{ shares_gift_cards: number }>(
      'SELECT shares_gift_cards FROM cp2_store_groups WHERE id = ?', [GROUP])
    ok('*** the switch persists ***', Number(stored?.shares_gift_cards) === 1)
    // Not re-resolving here: cache() would return the pre-write answer. The
    // one-company half of this is proved in probe-shared-gift-cards.ts.
  } finally {
    await controlExecute(
      'UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP])
    await controlExecute(
      'UPDATE cp2_store_groups SET legal_entity = ?, shares_gift_cards = 0 WHERE id = ?',
      [before?.legal_entity ?? 'one', GROUP])
    console.log('\nFlags restored.')
  }

  console.log(fails === 0 ? '\nThe money boundary holds.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(async (e) => {
  await controlExecute('UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP]).catch(() => {})
  await controlExecute("UPDATE cp2_store_groups SET legal_entity = 'one', shares_gift_cards = 0 WHERE id = ?", [GROUP]).catch(() => {})
  console.error(e); process.exit(1)
})
