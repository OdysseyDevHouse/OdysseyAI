import { EscPos, twoCol, wrapText } from './encoder'
import { formatMoney, formatQty } from '../decimals'
import type { ReceiptData } from '../receiptData'
import { slipConditionHolds } from '../stationery/conditions'
import { resolveQrUrl, type QrContext } from '../stationery/qrTarget'
import type { SlipBlock, SlipSpec } from '../stationery/slip'

/**
 * A designed slip, as ESC/POS bytes.
 *
 * ── IT MUST REPRODUCE renderReceipt() EXACTLY ─────────────────────────────
 *
 * For the shipped design this emits the same bytes the hard-coded renderer
 * emitted, and the test suite asserts it byte-for-byte. That is what makes the
 * designer safe to switch on: a shop that changes nothing keeps the slip it
 * had, down to the dashes.
 *
 * So the per-block code below is lifted from slips.ts rather than rewritten —
 * the same twoCol calls, the same wrap, the same `-` rule at `columns` wide.
 * Where the two ever differ, this one is wrong.
 *
 * ── GIFT MODE OVERRIDES THE DESIGN ────────────────────────────────────────
 *
 * A gift slip prints no money whatever the design says, exactly as before: the
 * money blocks emit nothing rather than being absent from the spec. A design
 * cannot put prices on a gift receipt.
 */

/**
 * The head's current state, so a command is sent only when it CHANGES.
 *
 * Not an optimisation. A thermal head is a state machine, and emitting
 * `ESC a 1` when it is already centred is a byte the old renderer never sent —
 * which would make this compiler's output differ from renderReceipt() for the
 * shipped design and break the one guarantee that makes the designer safe to
 * turn on. The parity suite compares bytes, and it caught exactly this.
 */
/**
 * What a slip's QR may point at.
 *
 * A receipt is not a document with a public page, so `documentUrl` is null and
 * a slip QR aimed at "this document" prints nothing. The store and review links
 * come from the receipt because the caller put them there — this module reads no
 * settings of its own, exactly as it reads no database.
 */
function qrCtx(data: ReceiptData): QrContext {
  return {
    appUrl: data.qrLinks?.appUrl ?? null,
    storeUrl: data.qrLinks?.storeUrl ?? null,
    reviewUrl: data.qrLinks?.reviewUrl ?? null,
    documentUrl: null,
  }
}

type Head = { align: 'left' | 'center' | 'right'; bold: boolean }

function setAlign(job: EscPos, head: Head, want: 'left' | 'center' | 'right'): void {
  if (head.align === want) return
  job.align(want)
  head.align = want
}

function setBold(job: EscPos, head: Head, want: boolean): void {
  if (head.bold === want) return
  job.bold(want)
  head.bold = want
}

/**
 * Whether this block will put anything on the paper for this sale.
 *
 * Kept beside the emitter and in the same order, because the two must agree:
 * a block that says it prints and then emits nothing leaves stray styling, and
 * one that says it does not while emitting something loses its alignment.
 */
function blockPrints(block: SlipBlock, data: ReceiptData): boolean {
  /*
   * ── A LINE THE DESIGN SAID TO SHOW ONLY SOMETIMES ───────────────────────
   *
   * Asked FIRST, and asked here rather than at the emit site, because this
   * function already feeds the separator logic: a rule with nothing left to
   * divide is dropped, and two rules that end up adjacent collapse to one. A
   * condition answered anywhere else would hide the line and leave its dashes
   * behind.
   *
   * The slip answers a shorter list than a document does — nothing is owed or
   * overdue at a till. See SLIP_CONDITIONS.
   */
  if (!slipConditionHolds(block.showWhen, data)) return false

  const gift = data.gift
  switch (block.kind) {
    case 'siteName':
    case 'title':
    case 'docLine':
    case 'staffLine':
    case 'lines':
    case 'feed':
      return true
    /*
     * A rule divides two things. On a gift slip the money sections below it are
     * suppressed, so a rule that survives is a line under nothing — which is
     * what the old renderer avoided by putting its rules inside the `if
     * (!gift)`. Decided by the CALLER, which knows what follows.
     */
    case 'rule':
      return true
    case 'vatNumber':
      return !!data.vatNumber && !gift
    case 'customer':
      return !!data.customerName
    case 'copyBanner':
      return data.copyNumber > 0 && !gift
    case 'giftNote':
      return gift
    case 'totals':
    case 'tenders':
      return !gift
    case 'tax':
      return !gift && data.vatByRate.length > 0
    case 'loyalty':
      return !gift && !!data.loyalty
    case 'qr':
      /*
       * A QR prints only if it has somewhere to point. The context comes from
       * the caller; a till with no APP_URL and no storefront configured has
       * nothing to encode, and a square that scans to a dead host is worse than
       * no square at all.
       */
      return !!(block.qrTarget && resolveQrUrl(block.qrTarget, block.qrUrl, qrCtx(data)))
    case 'text':
      return !!(block.text?.trim() || data.footerText)
    default:
      return false
  }
}

function emitBlock(
  job: EscPos,
  block: SlipBlock,
  data: ReceiptData,
  columns: number,
  head: Head,
): void {
  const gift = data.gift

  /*
   * A block that prints NOTHING must emit nothing at all — not even the
   * commands that would have styled it.
   *
   * Most blocks are conditional: no VAT number on a non-vendor, no COPY banner
   * on an original, no loyalty line without a customer. Setting bold around a
   * line that never appears leaves `ESC E 1 ESC E 0` on the roll, which is
   * harmless to the paper but is not what the old renderer sent — and the
   * parity suite compares bytes. It is also the honest rule: styling is for
   * something, and there is nothing here.
   */
  if (!blockPrints(block, data)) return

  // Alignment and emphasis are the designer's, applied around whatever the
  // block puts on the paper — and only when the head is not already there.
  if (block.align) setAlign(job, head, block.align)
  if (block.bold) setBold(job, head, true)
  if (block.size && block.size > 1) job.size(block.size, block.size)

  switch (block.kind) {
    case 'qr': {
      const url = block.qrTarget ? resolveQrUrl(block.qrTarget, block.qrUrl, qrCtx(data)) : null
      // blockPrints already refused a QR with nowhere to point, so this is the
      // belt to that braces rather than a second decision.
      if (!url) break
      /*
       * THE PRINTER ENCODES IT. Not a raster — GS ( k hands the payload to the
       * firmware, which lays the modules down at its own dot pitch. See
       * EscPos.qr for the command sequence and the length trap.
       *
       * Centred whatever the block says: a QR is a square on a 48-column roll
       * and the head positions it as a unit, so left-aligning it would put it
       * hard against the tear edge for no benefit.
       */
      setAlign(job, head, 'center')
      job.qr(url, { size: 6 })
      const caption = block.qrCaption?.trim()
      if (caption) job.line(caption.slice(0, columns))
      break
    }

    case 'siteName':
      job.line(data.siteName)
      break

    case 'vatNumber':
      if (data.vatNumber && !gift) job.line(`VAT no. ${data.vatNumber}`)
      break

    case 'title':
      // The one word the slip legally turns on. Bold whether or not the block
      // says so: this is not decoration.
      setBold(job, head, true)
      job.line(gift ? 'GIFT RECEIPT' : 'TAX INVOICE')
      setBold(job, head, false)
      break

    case 'giftNote':
      // Its own block rather than part of the title, because the old renderer
      // printed it AFTER the copy banner — and the parity suite is what said so.
      if (gift) job.line('A gift receipt - prices not shown.')
      break

    case 'docLine':
      job.line(`${data.documentNumber} · ${data.documentDate}`)
      break

    case 'staffLine':
      job.line(
        [data.cashierName, data.terminalCode, data.printedAt].filter(Boolean).join(' · '),
      )
      break

    case 'customer':
      if (data.customerName) {
        job.line(
          data.customerVatNo && !gift
            ? `${data.customerName} · VAT ${data.customerVatNo}`
            : data.customerName,
        )
      }
      break

    case 'copyBanner':
      if (data.copyNumber > 0 && !gift) {
        setBold(job, head, true)
        job.line(`COPY${data.copyNumber > 1 ? ` ${data.copyNumber}` : ''}`)
        setBold(job, head, false)
      }
      break

    case 'lines':
      /*
       * Left unless the designer says otherwise.
       *
       * These rows are built with twoCol(), which pads to put the money hard
       * against the last column — centring them is almost always a mistake,
       * because a price column that does not line up cannot be read down. But
       * it is the designer's mistake to make, and silently ignoring the setting
       * would be worse: they would move the control and see nothing change.
       */
      if (!block.align) setAlign(job, head, 'left')
      for (const line of data.lines) {
        const label = `${formatQty(line.qty)} x ${line.description}`
        if (gift) {
          for (const piece of wrapText(label, columns)) job.line(piece)
        } else {
          job.line(twoCol(label, formatMoney(line.lineTotalIncl), columns))
          if (line.qty !== 1) job.line(`  @ ${formatMoney(line.unitPriceIncl)}`)
        }
        for (const note of line.notes) {
          for (const piece of wrapText(`  ${note}`, columns)) job.line(piece)
        }
      }
      break

    case 'totals':
      if (gift) break
      if (!block.align) setAlign(job, head, 'left')
      if (data.discountTotal > 0) {
        job.line(twoCol('Discount', `-${formatMoney(data.discountTotal)}`, columns))
      }
      // Double height on the one number everybody looks for.
      setBold(job, head, true)
      job.size(1, 2)
      job.line(twoCol('TOTAL', formatMoney(data.totalIncl), columns))
      job.size(1, 1)
      setBold(job, head, false)
      if (data.roundingAdj !== 0) {
        job.line(twoCol('Cash rounding', formatMoney(data.roundingAdj), columns))
      }
      break

    case 'tenders':
      if (gift) break
      if (!block.align) setAlign(job, head, 'left')
      for (const t of data.tenders) {
        const label = t.reference ? `${t.name} (${t.reference})` : t.name
        job.line(twoCol(label, formatMoney(t.amount), columns))
      }
      if (data.changeGiven > 0) {
        setBold(job, head, true)
        job.line(twoCol('Change', formatMoney(data.changeGiven), columns))
        setBold(job, head, false)
      }
      break

    case 'tax':
      if (gift) break
      if (!block.align) setAlign(job, head, 'left')
      for (const rate of data.vatByRate) {
        job.line(
          twoCol(
            `VAT @ ${rate.ratePct}% on ${formatMoney(rate.excl)}`,
            formatMoney(rate.vat),
            columns,
          ),
        )
      }
      break

    case 'loyalty':
      if (gift) break
      if (data.loyalty) {
        job.line(
          `Earned ${data.loyalty.pointsEarned} point${data.loyalty.pointsEarned === 1 ? '' : 's'} · balance ${data.loyalty.balance}`,
        )
      }
      break

    case 'text': {
      /*
       * A `text` block with no words of its own falls back to the site's
       * receipt footer, which is where that setting already lives and what
       * every existing slip prints. A shop that types words here is overriding
       * it for this design.
       */
      const words = block.text?.trim() || data.footerText
      if (words) {
        for (const piece of wrapText(words, columns)) job.line(piece)
      }
      break
    }

    case 'rule':
      // A rule is the full width, so centring it would only add leading space.
      if (!block.align) setAlign(job, head, 'left')
      job.line('-'.repeat(columns))
      break

    case 'feed':
      job.line('')
      break
  }

  // Put the head back to a known state, so one block's emphasis cannot leak
  // into the next — the failure that turns a whole slip bold.
  if (block.size && block.size > 1) job.size(1, 1)
  if (block.bold) setBold(job, head, false)
}

export function renderSlipSpec(
  spec: SlipSpec,
  data: ReceiptData,
  opts: { columns?: 42 | 48 } = {},
): Uint8Array {
  const columns = opts.columns ?? 48
  const job = new EscPos().init()
  /* The head's state after init(): left, not bold. */
  const head: Head = { align: 'left', bold: false }

  /*
   * A separator with nothing after it is not a separator.
   *
   * `rule` and `feed` divide two things, so each is dropped unless some block
   * AFTER it actually prints. On a gift slip the totals, tenders and VAT are
   * all suppressed, and without this the roll ends in three rules under an
   * empty space — which is exactly what the old renderer avoided by nesting its
   * rules inside `if (!gift)`.
   *
   * Decided here rather than in blockPrints() because it is the only judgement
   * on this page that needs to see the whole list.
   */
  const prints = spec.blocks.map((b) => blockPrints(b, data))
  const substantive = spec.blocks.map(
    (b, i) => prints[i] && b.kind !== 'rule' && b.kind !== 'feed',
  )

  let sinceLastRule = 0 // substantive blocks printed since the last separator
  for (let i = 0; i < spec.blocks.length; i++) {
    const block = spec.blocks[i]

    if (block.kind === 'rule' || block.kind === 'feed') {
      // Nothing left to divide from.
      if (!substantive.slice(i + 1).some(Boolean)) continue
      // Nothing before it either — two separators in a row, which happens the
      // moment a suppressed section (the VAT block on a gift slip) falls out
      // from between them. One line, not two.
      if (sinceLastRule === 0) continue
      emitBlock(job, block, data, columns, head)
      sinceLastRule = 0
      continue
    }

    if (prints[i]) sinceLastRule++
    emitBlock(job, block, data, columns, head)
  }

  /*
   * Leave the head where it was found.
   *
   * The old renderer put alignment back to left after its centred footer, and
   * that trailing `ESC a 0` is not cosmetic: alignment survives the cut, so a
   * job that ends centred leaves the NEXT slip centred until something resets
   * it. Restoring here also makes this compiler's bytes identical to
   * renderReceipt()'s, which is the guarantee the parity suite holds us to.
   */
  setAlign(job, head, 'left')
  setBold(job, head, false)

  return job.feed(3).cut().build()
}
