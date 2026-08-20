/**
 * Which database owns the customer.
 *
 * The assertion that matters most is the FIRST group: a store that shares
 * nothing must resolve to ITSELF, in every circumstance, including the broken
 * ones. Stage 3 routes ~125 query sites through this resolver while every group
 * still resolves to itself, and that refactor is only provably a no-op if this
 * function cannot answer anything else.
 *
 * Everything after that is new behaviour that can be got wrong. The first group
 * is existing behaviour that must not be.
 *
 *   npm run test:customer-owner
 */
import {
  customerOwnerSite,
  supplierOwnerSite,
  customerFileIsShared,
  groupForSite,
  membersOfGroup,
  setMemberSharing,
  addMember,
  createGroup,
  deleteGroup,
} from '../src/lib/storeGroups'
import { MASTER } from '../src/lib/siteDb'
import { entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { execute, query } from '../src/lib/db'
import type { RowDataPacket } from 'mysql2/promise'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

type Restore = () => Promise<void>

/**
 * Every assertion calls the REAL customerOwnerSite(), not a copy of its logic.
 *
 * That is worth stating because the obvious worry is memoisation: the resolver
 * is wrapped in React's cache(), so a second call after flipping a flag might
 * return the first answer and make every later assertion meaningless. It does
 * not. cache() memoises per REQUEST, and a script has no request — measured,
 * not assumed: three calls with the same argument ran the function three times.
 *
 * So the flags below can be flipped and re-read directly. A mirror of the
 * resolver's logic would have tested nothing except itself.
 */
async function main() {
  const undo: Restore[] = []

  /* ── A store that shares nothing resolves to itself ──────────────────── */

  console.log('\n— A store in no group —')

  // Site ids that do not exist at all. The resolver must still answer, because
  // a missing site is exactly the shape of a control-database problem and the
  // till must keep trading against its own database.
  const ghost = await customerOwnerSite(990001)
  ok('an unknown site owns itself', ghost.siteId === 990001)
  ok('and reads its master database', ghost.purpose === MASTER)

  const ghostSupplier = await supplierOwnerSite(990002)
  ok('the supplier resolver agrees', ghostSupplier.siteId === 990002)

  ok('an unknown site is not shared', (await customerFileIsShared(990003)) === false)

  /* ── A real site with no group ───────────────────────────────────────── */

  const sites = await query<RowDataPacket & { id: number }>(
    'SELECT id FROM cp2_sites ORDER BY id LIMIT 2',
  )
  if (sites.length < 2) {
    console.log('\nNeeds two sites in cp2_sites to test the group cases. Stopping.')
    process.exit(fails > 0 ? 1 : 0)
  }
  const [siteA, siteB] = sites.map((s) => Number(s.id))

  const existing = await groupForSite(siteA)
  console.log(
    existing
      ? `\n— Sites ${siteA} and ${siteB}; site ${siteA} is in group "${existing.name}" —`
      : `\n— Sites ${siteA} and ${siteB}; no existing group —`,
  )

  /* ── With sharing OFF, both resolve to themselves ────────────────────── */

  console.log('\n— Sharing off —')

  const beforeA = await customerOwnerSite(siteA)
  const beforeB = await customerOwnerSite(siteB)
  ok(`site ${siteA} owns itself while sharing is off`, beforeA.siteId === siteA, `got ${beforeA.siteId}`)
  ok(`site ${siteB} owns itself while sharing is off`, beforeB.siteId === siteB, `got ${beforeB.siteId}`)

  /* ── Switching it on ─────────────────────────────────────────────────── */

  console.log('\n— Switching customer sharing on —')

  let group = await groupForSite(siteA)
  let createdGroup: number | null = null
  if (!group) {
    createdGroup = await createGroup('Resolver probe group', siteA)
    await addMember(createdGroup, siteA, { position: 0 })
    await addMember(createdGroup, siteB, { position: 1 })
    undo.push(async () => {
      await deleteGroup(createdGroup as number)
    })
    group = await groupForSite(siteA)
  }
  if (!group) {
    console.log('Could not establish a group. Stopping.')
    process.exit(1)
  }
  const groupId = group.id

  // Remember what to put back. Sharing flags are the only thing this test
  // writes to a real group, and every one of them is restored below.
  const before = await membersOfGroup(groupId)
  undo.push(async () => {
    for (const m of before) {
      await execute(
        `UPDATE cp2_store_group_members
            SET shares_customers = ?, shares_suppliers = ?
          WHERE group_id = ? AND site_id = ?`,
        [m.sharesCustomers ? 1 : 0, m.sharesSuppliers ? 1 : 0, groupId, m.siteId],
      )
    }
  })
  const originalPrimary = group.primarySiteId
  const originalEntity = group.legalEntity
  undo.push(async () => {
    await execute(
      'UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = ? WHERE id = ?',
      [originalPrimary, originalEntity, groupId],
    )
  })

  // The primary owns the file. Set it explicitly rather than assuming.
  await execute(
    // One company: balance sharing is refused for separate taxpayers, so the
    // resolver would decline no matter what the flags said.
    "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
    [siteA, groupId],
  )

  // Both ends must hold multi_branch or the resolver correctly refuses to route
  // anywhere — which would make every assertion below pass for the wrong
  // reason. Checked and reported rather than granted: this test must not change
  // what a site has bought, and a silent skip would read as a green run.
  const unentitled: number[] = []
  for (const s of [siteA, siteB]) {
    const ent = await entitlementsForSite(s)
    if (!hasModule(ent, 'multi_branch')) unentitled.push(s)
  }
  if (unentitled.length) {
    console.log(
      `\nSKIPPING the sharing cases: site(s) ${unentitled.join(', ')} do not hold ` +
        'multi_branch, so the resolver would decline to route regardless of the ' +
        'flags. Grant it in Setup to exercise them.',
    )
    for (const fn of undo.reverse()) await fn()
    console.log(fails === 0 ? '\nAll good (partial run).' : `\n${fails} failure(s).`)
    process.exit(fails > 0 ? 1 : 0)
  }

  // Written directly rather than through setMemberSharing(), because that
  // function refuses a store holding customers — which a dev site does. The
  // gate itself is asserted separately below.
  for (const s of [siteA, siteB]) {
    await execute(
      'UPDATE cp2_store_group_members SET shares_customers = 1 WHERE group_id = ? AND site_id = ?',
      [groupId, s],
    )
  }

  const sharedB = await customerOwnerSite(siteB)
  ok(`site ${siteB} now reads site ${siteA}`, sharedB.siteId === siteA, `got ${sharedB.siteId}`)
  ok('and still names a purpose', sharedB.purpose === MASTER)

  const sharedA = await customerOwnerSite(siteA)
  ok(`the primary still owns itself`, sharedA.siteId === siteA, `got ${sharedA.siteId}`)

  /* ── The two files are answered independently ────────────────────────── */

  console.log('\n— Customers and suppliers are separate switches —')

  const supplierB = await supplierOwnerSite(siteB)
  ok(
    'sharing customers does not share suppliers',
    supplierB.siteId === siteB,
    `got ${supplierB.siteId}`,
  )

  /* ── Both ends must hold it ──────────────────────────────────────────── */

  console.log('\n— Both ends must agree —')

  await execute(
    'UPDATE cp2_store_group_members SET shares_customers = 0 WHERE group_id = ? AND site_id = ?',
    [groupId, siteA],
  )
  const primaryOff = await customerOwnerSite(siteB)
  ok(
    'a primary that does not share cannot host the file',
    primaryOff.siteId === siteB,
    `got ${primaryOff.siteId}`,
  )
  await execute(
    'UPDATE cp2_store_group_members SET shares_customers = 1 WHERE group_id = ? AND site_id = ?',
    [groupId, siteA],
  )

  /* ── Separate companies cannot share a balance ───────────────────────── */

  console.log('\n— One company, or several —')

  // The resolver reads the entity answer LIVE rather than trusting the member
  // flags. Correcting it must stop the routing immediately, instead of leaving
  // stale flags writing into another taxpayer's debtors book.
  await execute(`UPDATE cp2_store_groups SET legal_entity = 'several' WHERE id = ?`, [groupId])
  const separate = await customerOwnerSite(siteB)
  ok(
    'separate companies do not share a customer file',
    separate.siteId === siteB,
    `got ${separate.siteId}`,
  )

  await execute(`UPDATE cp2_store_groups SET legal_entity = 'unknown' WHERE id = ?`, [groupId])
  const unanswered = await customerOwnerSite(siteB)
  ok('an unanswered group does not share either', unanswered.siteId === siteB)

  await execute(`UPDATE cp2_store_groups SET legal_entity = 'one' WHERE id = ?`, [groupId])

  /* ── No primary means the shared file names nothing ──────────────────── */

  console.log('\n— A group with no primary —')

  await execute('UPDATE cp2_store_groups SET primary_site_id = NULL WHERE id = ?', [groupId])
  const noPrimary = await customerOwnerSite(siteB)
  ok('with no primary chosen, a store owns itself', noPrimary.siteId === siteB, `got ${noPrimary.siteId}`)
  await execute(
    // One company: balance sharing is refused for separate taxpayers, so the
    // resolver would decline no matter what the flags said.
    "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
    [siteA, groupId],
  )

  /* ── The gate refuses a populated store ──────────────────────────────── */

  console.log('\n— The switch refuses a store that already has customers —')

  // Switch it back OFF first. The gate only guards the off-to-on transition —
  // a store already sharing legitimately fills up with customers and must not
  // become un-saveable — and the earlier phases left this flag on.
  await execute(
    'UPDATE cp2_store_group_members SET shares_customers = 0 WHERE group_id = ? AND site_id = ?',
    [groupId, siteB],
  )

  const members = await membersOfGroup(groupId)
  const memberB = members.find((m) => m.siteId === siteB)
  if (memberB) {
    const result = await setMemberSharing(groupId, siteB, {
      sharesProducts: memberB.sharesProducts,
      sharesDepartments: memberB.sharesDepartments,
      sharesCost: memberB.sharesCost,
      sharesSelling: memberB.sharesSelling,
      sharesCustomers: true,
    })
    // Site B in a dev database has customers, so this must refuse. If it does
    // not, the store is genuinely empty and the gate is untested rather than
    // broken — say so instead of asserting a wrong thing.
    const count = await customerCount(siteB)
    if (count > 0) {
      ok(
        'a store holding customers is refused',
        result.ok === false,
        result.ok ? 'it was allowed' : '',
      )
      if (!result.ok) console.log(`         → "${result.error}"`)

      // And the other half of the same rule: a store ALREADY sharing must not
      // become un-saveable as it fills up. Only the off-to-on transition is
      // gated, which is easy to get wrong in the direction that locks a shop
      // out of its own settings screen.
      await execute(
        'UPDATE cp2_store_group_members SET shares_customers = 1 WHERE group_id = ? AND site_id = ?',
        [groupId, siteB],
      )
      const again = await setMemberSharing(groupId, siteB, {
        sharesProducts: memberB.sharesProducts,
        sharesDepartments: memberB.sharesDepartments,
        sharesCost: memberB.sharesCost,
        sharesSelling: memberB.sharesSelling,
        sharesCustomers: true,
      })
      ok(
        'a store already sharing can still be saved',
        again.ok === true,
        again.ok ? '' : again.error,
      )
    } else {
      console.log(`SKIP  site ${siteB} holds no customers, so the gate has nothing to refuse`)
    }
  }

  /* ── Omitting a flag leaves it alone ─────────────────────────────────── */

  console.log('\n— An unrelated save must not switch the file off —')

  const beforeSave = await membersOfGroup(groupId)
  const bBefore = beforeSave.find((m) => m.siteId === siteB)
  if (bBefore) {
    await setMemberSharing(groupId, siteB, {
      sharesProducts: bBefore.sharesProducts,
      sharesDepartments: bBefore.sharesDepartments,
      sharesCost: bBefore.sharesCost,
      sharesSelling: bBefore.sharesSelling,
      // sharesCustomers deliberately omitted
    })
    const after = (await membersOfGroup(groupId)).find((m) => m.siteId === siteB)
    ok(
      'omitting sharesCustomers leaves it on',
      after?.sharesCustomers === bBefore.sharesCustomers,
      `was ${bBefore.sharesCustomers}, now ${after?.sharesCustomers}`,
    )
  }

  /* ── Put everything back ─────────────────────────────────────────────── */

  for (const fn of undo.reverse()) await fn()

  const restored = await membersOfGroup(groupId).catch(() => [])
  const stillOn = restored.filter((m) => m.sharesCustomers || m.sharesSuppliers)
  ok('every sharing flag was restored', stillOn.length === before.filter((m) => m.sharesCustomers || m.sharesSuppliers).length)

  console.log(fails === 0 ? '\nAll good.' : `\n${fails} failure(s).`)
  process.exit(fails > 0 ? 1 : 0)
}

/** How many customers a site holds, or 0 when its database cannot be read. */
async function customerCount(siteId: number): Promise<number> {
  const { siteQueryOne } = await import('../src/lib/siteDb')
  try {
    const row = await siteQueryOne<RowDataPacket & { n: number }>(
      siteId,
      'SELECT COUNT(*) AS n FROM customers',
    )
    return Number(row?.n ?? 0)
  } catch {
    return 0
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
