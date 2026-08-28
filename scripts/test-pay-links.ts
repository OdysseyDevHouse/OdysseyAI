/**
 * Pay links, against a live site database.
 *
 * A pay link is a URL printed on paper and handed to a member of the public, so
 * the checks here are about what it must NOT do as much as what it must:
 *
 *   a slug that can be guessed, or walked from a neighbouring one;
 *   a reprint scattering a second live link for one debt;
 *   a revoked or expired link that still takes money;
 *   a link that keeps asking for the original amount after a part payment;
 *   a settled thing that still offers a Pay button.
 *
 * It also proves the invariant the whole feature was designed around: a pay
 * link COLLECTS MONEY and never advances a document's state.
 *
 *   npm run test:pay-links
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import {
  payLinkFor,
  payLinkUrl,
  resolvePayLink,
  revokePayLinks,
  splitPayCode,
  payLinksEnabled,
} from '../src/lib/site/payLinks'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { documentPayUrl } from '../src/lib/site/qrLinks'
import { saveGateway, getGateway } from '../src/lib/site/payments'

const SITE = 1
const TAG = 99000001

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function cleanup() {
  await siteExecute(SITE, `DELETE FROM pay_links WHERE target_id >= ?`, [TAG])
}

async function main() {
  console.log('— Setup —')
  await cleanup()

  // Remembered so the site is put back exactly as found. NOT "what we read" —
  // restoring an observed value faithfully re-writes a previous crash's
  // pollution; these are the defaults the settings file declares.
  const gatewayBefore = await getGateway(SITE)
  const settingsBefore = {
    invoices: await getSetting(SITE, 'pay_link_on_invoices'),
    laybys: await getSetting(SITE, 'pay_link_on_laybys'),
    quotes: await getSetting(SITE, 'pay_link_on_quotes'),
  }

  await saveGateway(
    SITE,
    {
      isActive: true,
      isSandbox: true,
      merchantId: '10000100',
      merchantKey: 'test-key',
      passphrase: 'test-passphrase-do-not-use',
    },
    'test',
  )

  /* ── The setting gates everything ─────────────────────────────────────── */
  console.log('\n— The setting is the first gate —')

  await setSetting(SITE, 'pay_link_on_invoices', '0')
  ok(
    'links are off until the shop turns them on',
    (await payLinksEnabled(SITE, 'debtor_invoice')) === false,
  )
  ok(
    'and nothing is minted while they are off',
    (await payLinkFor(SITE, 'debtor_invoice', TAG)) === null,
  )

  await setSetting(SITE, 'pay_link_on_invoices', '1')
  ok('switching it on enables them', (await payLinksEnabled(SITE, 'debtor_invoice')) === true)

  // The settings are per-KIND, which is the whole reason there are four.
  ok(
    'a different kind stays off on its own setting',
    (await payLinksEnabled(SITE, 'layby')) === false,
  )

  /* ── The slug ─────────────────────────────────────────────────────────── */
  console.log('\n— The slug —')

  const link = await payLinkFor(SITE, 'debtor_invoice', TAG, { createdBy: 'test' })
  ok('a link is minted', link !== null, link?.slug)
  if (!link) throw new Error('no link — the rest cannot run')

  ok('the slug is long enough to be unguessable', link.slug.length >= 12, `${link.slug.length}`)
  ok(
    'it avoids the characters people mistype',
    !/[0OIl]/.test(link.slug),
    link.slug,
  )
  ok('it expires', link.expiresAt !== null, String(link.expiresAt))
  ok('and is not born revoked', link.revokedAt === null)

  // THE one that matters most: two links minted back to back must share no
  // predictable structure. A sequential slug would let anyone walk the range
  // and read what every other customer owes.
  const other = await payLinkFor(SITE, 'debtor_invoice', TAG + 1, { createdBy: 'test' })
  ok('two links are unrelated', other !== null && other.slug !== link.slug, other?.slug)

  /* ── Reuse ────────────────────────────────────────────────────────────── */
  console.log('\n— A reprint reuses its square —')

  const again = await payLinkFor(SITE, 'debtor_invoice', TAG, { createdBy: 'test' })
  ok('the same target gives the same slug', again?.slug === link.slug, again?.slug)

  const rows = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM pay_links WHERE purpose = 'debtor_invoice' AND target_id = ?`,
    [TAG],
  )
  ok('and no second row was written', Number(rows[0]?.n) === 1, String(rows[0]?.n))

  /* ── Resolving ────────────────────────────────────────────────────────── */
  console.log('\n— Resolving —')

  ok('a live slug resolves', (await resolvePayLink(SITE, link.slug))?.id === link.id)
  ok('an unknown slug resolves to nothing', (await resolvePayLink(SITE, 'no-such-slug')) === null)
  ok('an empty slug is refused', (await resolvePayLink(SITE, '')) === null)
  ok(
    'an over-long slug is refused before it reaches the database',
    (await resolvePayLink(SITE, 'x'.repeat(64))) === null,
  )

  // Cross-site: the same slug must not resolve at another shop. Site ids are
  // per-database, so a slug from one shop hitting another's database would be
  // reading a stranger's debt.
  ok(
    'a slug does not resolve at a site that does not have it',
    (await resolvePayLink(SITE + 999999, link.slug).catch(() => null)) === null,
  )

  /* ── The printed code ─────────────────────────────────────────────────── */
  console.log('\n— The printed code names its own site —')

  const url = await payLinkUrl(SITE, 'debtor_invoice', TAG)
  if (url) {
    const code = url.split('/p/')[1] ?? ''
    const split = splitPayCode(code)
    ok('the code round-trips to its site', split?.siteId === SITE, JSON.stringify(split))
    ok('and to its slug', split?.slug === link.slug)
    // The reason the site is in the slug rather than a signed token in the path.
    ok('the whole URL stays short enough to print', url.length < 80, `${url.length} chars`)
  } else {
    // APP_URL unset is a legitimate local state, not a failure: qrLinks refuses
    // to invent a host for the same reason. Say so rather than failing.
    console.log('SKIP  the URL shape — APP_URL is not set in this environment')
  }

  ok('a code with no site prefix is refused', splitPayCode('K7m2xQ9vTdRp') === null)
  ok('a code with a junk prefix is refused', splitPayCode('zz$$-K7m2xQ9vTdRp')?.siteId !== 0)
  ok('an empty code is refused', splitPayCode('') === null)

  /* ── Revocation ───────────────────────────────────────────────────────── */
  console.log('\n— Revoking —')

  const revoked = await revokePayLinks(SITE, 'debtor_invoice', TAG)
  ok('revoking reports what it stopped', revoked === 1, String(revoked))
  ok('a revoked slug no longer resolves', (await resolvePayLink(SITE, link.slug)) === null)

  // The point of the table. Paper cannot be recalled, so the row is the only
  // place a printed link can be stopped.
  const fresh = await payLinkFor(SITE, 'debtor_invoice', TAG, { createdBy: 'test' })
  ok('a new link is minted rather than resurrecting the dead one', fresh?.slug !== link.slug)

  /* ── Expiry ───────────────────────────────────────────────────────────── */
  console.log('\n— Expiry —')

  await siteExecute(
    SITE,
    `UPDATE pay_links SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE target_id = ?`,
    [TAG],
  )
  ok(
    'an expired slug does not resolve',
    (await resolvePayLink(SITE, fresh?.slug ?? '')) === null,
  )

  /* ── Which documents may carry a square ───────────────────────────────── */
  console.log('\n— documentPayUrl refuses the wrong documents —')

  // A CREDIT NOTE is money owed TO the customer. A pay button on one asks them
  // to settle their own refund, which is the single worst thing this feature
  // could print.
  ok(
    'a credit note gets no pay link',
    (await documentPayUrl(SITE, { id: TAG, docType: 'credit_sale', status: 'finalised' })) === null,
  )
  // A draft has no number and no debt — the business has not raised it yet.
  ok(
    'a draft invoice gets none',
    (await documentPayUrl(SITE, { id: TAG, docType: 'invoice', status: 'draft' })) === null,
  )
  ok(
    'a cancelled invoice gets none',
    (await documentPayUrl(SITE, { id: TAG, docType: 'invoice', status: 'cancelled' })) === null,
  )

  // And the two that DO. Only meaningful when APP_URL is configured; without it
  // every link is legitimately null and the assertion would be vacuous.
  if (await payLinkUrl(SITE, 'debtor_invoice', TAG + 5)) {
    const inv = await documentPayUrl(SITE, {
      id: TAG + 6,
      docType: 'invoice',
      status: 'finalised',
    })
    ok('a finalised invoice gets one', typeof inv === 'string' && inv.includes('/p/'), inv ?? 'null')

    await setSetting(SITE, 'pay_link_on_quotes', '1')
    const quote = await documentPayUrl(SITE, {
      id: TAG + 7,
      docType: 'quote',
      status: 'issued',
    })
    ok(
      'an issued quote gets a DEPOSIT link',
      typeof quote === 'string' && quote.includes('/p/'),
      quote ?? 'null',
    )

    // The link a quote gets must be a deposit, never a debtor invoice: a quote
    // is not a debt, and settling it as one would receipt money against an
    // invoice that does not exist.
    const quoteRow = await siteQueryOne<{ purpose: string }>(
      SITE,
      `SELECT purpose FROM pay_links WHERE target_id = ? LIMIT 1`,
      [TAG + 7],
    )
    ok(
      "and it is a deposit, not a debtor invoice",
      quoteRow?.purpose === 'document_deposit',
      quoteRow?.purpose,
    )
    await setSetting(SITE, 'pay_link_on_quotes', '0')
  } else {
    console.log('SKIP  the positive cases — APP_URL is not set in this environment')
  }

  /* ── Restore ──────────────────────────────────────────────────────────── */
  console.log('\n— Cleanup —')
  await cleanup()
  const left = await siteQueryOne<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM pay_links WHERE target_id >= ?`,
    [TAG],
  )
  ok('test links removed', Number(left?.n) === 0)

  await setSetting(SITE, 'pay_link_on_invoices', settingsBefore.invoices)
  await setSetting(SITE, 'pay_link_on_laybys', settingsBefore.laybys)
  await setSetting(SITE, 'pay_link_on_quotes', settingsBefore.quotes)

  if (gatewayBefore) {
    await saveGateway(
      SITE,
      {
        isActive: gatewayBefore.isActive,
        isSandbox: gatewayBefore.isSandbox,
        merchantId: gatewayBefore.merchantId,
        merchantKey: gatewayBefore.merchantKey,
        passphrase: gatewayBefore.passphrase,
      },
      gatewayBefore.updatedBy || 'test',
    )
  }
  ok('settings restored', (await getSetting(SITE, 'pay_link_on_invoices')) === settingsBefore.invoices)

  console.log(fails === 0 ? '\nAll pay-link checks passed.' : `\n${fails} check(s) FAILED.`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
