/**
 * Does list_filters actually exist, with the columns the code reads?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-list-filters.ts
 *
 * A migration runner records a file by NAME, so "241 applied" only proves the
 * runner ran it — not that the table is there with the right shape. This asks
 * information_schema, and then exercises the real read/write path so a column
 * name that does not match the SQL in listFilterMemory.ts fails here rather
 * than on someone's products screen.
 */
import { siteQuery } from '../src/lib/siteDb'
import {
  rememberFilters,
  rememberedFilters,
  forgetFilters,
} from '../src/lib/site/listFilterMemory'

const SITE = Number(process.argv[2] ?? 33)
const TEST_USER = 999999 // No such user; this is disposable UI state, not a FK.

async function main() {
  const cols = await siteQuery<any>(
    SITE,
    `SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'list_filters'
      ORDER BY ORDINAL_POSITION`,
  ).catch((e) => {
    console.error('table probe failed:', e.message)
    return []
  })

  console.log(`site ${SITE}: list_filters has ${cols.length} column(s)`)
  for (const c of cols) console.log(`  ${c.COLUMN_NAME} : ${c.DATA_TYPE}`)

  if (!cols.length) {
    console.error('FAIL: table missing')
    process.exit(1)
  }

  // The real round trip, through the functions the screens call.
  const encoded = 'visibleInPos:eq:Yes~productType:eq:normal'

  await rememberFilters(SITE, 'products', TEST_USER, encoded)
  const back = await rememberedFilters(SITE, 'products', TEST_USER)
  console.log('wrote  :', encoded)
  console.log('read   :', back)
  console.log('match  :', back === encoded)

  await forgetFilters(SITE, 'products', TEST_USER)
  const gone = await rememberedFilters(SITE, 'products', TEST_USER)
  console.log('after forget:', gone === null ? 'null (correct)' : `STILL THERE: ${gone}`)

  const ok = back === encoded && gone === null
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
}

main()
