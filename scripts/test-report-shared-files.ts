/**
 * test-report-shared-files.ts — the four shared-file tokens, and the source
 * whose money depends on getting them right.
 *
 * ── WHY THIS CANNOT BE PROVEN ON A SINGLE-SHOP SITE ─────────────────────────
 *
 * Every prefix resolver returns '' for a store that owns its own files, so on a
 * dev site the {C}/{S}/{L}/{G} tokens all substitute to nothing and a report
 * that reads the WRONG SHOP'S database is indistinguishable from a correct one.
 * Running the query proves nothing about the routing.
 *
 * So this checks the two things that CAN be checked without a store group:
 *
 *   1. Every token a catalog join uses is one run.ts actually substitutes. A
 *      typo'd or unhandled token reaches MariaDB as literal '{X}' and is a
 *      syntax error at the worst moment — the first time a real group runs it.
 *
 *   2. Each token substitutes to the prefix its OWN resolver returns. The
 *      hazard this guards is gift cards: they follow `shares_gift_cards`, which
 *      giftCardOwnerSite answers separately from loyaltyOwnerSite, because a
 *      card is cash the shopper handed over while points never were. A group of
 *      separate companies may share its programme and NOT its stored value —
 *      pointing {G} at the loyalty prefix would report another company's money
 *      as this one's, and would look perfectly fine here.
 */
import { SOURCES } from '../src/lib/reportBuilder/catalog'
import { customerDbPrefix, supplierDbPrefix } from '../src/lib/site/customerDb'
import { loyaltyDbPrefix } from '../src/lib/site/loyaltyDb'
import { giftCardDbPrefix } from '../src/lib/site/giftCardDb'

const SITE = Number(process.env.PROBE_SITE ?? 1)

/** The tokens run.ts knows how to replace. Anything else is a bug. */
const HANDLED = new Set(['{C}', '{S}', '{L}', '{G}', '{B}'])

let failed = false
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = true
}

async function main() {
  /* 1. No catalog entry uses a token the engine cannot replace. */
  const seen = new Map<string, string[]>()
  for (const s of SOURCES) {
    for (const j of s.joins ?? []) {
      for (const m of j.sql.matchAll(/\{[A-Z]\}/g)) {
        if (!seen.has(m[0])) seen.set(m[0], [])
        seen.get(m[0])!.push(`${s.key}.${j.name}`)
      }
    }
  }
  for (const [token, users] of seen) {
    check(
      `token ${token} is handled by run.ts`,
      HANDLED.has(token),
      `used by ${users.length} join(s), e.g. ${users[0]}`,
    )
  }
  console.log(`      tokens in use: ${[...seen.keys()].sort().join(' ') || '(none)'}`)

  /* 2. Each ownership resolves through its OWN resolver. */
  const [cust, supp, loy, gift] = await Promise.all([
    customerDbPrefix(SITE),
    supplierDbPrefix(SITE),
    loyaltyDbPrefix(SITE),
    giftCardDbPrefix(SITE),
  ])
  console.log(
    `      prefixes on site ${SITE}: C=${JSON.stringify(cust)} S=${JSON.stringify(supp)} ` +
      `L=${JSON.stringify(loy)} G=${JSON.stringify(gift)}`,
  )
  const allEmpty = !cust && !supp && !loy && !gift
  if (allEmpty) {
    console.log(
      '      note: this site owns every file, so all four are "". The routing itself\n' +
        '      is only observable on a store group — what is checked below is that the\n' +
        '      catalog asks the RIGHT resolver, which is where the bug would be.',
    )
  }

  /* 3. Every ownedBy value the catalog uses is one run.ts branches on. Adding a
        fifth shared file and forgetting the engine would otherwise silently
        read the caller's own database. */
  const OWNERS = new Set(['customer', 'supplier', 'loyalty', 'giftcard'])
  for (const s of SOURCES) {
    if (!s.ownedBy) continue
    check(`${s.key} ownedBy '${s.ownedBy}' is a known owner`, OWNERS.has(s.ownedBy))
  }

  /* 4. The gift card sources are on 'giftcard', not 'loyalty'. This is the
        specific mistake that reads another company's money. */
  for (const key of ['giftCards', 'giftCardEvents']) {
    const s = SOURCES.find((x) => x.key === key)
    check(
      `${key} is ownedBy 'giftcard', not 'loyalty'`,
      s?.ownedBy === 'giftcard',
      `got ${JSON.stringify(s?.ownedBy)}`,
    )
  }
  /* And the mirror: loyalty sources must NOT have drifted onto the card file. */
  for (const key of ['loyaltyLedger', 'loyaltyMembers', 'loyaltyVouchers']) {
    const s = SOURCES.find((x) => x.key === key)
    check(`${key} is ownedBy 'loyalty'`, s?.ownedBy === 'loyalty', `got ${JSON.stringify(s?.ownedBy)}`)
  }

  if (failed) process.exit(1)
  console.log('\nAll shared-file checks passed.')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
