/**
 * The unlock code is a contract between the control panel and every machine in
 * the field. A machine that stops accepting codes is offline and locked by
 * definition, so there is no way to push it a fix — these properties have to
 * hold before the scheme ships, not after.
 *
 *   npx tsx scripts/test-unlock-code.ts
 */
import { randomBytes } from 'node:crypto'
import {
  challengeFor,
  responseFor,
  verifyResponse,
  normaliseCode,
  UNLOCK_GRANT_DAYS,
} from '../src/lib/licence/unlockCode'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const secret = randomBytes(32).toString('base64')
const other = randomBytes(32).toString('base64')
const site = { siteId: 42, deviceSerial: 'MACHINE-A', unlockCounter: 0 }

console.log('\nThe happy path')
const ch = challengeFor(secret, site)
const rp = responseFor(secret, ch)
check('a response to our own challenge is accepted', verifyResponse(secret, ch, rp))
check('the challenge is readable over a phone', /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(ch), ch)
check('the response is readable over a phone', /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(rp), rp)

console.log('\nThe challenge is stable while the counter is')
check('same inputs give the same challenge', challengeFor(secret, site) === ch)

console.log('\nSingle use: redeeming changes the next challenge')
const after = challengeFor(secret, { ...site, unlockCounter: 1 })
check('the challenge moves when the counter does', after !== ch, `${ch} vs ${after}`)
check('the spent response no longer verifies', !verifyResponse(secret, after, rp))

console.log('\nMachine-specific')
const otherMachine = challengeFor(secret, { ...site, deviceSerial: 'MACHINE-B' })
check('a different serial gives a different challenge', otherMachine !== ch)
check("another machine's response is refused", !verifyResponse(secret, ch, responseFor(secret, otherMachine)))

console.log('\nSite-specific')
check('a different site gives a different challenge', challengeFor(secret, { ...site, siteId: 43 }) !== ch)

console.log('\nThe secret is what authorises')
check('a response minted with the wrong secret is refused', !verifyResponse(secret, ch, responseFor(other, ch)))
check("another site's secret gives another challenge", challengeFor(other, site) !== ch)

console.log('\nWhat the phone call actually sounds like')
check('lower case is accepted', verifyResponse(secret, ch, rp.toLowerCase()))
check('spaces instead of dashes are accepted', verifyResponse(secret, ch, rp.replace(/-/g, ' ')))
check('no separators at all are accepted', verifyResponse(secret, ch, rp.replace(/-/g, '')))
check('the challenge may be typed back without dashes', verifyResponse(secret, ch.replace(/-/g, ''), rp))
check('a wrong code is refused', !verifyResponse(secret, ch, 'ACD-EFG-HJK'))
check('an empty code is refused', !verifyResponse(secret, ch, ''))
check('a truncated code is refused', !verifyResponse(secret, ch, rp.slice(0, 5)))

console.log('\nThe alphabet excludes what people mishear')
const CONFUSABLE = ['0', 'O', '1', 'I', 'L', '5', 'S', '8', 'B', '2', 'Z']
const sample = Array.from({ length: 400 }, (_, i) =>
  challengeFor(secret, { siteId: i, deviceSerial: `M${i}`, unlockCounter: i % 7 }),
).join('')
const found = CONFUSABLE.filter((c) => sample.includes(c))
check('no confusable characters are ever emitted', found.length === 0, found.join(','))

console.log('\nDistribution (rejection sampling, not modulo bias)')
const counts = new Map<string, number>()
for (const c of sample.replace(/-/g, '')) counts.set(c, (counts.get(c) ?? 0) + 1)
const freqs = [...counts.values()]
const spread = Math.max(...freqs) / Math.min(...freqs)
check('no character is favoured', spread < 1.6, `most/least common ratio ${spread.toFixed(2)}`)
check('the whole alphabet is reachable', counts.size >= 24, `${counts.size} distinct characters`)

console.log('\nNo collisions across a realistic fleet')
const all = new Set<string>()
let dupes = 0
for (let s = 1; s <= 60; s++) {
  for (let d = 0; d < 8; d++) {
    for (let n = 0; n < 4; n++) {
      const c = challengeFor(secret, { siteId: s, deviceSerial: `TILL-${d}`, unlockCounter: n })
      if (all.has(c)) dupes++
      all.add(c)
    }
  }
}
check('1920 challenges are all distinct', dupes === 0, `${dupes} collisions`)

console.log('\nnormaliseCode')
check('strips confusables rather than mapping them', normaliseCode('ACD-0OI-EFG') === 'ACDEFG')
check('is idempotent', normaliseCode(normaliseCode(rp)) === normaliseCode(rp))

console.log('\nGrant window')
check('an unlock is time-boxed, not a clearance', UNLOCK_GRANT_DAYS > 0 && UNLOCK_GRANT_DAYS <= 30, `${UNLOCK_GRANT_DAYS} days`)

console.log(failures === 0 ? '\nAll unlock-code properties hold.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
