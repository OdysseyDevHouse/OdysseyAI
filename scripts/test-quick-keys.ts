/**
 * Quick keys — the model's invariants.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-quick-keys.ts
 *
 * What is checked is the handful of rules that keep the tree navigable, plus the one
 * place the schema and the intended behaviour deliberately disagree:
 *
 *   · ONE LEVEL of nesting. A group inside a group is a menu, and a till is not a menu.
 *   · DELETE PROMOTES. The FK is ON DELETE CASCADE, so deleting a group would take its
 *     members with it — deleteQuickKey re-parents them first. Get that order wrong and
 *     a shop loses six keys it spent ten minutes arranging. This is THE assertion in
 *     this file.
 *   · `position` renumbered 0..n-1 per scope, so "insert at 3" keeps meaning something.
 *   · `sig` server-written, and a duplicate refused even at the TOP LEVEL — where
 *     uq_slot cannot help, because MySQL treats the NULL parent_id as distinct.
 *   · an unknown capability or a hex colour refused rather than coerced.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import {
  listQuickKeys,
  getQuickKey,
  createQuickKey,
  createQuickKeyGroup,
  moveQuickKey,
  updateQuickKey,
  deleteQuickKey,
  ensureSupervisorGroup,
} from '../src/lib/site/quickKeys'
import { quickKeySig, actionForSlug, QUICK_KEY_ACTIONS, topLevelKeys, groupMembers } from '../src/lib/quickKeys'

const ROOT = path.resolve(import.meta.dirname, '..')
const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  /* A clean slate. Quick keys are configuration rather than history — nothing
     references them — so wiping the section is safe and makes the positions
     assertable. */
  await siteExecute(SITE, "DELETE FROM pos_quick_keys WHERE section = 'main'")

  const product = await siteQuery<any>(
    SITE,
    "SELECT id FROM products WHERE is_archived = 0 AND product_type IN ('normal','service') ORDER BY id LIMIT 3",
  )
  const dept = await siteQuery<any>(SITE, 'SELECT id FROM departments ORDER BY id LIMIT 1')
  if (product.length < 3 || dept.length < 1) {
    console.log('need 3 products and a department on site 1')
    process.exit(1)
  }

  /* ── 1. The catalogue is internally consistent ──────────────────────────
     Pure, but worth asserting here too: a slug in the catalogue with no capability, or
     a duplicate slug, is a key that saves and then cannot be pressed. */

  const slugs = QUICK_KEY_ACTIONS.map((a) => a.slug)
  ok('every action slug is unique', new Set(slugs).size === slugs.length)
  ok('every action names a capability', QUICK_KEY_ACTIONS.every((a) => !!a.capability))
  ok('every action names an icon', QUICK_KEY_ACTIONS.every((a) => !!a.icon))

  /*
   * ── EVERY ICON NAME IS ONE THE KIT ACTUALLY HAS ────────────────────────
   *
   * `icon` is a plain string, so `tsc` cannot check it — and a name the kit does not
   * export renders NOTHING, silently. Three of them were wrong when this test was added
   * (ShoppingBag, ClipboardList, Factory), which is exactly how long a typo survives
   * when nothing looks.
   *
   * Read as SOURCE rather than imported: `icons.tsx` pulls in lucide-react, which needs
   * a React runtime this test has no business booting — the same reason
   * test-permissions scans nav.ts as text.
   */
  const iconSrc = await readFile(path.join(ROOT, 'src', 'components', 'ui', 'icons.tsx'), 'utf8')
  const exported = new Set(
    [...iconSrc.matchAll(/^\s*(?:([A-Z][A-Za-z0-9]*)\s+as\s+)?([A-Z][A-Za-z0-9]*),\s*$/gm)].map(
      (m) => m[2],
    ),
  )
  ok('the kit icon list was parsed', exported.size > 50, `${exported.size} icons`)

  const unknownIcons = [...new Set(QUICK_KEY_ACTIONS.map((a) => a.icon))].filter(
    (name) => !exported.has(name),
  )
  ok(
    '*** every quick-key icon exists in the kit ***',
    unknownIcons.length === 0,
    unknownIcons.join(', ') || 'a missing name renders no glyph, silently',
  )
  ok('every action has a hint for the designer', QUICK_KEY_ACTIONS.every((a) => a.hint.length > 10))
  ok(
    'void-sale needs sales.till, NOT sales.void',
    actionForSlug('void-sale')?.capability === 'sales.till',
    actionForSlug('void-sale')?.capability,
  )

  /* ── 2. Creating keys ───────────────────────────────────────────────────── */

  const a1 = await createQuickKey(SITE, {
    target: { kind: 'action', actionSlug: 'save-sale' },
    icon: 'Save',
    colourToken: 'tile-1',
  })
  ok('an action key is created', a1.ok, a1.ok ? '' : a1.error)

  const p1 = await createQuickKey(SITE, {
    target: { kind: 'product', productId: product[0].id },
    colourToken: 'tile-grad-1',
  })
  ok('a product key is created', p1.ok, p1.ok ? '' : p1.error)
  ok(
    '  and a gradient token is accepted',
    p1.ok && p1.keys.some((k) => k.colourToken === 'tile-grad-1'),
  )

  const p2 = await createQuickKey(SITE, { target: { kind: 'product', productId: product[1].id } })
  const p3 = await createQuickKey(SITE, { target: { kind: 'product', productId: product[2].id } })
  const d1 = await createQuickKey(SITE, {
    target: { kind: 'department', departmentId: dept[0].id },
  })
  ok('a department key is created', d1.ok, d1.ok ? '' : d1.error)

  const keys = await listQuickKeys(SITE)
  ok('five keys on the bar', topLevelKeys(keys).length === 5, String(topLevelKeys(keys).length))
  ok(
    'positions are 0..4 with no gaps',
    topLevelKeys(keys).map((k) => k.position).join(',') === '0,1,2,3,4',
    topLevelKeys(keys).map((k) => k.position).join(','),
  )

  /* ── 3. A duplicate is refused AT THE TOP LEVEL ─────────────────────────
     Where uq_slot cannot help: every bar key has parent_id NULL, and MySQL treats
     NULLs as distinct in a unique index. Without the code check a shop could put one
     product on a bar twice and then wonder which of two identical keys to edit. */

  const dup = await createQuickKey(SITE, { target: { kind: 'product', productId: product[0].id } })
  ok('the same product twice on one bar is REFUSED', !dup.ok, dup.ok ? '' : dup.error)
  ok(
    '  and the bar is unchanged',
    topLevelKeys(await listQuickKeys(SITE)).length === 5,
  )

  /* ── 4. Validation refuses rather than coerces ──────────────────────────── */

  const badColour = await createQuickKey(SITE, {
    target: { kind: 'action', actionSlug: 'undo' },
    colourToken: '#ff0000',
  })
  ok('a hex colour is refused', !badColour.ok, badColour.ok ? '' : badColour.error)

  const badSlug = await createQuickKey(SITE, {
    target: { kind: 'action', actionSlug: 'launch-the-rockets' },
  })
  ok('an unknown action is refused', !badSlug.ok, badSlug.ok ? '' : badSlug.error)

  /* ── 5. Grouping ───────────────────────────────────────────────────────── */

  const memberIds = [
    keys.find((k) => k.productId === product[1].id)!.id,
    keys.find((k) => k.productId === product[2].id)!.id,
  ]
  const group = await createQuickKeyGroup(
    SITE,
    { caption: 'Drinks', icon: 'Shapes', colourToken: 'tile-3' },
    memberIds,
  )
  ok('a group is created with its members in one request', group.ok, group.ok ? '' : group.error)

  const afterGroup = await listQuickKeys(SITE)
  const groupRow = afterGroup.find((k) => k.kind === 'group' && k.caption === 'Drinks')!
  ok('the group is on the bar', groupRow !== undefined && groupRow.parentId === null)
  ok(
    'its two members are inside it',
    groupMembers(afterGroup, groupRow.id).length === 2,
    String(groupMembers(afterGroup, groupRow.id).length),
  )
  ok(
    '  re-positioned from zero, not keeping their old slots',
    groupMembers(afterGroup, groupRow.id).map((k) => k.position).join(',') === '0,1',
    groupMembers(afterGroup, groupRow.id).map((k) => k.position).join(','),
  )
  ok(
    '  and the bar closed up behind them',
    topLevelKeys(afterGroup).map((k) => k.position).join(',') === '0,1,2,3',
    topLevelKeys(afterGroup).map((k) => k.position).join(','),
  )

  /* ── 6. ONE LEVEL ONLY ─────────────────────────────────────────────────── */

  const nested = await createQuickKeyGroup(
    SITE,
    { caption: 'Fizzy' },
    [groupRow.id],
  )
  ok('a group cannot be filed into a group', !nested.ok, nested.ok ? '' : nested.error)

  const movedGroup = await moveQuickKey(SITE, groupRow.id, { parentId: groupRow.id, index: 0 })
  ok('a group cannot be moved into itself', !movedGroup.ok, movedGroup.ok ? '' : movedGroup.error)

  /* ── 7. Moving ─────────────────────────────────────────────────────────── */

  const barKey = topLevelKeys(afterGroup).find((k) => k.kind === 'action')!
  const intoGroup = await moveQuickKey(SITE, barKey.id, { parentId: groupRow.id, index: 0 })
  ok('a key moves into a group', intoGroup.ok, intoGroup.ok ? '' : intoGroup.error)

  const afterMove = await listQuickKeys(SITE)
  ok(
    '  landing at the index asked for',
    groupMembers(afterMove, groupRow.id)[0]?.id === barKey.id,
    String(groupMembers(afterMove, groupRow.id)[0]?.id),
  )
  ok(
    '  and the group renumbered 0..2',
    groupMembers(afterMove, groupRow.id).map((k) => k.position).join(',') === '0,1,2',
    groupMembers(afterMove, groupRow.id).map((k) => k.position).join(','),
  )
  ok(
    '  and the bar renumbered behind it',
    topLevelKeys(afterMove).map((k) => k.position).join(',') === '0,1,2',
    topLevelKeys(afterMove).map((k) => k.position).join(','),
  )

  const backOut = await moveQuickKey(SITE, barKey.id, { parentId: null, index: 0 })
  ok('a key moves back out to the bar', backOut.ok, backOut.ok ? '' : backOut.error)
  const afterOut = await listQuickKeys(SITE)
  ok(
    '  at the front, pushing the others along',
    topLevelKeys(afterOut)[0]?.id === barKey.id,
    String(topLevelKeys(afterOut)[0]?.id),
  )
  ok(
    '  positions still 0..3 with no gaps',
    topLevelKeys(afterOut).map((k) => k.position).join(',') === '0,1,2,3',
    topLevelKeys(afterOut).map((k) => k.position).join(','),
  )

  /* ── 8. Renaming a group moves its signature ────────────────────────────
     A folder is identified by nothing but its caption. Left stale, two folders could
     share one signature and uq_slot would refuse an unrelated edit later, somewhere
     nobody would connect to a rename. */

  const renamed = await updateQuickKey(SITE, groupRow.id, { caption: 'Cold Drinks' })
  ok('a group renames', renamed.ok, renamed.ok ? '' : renamed.error)
  const renamedRow = await getQuickKey(SITE, groupRow.id)
  ok(
    '  and its signature follows the new name',
    renamedRow?.sig === quickKeySig({ kind: 'group' }, 'Cold Drinks'),
    renamedRow?.sig,
  )

  /* ── 9. THE ONE THAT MATTERS: delete PROMOTES ───────────────────────────
     The FK is ON DELETE CASCADE. If deleteQuickKey removed the group first, the members
     would go with it — and a shop would lose keys it had arranged by hand. */

  const before = groupMembers(await listQuickKeys(SITE), groupRow.id)
  ok('the group has members to lose', before.length === 2, String(before.length))

  const deleted = await deleteQuickKey(SITE, groupRow.id)
  ok('the group is deleted', deleted.ok, deleted.ok ? '' : deleted.error)

  const survivors = await listQuickKeys(SITE)
  ok(
    '*** its members SURVIVED, promoted to the bar ***',
    before.every((m) => survivors.some((s) => s.id === m.id && s.parentId === null)),
    `${survivors.filter((s) => before.some((m) => m.id === s.id)).length} of ${before.length} survived`,
  )
  ok(
    '  and the bar is renumbered 0..n with no gaps',
    topLevelKeys(survivors).map((k) => k.position).join(',') ===
      topLevelKeys(survivors).map((_, i) => i).join(','),
    topLevelKeys(survivors).map((k) => k.position).join(','),
  )
  ok('  the group itself is gone', !survivors.some((k) => k.id === groupRow.id))

  /* ── 10. The supervisor group ───────────────────────────────────────────── */

  const supId = await ensureSupervisorGroup(SITE)
  ok('a supervisor group is created', supId > 0, String(supId))
  const supAgain = await ensureSupervisorGroup(SITE)
  ok('  and calling it again is idempotent', supAgain === supId, `${supId} vs ${supAgain}`)

  const supDelete = await deleteQuickKey(SITE, supId)
  ok('  it cannot be deleted', !supDelete.ok, supDelete.ok ? '' : supDelete.error)

  /* ── Clean up ───────────────────────────────────────────────────────────── */
  await siteExecute(SITE, "DELETE FROM pos_quick_keys WHERE section = 'main'")
  const left = await siteQuery<any>(SITE, 'SELECT COUNT(*) AS n FROM pos_quick_keys')
  ok('the test leaves nothing behind', Number(left[0]?.n) === 0, String(left[0]?.n))

  console.log(fails === 0 ? '\nAll quick-key checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
