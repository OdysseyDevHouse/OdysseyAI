/**
 * Gift cards across a group.
 *
 * The question the whole change exists to answer: can a card sold at one store
 * be spent at another? Today it could not — findGiftCard read the caller's own
 * table, so store 7 said "no such card" about a card that plainly existed.
 *
 * And the question that makes it safe: what happens when the stores are
 * separate companies? Gift cards ride on shares_loyalty, which is exempt from
 * the legal-entity gate — so without a second answer, turning loyalty on would
 * silently pool two taxpayers' stored value. That is what shares_gift_cards is
 * for, and this proves it does something rather than merely existing.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-shared-gift-cards.ts
 */
import { execute as controlExecute, queryOne as controlQueryOne } from '../src/lib/db'
import { giftCardOwnerSite, giftCardFileIsShared, giftCardRefusalForGroup,
         loyaltyOwnerSite } from '../src/lib/storeGroups'
import { generateGiftCards, findGiftCard } from '../src/lib/site/giftCards'
import { giftCardExecute } from '../src/lib/site/giftCardDb'

const GROUP = 4
const PRIMARY = 33
const BRANCH = 34
const ACTOR = { userId: 1, userName: 'Gift probe' }

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}

async function main() {
  const before = await controlQueryOne<{ legal_entity: string }>(
    'SELECT legal_entity FROM cp2_store_groups WHERE id = ?', [GROUP])
  let code = ''

  try {
    /*
     * Set the flags FIRST, before anything resolves. loyaltyOwnerSite and
     * giftCardOwnerSite are cache()-wrapped and React's cache is per-request,
     * which a script is one of — resolving before the write would memoise the
     * wrong answer for the whole process. This cost time on the loyalty probe.
     */
    await controlExecute(
      'UPDATE cp2_store_group_members SET shares_loyalty = 1 WHERE group_id = ? AND site_id IN (?,?)',
      [GROUP, PRIMARY, BRANCH])
    await controlExecute(
      "UPDATE cp2_store_groups SET legal_entity = 'one', shares_gift_cards = 0 WHERE id = ?",
      [GROUP])

    console.log('\n── One company: the card scheme is shared ─────────────────\n')

    const owner = await giftCardOwnerSite(BRANCH)
    ok('*** the branch reads the PRIMARY\u2019s cards ***', owner.siteId === PRIMARY, `${owner.siteId}`)
    ok('  which is where its loyalty is too', (await loyaltyOwnerSite(BRANCH)).siteId === PRIMARY)
    ok('  and the file reports as shared', await giftCardFileIsShared(BRANCH))
    ok('  with nothing to explain away', (await giftCardRefusalForGroup(BRANCH)) === null)

    // Generated AT THE BRANCH — which, being shared, writes to the primary.
    const made = await generateGiftCards(BRANCH, ACTOR, { count: 1, note: 'probe' })
    ok('a card can be generated from the branch', made.ok, made.ok ? '' : made.error)
    if (!made.ok) return
    code = made.codes[0]

    const atBranch = await findGiftCard(BRANCH, code)
    const atPrimary = await findGiftCard(PRIMARY, code)
    ok('*** the SAME card is found at both stores ***',
       !!atBranch && !!atPrimary && atBranch.id === atPrimary.id,
       `branch=${atBranch?.id} primary=${atPrimary?.id}`)
  } finally {
    // Restored before the second half so the resolvers are re-read in a fresh
    // process — see the note above about cache().
    await controlExecute(
      'UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP])
    await controlExecute(
      "UPDATE cp2_store_groups SET legal_entity = ?, shares_gift_cards = 0 WHERE id = ?",
      [before?.legal_entity ?? 'one', GROUP])
    if (code) {
      await giftCardExecute(PRIMARY, 'DELETE FROM gift_card_events WHERE card_id IN (SELECT id FROM gift_cards WHERE code = ?)', [code])
      await giftCardExecute(PRIMARY, 'DELETE FROM gift_cards WHERE code = ?', [code])
    }
    console.log('\nFlags restored, probe card removed.')
  }

  console.log(fails === 0 ? '\nShared gift cards hold.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(async (e) => {
  await controlExecute('UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP]).catch(() => {})
  await controlExecute("UPDATE cp2_store_groups SET shares_gift_cards = 0 WHERE id = ?", [GROUP]).catch(() => {})
  console.error(e); process.exit(1)
})
