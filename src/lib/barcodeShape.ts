/**
 * A scale barcode shape, broken into the segments a person can look at.
 *
 * Pure and free of `server-only` for the same reason `barcodes.ts` is: this is
 * arithmetic about a shape, and the screen that draws it is a client component.
 *
 * ── WHY THIS IS NOT INSIDE THE DIAGRAM COMPONENT ───────────────────────────
 *
 * Because it has to be TESTED. The segments describe how the till reads money
 * out of a label, and a diagram that quietly disagrees with the parser is worse
 * than no diagram: it would show a shopkeeper a picture confirming the setup is
 * right on exactly the day it is wrong. Splitting the arithmetic out means
 * test-scale-barcode-rules.ts can assert the picture and the parse agree on the
 * same label.
 *
 * ── THE ONE RULE TO KEEP ───────────────────────────────────────────────────
 *
 * `parseVariableBarcode` counts the value BACK from the end — past the trailing
 * check digit — and treats whatever sits between the stock code and that slice
 * as digits to skip. This file must segment the same way round. Deriving the
 * skipped run by subtraction, rather than by walking forward from the stock
 * code, is what keeps the two in step.
 *
 * ── THE TRAILING DIGIT IS NOT OPTIONAL ─────────────────────────────────────
 *
 * It used to be drawn only when `hasCheckDigit` was set, which produced a
 * 12-digit label with a hole at the end — a barcode that cannot be printed.
 * EAN-13 ends in a check digit by construction; no setting on this screen can
 * remove it. So the last segment is UNCONDITIONAL, and the flag means the thing
 * a shop actually has to decide: whether the digit between the stock code and
 * the value is a second check digit to skip, or the first digit of the money.
 *
 * That is a real fork with real consequences. On 21 1234 9 15999 4 read with a
 * leftover-width value, the till either charges 159.99 or 9159.99 — and the two
 * shapes are indistinguishable from the four numbers on the form, which is the
 * entire reason this diagram exists.
 *
 * The skipped run is DERIVED, never invented. It is drawn only when the widths
 * leave a gap on a 13-digit label; padding the picture with a digit that is not
 * there was the other half of the same bug.
 */

export type ScaleShape = {
  prefix: string
  pluLength: number
  /**
   * A SECOND check digit sits between the stock code and the value.
   *
   * NOT "this label has a check digit". Every scale label ends in one — the
   * symbology requires it, and a shop cannot turn it off — so a flag for that
   * would be a question with one answer. See THE TRAILING DIGIT below.
   */
  hasCheckDigit: boolean
  /** The value's own width. 0 means "whatever is left over". */
  valueLength: number
  decimals: number
}

export type ShapeSegment = {
  key: string
  label: string
  digits: string
  tone: 'identity' | 'value' | 'skipped'
}

export type ShapeBreakdown =
  | { ok: false; reason: string }
  | { ok: true; segments: ShapeSegment[]; total: number; value: string }

/**
 * The sample digits.
 *
 * Fixed rather than random: a diagram whose numbers change on every keystroke
 * is read as data rather than as an illustration, and somebody would eventually
 * try to look their own product up by it. `1234…` also makes a mis-set stock
 * code length obvious at a glance — the digits count up, so a segment holding
 * `123` when it should hold `1234` reads wrong immediately.
 */
const STOCK_SAMPLE = '123456789012'

/**
 * The sample value, built to the width the shape asks for.
 *
 * NOT a fixed string sliced to length. The first version was `000001599`, taken
 * from the end — which reads 15.99 at five digits and 15.99 at six, because the
 * extra digit it picks up is a leading zero. The width control therefore looked
 * as though it did nothing, on the one diagram whose whole job is to show what
 * the widths do.
 *
 * So the amount SCALES with the width: the last two digits are the cents and
 * everything before them counts up, giving 15.99 at four, 159.99 at five,
 * 1599.99 at six. A change to the field visibly changes the money, which is the
 * relationship the picture exists to teach.
 */
function valueSample(width: number, decimals: number): string {
  /* Build from the right: `decimals` digits of cents, then a body that grows.
     `99` and a run of `159…` are arbitrary but deliberately not round — 000000
     would hide an off-by-one, and a repeated digit would hide a mis-slice. */
  const cents = '99'.repeat(decimals).slice(0, decimals)
  const bodyWidth = Math.max(0, width - decimals)
  const body = '1598476'.slice(0, bodyWidth).padStart(bodyWidth, '1')
  return (body + cents).slice(0, width) || '0'
}

/**
 * The digit a scale prints between the stock code and the value.
 *
 * A single `9`, because that is overwhelmingly what it is in the wild — a check
 * digit guarding the stock code, as on a real Avery label: 2 12345 6 01599 6.
 *
 * Deliberately NOT a digit that could pass for part of the price. On a value
 * width of 0 — where the till takes everything left over — unticking the box
 * hands this 9 to the value, and the price visibly jumps. On a FIXED width the
 * shopkeeper has named the value's size, so the label simply gets a digit
 * shorter instead; both are honest, and both are what the till would do.
 */
const SKIPPED_SAMPLE = '9'

/**
 * Break a shape into labelled segments, using a generated sample label.
 *
 * Returns a reason rather than throwing when the shape cannot describe a
 * barcode: the form this drives is INCOMPLETE most of the time somebody is
 * typing into it, and a half-typed field is not an error worth shouting about.
 */
export function segmentScaleBarcode(shape: ScaleShape): ShapeBreakdown {
  const prefix = shape.prefix.trim()

  /* The label's own last digit, always. Not a setting — see the header. */
  const CHECK = 1

  if (!/^\d+$/.test(prefix)) {
    return { ok: false, reason: 'Enter a prefix to see how a label is read.' }
  }
  if (!Number.isInteger(shape.pluLength) || shape.pluLength < 1) {
    return { ok: false, reason: 'Enter a stock code length to see how a label is read.' }
  }
  if (shape.pluLength > STOCK_SAMPLE.length) {
    return { ok: false, reason: 'That stock code is longer than any barcode holds.' }
  }

  /* A value width of 0 means "everything left over", so there is no width to
     draw — it depends on the label that arrives.

     Drawn at the width a 13-digit EAN would leave, rather than at 1. A single
     digit is the honest minimum and it teaches the wrong thing: it prices the
     sample at R0.09 and makes a flexible shape look like it reads almost
     nothing, when in fact it reads MORE than a fixed one. The label says "any
     length" so the picture is not claiming a specific width; what it shows is
     what a typical label would give. Floored at 1 so a short prefix and a long
     stock code cannot produce a negative slice. */
  const flexible = !Number.isInteger(shape.valueLength) || shape.valueLength <= 0

  /* The middle digit the till steps over, when the shape says there is one.
     A single digit because that is what a second check digit is; a shop with a
     wider filler run leaves the value width at 0 and lets the till take
     whatever is left. */
  const skipped = shape.hasCheckDigit ? SKIPPED_SAMPLE.length : 0

  const valueLength = flexible
    ? Math.max(1, 13 - prefix.length - shape.pluLength - skipped - CHECK)
    : shape.valueLength

  const total = prefix.length + shape.pluLength + skipped + valueLength + CHECK
  if (total > 18) {
    return {
      ok: false,
      reason: `Those lengths need ${total} digits, which is longer than any barcode.`,
    }
  }

  const decimals =
    Number.isInteger(shape.decimals) && shape.decimals >= 0 && shape.decimals <= 3
      ? shape.decimals
      : 2
  const stock = STOCK_SAMPLE.slice(0, shape.pluLength)
  const valueDigits = valueSample(valueLength, decimals)

  const segments: ShapeSegment[] = [
    { key: 'prefix', label: 'Prefix', digits: prefix, tone: 'identity' },
    { key: 'stock', label: 'Stock code', digits: stock, tone: 'identity' },
  ]

  /* The middle digit, drawn only when the shape says the till steps over one.
     Untick the box and it does not vanish from the label — it joins the value,
     which is what `valueSample` above has already widened to show. */
  if (skipped) {
    segments.push({
      key: 'skipped',
      label: 'Ignored',
      digits: SKIPPED_SAMPLE,
      tone: 'skipped',
    })
  }

  segments.push({
    key: 'value',
    label: flexible ? 'Value (any length)' : 'Value',
    digits: valueDigits,
    tone: 'value',
  })

  /* Always. A label does not end without one. */
  segments.push({ key: 'check', label: 'Check digit', digits: '4', tone: 'skipped' })

  const amount = Number(valueDigits) / 10 ** decimals

  return {
    ok: true,
    segments,
    /* Already counts the skipped digit and the trailing check digit — both are
       part of the label the shape describes. It used to add the skipped run a
       second time here, which is why a fixed shape quoted one digit too many. */
    total,
    value: amount.toFixed(decimals),
  }
}
