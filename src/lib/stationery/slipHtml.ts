import { formatMoney, formatQty } from '../decimals'
import { escapeHtml } from './render'
import { slipConditionHolds } from './conditions'
import type { ReceiptData } from '../receiptData'
import type { SlipBlock, SlipSpec } from './slip'

/**
 * A designed slip as an HTML string.
 *
 * ── WHY A STRING AND NOT A COMPONENT ──────────────────────────────────────
 *
 * This began as a React component, which is the obvious shape for markup. Next
 * forbids it in the one place that needs it most: importing `react-dom/server`
 * into a server action fails the build, and it is right to — a server action is
 * not a renderer. A component would therefore have needed a string version
 * beside it for the preview, and a slip rendered three ways is a slip that will
 * eventually be rendered three DIFFERENT ways.
 *
 * So there are exactly two renderers of a SlipSpec, and this is one:
 *
 *   lib/escpos/slipSpec.ts   the thermal roll — what the customer receives
 *   this module              the screen, the browser print, and the preview
 *
 * The byte renderer is the authority. The block order, the suppression rules
 * and the separator collapsing here are copied from it deliberately rather than
 * re-derived, so a change there is a change to look for here.
 *
 * Every value is escaped: a product description is user text and this markup
 * is injected into the designer's page.
 */

const ALIGN: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

/*
 * ── SIZES ARE RELATIVE, NOT ABSOLUTE ──────────────────────────────────────
 *
 * A slip prints at 12px over 72mm and these were written as the pixel sizes
 * that produce — 12, 16, 20. In em against that same 12px base they are the
 * identical sizes on paper, but they now follow whatever the container sets,
 * which is what lets the DESIGNER show the slip enlarged without touching what
 * the printer does. See SlipCanvas.
 */
const SIZE: Record<number, string> = {
  1: 'text-[1em]',
  2: 'text-[1.3333em]',
  3: 'text-[1.6667em]',
}

function cls(b: SlipBlock, fallback = 'left'): string {
  return [
    ALIGN[b.align ?? fallback] ?? ALIGN.left,
    SIZE[b.size ?? 1] ?? SIZE[1],
    b.bold ? 'font-bold' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

const row = (label: string, value: string, bold = false) =>
  `<div class="flex justify-between gap-2${bold ? ' font-bold' : ''}">` +
  `<span class="min-w-0 text-ink-2">${escapeHtml(label)}</span>` +
  `<span class="numeric shrink-0 text-ink">${escapeHtml(value)}</span></div>`

/** Whether a block shows anything — mirrors blockPrints() in slipSpec.ts. */
function prints(b: SlipBlock, r: ReceiptData): boolean {
  /*
   * The same first question renderSlipSpec's blockPrints() asks, in the same
   * position, for the same reason — the two prints must not disagree, and a
   * condition answered in one renderer and not the other is precisely the kind
   * of divergence this file exists to prevent.
   */
  if (!slipConditionHolds(b.showWhen, r)) return false

  const gift = r.gift
  switch (b.kind) {
    case 'siteName':
    case 'title':
    case 'docLine':
    case 'staffLine':
    case 'lines':
      return true
    case 'vatNumber':
      return !!r.vatNumber && !gift
    case 'customer':
      return !!r.customerName
    case 'copyBanner':
      return r.copyNumber > 0 && !gift
    case 'giftNote':
      return gift
    case 'totals':
    case 'tenders':
      return !gift
    case 'tax':
      return !gift && r.vatByRate.length > 0
    case 'loyalty':
      return !gift && !!r.loyalty
    case 'text':
      return !!(b.text?.trim() || r.footerText)
    default:
      return false
  }
}

function block(b: SlipBlock, r: ReceiptData): string {
  const gift = r.gift

  switch (b.kind) {
    case 'siteName':
      return `<p class="${cls(b, 'center')} font-semibold text-ink">${escapeHtml(r.siteName)}</p>`

    case 'vatNumber':
      return `<p class="${cls(b, 'center')} text-muted">VAT no. ${escapeHtml(r.vatNumber ?? '')}</p>`

    case 'title':
      return `<p class="${cls(b, 'center')} font-semibold tracking-wide text-ink">${gift ? 'GIFT RECEIPT' : 'TAX INVOICE'}</p>`

    case 'giftNote':
      return `<p class="${cls(b, 'center')} text-muted">A gift receipt — prices not shown.</p>`

    case 'docLine':
      return `<p class="${cls(b, 'center')} text-muted">${escapeHtml(r.documentNumber)} · ${escapeHtml(r.documentDate)}</p>`

    case 'staffLine':
      return `<p class="${cls(b, 'center')} text-muted">${escapeHtml(
        [r.cashierName, r.terminalCode, r.printedAt].filter(Boolean).join(' · '),
      )}</p>`

    case 'customer':
      return `<p class="${cls(b, 'center')} text-ink-2">${escapeHtml(
        r.customerName + (r.customerVatNo && !gift ? ` · VAT ${r.customerVatNo}` : ''),
      )}</p>`

    case 'copyBanner':
      return `<p class="${cls(b, 'center')} font-bold text-warning-ink">COPY${
        r.copyNumber > 1 ? ` ${r.copyNumber}` : ''
      }</p>`

    case 'lines':
      return (
        `<ul class="${cls(b)}">` +
        r.lines
          .map((line) => {
            const label = `${formatQty(line.qty)} × ${line.description}`
            const money = gift
              ? ''
              : `<span class="numeric shrink-0 text-ink">${escapeHtml(formatMoney(line.lineTotalIncl))}</span>`
            const unit =
              !gift && line.qty !== 1
                ? `<div class="text-[0.9167em] text-muted">@ ${escapeHtml(formatMoney(line.unitPriceIncl))}</div>`
                : ''
            const notes = line.notes
              .map((n) => `<div class="pl-3 text-[0.9167em] text-muted">${escapeHtml(n)}</div>`)
              .join('')
            return (
              `<li class="py-0.5"><div class="flex justify-between gap-2">` +
              `<span class="min-w-0 flex-1 text-ink">${escapeHtml(label)}</span>${money}</div>` +
              unit +
              notes +
              `</li>`
            )
          })
          .join('') +
        `</ul>`
      )

    case 'totals':
      return (
        `<div class="${cls(b)}">` +
        (r.discountTotal > 0 ? row('Discount', `−${formatMoney(r.discountTotal)}`) : '') +
        `<div class="flex justify-between gap-2 text-[1.1667em] font-bold">` +
        `<span class="text-ink">TOTAL</span>` +
        `<span class="numeric text-ink">${escapeHtml(formatMoney(r.totalIncl))}</span></div>` +
        (r.roundingAdj !== 0 ? row('Cash rounding', formatMoney(r.roundingAdj)) : '') +
        `</div>`
      )

    case 'tenders':
      return (
        `<div class="${cls(b)}">` +
        r.tenders
          .map((t) => row(t.reference ? `${t.name} (${t.reference})` : t.name, formatMoney(t.amount)))
          .join('') +
        (r.changeGiven > 0 ? row('Change', formatMoney(r.changeGiven), true) : '') +
        `</div>`
      )

    case 'tax':
      return (
        `<div class="${cls(b)} text-[0.9167em]">` +
        r.vatByRate
          .map((rate) =>
            row(`VAT @ ${rate.ratePct}% on ${formatMoney(rate.excl)}`, formatMoney(rate.vat)),
          )
          .join('') +
        `</div>`
      )

    case 'loyalty':
      return `<p class="${cls(b, 'center')} text-[0.9167em] text-muted">Earned ${
        r.loyalty!.pointsEarned
      } point${r.loyalty!.pointsEarned === 1 ? '' : 's'} · balance ${r.loyalty!.balance}</p>`

    case 'text': {
      const words = b.text?.trim() || r.footerText
      return `<p class="${cls(b, 'center')} whitespace-pre-line text-muted">${escapeHtml(words)}</p>`
    }

    case 'rule':
      return `<hr class="my-1 border-border">`

    case 'feed':
      return `<div class="h-3"></div>`

    default:
      return ''
  }
}

export function slipPreviewHtml(spec: SlipSpec, receipt: ReceiptData): string {
  // Separator collapsing, copied from renderSlipSpec so the preview shows the
  // same roll: a rule with nothing after it, or nothing before it, is dropped.
  const substantive = spec.blocks.map(
    (b) => b.kind !== 'rule' && b.kind !== 'feed' && prints(b, receipt),
  )

  const out: string[] = []
  let sinceLastRule = 0
  for (let i = 0; i < spec.blocks.length; i++) {
    const b = spec.blocks[i]
    if (b.kind === 'rule' || b.kind === 'feed') {
      if (!substantive.slice(i + 1).some(Boolean)) continue
      if (sinceLastRule === 0) continue
      out.push(block(b, receipt))
      sinceLastRule = 0
      continue
    }
    if (!prints(b, receipt)) continue
    sinceLastRule++
    out.push(block(b, receipt))
  }

  return (
    `<article class="mx-auto w-full max-w-[72mm] bg-surface p-3 text-[12px] text-ink">` +
    out.join('') +
    `</article>`
  )
}

/**
 * Each block's own markup, keyed by its INDEX in the design.
 *
 * ── FOR THE DESIGNER, WHICH DRAWS EVERY BLOCK IN A BOX ────────────────────
 *
 * The A4 canvas has compileBlocks for exactly this reason and the argument is
 * the same here: a designer that draws its own idea of a block is a designer
 * that can lie about the roll. These fragments come from the SAME `block`
 * function slipPreviewHtml uses, so what a shop clicks on is what prints.
 *
 * ── AN EMPTY STRING MEANS "PRINTS NOTHING TODAY" ──────────────────────────
 *
 * A VAT number block on a non-vendor, a customer block on a cash sale, a gift
 * note on an ordinary slip. The canvas still has to SHOW those — they are part
 * of the design and a shop must be able to select and reorder them — but it has
 * to show them as what they are, rather than pretending they carry text.
 *
 * Keyed by index rather than by id because a slip block has no id: the design is
 * an ordered list, and position IS identity. Two rules in a design are the same
 * block in different places, which is the correct reading of a list.
 */
export function slipBlockHtml(spec: SlipSpec, receipt: ReceiptData): string[] {
  return spec.blocks.map((b) => {
    /*
     * A RULE AND A BLANK LINE ALWAYS DRAW.
     *
     * The prints() helper answers "does this block have anything to SAY", and a
     * separator says nothing — so it returns false for both, which is right for
     * the whole-slip renderer, where they are handled separately and collapsed
     * when they would strand at an edge.
     *
     * On the canvas the question is different: this block IS a line across the
     * paper, and a designer clicking one must see the line rather than a note
     * saying it has nothing to show. Asking prints() here reported both as
     * blank, which is how it read on screen.
     */
    if (b.kind === 'rule' || b.kind === 'feed') return block(b, receipt)
    return prints(b, receipt) ? block(b, receipt) : ''
  })
}
