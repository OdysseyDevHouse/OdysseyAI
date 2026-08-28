/**
 * The till's session rules — the shift gate, return-to-login, idle logout and
 * scan sounds.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-pos-till-rules.ts
 *
 * Four settings added together, and what is checked here is the layer with
 * actual logic in it rather than the screens on top:
 *
 *   · The DEFAULTS, because they are load-bearing. `pos_require_shift` defaults
 *     ON, and a site reading it as off would trade into no cash-up. The other
 *     three default OFF, and a site inheriting them on would start demanding a
 *     PIN per sale — or beeping — at a counter that never asked for either.
 *
 *   · The VALIDATOR on the idle timeout, which is the only one of the three that
 *     takes anything other than 1 or 0. Its refusals are the point: a 5-second
 *     timeout makes a till unusable, and a NaN reaching the browser would drive a
 *     setTimeout that silently never fires — a security setting that reads as on
 *     and does nothing.
 *
 *   · That the shift rule and the clock rule are INDEPENDENT, because the till
 *     resolves both in one read and an earlier version of that gate tied the
 *     second to the first — which would have left the clock rule configured,
 *     gating nobody, on exactly the sites that turned shifts off.
 *
 * Restores every key to its DEFAULT rather than to whatever it read on the way
 * in: a previous crashed run's pollution is otherwise faithfully put back.
 */
import {
  SETTING_DEFAULTS,
  getSetting,
  getSettings,
  setSetting,
  validateSetting,
} from '../src/lib/site/settings'

const SITE = 1

let failures = 0

function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`)
}

function checkRefused(what: string, key: Parameters<typeof validateSetting>[0], value: string) {
  const message = validateSetting(key, value)
  const ok = message !== null
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? ` — "${message}"` : ' (it was ACCEPTED)'}`)
}

function checkAccepted(what: string, key: Parameters<typeof validateSetting>[0], value: string) {
  const message = validateSetting(key, value)
  const ok = message === null
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : ` (refused: ${message})`}`)
}

async function main() {
  console.log('\n── The declared defaults ──────────────────────────────────────')
  /* Asserted against the constant rather than against the database: a site that
     has already been through the setup screen would report whatever somebody
     chose there, which proves nothing about what a NEW site inherits. */
  check('pos_require_shift defaults ON', SETTING_DEFAULTS.pos_require_shift, '1')
  check('pos_return_to_login defaults OFF', SETTING_DEFAULTS.pos_return_to_login, '0')
  check('pos_idle_logout_seconds defaults to never', SETTING_DEFAULTS.pos_idle_logout_seconds, '0')
  check('pos_scan_sounds defaults OFF', SETTING_DEFAULTS.pos_scan_sounds, '0')

  console.log('\n── The idle timeout validator ─────────────────────────────────')
  checkAccepted('zero is never, and must stay allowed', 'pos_idle_logout_seconds', '0')
  checkAccepted('15 seconds — the shortest the screen offers', 'pos_idle_logout_seconds', '15')
  checkAccepted('300 seconds — the longest', 'pos_idle_logout_seconds', '300')
  checkRefused('a 5-second timeout would fire mid-sale', 'pos_idle_logout_seconds', '5')
  checkRefused('a negative timeout', 'pos_idle_logout_seconds', '-30')
  checkRefused('a fractional timeout', 'pos_idle_logout_seconds', '30.5')
  checkRefused('a value that is not a number at all', 'pos_idle_logout_seconds', 'soon')
  checkRefused('longer than an hour is Never wearing a hat', 'pos_idle_logout_seconds', '7200')

  console.log('\n── The two flags refuse anything but 1 and 0 ──────────────────')
  checkAccepted('require-shift accepts 1', 'pos_require_shift', '1')
  checkAccepted('require-shift accepts 0', 'pos_require_shift', '0')
  checkRefused('require-shift refuses "true"', 'pos_require_shift', 'true')
  checkAccepted('return-to-login accepts 0', 'pos_return_to_login', '0')
  checkRefused('return-to-login refuses "yes"', 'pos_return_to_login', 'yes')
  checkAccepted('scan-sounds accepts 1', 'pos_scan_sounds', '1')
  checkRefused('scan-sounds refuses "on"', 'pos_scan_sounds', 'on')

  console.log('\n── Round-tripping through the database ────────────────────────')
  try {
    const wrote = await setSetting(SITE, 'pos_idle_logout_seconds', '120')
    check('a valid timeout saves', wrote.ok, true)
    check('and reads back', await getSetting(SITE, 'pos_idle_logout_seconds'), '120')

    /* setSetting runs the validator itself — this is the only check a direct
       call passes through, so a bad value must not reach the column. */
    const refused = await setSetting(SITE, 'pos_idle_logout_seconds', '3')
    check('setSetting refuses a 3-second timeout', refused.ok, false)
    check(
      'and the stored value is untouched',
      await getSetting(SITE, 'pos_idle_logout_seconds'),
      '120',
    )

    console.log('\n── The shift rule and the clock rule are independent ──────────')
    /* The pairing the till reads in one round trip — see tillShiftStatusAction.
       Set opposite ways round precisely because an earlier gate tied the clock
       rule to an open shift, which would have made this combination impossible
       to express: shifts off, clocking on still required. */
    await setSetting(SITE, 'pos_require_shift', '0')
    await setSetting(SITE, 'pos_force_clock_in', '1')
    const rules = await getSettings(SITE, ['pos_require_shift', 'pos_force_clock_in'])
    check('shifts can be off', rules.pos_require_shift, '0')
    check('while clocking on is still required', rules.pos_force_clock_in, '1')
  } finally {
    /* Back to the DEFAULT, not to what was read on the way in. Restoring "the
       original" would faithfully re-write a previous crashed run's pollution. */
    for (const key of [
      'pos_require_shift',
      'pos_return_to_login',
      'pos_idle_logout_seconds',
      'pos_scan_sounds',
      'pos_force_clock_in',
    ] as const) {
      await setSetting(SITE, key, SETTING_DEFAULTS[key])
    }
    console.log('\nRestored all four keys to their defaults.')
  }

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check${failures === 1 ? '' : 's'} FAILED.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nThe suite threw before it finished:', err)
  process.exit(1)
})
