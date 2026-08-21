/**
 * The switch that turns loyalty sharing on — step 6, the last of the plan.
 *
 * The preconditions are deliberately NOT a copy of the customer ones, and this
 * is where that difference is proved rather than asserted:
 *
 *   · Separate companies ARE allowed to share a programme. Refusing them would
 *     refuse the ordinary franchise case, which is what the member file was
 *     built for. The customer file refuses them, and must.
 *   · A store with members of its own is refused, like the other two files, but
 *     for a sharper reason: two files may both have issued M000001, and a card
 *     is in somebody's wallet.
 *   · Both databases must be on one server, as the design rests on that.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-loyalty-switch.ts
 */
import { setMemberSharing, storeContents } from '../src/lib/storeGroups'
import { enrolMember, getLoyaltySettings, saveLoyaltySettings } from '../src/lib/site/loyalty'
import { execute as controlExecute, queryOne as controlQueryOne } from '../src/lib/db'
import { siteExecute } from '../src/lib/siteDb'

const GROUP = 4
const PRIMARY = 33 // head office, and the group primary
const BRANCH = 34
const ACTOR = { userId: 1, userName: 'Switch probe' }

let fails = 0
const ok = (l: string, c: boolean, d = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : '**FAIL**'}  ${l}${d ? '  -- ' + d : ''}`)
}
const base = { sharesProducts: false, sharesDepartments: false, sharesCost: false, sharesSelling: false }

async function entity(value: 'one' | 'several' | 'unknown') {
  await controlExecute('UPDATE cp2_store_groups SET legal_entity = ? WHERE id = ?', [value, GROUP])
}
async function flag(siteId: number): Promise<number> {
  const r = await controlQueryOne<{ shares_loyalty: number }>(
    'SELECT shares_loyalty FROM cp2_store_group_members WHERE group_id = ? AND site_id = ?',
    [GROUP, siteId],
  )
  return Number(r?.shares_loyalty ?? 0)
}

async function main() {
  const before = await controlQueryOne<{ legal_entity: string }>(
    'SELECT legal_entity FROM cp2_store_groups WHERE id = ?', [GROUP])

  try {
    console.log('\n── An empty branch can join ───────────────────────────────\n')
    await entity('one')
    const on = await setMemberSharing(GROUP, BRANCH, { ...base, sharesLoyalty: true })
    ok('the switch turns on', on.ok, on.ok ? '' : on.error)
    ok('*** and it PERSISTED ***', (await flag(BRANCH)) === 1)

    /*
     * The RESOLUTION is not asserted here, and that is deliberate.
     *
     * loyaltyOwnerSite is cache()-wrapped. React's cache is per-REQUEST, and a
     * script is one long request — so setMemberSharing's own internal call
     * memoises the pre-write answer and every later call in this process gets
     * it back. Asserting here reports a stale cache as a broken resolver, which
     * cost time once already.
     *
     * probe-loyalty-only-sharing.ts asks that question properly: it sets the
     * flag FIRST, then resolves, and finds the primary. This probe is about the
     * switch and its refusals.
     */

    console.log('\n── Separate companies are ALLOWED ─────────────────────────\n')
    await entity('several')
    const several = await setMemberSharing(GROUP, BRANCH, { ...base, sharesLoyalty: true })
    ok('*** a group of separate companies may share a programme ***', several.ok,
       several.ok ? '' : several.error)

    // The contrast that makes the point: the customer file refuses the same group.
    const cust = await setMemberSharing(GROUP, BRANCH, { ...base, sharesCustomers: true })
    ok('*** while the CUSTOMER file still refuses them ***', !cust.ok,
       cust.ok ? 'it allowed a shared debtors book across companies' : cust.error)

    await entity('unknown')
    const unknown = await setMemberSharing(GROUP, BRANCH, { ...base, sharesLoyalty: true })
    ok('an unanswered entity question does not block loyalty either', unknown.ok,
       unknown.ok ? '' : unknown.error)

    console.log('\n── A branch with its own members is refused ───────────────\n')
    await setMemberSharing(GROUP, BRANCH, { ...base, sharesLoyalty: false })
    await entity('one')

    const s = await getLoyaltySettings(BRANCH)
    await saveLoyaltySettings(BRANCH, ACTOR, { ...s, enabled: true })
    const own = await enrolMember(BRANCH, ACTOR, { name: `Branch member ${Date.now()}` })
    ok('the branch has a member of its own', own.ok, own.ok ? '' : own.error)

    const counted = await storeContents(BRANCH)
    ok('  storeContents counts it', counted.members > 0, `${counted.members}`)

    const blocked = await setMemberSharing(GROUP, BRANCH, { ...base, sharesLoyalty: true })
    ok('*** joining is REFUSED while it holds members ***', !blocked.ok,
       blocked.ok ? 'it merged two member files' : blocked.error)
    ok('  and the refusal explains the card-number collision',
       !blocked.ok && /card number/i.test(blocked.error ?? ''),
       blocked.ok ? '' : blocked.error)
    ok('  the flag stayed off', (await flag(BRANCH)) === 0)

    if (own.ok) {
      await siteExecute(BRANCH, 'DELETE FROM loyalty_ledger WHERE member_id = ?', [own.memberId])
      await siteExecute(BRANCH, 'DELETE FROM loyalty_members WHERE id = ?', [own.memberId])
    }

    console.log('\n── The primary is never blocked by its own members ────────\n')
    const primary = await setMemberSharing(GROUP, PRIMARY, { ...base, sharesLoyalty: true })
    ok('*** head office can host the programme it already holds ***', primary.ok,
       primary.ok ? '' : primary.error)
  } finally {
    await controlExecute(
      'UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP])
    await entity((before?.legal_entity as 'one') ?? 'one')
    console.log('\nFlags and the entity answer restored.')
  }

  console.log(fails === 0 ? '\nThe loyalty switch holds.\n' : `\n${fails} FAILED\n`)
  process.exit(fails === 0 ? 0 : 1)
}
main().catch(async (e) => {
  await controlExecute('UPDATE cp2_store_group_members SET shares_loyalty = 0 WHERE group_id = ?', [GROUP]).catch(() => {})
  console.error(e); process.exit(1)
})
