import type { RenderInput, TokenValues } from '../render'
import type { StatementData } from '../../statements/render'
import {
  STATEMENT_CLOSINGS,
  STATEMENT_DUE_LABELS,
  STATEMENT_HEADINGS,
  type StatementVariant,
} from '../../statements/variant'
import { AGING_BUCKETS } from '../../agingBuckets'

/**
 * A statement, a supplier account or a remittance advice, as tokens.
 *
 * ── ONE ADAPTER, THREE DOCUMENTS ──────────────────────────────────────────
 *
 * A customer statement demands money, a supplier statement reports what we owe,
 * and a remittance says what we have just paid. The SHAPE is identical — a
 * letterhead, an account, a list of documents, a summary — so they share a
 * design, and what differs arrives as tokens rather than as three layouts to
 * keep in step.
 *
 * That is the same call the sales documents make: one design serves a quote, an
 * order, a pro forma and a tax invoice because {doc.heading} says which it is.
 * Here {doc.heading} and {totals.dueLabel} do the same work.
 *
 * ── THE AGEING LADDER IS A SECTION ────────────────────────────────────────
 *
 * Its headings change with the account: 7/14/21 days for a weekly cycle,
 * 30/60/90 for a monthly one. So the labels travel WITH the figures as rows,
 * rather than as six fixed tokens that would each be wrong for half the ledger.
 *
 * A remittance has no ladder — nothing is overdue on money already paid — so it
 * emits no rows at all, and the block showing it disappears with them.
 */

export function statementTokens(
  data: StatementData,
  variant: StatementVariant,
  /*
   * The letterhead beyond a name and a VAT number.
   *
   * StatementData carries only those two, because the hand-drawn layout needed
   * no more — so the caller that wants a full letterhead reads it and passes it
   * in, rather than six call signatures widening for data one of them uses.
   * Absent, the letterhead simply prints shorter.
   */
  extra: {
    printedAt?: string
    logoHtml?: string | null
    siteAddress?: string[]
    sitePhone?: string | null
    siteEmail?: string | null
    siteRegistrationNumber?: string | null
  } = {},
): RenderInput {
  const { site, account } = data

  const isRemittance = variant === 'remittance'

  const values: TokenValues = {
    'site.name': site.name,
    'site.vatNumber': site.vatNumber,
    'site.vatLine': site.vatNumber ? `VAT no. ${site.vatNumber}` : '',
    'site.registrationNumber': extra.siteRegistrationNumber ?? null,
    'site.registrationLine': extra.siteRegistrationNumber
      ? `Reg. no. ${extra.siteRegistrationNumber}`
      : '',
    'site.address': (extra.siteAddress ?? []).filter(Boolean).join('\n'),
    'site.address1': extra.siteAddress?.[0] ?? '',
    'site.address2': extra.siteAddress?.[1] ?? '',
    'site.address3': extra.siteAddress?.[2] ?? '',
    'site.postalCode': extra.siteAddress?.[3] ?? '',
    'site.phone': extra.sitePhone ?? '',
    'site.email': extra.siteEmail ?? '',
    'site.logo': extra.logoHtml ?? '',

    'doc.heading': STATEMENT_HEADINGS[variant],
    // A statement has no number of its own: it is a view of an account over a
    // period, and the period is what identifies it.
    'doc.number': '',
    'doc.date': data.period.to,
    'doc.period': data.periodLabel,
    'doc.periodFrom': data.period.from,
    'doc.periodTo': data.period.to,
    'doc.reference': null,
    'doc.notes': '',
    'doc.printedAt': extra.printedAt ?? '',
    'doc.closing': STATEMENT_CLOSINGS[variant],

    'account.name': account.name,
    'account.code': account.code,
    'account.contactName': account.contactName ?? '',
    'account.address': account.addressLines.filter(Boolean).join('\n'),
    'account.email': account.email ?? '',
    'account.phone': account.phone ?? '',
    'account.vatNumber': account.vatNumber ?? '',

    /*
     * Labelled variants, as the purchase order uses: a caption over a blank
     * reads as something somebody forgot to fill in, and the template language
     * has no conditionals on purpose.
     */
    'account.terms':
      account.paymentTermsDays > 0 ? `${account.paymentTermsDays} days` : '',
    // A money FORMAT, so it prints R50 000.00 rather than 50000.00 — the token
    // formats, the adapter supplies the number.
    'account.creditLimit':
      !isRemittance && account.creditLimit > 0 ? account.creditLimit : null,
    'account.termsLine':
      account.paymentTermsDays > 0 ? `Terms: ${account.paymentTermsDays} days` : '',
    /*
     * Never on a remittance. Telling a supplier our credit limit with them on
     * the advice that pays them is at best noise and at worst a negotiating
     * position we did not mean to publish.
     */
    'account.creditLimitLine':
      !isRemittance && account.creditLimit > 0
        ? `Credit limit: ${account.creditLimit.toFixed(2)}`
        : '',

    'totals.opening': data.openingBalance,
    'totals.closing': data.closingBalance,
    'totals.dueNow': data.dueNow,
    'totals.dueLabel': STATEMENT_DUE_LABELS[variant],
    'totals.settlementDiscount':
      data.settlementDiscount && data.settlementDiscount > 0 ? data.settlementDiscount : null,
    'totals.agingTotal': isRemittance ? null : data.aging.total,
  }

  const lines: TokenValues[] = data.lines.map((line) => ({
    'line.date': line.date,
    'line.docType': line.docType,
    'line.docNumber': line.docNumber ?? '',
    'line.description': line.description,
    'line.reference': line.reference ?? '',
    // Zero prints blank rather than R0.00: a credit line has no debit, and a
    // column of noughts beside every figure is noise on a page of figures.
    'line.debit': line.debit !== 0 ? line.debit : null,
    'line.credit': line.credit !== 0 ? line.credit : null,
    /*
     * On an OPEN-ITEM statement this is what is still unpaid on the document,
     * and a settled one shows nothing rather than R0.00 — a page of figures
     * reads better without a column of noughts, and a zero here is not a claim
     * about an amount but the absence of one.
     *
     * On an ACTIVITY statement it is the running balance, which is genuinely a
     * figure even when it is zero, so it always prints.
     */
    'line.owing':
      data.format === 'open-item'
        ? Math.abs(line.outstanding) > 0.005
          ? Math.abs(line.outstanding)
          : null
        : line.balance,
    'line.daysOverdue': line.daysOverdue > 0 ? String(line.daysOverdue) : '',
  }))

  /*
   * The ladder. Empty on a remittance, so the block carrying it hides itself
   * rather than printing a row of zeroes about money already paid.
   */
  const aging: TokenValues[] = isRemittance
    ? []
    : [
        ...AGING_BUCKETS.map((bucket) => ({
          'bucket.label': data.bucketLabels[bucket],
          'bucket.amount': data.aging[bucket],
        })),
        // The total is the last rung, so a design lays out one table rather than
        // a table and a stray token that has to be positioned to match it.
        { 'bucket.label': 'Total', 'bucket.amount': data.aging.total },
      ]

  return {
    values,
    sections: { lines, aging },
    capabilities: { isOwner: false, granted: new Set() },
  }
}

