/**
 * The shop's tax identity — its number, its label, and what they gate.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-tax-identity.ts
 *
 * Two settings' worth of behaviour, and the parts worth proving are the ones a
 * screen cannot show:
 *
 *   · THE GUARD IS NOT RETROSPECTIVE. A shop that removes its VAT number keeps
 *     every product already on 15% exactly where it is — the gate stands at the
 *     moment somebody CHANGES a rate, never over what is already stored. This
 *     is the requirement's one explicit out-of-scope, and the easiest thing to
 *     get wrong by writing the check one function too far up.
 *
 *   · ZERO IS ALWAYS ALLOWED, registered or not. Zero-rated goods are real, and
 *     a guard that refused them would stop an unregistered shop adding any
 *     product at all.
 *
 *   · THE LABEL VALIDATOR refuses what would break a slip: an empty string, a
 *     sentence, and a number typed into the box where the WORD goes.
 *
 * ── WHY THE VAT NUMBER IS NOT WRITTEN HERE ──────────────────────────────────
 *
 * It lives in cp2_sites, the CONTROL database, which this suite has no business
 * writing to — a test that edited a real shop's registered number and crashed
 * before its restore would leave that shop unable to invoice. So the guard is
 * exercised through `whyTaxRateRefused` against the site's REAL registration
 * state, and the assertions are written to hold either way: what is proved is
 * that the rule agrees with itself, not that a particular shop is registered.
 */
import {
  SETTING_DEFAULTS,
  getSetting,
  setSetting,
  validateSetting,
} from '../src/lib/site/settings'
import {
  DEFAULT_TAX_LABEL,
  taxIdentity,
  taxLabel,
  vatRatePercent,
  whyTaxRateRefused,
} from '../src/lib/site/taxIdentity'
import { listVatRates } from '../src/lib/site/lookups'

const SITE = 1

let failures = 0
function check(what: string, got: unknown, want: unknown) {
  const ok = got === want
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`,
  )
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
  console.log('\n── The label validator ────────────────────────────────────────')
  check('the default is VAT', SETTING_DEFAULTS.tax_label, DEFAULT_TAX_LABEL)
  checkAccepted('VAT', 'tax_label', 'VAT')
  checkAccepted('HST — Canada', 'tax_label', 'HST')
  checkAccepted('Tax — the United States', 'tax_label', 'Tax')
  checkAccepted('GST/HST, which is a real Canadian label', 'tax_label', 'GST/HST')
  checkRefused('an empty label', 'tax_label', '')
  checkRefused('a label of only spaces', 'tax_label', '   ')
  checkRefused('a sentence, which would break a 40-column slip', 'tax_label', 'Value Added Tax On Goods')
  checkRefused('the NUMBER typed into the label box', 'tax_label', '4123456789')
  checkRefused('a label starting with a digit', 'tax_label', '15% VAT')

  console.log('\n── The label round-trips and is read back everywhere ──────────')
  const originalLabel = await getSetting(SITE, 'tax_label')
  try {
    const wrote = await setSetting(SITE, 'tax_label', 'HST')
    check('a valid label saves', wrote.ok, true)
    check('taxLabel() reports it', await taxLabel(SITE), 'HST')
    check('taxIdentity() agrees', (await taxIdentity(SITE)).label, 'HST')

    /* An empty row must READ as the default even though it cannot be WRITTEN —
       the two are different questions and only the validator answers the
       second. A site migrated before this setting existed has no row at all. */
    const refused = await setSetting(SITE, 'tax_label', '')
    check('an empty label is refused at the writer too', refused.ok, false)
    check('and the stored label is untouched', await taxLabel(SITE), 'HST')
  } finally {
    await setSetting(SITE, 'tax_label', originalLabel || DEFAULT_TAX_LABEL)
    console.log(`\nRestored the label to "${originalLabel || DEFAULT_TAX_LABEL}".`)
  }

  console.log('\n── Resolving a rate id to a percentage ────────────────────────')
  const rates = await listVatRates(SITE)
  const standard = rates.find((r) => r.vatType === 'sales' && r.rate > 0)
  const zero = rates.find((r) => r.vatType === 'sales' && r.rate === 0)
  if (!standard || !zero) {
    failures++
    console.log('FAIL  this site has no standard AND zero sales rate to test with')
  } else {
    check('a standard rate resolves to its percentage', await vatRatePercent(SITE, standard.id), standard.rate)
    check('a zero rate resolves to 0', await vatRatePercent(SITE, zero.id), 0)
    check('null means "the site default"', await vatRatePercent(SITE, null), null)
    /* A deleted row reads as 0 rather than throwing — the permissive direction,
       because the write is about to fail on the foreign key anyway. */
    check('a rate id that no longer exists reads as 0', await vatRatePercent(SITE, 999_999), 0)
  }

  console.log('\n── The guard ──────────────────────────────────────────────────')
  const identity = await taxIdentity(SITE)
  console.log(
    `   (this site ${identity.registered ? `IS registered — ${identity.number}` : 'is NOT registered'})`,
  )

  /* Zero is allowed either way, and this is the assertion that holds whatever
     the site's registration state — it is the rule that lets an unregistered
     shop add products at all. */
  check('zero is always allowed', await whyTaxRateRefused(SITE, 0), null)
  check('null — the site default — is always allowed', await whyTaxRateRefused(SITE, null), null)
  check('a negative rate is not something to refuse', await whyTaxRateRefused(SITE, -5), null)

  const refusal = await whyTaxRateRefused(SITE, 15)
  if (identity.registered) {
    check('a registered shop may charge 15%', refusal, null)
  } else {
    check('an unregistered shop may not charge 15%', refusal !== null, true)
    check(
      'and the refusal names the shop’s own word for the tax',
      refusal?.includes(identity.label),
      true,
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
  console.error('\nThe suite threw before it finished:', err)
  process.exit(1)
})
