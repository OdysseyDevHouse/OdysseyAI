/**
 * The till's unlock path — the one place a PIN alone mints a browser session.
 *
 *   npx tsx --conditions=react-server --env-file=.env --env-file=.env.local \
 *     scripts/test-pos-unlock.ts
 *
 * The screen is public by necessity, so what bounds it is the SITE RESOLUTION: the
 * site comes from the machine's own terminal claim, never from anything typed. This
 * checks that boundary directly rather than through the UI, because the UI is the
 * part that cannot enforce it.
 *
 * Exercises the resolver and the capability rule. It deliberately does NOT call
 * `posUnlockAction` itself — that sets cookies through `next/headers`, which has no
 * meaning outside a request — so the pieces it composes are tested instead.
 */
import { activeSiteIds } from '../src/lib/sites'
import { siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { signInWithPin, listUsers } from '../src/lib/site/users'
import { capabilitiesForRole, can } from '../src/lib/site/permissions'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The resolver from actions.ts, exercised here rather than through a request. */
async function siteForDevice(deviceId: string): Promise<number | null> {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(deviceId)) return null
  for (const siteId of await activeSiteIds()) {
    const row = await siteQueryOne<{ id: number }>(
      siteId,
      'SELECT id FROM terminals WHERE device_id = ? AND is_active = 1 LIMIT 1',
      [deviceId],
    ).catch(() => null)
    if (row) return siteId
  }
  return null
}

async function main() {
  const sites = await activeSiteIds()
  console.log(`      (active sites: ${sites.join(', ')})`)

  /* ── The device id is validated before anything is queried ───────────────
     A shape check first means a malformed id costs no query at all — and, more to
     the point, no bcrypt comparison. Without it this endpoint could be used to
     fish for valid PINs across every shop on the platform. */

  {
    ok('an empty device id resolves to nothing', (await siteForDevice('')) === null)
    ok('a short device id is refused', (await siteForDevice('abc')) === null)
    ok(
      'a device id with SQL in it is refused by shape',
      (await siteForDevice("' OR 1=1 --")) === null,
    )
    ok(
      'an over-long device id is refused',
      (await siteForDevice('a'.repeat(65))) === null,
    )
  }

  /* ── A well-formed but unknown device belongs to no site ─────────────── */

  {
    const unknown = await siteForDevice('00000000-1111-2222-3333-444444444444')
    // This is what stops the screen being a way into an arbitrary shop: no claim,
    // no site, and the action returns before signInWithPin is reached.
    ok('an UNCLAIMED device resolves to no site', unknown === null)
  }

  /* ── A claimed device resolves to its own site, and only that one ────── */

  const claimed = await (async () => {
    for (const siteId of sites) {
      const row = await siteQueryOne<{ device_id: string }>(
        siteId,
        'SELECT device_id FROM terminals WHERE device_id IS NOT NULL AND is_active = 1 LIMIT 1',
      ).catch(() => null)
      if (row?.device_id) return { siteId, deviceId: String(row.device_id) }
    }
    return null
  })()

  if (!claimed) {
    console.log('SKIP  no claimed terminal on any active site')
  } else {
    const resolved = await siteForDevice(claimed.deviceId)
    ok(
      'a claimed device resolves to ITS site',
      resolved === claimed.siteId,
      `${resolved} vs ${claimed.siteId}`,
    )

    /* ── The capability rule ─────────────────────────────────────────────
       A PIN that cannot work a till must not be able to mint a session with it.
       That is the second bound on this endpoint after the terminal claim. */

    const users = await listUsers(claimed.siteId)
    let tillCapable = 0
    let notTillCapable = 0
    for (const u of users) {
      if (!u.isActive || !u.hasPin) continue
      const caps = await capabilitiesForRole(claimed.siteId, u.roleId)
      if (can(caps, 'sales.till')) tillCapable++
      else notTillCapable++
    }
    console.log(
      `      (${tillCapable} till-capable, ${notTillCapable} not, of ${users.length} users)`,
    )
    ok('at least one operator could unlock this till', tillCapable > 0)

    // A user with a PIN but no role cannot unlock — `capabilitiesForRole(null)` is
    // NO_CAPABILITIES, so `can()` refuses. This is the dev data's own shape: the
    // pos_only users here have role_id NULL.
    const roleless = users.filter((u) => u.isActive && u.hasPin && u.roleId === null)
    if (roleless.length > 0) {
      const caps = await capabilitiesForRole(claimed.siteId, null)
      ok(
        'an operator with a PIN but NO ROLE cannot unlock',
        !can(caps, 'sales.till'),
        `${roleless.length} such user(s)`,
      )
    }

    /* ── A wrong PIN is refused, and says nothing useful ───────────────── */

    const wrong = await signInWithPin(claimed.siteId, '0000')
    ok('a wrong PIN is refused', !wrong.ok)
    /* The refusal must not confirm that a PIN belongs to somebody, or that one
       length is closer than another — both narrow a guess. Asserted against the
       actual user names on the site rather than by pattern: an earlier version used
       /[A-Z][a-z]+ [A-Z]/ and failed on "That PIN was not recognised.", which names
       nobody. Testing the real thing beats testing a proxy for it. */
    const names = users.map((u) => u.name).filter(Boolean)
    ok(
      'and the message names no operator',
      !wrong.ok && !names.some((n) => wrong.error.includes(n)),
      wrong.ok ? '' : wrong.error,
    )
  }

  /* ── Terminals are per-site, so a device cannot span two ─────────────── */

  {
    const perSite = new Map<string, number[]>()
    for (const siteId of sites) {
      const rows = await siteQuery<{ device_id: string }>(
        siteId,
        'SELECT device_id FROM terminals WHERE device_id IS NOT NULL',
      ).catch(() => [])
      for (const r of rows) {
        const key = String(r.device_id)
        perSite.set(key, [...(perSite.get(key) ?? []), siteId])
      }
    }
    const shared = [...perSite.entries()].filter(([, ids]) => ids.length > 1)
    // If one machine were claimed at two sites, the resolver's first-match wins and
    // an operator could unlock into whichever site happens to be listed first. Worth
    // knowing about rather than assuming away.
    ok(
      'no device is claimed at more than one site',
      shared.length === 0,
      shared.map(([d, ids]) => `${d.slice(0, 8)}…@${ids.join('+')}`).join(', '),
    )
  }

  console.log(fails === 0 ? '\nAll unlock checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
