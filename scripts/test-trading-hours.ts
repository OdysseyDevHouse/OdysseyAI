/**
 * Trading hours, collection slots and the three open states.
 *
 * Pure — no database, no site, nothing to clean up. Which is the point: every
 * case below is one a real takeaway hits on an ordinary Friday, and none of them
 * is comfortable to reproduce by hand at the right time of day.
 *
 * The ones that matter most are the boundaries: the last slot before closing
 * (a kitchen that shuts at 21:00 and needs 20 minutes cannot promise 20:55),
 * the split shift, and the difference between "no hours set" and "hours set to
 * nothing".
 *
 *   npm run test:trading-hours
 */
import {
  collectionSlots,
  dayLabel,
  isOfferedSlot,
  isoDate,
  nextOpening,
  openState,
  rangesOn,
  slotLabel,
  type TradingRules,
} from '../src/lib/tradingHours'
import { parseOpeningHours } from '../src/lib/reservationTypes'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A Tuesday, so weekday indexing is unambiguous (0 = Sunday). */
const at = (day: number, hh: number, mm = 0) => new Date(2026, 7, day, hh, mm, 0, 0)

const base: TradingRules = {
  hours: null,
  exceptions: [],
  acceptingOrders: true,
  acceptingNote: '',
  leadTimeMinutes: 20,
  horizonDays: 2,
}

// 2026-08-18 is a Tuesday.
const TUE = 18
const WED = 19

const weekday = parseOpeningHours(
  JSON.stringify({
    '2': [['08:00', '14:00'], ['17:00', '21:00']], // Tuesday, split shift
    '3': [['08:00', '21:00']], // Wednesday
  }),
)

function main() {
  console.log('\n— A shop that has never set hours —')
  // Every existing shop. Must stay always-open or this migration changes them.
  ok('is open at 3am', openState(base, at(TUE, 3)).state === 'open')
  ok('and at 11pm', openState(base, at(TUE, 23)).state === 'open')
  const always = openState(base, at(TUE, 12))
  ok('and promises no closing time', always.state === 'open' && always.closesAt === null)

  console.log('\n— Hours that were set, then broken —')
  // A populated column that parses to nothing is a broken value, not "always
  // open". parseOpeningHours already reads junk as {}; closed is the safe read.
  const broken: TradingRules = { ...base, hours: parseOpeningHours('not json at all') }
  ok('reads as closed, not as open', openState(broken, at(TUE, 12)).state === 'closed')
  ok('which is different from never setting any', openState(base, at(TUE, 12)).state === 'open')

  console.log('\n— A split shift —')
  const shop: TradingRules = { ...base, hours: weekday }
  ok('open at lunch', openState(shop, at(TUE, 12)).state === 'open')
  ok('closed between services', openState(shop, at(TUE, 15, 30)).state === 'closed')
  ok('open again for dinner', openState(shop, at(TUE, 18)).state === 'open')
  ok('closed after service', openState(shop, at(TUE, 22)).state === 'closed')
  ok('both windows are found', rangesOn(shop, at(TUE, 12)).length === 2)
  ok('and they are in order', rangesOn(shop, at(TUE, 12))[0][0] < rangesOn(shop, at(TUE, 12))[1][0])

  console.log('\n— What time does it close —')
  const atLunch = openState(shop, at(TUE, 12))
  const atDinner = openState(shop, at(TUE, 19))
  ok('the lunch window', atLunch.state === 'open' && atLunch.closesAt === '14:00',
    atLunch.state === 'open' ? String(atLunch.closesAt) : atLunch.state)
  ok('and the dinner one', atDinner.state === 'open' && atDinner.closesAt === '21:00')

  console.log('\n— When does it open again —')
  const afterLunch = nextOpening(shop, at(TUE, 15, 30))
  ok('the next service today', afterLunch?.getHours() === 17, String(afterLunch))
  const afterClose = nextOpening(shop, at(TUE, 22))
  ok('tomorrow morning', afterClose?.getDate() === WED && afterClose?.getHours() === 8, String(afterClose))

  console.log('\n— Not accepting orders —')
  const paused: TradingRules = { ...shop, acceptingOrders: false, acceptingNote: 'Kitchen busy' }
  // A hard stop regardless of the clock: it is 12:00 and the shop IS open.
  ok('beats the clock', openState(paused, at(TUE, 12)).state === 'paused')
  ok('and carries the reason', openState(paused, at(TUE, 12)).note === 'Kitchen busy')
  // `>= 0` would have been vacuously true — the whole point is that a stopped
  // queue stops offering times, so assert the count is actually zero.
  ok('and offers no times at all', collectionSlots(paused, at(TUE, 12)).length === 0,
    String(collectionSlots(paused, at(TUE, 12)).length))

  console.log('\n— Collection slots —')
  const slots = collectionSlots(shop, at(TUE, 12))
  ok('there are some', slots.length > 0, String(slots.length))
  // Lead time is 20 minutes from 12:00, rounded up to the next quarter hour.
  ok('the first is after the lead time', slots[0] >= at(TUE, 12, 20), String(slots[0]))
  ok('and lands on a quarter hour', slots[0].getMinutes() % 15 === 0, String(slots[0].getMinutes()))
  ok('every slot is in the future', slots.every((s) => s > at(TUE, 12)))

  console.log('\n— The boundary people forget —')
  // A kitchen needing 20 minutes cannot promise 13:55 when it shuts at 14:00.
  const lunchSlots = slots.filter((s) => s.getDate() === TUE && s.getHours() < 15)
  const latestLunch = lunchSlots[lunchSlots.length - 1]
  ok(
    'no slot inside the lead time before closing',
    latestLunch <= at(TUE, 13, 40),
    String(latestLunch),
  )
  ok('nothing is offered during the gap', !slots.some((s) => s.getDate() === TUE && s.getHours() === 15))

  console.log('\n— Ordering for later when closed —')
  const late = collectionSlots(shop, at(TUE, 23))
  ok('a shop shut for the night still offers slots', late.length > 0, String(late.length))
  ok('and the first is the next morning', late[0]?.getDate() === WED, String(late[0]))
  // This is the 22:30 pizza craving. Refusing it would turn away real trade.
  ok('the first slot respects opening time', late[0]?.getHours() === 8)

  console.log('\n— The horizon —')
  const far = collectionSlots({ ...shop, horizonDays: 0 }, at(TUE, 12))
  ok('a zero horizon offers only today', far.every((s) => s.getDate() === TUE))
  const wide = collectionSlots({ ...shop, horizonDays: 2 }, at(TUE, 12))
  ok('a wider one reaches further', wide.length > far.length, `${wide.length} vs ${far.length}`)

  console.log('\n— A day that does not repeat —')
  const holiday: TradingRules = {
    ...shop,
    exceptions: [
      { onDate: isoDate(at(WED, 0)), isClosed: true, openTime: null, closeTime: null, note: 'Public holiday' },
    ],
  }
  ok('the shop is closed on it', openState(holiday, at(WED, 12)).state === 'closed')
  ok('and says why', openState(holiday, at(WED, 12)).note === 'Public holiday')
  ok('no slots that day', !collectionSlots(holiday, at(TUE, 12)).some((s) => s.getDate() === WED))
  ok('the ordinary week is untouched', openState(holiday, at(TUE, 12)).state === 'open')

  console.log('\n— A short day —')
  const short: TradingRules = {
    ...shop,
    exceptions: [
      { onDate: isoDate(at(WED, 0)), isClosed: false, openTime: '09:00', closeTime: '12:00', note: 'Christmas Eve' },
    ],
  }
  // The exception REPLACES the weekly pattern; it does not add to it.
  ok('open inside the short window', openState(short, at(WED, 10)).state === 'open')
  ok('closed when the usual week would be open', openState(short, at(WED, 15)).state === 'closed')
  ok('exactly one window that day', rangesOn(short, at(WED, 10)).length === 1)

  console.log('\n— A short day with no times —')
  const nonsense: TradingRules = {
    ...shop,
    exceptions: [{ onDate: isoDate(at(WED, 0)), isClosed: false, openTime: null, closeTime: null, note: '' }],
  }
  // Meaningless, and "closed" is the safer of the two readings.
  ok('reads as closed rather than always open', openState(nonsense, at(WED, 12)).state === 'closed')

  console.log('\n— A slot the browser sent back —')
  const offered = slots[0]
  ok('one we offered is accepted', isOfferedSlot(shop, offered, at(TUE, 12)))
  // The stale-tab case: a time inside the closed gap must be refused.
  ok('one in the gap is refused', !isOfferedSlot(shop, at(TUE, 15, 30), at(TUE, 12)))
  ok('one in the past is refused', !isOfferedSlot(shop, at(TUE, 9), at(TUE, 12)))
  ok('and a paused shop offers none', !isOfferedSlot(paused, offered, at(TUE, 12)))

  console.log('\n— Saying it out loud —')
  ok('today reads as today', dayLabel(at(TUE, 19), at(TUE, 12)) === 'today')
  ok('tomorrow reads as tomorrow', dayLabel(at(WED, 9), at(TUE, 12)) === 'tomorrow')
  ok('further out names the day', dayLabel(at(TUE + 3, 9), at(TUE, 12)).length > 3)
  ok('a slot reads as a promise', slotLabel(at(TUE, 19, 45), at(TUE, 12)) === 'today at 19:45',
    slotLabel(at(TUE, 19, 45), at(TUE, 12)))

  console.log(fails === 0 ? '\nAll trading hour checks passed.' : `\n${fails} FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
