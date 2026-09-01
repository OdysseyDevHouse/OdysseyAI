/**
 * How many CONTROL-database queries one guarded request costs.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The desktop app runs its Next server in-process on a shop's counter, so every
 * control query crosses the internet — to a database that is IP-whitelisted to
 * the office. The lease and the site mirror were made the primary paths to stop
 * that happening per click; this counts whether it worked, rather than trusting
 * a reading of the code.
 *
 * ── HOW IT COUNTS ───────────────────────────────────────────────────────────
 *
 * By wrapping the pool's execute(), not by parsing a log. lib/db.ts hands every
 * caller the SAME pooled object, so one wrapper sees every control query any
 * code path makes — including ones this script never thought to look for, which
 * is the whole point of measuring instead of predicting.
 *
 * Run:
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-control-calls.ts
 */
import { pool } from '../src/lib/db'

type Seen = { sql: string; table: string }

const seen: Seen[] = []

/** The cp2_ table a statement touches, for a readable tally. */
function tableOf(sql: string): string {
  const m = sql.match(/\b(?:FROM|INTO|UPDATE|JOIN)\s+`?(cp2_[a-z_]+)`?/i)
  if (m) return m[1]
  if (/^\s*SELECT\s+1\b/i.test(sql)) return '(ping)'
  return '(other)'
}

function instrument() {
  const p = pool() as unknown as {
    execute: (...args: unknown[]) => unknown
    query: (...args: unknown[]) => unknown
  }
  for (const method of ['execute', 'query'] as const) {
    const original = p[method].bind(p)
    p[method] = (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : String((args[0] as { sql?: string })?.sql ?? '')
      seen.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 90), table: tableOf(sql) })
      return original(...args)
    }
  }
}

function report(label: string) {
  const byTable = new Map<string, number>()
  for (const s of seen) byTable.set(s.table, (byTable.get(s.table) ?? 0) + 1)

  console.log(`\n  ${label}: ${seen.length} control quer${seen.length === 1 ? 'y' : 'ies'}`)
  for (const [table, n] of [...byTable].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${table}`)
  }
  if (seen.length === 0) console.log('    (none — answered entirely from the local database)')
  seen.length = 0
}

async function main() {
  const siteId = Number(process.env.PROBE_SITE_ID || 33)

  console.log('\nControl-database calls per guarded request')
  console.log(`  APP_MODE=${process.env.APP_MODE ?? '(unset)'}  site=${siteId}`)

  instrument()

  /* The two reads requireSite()/requireSiteUser() make on every page. Called
     directly rather than through a browser so the count is the guard chain's
     alone, with no page query mixed in. */
  const { getSite } = await import('../src/lib/sites')
  const { entitlementsForSite } = await import('../src/lib/control/modules')

  await getSite(siteId).catch(() => null)
  report('getSite')

  await entitlementsForSite(siteId).catch(() => null)
  report('entitlementsForSite')

  /* Again, to show what a SECOND click costs. entitlementsForSite is memoised
     with React cache(), which is request-scoped — outside a request each call
     is a fresh one, which is exactly what a second page load is. */
  await getSite(siteId).catch(() => null)
  await entitlementsForSite(siteId).catch(() => null)
  report('a second page load')

  /* ── THE SESSION CHECK ────────────────────────────────────────────────────
   *
   * requireSession() runs this on every guarded request, ahead of both reads
   * above. It cannot be called here — it wants a real cookie — so this asks the
   * same question its `session.sid && …` guard asks.
   *
   * A desktop sign-in mints NO sid, so the guard short-circuits and the query
   * never happens. Proving that costs one call with a sid to show the query is
   * real, and the count above (0) to show it is not being made. */
  const { sessionIsCurrent } = await import('../src/lib/control/sessions')
  await sessionIsCurrent(1, 'probe-not-a-real-sid').catch(() => false)
  report('sessionIsCurrent, IF a session carried a sid')
  console.log(
    '    ↑ desktop sign-ins mint no sid, so requireSession never reaches this.\n' +
      '      See auth.ts: `enrols`, and the sid-less token in trySignInOffline.',
  )

  process.exit(0)
}

void main()
