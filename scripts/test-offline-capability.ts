/**
 * What the offline till may do, and what it must refuse to offer — pure.
 *
 *   npx tsx scripts/test-offline-capability.ts
 *
 * None of this is a security boundary; the server re-derives an operator's
 * capabilities at sync and re-checks pricing when the sale posts. What is checked
 * here is that the SCREEN offers the right things, because the two ways to get it
 * wrong are both bad: offering account credit offline puts a shop's money at risk,
 * and refusing an owner their own permissions strands the person who can fix it.
 */
import { operatorCan, offlineBlockedTender, offlineBlockedProduct } from '../src/lib/offlineCapability'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function main() {
  /* ── The owner sentinel ───────────────────────────────────────────────
     An owner's CapabilitySet is `{ isOwner: true, granted: <EMPTY> }` — `can()`
     short-circuits on the flag and never reads the set. Flattening `granted`
     alone would therefore strip an owner of everything the moment they went
     offline, which is the single worst way to get this wrong: the person who
     could fix it is the person locked out. */

  {
    const owner = ['*']
    ok('an owner may use the till', operatorCan(owner, 'sales.till'))
    ok('an owner may void', operatorCan(owner, 'sales.void'))
    ok('an owner may do anything at all', operatorCan(owner, 'anything.at.all'))
  }

  /* ── An ordinary role gets exactly what it was granted ───────────────── */

  {
    const cashier = ['sales.till', 'products.view']
    ok('a cashier may use the till', operatorCan(cashier, 'sales.till'))
    ok('a cashier may NOT void', !operatorCan(cashier, 'sales.void'))
    ok('a cashier may NOT override a price', !operatorCan(cashier, 'sales.price_override'))
    ok('an ungranted capability is refused', !operatorCan(cashier, 'nonsense'))
  }

  {
    // Nobody, which is what an operator with no role resolves to. Must refuse
    // rather than default open.
    ok('an empty capability list grants nothing', !operatorCan([], 'sales.till'))
  }

  /* ── Tenders that cannot work offline ─────────────────────────────────
     The rule is "depends on a balance only the server knows". Not "hard to
     compute" — the arithmetic is easy; what is missing offline is the rollback
     that protects it. */

  {
    const cash = { postsToDebtor: false, integrationKey: null }
    const card = { postsToDebtor: false, integrationKey: 'yoco' }
    ok('cash works offline', offlineBlockedTender(cash) === null)
    ok('a card works offline', offlineBlockedTender(card) === null)
  }

  {
    // A credit check against an hours-stale balance is how a shop extends credit
    // to somebody who has already exhausted it.
    const account = { postsToDebtor: true, integrationKey: null }
    const blocked = offlineBlockedTender(account)
    ok('an ACCOUNT tender is refused offline', blocked !== null, String(blocked))
    // The reason is a sentence, not a boolean, so the key can SAY it — a tender
    // that silently vanishes leaves the cashier wondering whether the store even
    // has the facility.
    ok('and it says why', /network/i.test(blocked ?? ''), String(blocked))
  }

  {
    // redeemPointsForSale THROWS rather than refusing, precisely so an
    // unaffordable redemption rolls the whole sale back. Offline there is nothing
    // to roll back into.
    const points = { postsToDebtor: false, integrationKey: 'loyalty' }
    ok('a LOYALTY tender is refused offline', offlineBlockedTender(points) !== null)
  }

  /* ── Products that cannot be sold offline ─────────────────────────────── */

  {
    for (const type of ['normal', 'returnable', 'service', 'buyout', 'calcqty']) {
      ok(`a ${type} product sells offline`, offlineBlockedProduct({ productType: type }) === null)
    }
  }

  {
    // markSold has to write in the same transaction as the movement, and another
    // till can sell the same serial in the meantime.
    ok(
      'a SERIAL-tracked product is refused offline',
      offlineBlockedProduct({ productType: 'serial' }) !== null,
    )
  }

  {
    // resolveComponents walks the composition tree with a recursive query and can
    // legitimately refuse. Guessing the components would post the wrong stock
    // movements for goods that have already left the shop.
    ok(
      'a RECIPE product is refused offline',
      offlineBlockedProduct({ productType: 'recipe' }) !== null,
    )
    ok(
      'a REFER product is refused offline',
      offlineBlockedProduct({ productType: 'refer' }) !== null,
    )
  }

  console.log(fails === 0 ? '\nAll offline-capability checks passed.' : `\n${fails} check(s) failed.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
