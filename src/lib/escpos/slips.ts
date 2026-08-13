import { EscPos, twoCol, wrapText } from './encoder'
import { formatMoney, formatQty } from '../decimals'
import type { ReceiptData } from '../receiptData'
import type { BillData } from '../billData'

/**
 * Slip layouts, as ESC/POS jobs.
 *
 * Each renderer consumes the SAME data object the browser print renders, so
 * the two prints cannot disagree — the whole reason receiptData/billData are
 * pure. Columns default to 48 (80mm, Font A); 42 fits the narrower heads.
 *
 * Nothing here talks to a printer. The bytes go to the local bridge
 * (scripts/print-bridge.mjs), which forwards them raw.
 */

export type SlipOptions = { columns?: 42 | 48 }

function header(job: EscPos, siteName: string, columns: number): void {
  void columns
  job.align('center').size(2, 2).line(siteName).size(1, 1)
}

export function renderReceipt(data: ReceiptData, opts: SlipOptions = {}): Uint8Array {
  const columns = opts.columns ?? 48
  const job = new EscPos().init()

  header(job, data.siteName, columns)
  if (data.vatNumber && !data.gift) job.line(`VAT no. ${data.vatNumber}`)
  job.bold(true).line(data.gift ? 'GIFT RECEIPT' : 'TAX INVOICE').bold(false)
  job.line(`${data.documentNumber} · ${data.documentDate}`)
  job.line([data.cashierName, data.terminalCode, data.printedAt].filter(Boolean).join(' · '))
  if (data.customerName) {
    job.line(
      data.customerVatNo && !data.gift
        ? `${data.customerName} · VAT ${data.customerVatNo}`
        : data.customerName,
    )
  }
  if (data.copyNumber > 0 && !data.gift) {
    job.bold(true).line(`COPY${data.copyNumber > 1 ? ` ${data.copyNumber}` : ''}`).bold(false)
  }
  if (data.gift) job.line('A gift receipt - prices not shown.')

  job.align('left').line('-'.repeat(columns))

  for (const line of data.lines) {
    const label = `${formatQty(line.qty)} x ${line.description}`
    if (data.gift) {
      for (const piece of wrapText(label, columns)) job.line(piece)
    } else {
      job.line(twoCol(label, formatMoney(line.lineTotalIncl), columns))
      if (line.qty !== 1) job.line(`  @ ${formatMoney(line.unitPriceIncl)}`)
    }
    for (const note of line.notes) {
      for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
    }
  }

  job.line('-'.repeat(columns))

  if (!data.gift) {
    if (data.discountTotal > 0) {
      job.line(twoCol('Discount', `-${formatMoney(data.discountTotal)}`, columns))
    }
    job.bold(true).size(1, 2)
    job.line(twoCol('TOTAL', formatMoney(data.totalIncl), columns))
    job.size(1, 1).bold(false)
    if (data.roundingAdj !== 0) {
      job.line(twoCol('Cash rounding', formatMoney(data.roundingAdj), columns))
    }

    for (const t of data.tenders) {
      const label = t.reference ? `${t.name} (${t.reference})` : t.name
      job.line(twoCol(label, formatMoney(t.amount), columns))
    }
    if (data.changeGiven > 0) {
      job.bold(true).line(twoCol('Change', formatMoney(data.changeGiven), columns)).bold(false)
    }

    job.line('-'.repeat(columns))
    for (const rate of data.vatByRate) {
      job.line(
        twoCol(`VAT @ ${rate.ratePct}% on ${formatMoney(rate.excl)}`, formatMoney(rate.vat), columns),
      )
    }

    if (data.loyalty) {
      job.align('center').line(
        `Earned ${data.loyalty.pointsEarned} point${data.loyalty.pointsEarned === 1 ? '' : 's'} · balance ${data.loyalty.balance}`,
      )
      job.align('left')
    }
  }

  if (data.footerText) {
    job.align('center')
    for (const piece of wrapText(data.footerText, columns)) job.line(piece)
    job.align('left')
  }

  return job.feed(3).cut().build()
}

export function renderBill(data: BillData, opts: SlipOptions = {}): Uint8Array {
  const columns = opts.columns ?? 48
  const job = new EscPos().init()

  header(job, data.siteName, columns)
  if (data.vatNumber) job.line(`VAT no. ${data.vatNumber}`)
  job.size(2, 2).line(data.label).size(1, 1)
  job.line([data.covers ? `${data.covers} pax` : '', data.userName, data.printedAt].filter(Boolean).join(' · '))

  // The banner IS the legal difference between this slip and a tax invoice.
  job.bold(true).line('PRO-FORMA - NOT A TAX INVOICE').line('NO PAYMENT HAS BEEN TAKEN').bold(false)

  job.align('left').line('-'.repeat(columns))
  for (const line of data.lines) {
    job.line(twoCol(`${formatQty(line.qty)} x ${line.description}`, formatMoney(line.lineTotalIncl), columns))
    for (const note of line.notes) {
      for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
    }
  }
  job.line('-'.repeat(columns))

  if (data.discountTotal > 0) {
    job.line(twoCol('Discount', `-${formatMoney(data.discountTotal)}`, columns))
  }
  job.line(twoCol('Excl. VAT', formatMoney(data.subtotalExcl), columns))
  for (const rate of data.vatByRate) {
    job.line(twoCol(`VAT @ ${rate.ratePct}%`, formatMoney(rate.vat), columns))
  }
  job.bold(true).size(1, 2).line(twoCol('TOTAL', formatMoney(data.totalIncl), columns)).size(1, 1).bold(false)

  job.align('center').line('Please settle at the table or the counter.')

  return job.feed(3).cut().build()
}

export type KitchenTicketData = {
  /** The table code, or whatever the waiter typed. */
  tableLabel: string
  /** WHO SENT it — the runner delivers to whoever pressed the key. */
  waiter: string
  at: string
  covers: number | null
  lines: {
    qty: number
    description: string
    /** Instruction answers marked prints_on_kitchen. */
    notes: string[]
    /** The free-text line note — "allergy: nuts" MUST reach the kitchen. */
    note: string
  }[]
}

export function renderKitchenTicket(data: KitchenTicketData, opts: SlipOptions = {}): Uint8Array {
  const columns = opts.columns ?? 48
  const job = new EscPos().init()

  job.align('center').size(2, 2).line(data.tableLabel).size(1, 1)
  job.line([data.at, data.waiter, data.covers ? `${data.covers} pax` : ''].filter(Boolean).join(' · '))
  job.align('left').line('-'.repeat(columns))

  for (const line of data.lines) {
    job.size(2, 2).line(`${formatQty(line.qty)} x ${line.description}`).size(1, 1)
    for (const note of line.notes) {
      for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
    }
    if (line.note) {
      job.bold(true)
      for (const piece of wrapText(`  ${line.note}`, columns)) job.line(piece)
      job.bold(false)
    }
  }

  return job.feed(3).cut().build()
}

/** The setup page's "does the printer work" slip. */
export function renderTestSlip(opts: SlipOptions & { siteName: string }): Uint8Array {
  const columns = opts.columns ?? 48
  return new EscPos()
    .init()
    .align('center')
    .size(2, 2)
    .line(opts.siteName)
    .size(1, 1)
    .line('Printer test')
    .align('left')
    .line('-'.repeat(columns))
    .line(twoCol('Two columns line up', formatMoney(1234.56), columns))
    .line('Accents: crème brûlée, für, señor')
    .line('-'.repeat(columns))
    .align('center')
    .line('If this reads cleanly, the till can print.')
    .feed(3)
    .cut()
    .build()
}
