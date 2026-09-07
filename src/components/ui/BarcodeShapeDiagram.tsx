import { segmentScaleBarcode, type ScaleShape } from '@/lib/barcodeShape'

/**
 * What a scale barcode shape MEANS, drawn from a sample label.
 *
 * ── WHY A PICTURE AND NOT FOUR HINTS ───────────────────────────────────────
 *
 * "Prefix 60, stock code 4, value 5, check digit on" is four numbers that only
 * describe a barcode once somebody holds them in their head at the same time.
 * The mistakes this screen invites are all mistakes of ARRANGEMENT — a value
 * width that eats the check digit, a stock code that runs into the price — and
 * none of them look wrong as a list of numbers. They look wrong as a picture.
 *
 * That matters here more than on most screens: the embedded value IS the money.
 * A shape that is one digit out does not fail, it mischarges every weighed item
 * quietly, and the first anyone knows is a cash-up that will not balance. The
 * point of this component is to make that visible while it is still being
 * typed, rather than at the till.
 *
 * ── THE SKIPPED SEGMENT IS THE WHOLE POINT ─────────────────────────────────
 *
 * A scale is free to print digits between the stock code and the price that
 * mean nothing to a till — most often a second check digit guarding the stock
 * code, as on a real Avery label: 2 12345 6 01599 6. Those digits have no
 * field on the form, because the value is counted back from the END and they
 * are simply what is left over.
 *
 * So they are invisible in the form and they are the single most dangerous part
 * of the shape: read forward instead, that middle 6 joins the price and rings
 * up R6015.99 for a R15.99 item. Naming the segment on the diagram is how a
 * shopkeeper sees the till is ignoring a digit — and can tell whether it is
 * ignoring the RIGHT one.
 *
 * Rendered from `segmentScaleBarcode`, which is also what the tests assert
 * against. A diagram drawn from its own arithmetic would agree with the parser
 * right up until one of them changed.
 */
export function BarcodeShapeDiagram({
  shape,
  className = '',
}: {
  shape: ScaleShape
  /** For the caller's own spacing. The component sets none of its own margin. */
  className?: string
}) {
  const result = segmentScaleBarcode(shape)

  /* A shape that cannot describe a barcode gets a sentence, not a broken
     picture. This is the state the form is in for most of the time somebody is
     typing into it — mid-edit, with a field momentarily empty — so it has to
     read as "not yet" rather than as an error. */
  if (!result.ok) {
    return (
      <p className={`text-sm text-muted ${className}`}>{result.reason}</p>
    )
  }

  const { segments, total, value } = result

  return (
    <div className={className}>
      {/* The digits, in one row, each segment under its own label.
          `items-start` so a two-line label does not push its digits down out of
          line with the rest of the barcode. */}
      <div className="flex flex-wrap items-start gap-x-1.5 gap-y-3">
        {segments.map((seg) => (
          <div key={seg.key} className="flex flex-col items-center gap-1">
            <span
              className={`numeric rounded-control px-2 py-1 text-base font-semibold tabular-nums ${TONE[seg.tone].digits}`}
            >
              {seg.digits}
            </span>
            <span className={`text-[11px] leading-tight font-medium ${TONE[seg.tone].label}`}>
              {seg.label}
            </span>
          </div>
        ))}
      </div>

      {/* What the till would actually do with it — the sentence the four
          numbers add up to, and the thing somebody is really checking. */}
      <p className="mt-3 text-sm text-muted">
        A {total}-digit label. The till reads stock code{' '}
        <span className="numeric font-medium text-ink">{segments[1].digits}</span> and charges{' '}
        <span className="numeric font-medium text-ink">{value}</span>.
      </p>
    </div>
  )
}

/**
 * One tone per kind of segment, so the picture is read by colour before it is
 * read by label.
 *
 * `brand` for the two segments that IDENTIFY (prefix, stock code), `success`
 * for the money, `warning` for the digits the till throws away. Warning rather
 * than a neutral grey on purpose: a discarded digit is not decoration, it is
 * the thing most likely to be wrong, and the palette's own rule is that warning
 * means "needs attention". Grey would say "ignore this", which is the opposite
 * of what a skipped digit deserves on the one screen where it can be fixed.
 */
const TONE = {
  identity: { digits: 'bg-brand-soft text-brand-ink', label: 'text-brand-ink' },
  value: { digits: 'bg-success-soft text-success-ink', label: 'text-success-ink' },
  skipped: { digits: 'bg-warning-soft text-warning-ink', label: 'text-warning-ink' },
} as const
