/**
 * The whole telephone exchange, both ends, with no network between them.
 *
 * test-unlock-code.ts pins down the primitives. This simulates the actual call:
 * a locked machine derives a challenge from its own stored state, a supervisor
 * on the control panel searches its registered machines for one that matches,
 * reads back a response, and the machine accepts it — then does not accept it
 * again.
 *
 * The counter-search is the part worth proving. The control panel only mirrors
 * the machine's redeem counter, so the two drift: a code issued and never typed
 * in leaves the panel behind, a machine restored from backup leaves it ahead.
 * If the search window is wrong, real customers get "that code does not match"
 * and there is no way to fix it from their side.
 *
 *   npx tsx scripts/test-unlock-exchange.ts
 */
import { randomBytes } from 'node:crypto'
import {
  challengeFor,
  responseFor,
  verifyResponse,
  normaliseCode,
} from '../src/lib/licence/unlockCode'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const COUNTER_WINDOW = 5 // must match grantUnlock.ts

/** A machine in a shop, holding its own lease. */
function machine(siteId: number, serial: string, secret: string, counter = 0) {
  return {
    siteId,
    serial,
    secret,
    counter,
    /** What the lock screen shows. */
    challenge() {
      return challengeFor(this.secret, {
        siteId: this.siteId,
        deviceSerial: this.serial,
        unlockCounter: this.counter,
      })
    },
    /** What redeemUnlockAction does: recompute, verify, then bump. */
    redeem(supplied: string) {
      const ch = this.challenge()
      if (!verifyResponse(this.secret, ch, supplied)) return false
      this.counter += 1
      return true
    },
  }
}

/**
 * The control panel: several registered machines, and a mirrored counter that
 * may be wrong in either direction.
 */
function controlPanel(registered: Array<{ serial: string; secret: string; knownCounter: number }>) {
  return {
    issue(siteId: number, suppliedChallenge: string) {
      const target = normaliseCode(suppliedChallenge)
      for (const row of registered) {
        const from = Math.max(0, row.knownCounter - COUNTER_WINDOW)
        for (let c = from; c <= row.knownCounter + COUNTER_WINDOW; c++) {
          const candidate = challengeFor(row.secret, {
            siteId,
            deviceSerial: row.serial,
            unlockCounter: c,
          })
          if (normaliseCode(candidate) === target) {
            return { ok: true as const, response: responseFor(row.secret, candidate), serial: row.serial }
          }
        }
      }
      return { ok: false as const }
    },
  }
}

const SITE = 42
const secretA = randomBytes(32).toString('base64')
const secretB = randomBytes(32).toString('base64')

console.log('\nA shop rings in')
{
  const till = machine(SITE, 'TILL-A', secretA)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])

  const shown = till.challenge()
  const issued = panel.issue(SITE, shown)
  check('the panel finds the machine from the code alone', issued.ok)
  check('and identifies which machine it was', issued.ok && issued.serial === 'TILL-A')
  check('the machine accepts the response', issued.ok && till.redeem(issued.response))
  check('and its counter moved', till.counter === 1)
}

console.log('\nThe same code cannot be used twice')
{
  const till = machine(SITE, 'TILL-A', secretA)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  const issued = panel.issue(SITE, till.challenge())
  if (!issued.ok) throw new Error('setup failed')

  check('first use works', till.redeem(issued.response))
  check('second use is refused', !till.redeem(issued.response))
  check('a new challenge is shown after redeeming', till.challenge() !== challengeFor(secretA, { siteId: SITE, deviceSerial: 'TILL-A', unlockCounter: 0 }))
}

console.log('\nThe right machine, out of several at one site')
{
  const tillA = machine(SITE, 'TILL-A', secretA)
  const tillB = machine(SITE, 'TILL-B', secretB)
  const panel = controlPanel([
    { serial: 'TILL-A', secret: secretA, knownCounter: 0 },
    { serial: 'TILL-B', secret: secretB, knownCounter: 0 },
  ])

  const forB = panel.issue(SITE, tillB.challenge())
  check('the panel picks the machine that rang', forB.ok && forB.serial === 'TILL-B')
  check('and its code works there', forB.ok && tillB.redeem(forB.response))

  const forB2 = panel.issue(SITE, tillB.challenge())
  check("a code for one till is refused by the other", forB2.ok && !tillA.redeem(forB2.response))
}

console.log('\nCounter drift: the panel is BEHIND (codes issued, never typed in)')
for (const drift of [1, 3, COUNTER_WINDOW]) {
  const till = machine(SITE, 'TILL-A', secretA, drift)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  const issued = panel.issue(SITE, till.challenge())
  check(`drift of ${drift} still resolves`, issued.ok && till.redeem(issued.response))
}

console.log('\nCounter drift: the panel is AHEAD (machine restored from a backup)')
for (const drift of [1, 3, COUNTER_WINDOW]) {
  const till = machine(SITE, 'TILL-A', secretA, 0)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: drift }])
  const issued = panel.issue(SITE, till.challenge())
  check(`drift of -${drift} still resolves`, issued.ok && till.redeem(issued.response))
}

console.log('\nBeyond the window, it fails honestly rather than silently')
{
  const till = machine(SITE, 'TILL-A', secretA, COUNTER_WINDOW + 4)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  const issued = panel.issue(SITE, till.challenge())
  check('a machine far out of step is not matched', !issued.ok)
}

console.log('\nAn unregistered machine cannot be unlocked')
{
  const rogue = machine(SITE, 'TILL-X', randomBytes(32).toString('base64'))
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  check('its code matches nothing', !panel.issue(SITE, rogue.challenge()).ok)
}

console.log('\nA code from another SITE does not work here')
{
  const till = machine(99, 'TILL-A', secretA)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  check('the site is part of what is signed', !panel.issue(SITE, till.challenge()).ok)
}

console.log('\nWhat a bad phone line does to it')
{
  const till = machine(SITE, 'TILL-A', secretA)
  const panel = controlPanel([{ serial: 'TILL-A', secret: secretA, knownCounter: 0 }])
  const shown = till.challenge()

  check('the panel accepts it typed without dashes', panel.issue(SITE, shown.replace(/-/g, '')).ok)
  check('the panel accepts it in lower case', panel.issue(SITE, shown.toLowerCase()).ok)
  check('the panel accepts it with spaces', panel.issue(SITE, shown.replace(/-/g, ' ')).ok)

  const issued = panel.issue(SITE, shown)
  if (!issued.ok) throw new Error('setup failed')
  check('the machine accepts the response typed loosely', till.redeem(` ${issued.response.toLowerCase()} `))
}

console.log('\nA guessed code does not open anything')
{
  const till = machine(SITE, 'TILL-A', secretA)
  let opened = 0
  for (let i = 0; i < 500; i++) {
    const guess = challengeFor(randomBytes(32).toString('base64'), {
      siteId: SITE,
      deviceSerial: 'TILL-A',
      unlockCounter: 0,
    })
    if (verifyResponse(secretA, till.challenge(), guess)) opened++
  }
  check('500 random codes all refused', opened === 0, `${opened} opened`)
  check('and no failed guess moved the counter', till.counter === 0)
}

console.log(failures === 0 ? '\nThe telephone exchange holds.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
