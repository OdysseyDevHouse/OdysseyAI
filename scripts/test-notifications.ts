/**
 * The notification centre — audience honesty and per-user read state.
 *
 * The property that matters most: a row is visible ONLY to people whose own
 * capabilities admit its audience, and one reader marking it read never
 * clears it for another.
 *
 *   npm run test:notifications
 */
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import {
  notify,
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '../src/lib/site/notifications'
import { NO_CAPABILITIES, type CapabilitySet } from '../src/lib/site/permissions'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const TAG = 'zn_probe'
const capsWith = (...granted: string[]): CapabilitySet => ({ isOwner: false, granted: new Set(granted) })
const OWNER: CapabilitySet = { isOwner: true, granted: new Set() }

async function cleanup(userIds: number[]) {
  await siteExecute(SITE, `DELETE FROM notifications WHERE title LIKE '${TAG}%'`)
  if (userIds.length) {
    await siteExecute(
      SITE,
      `DELETE FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
      userIds,
    )
  }
}

async function main() {
  await siteExecute(SITE, `DELETE FROM notifications WHERE title LIKE '${TAG}%'`)
  await siteExecute(SITE, `DELETE FROM users WHERE name LIKE '${TAG}%'`)

  // Two throwaway readers. Capabilities are passed straight into the lib, so
  // no roles are needed — the lib trusts the CapabilitySet it is handed, which
  // is exactly what requireSiteUser resolves in production.
  await siteExecute(SITE, `INSERT INTO users (name, user_type) VALUES ('${TAG} A', 'back_office')`)
  await siteExecute(SITE, `INSERT INTO users (name, user_type) VALUES ('${TAG} B', 'back_office')`)
  const ids = await siteQuery<any>(SITE, `SELECT id FROM users WHERE name LIKE '${TAG}%' ORDER BY id`)
  const [userA, userB] = ids.map((r: any) => Number(r.id))

  try {
    /* ── 1. Write and read back ────────────────────────────────────────── */

    await notify(SITE, {
      event: 'grv_received',
      audience: 'purchasing.view',
      title: `${TAG} purchasing row`,
      body: 'goods received',
      href: '/purchasing/1',
    })
    await notify(SITE, {
      event: 'online_order_placed',
      audience: null,
      title: `${TAG} broadcast row`,
    })
    await notify(SITE, {
      event: 'sale_voided',
      audience: null,
      userId: userA,
      title: `${TAG} direct-to-A row`,
    })

    const forPurchasing = await listNotifications(SITE, userA, capsWith('purchasing.view'))
    const mine = forPurchasing.filter((n) => n.title.startsWith(TAG))
    ok('*** a granted reader sees audience + broadcast + own rows, newest first ***',
      mine.length === 3 && mine[0].title === `${TAG} direct-to-A row`,
      mine.map((n) => n.title.slice(TAG.length + 1)).join(' | '))
    ok('  all unread on arrival', mine.every((n) => n.readAt === null))

    /* ── 2. Audience honesty ───────────────────────────────────────────── */

    const forNothing = await listNotifications(SITE, userB, NO_CAPABILITIES)
    const bMine = forNothing.filter((n) => n.title.startsWith(TAG))
    ok('*** an ungranted reader sees only the broadcast ***',
      bMine.length === 1 && bMine[0].title === `${TAG} broadcast row`,
      bMine.map((n) => n.title).join(' | '))

    const forOwner = await listNotifications(SITE, userB, OWNER)
    ok('  an owner sees every audience (but not another person\'s direct row)',
      forOwner.filter((n) => n.title.startsWith(TAG)).length === 2)

    ok('*** a direct row is invisible to B even with the capability ***',
      !(await listNotifications(SITE, userB, capsWith('purchasing.view')))
        .some((n) => n.title === `${TAG} direct-to-A row`))

    /* ── 3. Read state is per user ─────────────────────────────────────── */

    const beforeA = await unreadCount(SITE, userA, capsWith('purchasing.view'))
    const beforeB = await unreadCount(SITE, userB, capsWith('purchasing.view'))
    const target = mine.find((n) => n.title === `${TAG} purchasing row`)!
    await markRead(SITE, userA, target.id)
    ok('*** markRead drops A\'s count by one ***',
      (await unreadCount(SITE, userA, capsWith('purchasing.view'))) === beforeA - 1)
    ok('  and leaves B\'s untouched',
      (await unreadCount(SITE, userB, capsWith('purchasing.view'))) === beforeB)

    await markAllRead(SITE, userA, capsWith('purchasing.view'))
    ok('*** markAllRead zeroes A\'s count ***',
      (await unreadCount(SITE, userA, capsWith('purchasing.view'))) === 0)
    await markAllRead(SITE, userA, capsWith('purchasing.view'))
    ok('  and is idempotent',
      (await unreadCount(SITE, userA, capsWith('purchasing.view'))) === 0)

    // A row outside B's audience stays unread for the day a role grants it.
    // Asserted on the PROBE row, not the raw count — real producers write to
    // this table too, and their rows are unread for a fresh fixture user.
    await markAllRead(SITE, userB, NO_CAPABILITIES)
    const bAfterSweep = await listNotifications(SITE, userB, capsWith('purchasing.view'), { limit: 100 })
    ok('*** mark-all only touches VISIBLE rows ***',
      bAfterSweep.some((n) => n.title === `${TAG} purchasing row` && n.readAt === null),
      'the purchasing row is still unread for B')

    /* ── 4. Fail-soft ──────────────────────────────────────────────────── */

    let threw = false
    try {
      await notify(SITE, {
        event: 'low_stock',
        audience: null,
        userId: 999_999_999, // FK violation
        title: `${TAG} doomed row`,
      })
    } catch {
      threw = true
    }
    ok('*** notify swallows an FK violation instead of throwing ***', !threw)
    ok('  and wrote nothing',
      !(await listNotifications(SITE, userA, OWNER)).some((n) => n.title === `${TAG} doomed row`))

    /* ── 5. Retention ──────────────────────────────────────────────────── */

    await notify(SITE, { event: 'low_stock', audience: null, title: `${TAG} ancient row` })
    await siteExecute(
      SITE,
      `UPDATE notifications SET created_at = DATE_SUB(NOW(), INTERVAL 91 DAY) WHERE title = ?`,
      [`${TAG} ancient row`],
    )
    await notify(SITE, { event: 'low_stock', audience: null, title: `${TAG} fresh row` })
    const ancient = await siteQuery<any>(
      SITE,
      'SELECT id FROM notifications WHERE title = ?',
      [`${TAG} ancient row`],
    )
    ok('*** a 91-day-old row is pruned by the next write ***', ancient.length === 0)

    /* ── 6. Truncation ─────────────────────────────────────────────────── */

    await notify(SITE, {
      event: 'low_stock',
      audience: null,
      title: `${TAG} ${'x'.repeat(300)}`,
      body: 'y'.repeat(600),
      href: `/long/${'z'.repeat(300)}`,
    })
    const long = (await listNotifications(SITE, userA, OWNER, { limit: 50 }))
      .find((n) => n.title.startsWith(`${TAG} xxx`))
    ok('*** over-length fields are truncated, not refused ***',
      long !== undefined && long.title.length === 160 &&
      (long.body?.length ?? 0) === 400 && (long.href?.length ?? 0) === 190)
  } finally {
    await cleanup([userA, userB])
  }

  console.log(fails === 0 ? '\nAll notification checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
