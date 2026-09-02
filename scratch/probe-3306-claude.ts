/* Which control-pool statements fire on a desktop install, per module.
   Instruments mysql2 and calls the real functions directly. */
process.env.APP_MODE = 'desktop'
process.env.ODYSSEY_ROLE = 'backoffice'

import mysql from 'mysql2/promise'

let current = 'startup'
const hits: { who: string; where: string; sql: string }[] = []
const realCreatePool = mysql.createPool.bind(mysql)
;(mysql as any).createPool = (cfg: any) => {
  const pool = realCreatePool(cfg)
  const wrap = (fn: any) => async (...args: any[]) => {
    const sql = String(args[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)
    hits.push({ who: current, where: `${cfg.host}:${cfg.port}`, sql })
    return fn(...args)
  }
  ;(pool as any).query = wrap(pool.query.bind(pool))
  ;(pool as any).execute = wrap(pool.execute.bind(pool))
  return pool
}

async function step(name: string, fn: () => Promise<unknown>) {
  current = name
  try { await fn() } catch (e) { /* failure is fine; we want the traffic */ }
}

async function main() {
  const sites = await import('@/lib/sites')
  const twoFactor = await import('@/lib/twoFactor')
  const sessions = await import('@/lib/control/sessions')
  const signinLog = await import('@/lib/signinLog')
  const modules = await import('@/lib/control/modules')
  const siteDb = await import('@/lib/siteDb')

  await step('sites.listSitesForUser', () => sites.listSitesForUser(1))
  await step('sites.getSiteForUser', () => sites.getSiteForUser(1, 4))
  await step('sites.getSite', () => sites.getSite(4))
  await step('twoFactor.totpStatus', () => twoFactor.totpStatus(1))
  await step('sessions.claimSession', () => sessions.claimSession(1, 'probe', 'probe'))
  await step('signinLog.recordSignIn', () => signinLog.recordSignIn({ userId: 1, email: 'p@x', event: 'failed' } as never))
  await step('modules.siteModules', () => (modules as never as Record<string, (n: number) => Promise<unknown>>).siteModules(4))
  await step('siteDb.sitePool(master)', () => (siteDb as never as Record<string, (n: number) => Promise<unknown>>).sitePool(4))

  console.log('\n=== CONTROL-POOL TRAFFIC (desktop mode) ===')
  if (!hits.length) console.log('(none)')
  for (const h of hits) console.log(`[${h.who}]\n   ${h.where} | ${h.sql}`)
  console.log(`\nTOTAL STATEMENTS: ${hits.length}`)
  process.exit(0)
}
main()
