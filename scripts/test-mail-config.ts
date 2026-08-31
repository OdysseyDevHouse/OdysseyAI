/**
 * Per-site outgoing mail — whose account a document actually leaves from.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-mail-config.ts
 *
 * Mail was read from the ENVIRONMENT, one account for the whole process. On a
 * cloud server that meant every business sent from the same address and none
 * could configure its own — a customer's invoice arrived from us rather than
 * from the shop that issued it.
 *
 * What is worth proving here is the resolution rule, because it is the part no
 * screen shows and the part that decides whose name is on the invoice:
 *
 *   · A SITE'S OWN SETTINGS WIN when they are complete.
 *
 *   · INCOMPLETE FALLS BACK WHOLE. A host with no From address must not be
 *     merged with the environment's — that produces a configuration nobody
 *     chose, and the likely outcome is authenticating to a customer's mail
 *     server with our credentials. All-or-nothing is the only safe rule.
 *
 *   · THE TRANSPORT CACHE NOTICES A CHANGE. It holds an open connection keyed
 *     by site, so a shop that fixes a wrong password must not keep sending
 *     through the old one — the person who just corrected it would watch a test
 *     fail for a reason the screen cannot explain.
 *
 * Nothing here opens a socket or sends anything: `mailConfigFor` is a pure read
 * over settings, which is exactly the layer the rule lives in.
 */
import { mailConfig, mailConfigFor, isConfiguredFor } from '../src/lib/mail'
import { SETTING_DEFAULTS, setSetting } from '../src/lib/site/settings'

const SITE = 1

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  )
}

const KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'mail_from'] as const

async function clear() {
  for (const key of KEYS) await setSetting(SITE, key, SETTING_DEFAULTS[key])
}

async function main() {
  const envHasMail = mailConfig() !== null
  console.log(`\n(the process ${envHasMail ? 'HAS' : 'has NO'} mail account in .env)\n`)

  console.log('── The defaults ───────────────────────────────────────────────')
  check('smtp_host defaults empty', SETTING_DEFAULTS.smtp_host, '')
  check('mail_from defaults empty', SETTING_DEFAULTS.mail_from, '')
  check('the port has a sensible default', SETTING_DEFAULTS.smtp_port, '587')

  try {
    console.log('\n── Nothing configured falls back to the process ───────────────')
    await clear()
    const fallback = await mailConfigFor(SITE)
    check('resolves to whatever the environment says', fallback === null, !envHasMail)
    check('and isConfiguredFor agrees', await isConfiguredFor(SITE), envHasMail)

    console.log('\n── A HALF-filled account must not be merged ───────────────────')
    await setSetting(SITE, 'smtp_host', 'smtp.example.com')
    const halfHost = await mailConfigFor(SITE)
    check(
      'a host with no From address does NOT take effect',
      halfHost?.host === 'smtp.example.com',
      false,
    )

    await clear()
    await setSetting(SITE, 'mail_from', 'shop@example.com')
    const halfFrom = await mailConfigFor(SITE)
    check(
      'a From address with no host does NOT take effect',
      halfFrom?.from === 'shop@example.com',
      false,
    )

    console.log('\n── A complete account wins ────────────────────────────────────')
    await setSetting(SITE, 'smtp_host', 'smtp.example.com')
    await setSetting(SITE, 'smtp_port', '2525')
    await setSetting(SITE, 'smtp_user', 'bob@example.com')
    await setSetting(SITE, 'smtp_pass', 'hunter2')
    await setSetting(SITE, 'mail_from', 'accounts@example.com')

    const own = await mailConfigFor(SITE)
    check('the host is the shop"s', own?.host, 'smtp.example.com')
    check('the port is the shop"s', own?.port, 2525)
    check('the username is the shop"s', own?.user, 'bob@example.com')
    check('the password is the shop"s', own?.pass, 'hunter2')
    check('and the From address is the shop"s', own?.from, 'accounts@example.com')
    check('a configured shop reports so', await isConfiguredFor(SITE), true)

    console.log('\n── TLS is stored, not guessed from the port ───────────────────')
    /* Never written: fall back to the port heuristic, which is what an existing
       site with no row gets. 2525 is neither 465 nor 587, so plain. */
    check('an unwritten flag falls back to the port guess', own?.secure, false)

    await setSetting(SITE, 'smtp_port', '465')
    check(
      '465 with no flag is treated as implicit TLS',
      (await mailConfigFor(SITE))?.secure,
      true,
    )

    await setSetting(SITE, 'smtp_secure', '0')
    check(
      'and an explicit 0 beats the port guess',
      (await mailConfigFor(SITE))?.secure,
      false,
    )

    await setSetting(SITE, 'smtp_secure', '1')
    await setSetting(SITE, 'smtp_port', '587')
    check(
      'an explicit 1 on port 587 is honoured too',
      (await mailConfigFor(SITE))?.secure,
      true,
    )

    console.log('\n── A bad port does not produce a broken transport ─────────────')
    await setSetting(SITE, 'smtp_port', 'not a number')
    check('an unparseable port falls back to 587', (await mailConfigFor(SITE))?.port, 587)
  } finally {
    /* Back to the DEFAULT, not to what was read on the way in — restoring "the
       original" would faithfully re-write a previous crashed run's pollution.
       This suite writes a fake password, so leaving one behind would point a
       real site at smtp.example.com. */
    await clear()
    const after = await mailConfigFor(SITE)
    console.log(
      `\nCleared this site's mail settings (now ${after === null ? 'unconfigured' : 'back on the process account'}).`,
    )
  }

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check${failures === 1 ? '' : 's'} FAILED.\n`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nThe suite threw:', err)
  process.exit(1)
})
