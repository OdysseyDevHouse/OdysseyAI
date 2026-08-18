/*
 * What each till now runs.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-terminal-modes.ts
 *
 * Reads the COLUMN through information_schema before selecting it, because a
 * migration reporting "ok" and a column existing are different claims — and a
 * site whose schema drifted would otherwise fail here with a confusing SQL
 * error rather than a plain statement of what is missing.
 */
import { activeSiteIds } from '../src/lib/sites'
import { siteQuery } from '../src/lib/siteDb'

async function main() {
  for (const siteId of await activeSiteIds()) {
    const cols = await siteQuery<{ COLUMN_NAME: string; COLUMN_TYPE: string; COLUMN_DEFAULT: string | null }>(
      siteId,
      `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'terminals' AND COLUMN_NAME = 'pos_mode'`,
    )
    console.log(`\n── site ${siteId} ─────────────────────────────────────────`)
    if (!cols.length) {
      console.log('  pos_mode column: MISSING — migration 180 has not run here')
      continue
    }
    console.log(`  pos_mode column: ${cols[0].COLUMN_TYPE} default ${cols[0].COLUMN_DEFAULT}`)

    const rows = await siteQuery<{ code: string; pos_mode: string }>(
      siteId,
      'SELECT code, pos_mode FROM terminals ORDER BY code',
    )
    for (const r of rows) console.log(`    ${r.code.padEnd(10)} ${r.pos_mode}`)

    const stale = await siteQuery<{ n: number }>(
      siteId,
      "SELECT COUNT(*) AS n FROM settings WHERE setting_key = 'pos_mode'",
    )
    console.log(`  retired site setting rows left: ${stale[0]?.n ?? 0}`)
  }
}

main().then(() => process.exit(0))
