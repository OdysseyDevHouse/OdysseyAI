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
  if (data.vatNumber && !data.gift) job.line(`${data.taxLabel ?? 'VAT'} no. ${data.vatNumber}`)
  job.bold(true).line(data.gift ? 'GIFT RECEIPT' : 'TAX INVOICE').bold(false)
  job.line(`${data.documentNumber} · ${data.documentDate}`)
  job.line([data.cashierName, data.terminalCode, data.printedAt].filter(Boolean).join(' · '))
  if (data.customerName) {
    job.line(
      data.customerVatNo && !data.gift
        ? `${data.customerName} · ${data.taxLabel ?? 'VAT'} ${data.customerVatNo}`
        : data.customerName,
    )
  }
  if (data.copyNumber > 0 && !data.gift) {
    job.bold(true).line(`COPY${data.copyNumber > 1 ? ` ${data.copyNumber}` : ''}`).bold(false)
  }
  if (data.gift) job.line('A gift receipt - prices not shown.')

  job.align('left').line('-'.repeat(columns))

  for (const line of data.lines) {
    const label = `${formatQty(line.qty, { exact: true })} x ${line.description}`
    if (data.gift) {
      for (const piece of wrapText(label, columns)) job.line(piece)
    } else {
      job.line(twoCol(label, formatMoney(line.lineTotalIncl), columns))
      if (line.qty !== 1) job.line(`  @ ${formatMoney(line.unitPriceIncl)}`)
      /* What came off this line and why — ASCII throughout, like every other
         money row here: the encoder folds '·' to '.' and there is no minus
         sign on the roll.
         A REWARD line has a special but no discount: the promotion handed it
         over rather than reducing it, so the money column reads "Free" and a
         R0.00 line stops looking like a pricing error. */
      if (line.discountIncl > 0 || line.specialName) {
        const off = line.discountIncl > 0
          ? `${line.specialName ? ' - ' : ''}${formatQty(line.discountPct, { exact: true })}% off`
          : ''
        job.line(
          twoCol(
            `  ${line.specialName ?? ''}${off}`,
            line.discountIncl > 0 ? `-${formatMoney(line.discountIncl)}` : 'Free',
            columns,
          ),
        )
      }
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
        twoCol(`${data.taxLabel ?? 'VAT'} @ ${rate.ratePct}% on ${formatMoney(rate.excl)}`, formatMoney(rate.vat), columns),
      )
    }

    if (data.loyalty) {
      job.align('center').line(
        `Earned ${data.loyalty.pointsEarned} point${data.loyalty.pointsEarned === 1 ? '' : 's'} · balance ${data.loyalty.balance}`,
      )
      job.align('left')
    }
  }

  /*
   * The sale's custom comments, above the footer.
   *
   * Already filtered to the ones marked to print and already formatted — see
   * ReceiptData.comments. This lays them out and decides nothing.
   *
   * Wrapped, because a label and an answer together can exceed 40 columns on a
   * narrow roll and an un-wrapped line is silently truncated by the printer
   * rather than by anything that could warn about it.
   *
   * NOT on a gift slip. That slip exists to hide what the sale was worth, and
   * an answer captured at the pad is exactly the sort of thing — a name, an
   * account reference — the giver did not mean to send along with it.
   */
  if (!data.gift && data.comments?.length) {
    job.line('-'.repeat(columns))
    for (const c of data.comments) {
      for (const piece of wrapText(`${c.label}: ${c.value}`, columns)) job.line(piece)
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
  if (data.vatNumber) job.line(`${data.taxLabel ?? 'VAT'} no. ${data.vatNumber}`)
  job.size(2, 2).line(data.label).size(1, 1)
  job.line([data.covers ? `${data.covers} pax` : '', data.userName, data.printedAt].filter(Boolean).join(' · '))

  // The banner IS the legal difference between this slip and a tax invoice.
  job.bold(true).line('PRO-FORMA - NOT A TAX INVOICE').line('NO PAYMENT HAS BEEN TAKEN').bold(false)

  job.align('left').line('-'.repeat(columns))
  for (const line of data.lines) {
    job.line(twoCol(`${formatQty(line.qty, { exact: true })} x ${line.description}`, formatMoney(line.lineTotalIncl), columns))
    for (const note of line.notes) {
      for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
    }
  }
  job.line('-'.repeat(columns))

  if (data.discountTotal > 0) {
    job.line(twoCol('Discount', `-${formatMoney(data.discountTotal)}`, columns))
  }
  job.line(twoCol(`Excl. ${data.taxLabel ?? 'VAT'}`, formatMoney(data.subtotalExcl), columns))
  for (const rate of data.vatByRate) {
    job.line(twoCol(`${data.taxLabel ?? 'VAT'} @ ${rate.ratePct}%`, formatMoney(rate.vat), columns))
  }
  job.bold(true).size(1, 2).line(twoCol('TOTAL', formatMoney(data.totalIncl), columns)).size(1, 1).bold(false)

  job.align('center').line('Please settle at the table or the counter.')

  return job.feed(3).cut().build()
}

export type KitchenTicketLine = {
  qty: number
  description: string
  /** Instruction answers marked prints_on_kitchen. */
  notes: string[]
  /** The free-text line note — "allergy: nuts" MUST reach the kitchen. */
  note: string
}

export type KitchenTicketData = {
  /** The table code, or whatever the waiter typed. */
  tableLabel: string
  /**
   * Which logical printer this copy is for — "Bar", "Grill".
   *
   * Printed because one order can produce several tickets, and a docket that
   * cannot say which station it belongs to is a docket somebody has to guess
   * about when two of them come off the same machine during a queue.
   */
  printerName: string
  /** WHO SENT it — the runner delivers to whoever pressed the key. */
  waiter: string
  at: string
  covers: number | null
  /**
   * A STOP-COOKING notice rather than an order.
   *
   * Printed with a banner, rules above and below, and every quantity marked so
   * it cannot be mistaken for a new order at a glance across a hot pass. That
   * is the whole design constraint: a chef reads these at arm's length while
   * doing something else, and a cancellation that looks like an order is worse
   * than no cancellation at all — it ADDS a plate instead of removing one.
   */
  cancelled?: boolean
  /** Why it was cancelled, when the till was told. Blank when it was not. */
  reason?: string
  /**
   * The courses, in the order they should be worked.
   *
   * A group with an empty title prints under no heading — see
   * groupKitchenLines, which always puts that one last.
   */
  groups: { title: string; lines: KitchenTicketLine[] }[]
}

export function renderKitchenTicket(data: KitchenTicketData, opts: SlipOptions = {}): Uint8Array {
  const columns = opts.columns ?? 48
  const job = new EscPos().init()

  /* The banner leads, ABOVE the table. A chef reads the top line of a docket
     and nothing else until they know what kind of docket it is, so "what is
     this" has to come before "whose is it". Rules top and bottom so it reads as
     a block rather than a heading somebody's eye can slide past. */
  if (data.cancelled) {
    job.align('center')
    job.line('*'.repeat(columns))
    job.size(2, 2).bold(true).line('** CANCELLED **').bold(false).size(1, 1)
    job.line('DO NOT MAKE — take these off')
    job.line('*'.repeat(columns))
  }

  job.align('center').size(2, 2).line(data.tableLabel).size(1, 1)
  if (data.printerName) job.bold(true).line(data.printerName).bold(false)
  job.line([data.at, data.waiter, data.covers ? `${data.covers} pax` : ''].filter(Boolean).join(' · '))
  /* The reason, when the till was given one. A chef who can see WHY reads a
     cancellation as information rather than as somebody messing them about —
     "wrong table" and "customer left" call for different responses to the food
     already on the pass. */
  if (data.cancelled && data.reason) {
    for (const piece of wrapText(data.reason, columns)) job.line(piece)
  }
  job.align('left').line('-'.repeat(columns))

  /* Only worth a heading when there is something to tell APART. A single
     course would otherwise print "STARTERS" over a ticket whose every line is
     a starter, which is noise on an 80mm roll. */
  const showHeadings = data.groups.filter((g) => g.title).length > 0 && data.groups.length > 1

  for (const group of data.groups) {
    if (showHeadings && group.title) {
      job.bold(true).line(group.title.toUpperCase()).bold(false)
    }
    for (const line of group.lines) {
      /* Every quantity carries the word on a cancellation, not just the header.
         A docket can be torn, or read from halfway down while it is still
         coming off the roll, and a bare "2 x Steak" in that state is an ORDER. */
      const qty = `${formatQty(line.qty, { exact: true })} x ${line.description}`
      job.size(2, 2).line(data.cancelled ? `CANCEL ${qty}` : qty).size(1, 1)
      for (const note of line.notes) {
        for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
      }
      if (line.note) {
        job.bold(true)
        for (const piece of wrapText(`  ${line.note}`, columns)) job.line(piece)
        job.bold(false)
      }
    }
  }

  /* Closed as well as opened. The paper is torn from the top, so the LAST thing
     under a chef's thumb as they pull it off should still say what it is. */
  if (data.cancelled) {
    job.align('center').line('*'.repeat(columns)).line('** CANCELLED **')
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
