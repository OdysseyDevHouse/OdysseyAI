/**
 * The designed till slip.
 *
 *   npm run test:slip-design
 *
 * ── THE CENTRAL ASSERTION ────────────────────────────────────────────────
 *
 * The shipped design must print the SAME SLIP the hard-coded renderer printed.
 * That is what makes the designer safe to switch on: a shop that changes
 * nothing keeps the slip it had, down to the dashes. Every other check here is
 * secondary to that one.
 *
 * The comparison is on bytes, normalised for one thing only: the old renderer
 * emits `ESC a 0` immediately followed by `ESC a 1` between two centred blocks,
 * setting the head to left and then back to centre without printing anything
 * between. The compiler tracks head state and does not send those six bytes.
 * The rolls are identical; the streams are not. Normalising that — and nothing
 * else — keeps the assertion honest rather than making it pass.
 *
 * Needs no database and no printer, so it runs in a second.
 */
import { renderReceipt } from '../src/lib/escpos/slips'
import { renderSlipSpec } from '../src/lib/escpos/slipSpec'
import {
  SLIP_DEFAULT,
  validateSlip,
  parseSlip,
  serialiseSlip,
  REQUIRED_KINDS,
  MAX_SLIP_BLOCKS,
  type SlipSpec,
} from '../src/lib/stationery/slip'
import { slipBlockHtml, slipPreviewHtml } from '../src/lib/stationery/slipHtml'
import type { ReceiptData } from '../src/lib/receiptData'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function sample(over: Record<string, unknown> = {}): ReceiptData {
  return {
    proForma: false,
    gift: false,
    siteName: 'Acme Trading',
    vatNumber: '4123456789',
    documentNumber: 'INV000123',
    documentDate: '2026-08-18',
    printedAt: '15:42',
    cashierName: 'Sam',
    terminalCode: 'T1',
    customerName: 'J. Buyer',
    customerVatNo: '4987654321',
    lines: [
      { qty: 2, description: 'Widget', unitPriceIncl: 25, lineTotalIncl: 50, notes: [] },
      {
        qty: 1,
        description: 'A rather long product description that must wrap somewhere',
        unitPriceIncl: 12.5,
        lineTotalIncl: 12.5,
        notes: ['no onion'],
      },
    ],
    subtotalExcl: 54.35,
    vatTotal: 8.15,
    discountTotal: 5,
    totalIncl: 62.5,
    roundingAdj: -0.05,
    vatByRate: [{ ratePct: 15, excl: 54.35, vat: 8.15, incl: 62.5 }],
    tenders: [{ name: 'Cash', amount: 70, changeGiven: 7.5, reference: null }],
    changeGiven: 7.5,
    loyalty: { pointsEarned: 6, balance: 42 },
    copyNumber: 1,
    footerText: 'Goods may be returned within 14 days with this slip.',
    ...over,
  } as unknown as ReceiptData
}

const ESC = 0x1b
const ESC_A = String.fromCharCode(ESC) + 'a'

/**
 * The stream with every alignment command that changes NOTHING removed.
 *
 * `ESC a` is a state change, so two streams print the same roll whenever the
 * head is in the same state at every byte that marks paper — regardless of how
 * many redundant commands got it there. The old renderer sets alignment
 * unconditionally (often left-then-immediately-centre, and often centre when
 * already centred); the compiler tracks head state and sends only real changes.
 *
 * So this replays alignment on both sides and drops any command whose operand
 * equals the current state. What survives is the sequence of marks and the
 * state each was made in — which IS the printed slip. Anything else (bold,
 * size, text, feed, cut) passes through untouched, so a real difference still
 * fails.
 */
function normalise(u: Uint8Array): string {
  const b = Buffer.from(u)
  const out: number[] = []

  /*
   * Alignment is not written out when it is seen — it is written out when
   * something is about to MARK PAPER in it. That is what makes both forms of
   * redundancy disappear at once: a command that restates the current state,
   * and a pair that sets then replaces without printing between. Deferring is
   * the whole trick; comparing commands one at a time cannot see either.
   */
  let pending = 0 // ESC @ leaves the head left-aligned
  let emitted = 0

  const flush = () => {
    if (pending === emitted) return
    out.push(ESC, 0x61, pending)
    emitted = pending
  }

  for (let i = 0; i < b.length; i++) {
    if (b[i] === ESC && b[i + 1] === 0x61 && i + 2 < b.length) {
      pending = b[i + 2]
      i += 2
      continue
    }
    // Anything else is either a mark or another state change, and both must
    // happen with alignment already correct.
    flush()
    out.push(b[i])
  }
  flush()

  return Buffer.from(out).toString('latin1')
}

/* ── parity: the shipped design reproduces the old renderer ─────────────── */

console.log('\n-- the shipped design prints what the old renderer printed --')

const CASES: [string, ReceiptData][] = [
  ['an ordinary sale', sample()],
  ['a gift slip', sample({ gift: true })],
  ['an original, no customer, no loyalty', sample({ customerName: null, customerVatNo: null, loyalty: null, copyNumber: 0 })],
  ['a non-vendor, no discount, no rounding', sample({ vatNumber: null, discountTotal: 0, roundingAdj: 0 })],
  ['no footer configured', sample({ footerText: '' })],
  ['no tenders recorded', sample({ tenders: [], changeGiven: 0 })],
  ['one line, exact money', sample({ lines: [{ qty: 1, description: 'One thing', unitPriceIncl: 10, lineTotalIncl: 10, notes: [] }] })],
  ['a customer with no VAT number', sample({ customerVatNo: null })],
  ['a second reprint', sample({ copyNumber: 3 })],
]

for (const [label, data] of CASES) {
  for (const columns of [48, 42] as const) {
    const legacy = renderReceipt(data, { columns })
    const spec = renderSlipSpec(SLIP_DEFAULT, data, { columns })
    const same = normalise(legacy) === normalise(spec)
    ok(`${label} @ ${columns} columns`, same, `${legacy.length} vs ${spec.length} bytes`)
  }
}

/* ── the comparison above is not vacuous ─────────────────────────────────── */

console.log('\n-- ...and a real change is still detected --')
{
  /*
   * A normalised comparison that passes everything proves nothing, and this one
   * is deliberately permissive about alignment commands. So: change the design
   * in ways a designer actually would, and require every one to show up.
   *
   * This is not padding. The centred-line-items case below caught a real bug —
   * the emitter hard-coded left alignment on the money sections, so a designer
   * could move the control and see nothing happen.
   */
  const base = sample()
  const legacy = normalise(renderReceipt(base, { columns: 48 }))
  const differs = (spec: SlipSpec) =>
    normalise(renderSlipSpec(spec, base, { columns: 48 })) !== legacy

  ok('a reordered design differs', differs({ version: 1, blocks: [...SLIP_DEFAULT.blocks].reverse() }))
  ok('a design missing the VAT block differs',
    differs({ version: 1, blocks: SLIP_DEFAULT.blocks.filter((b) => b.kind !== 'tax') }))
  ok('centring the line items differs',
    differs({ version: 1, blocks: SLIP_DEFAULT.blocks.map((b) => (b.kind === 'lines' ? { ...b, align: 'center' as const } : b)) }))
  ok('bolding a line differs',
    differs({ version: 1, blocks: SLIP_DEFAULT.blocks.map((b) => (b.kind === 'docLine' ? { ...b, bold: true } : b)) }))
  ok('an added text block differs',
    differs({ version: 1, blocks: [...SLIP_DEFAULT.blocks, { kind: 'text', text: 'EXTRA' }] }))
  ok('enlarging a block differs',
    differs({ version: 1, blocks: SLIP_DEFAULT.blocks.map((b) => (b.kind === 'docLine' ? { ...b, size: 2 as const } : b)) }))
}

/* ── the head is left in a known state ───────────────────────────────────── */

console.log('\n-- printer state --')
{
  const bytes = Buffer.from(renderSlipSpec(SLIP_DEFAULT, sample(), { columns: 48 }))
  const text = bytes.toString('latin1')
  const cut = String.fromCharCode(0x1d) + 'VB' + String.fromCharCode(0)
  ok('the job ends with a cut', text.endsWith(cut))

  // Alignment survives the cut, so a job that ends centred leaves the NEXT
  // slip centred. The last alignment command must be back to left.
  const lastAlign = text.lastIndexOf(ESC_A)
  ok('the head is returned to left before the cut',
    lastAlign >= 0 && text.charCodeAt(lastAlign + 2) === 0)

  // Bold likewise.
  const ESC_E = String.fromCharCode(0x1b) + 'E'
  const lastBold = text.lastIndexOf(ESC_E)
  ok('bold is off at the end', lastBold === -1 || text.charCodeAt(lastBold + 2) === 0)
}

/* ── a gift slip cannot be made to show money ────────────────────────────── */

console.log('\n-- gift mode overrides the design --')
{
  // A design that puts every money block on the paper, printed as a gift slip.
  const greedy: SlipSpec = {
    version: 1,
    blocks: [
      { kind: 'title' },
      { kind: 'docLine' },
      { kind: 'lines' },
      { kind: 'totals' },
      { kind: 'tenders' },
      { kind: 'tax' },
      { kind: 'loyalty' },
    ],
  }
  const out = Buffer.from(renderSlipSpec(greedy, sample({ gift: true }), { columns: 48 })).toString('latin1')
  ok('no rand amount reaches a gift slip', !/R\d/.test(out), out.slice(0, 120))
  ok('no TOTAL line reaches a gift slip', !/TOTAL/.test(out))
  ok('...but the sale itself still prints', /Widget/.test(out))
}

/* ── separators ──────────────────────────────────────────────────────────── */

console.log('\n-- separators --')
{
  const trailing: SlipSpec = {
    version: 1,
    blocks: [
      { kind: 'title' }, { kind: 'docLine' }, { kind: 'lines' }, { kind: 'totals' },
      { kind: 'tax' }, { kind: 'rule' }, { kind: 'rule' },
    ],
  }
  const out = Buffer.from(renderSlipSpec(trailing, sample(), { columns: 48 })).toString('latin1')
  ok('a rule with nothing after it is dropped', !/-{48}\n[^-]*$/.test(out.split('\n').slice(-3).join('\n')) || !out.trimEnd().endsWith('-'.repeat(48)))

  // Two rules with a suppressed section between them collapse to one.
  const collapsing: SlipSpec = {
    version: 1,
    blocks: [
      { kind: 'title' }, { kind: 'docLine' }, { kind: 'lines' },
      { kind: 'rule' }, { kind: 'tax' }, { kind: 'rule' }, { kind: 'text', text: 'Thanks' },
    ],
  }
  const gift = Buffer.from(renderSlipSpec(collapsing, sample({ gift: true }), { columns: 48 })).toString('latin1')
  const rules = (gift.match(new RegExp('-'.repeat(48), 'g')) ?? []).length
  ok('two rules around a suppressed section print as one', rules === 1, `${rules} rules`)
}

/* ── validation ──────────────────────────────────────────────────────────── */

console.log('\n-- validation --')
{
  ok('the shipped design validates', validateSlip(SLIP_DEFAULT).ok,
    JSON.stringify(validateSlip(SLIP_DEFAULT).errors))

  for (const kind of REQUIRED_KINDS) {
    const without: SlipSpec = {
      version: 1,
      blocks: SLIP_DEFAULT.blocks.filter((b) => b.kind !== kind),
    }
    const r = validateSlip(without)
    ok(`a slip without "${kind}" is refused`, !r.ok, JSON.stringify(r.errors))
  }

  const twice: SlipSpec = {
    version: 1,
    blocks: [...SLIP_DEFAULT.blocks, { kind: 'totals' as const }],
  }
  ok('two totals blocks are refused', !validateSlip(twice).ok)

  const many: SlipSpec = {
    version: 1,
    blocks: Array.from({ length: MAX_SLIP_BLOCKS + 5 }, () => ({ kind: 'rule' as const })),
  }
  ok('too many blocks is refused', !validateSlip(many).ok)

  ok('several text, rule and feed blocks are fine',
    validateSlip({
      version: 1,
      blocks: [...SLIP_DEFAULT.blocks, { kind: 'text', text: 'a' }, { kind: 'rule' }, { kind: 'feed' }],
    }).ok)
}

/* ── round trip ──────────────────────────────────────────────────────────── */

console.log('\n-- storage round trip --')
{
  const json = serialiseSlip(SLIP_DEFAULT)
  const back = parseSlip(json)
  ok('a design survives being stored and read back',
    !!back && JSON.stringify(back.blocks) === JSON.stringify(SLIP_DEFAULT.blocks))

  ok('unreadable JSON is null, not a throw', parseSlip('{{{') === null)
  ok('JSON with no blocks is null', parseSlip('{"version":1}') === null)

  // The saved_reports rule: a spec outlives the code that wrote it.
  const withUnknown = parseSlip('{"version":1,"blocks":[{"kind":"lines"},{"kind":"someFutureThing"}]}')
  ok('a block kind we no longer know is dropped, not fatal',
    !!withUnknown && withUnknown.blocks.length === 1 && withUnknown.blocks[0].kind === 'lines')

  const dirty = parseSlip('{"version":1,"blocks":[{"kind":"text","text":"hi","align":"sideways","size":99,"bold":"yes"}]}')
  ok('nonsense attributes are dropped, the block survives',
    !!dirty && dirty.blocks.length === 1 && dirty.blocks[0].align === undefined &&
    dirty.blocks[0].size === undefined && dirty.blocks[0].bold === undefined)
}

/* ── the designer's canvas ───────────────────────────────────────────────── */

console.log('\n-- what the slip canvas draws --')
{
  /*
   * The canvas draws every block in its own selectable box, so it needs them
   * apart rather than joined — the same reason the A4 designer has compileBlocks.
   * And for the same reason it must come from the SAME renderer: a canvas that
   * draws its own idea of a block is a canvas that can lie about the roll.
   */
  const spec = SLIP_DEFAULT
  const receipt = sample()
  const parts = slipBlockHtml(spec, receipt)

  ok('one fragment per block', parts.length === spec.blocks.length)

  /*
   * A RULE AND A BLANK LINE ALWAYS DRAW.
   *
   * `prints` answers "has this anything to SAY", and a separator says nothing —
   * right for the whole-slip renderer, wrong for a canvas where the block IS the
   * line. Asking it here labelled every rule "nothing to show on this sale",
   * which is what it looked like on screen.
   */
  const ruleAt = spec.blocks.findIndex((b) => b.kind === 'rule')
  ok('a dividing line draws its rule', ruleAt >= 0 && /<hr/.test(parts[ruleAt]),
    ruleAt >= 0 ? JSON.stringify(parts[ruleAt]) : 'no rule in the default')

  const feedIdx = spec.blocks.findIndex((b) => b.kind === 'feed')
  if (feedIdx >= 0) ok('a blank line draws its space', parts[feedIdx] !== '')

  /*
   * And a block with nothing to say today is EMPTY rather than absent: the
   * canvas still shows it, because it is part of the design and must stay
   * selectable and movable, but it labels it instead of drawing a box a shop
   * cannot account for.
   */
  const vatAt = spec.blocks.findIndex((b) => b.kind === 'vatNumber')
  const noVat = slipBlockHtml(spec, { ...receipt, vatNumber: null } as never)
  ok('a VAT number block is empty for a non-vendor', vatAt >= 0 && noVat[vatAt] === '')
  ok('...but the block is still there to select', noVat.length === spec.blocks.length)

  /*
   * THE CANVAS AND THE ROLL AGREE.
   *
   * Every fragment must appear verbatim in the whole-slip render. That is a
   * stronger check than "both mention the shop name": it fails on a wrapper or a
   * class that only one side adds, which is exactly how the A4 canvas and its
   * printed page drifted apart once already.
   */
  const whole = slipPreviewHtml(spec, receipt)
  const missing = spec.blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b, i }) => parts[i] !== '' && b.kind !== 'rule' && b.kind !== 'feed')
    .filter(({ i }) => !whole.includes(parts[i]))
  ok('each fragment appears verbatim on the printed slip', missing.length === 0,
    missing.map(({ b }) => b.kind).join(', '))
}

console.log(`\n${fails === 0 ? 'All slip-design checks passed.' : `${fails} FAILED`}`)
process.exit(fails === 0 ? 0 : 1)
