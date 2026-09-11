/**
 * Reading a scale barcode, against the SHAPES a shop configures.
 *
 * Separate from test-scale-barcodes.ts, which is about something else and must
 * stay: that one drives resolveScan against real products to prove the embedded
 * value becomes a weight OR a price and never both. This one is about which
 * RULE reads a barcode and what it makes of the digits — pure, no database.
 *
 * ── WHY THIS IS TESTED HARD ───────────────────────────────────────────────
 *
 * The embedded value IS the money. A rule that reads one digit too many or too
 * few does not fail — it charges the wrong amount, silently, on every weighed
 * item, and the first anyone knows is a cash-up that does not balance. There is
 * no exception to catch and nothing on screen to notice.
 *
 * So every case here asserts a PRICE, not just that something parsed.
 *
 *   npm run test:scale-barcode-rules
 */
import {
  parseVariableBarcode,
  parseWithRules,
  rulesByPrecedence,
  type ScaleBarcodeRule,
} from '@/lib/barcodes'
import { segmentScaleBarcode, type ScaleShape } from '@/lib/barcodeShape'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** One 13-digit label, reused by the fallback ladder below. */
const BARCODE = '2012340125007'

/** The legacy screen's row, as a rule: 20 / 4 / True / 5 / 2. */
const LEGACY: ScaleBarcodeRule = {
  prefix: '20',
  pluLength: 4,
  hasCheckDigit: true,
  valueLength: 0,
  decimals: 2,
}

function main() {
  /* ── THE SHAPE FROM THE LEGACY SCREENSHOT ─────────────────────────────── */
  {
    /* 20 | 1234 | 012500 | 7 — thirteen digits, which is what a scale prints.
       Prefix 2, PLU 4 and one check digit leave SIX for the value, not five, so
       12500 with decimals 2 is R125.00. Spelled out because an earlier draft of
       this test asserted R12.50 and was wrong about the arithmetic rather than
       about the code — exactly the mistake that makes a pricing bug invisible. */
    const r = parseVariableBarcode('2012340125007', LEGACY)
    check('reads the PLU', r?.plu === '1234', JSON.stringify(r))
    check('reads the value as money', r?.value === 125, JSON.stringify(r))
  }

  /* A 13-digit code, which is what a scale actually prints. */
  {
    // 20 | 1234 | 012500 | 7   (6 value digits + check)
    const r = parseVariableBarcode('2012340125007', LEGACY)
    check('a 13-digit label parses at all', r !== null, JSON.stringify(r))
  }

  /* ── DECIMALS DECIDE THE MAGNITUDE ────────────────────────────────────── */
  {
    const grams = { ...LEGACY, decimals: 3 }
    const a = parseVariableBarcode('2012340125007', LEGACY)
    const b = parseVariableBarcode('2012340125007', grams)
    check(
      'decimals 3 is exactly a tenth of decimals 2',
      !!a && !!b && Math.abs(a.value / 10 - b.value) < 1e-9,
      `${a?.value} vs ${b?.value}`,
    )
  }

  /* ── CHECK DIGIT IS A SHAPE FLAG, NOT A VERIFIER ──────────────────────── */
  {
    // A deliberately WRONG check digit must still scan: the till refusing a
    // real product at a queue is worse than reading a mis-keyed one.
    const good = parseVariableBarcode('2012340125007', LEGACY)
    const bad = parseVariableBarcode('2012340125009', LEGACY)
    check('a wrong check digit still scans', bad !== null && bad.value === good?.value,
      `${JSON.stringify(good)} vs ${JSON.stringify(bad)}`)
  }
  {
    /* The TRAILING digit is never part of the value, whatever the flag says.
       EAN-13 ends in a check digit by construction, so a rule cannot hand it
       to the price — and a parser that let it slice across that digit read
       `59994` out of …15999|4 and charged 599.94 for a R159.99 item.

       This assertion used to run the other way ("without a check digit the last
       digit joins the value"), which is what licensed that off-by-one. */
    const label = '2112349159994' // 21 | 1234 | 9 | 15999 | 4
    const sized = { prefix: '21', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2 }
    const on = parseVariableBarcode(label, sized)
    const off = parseVariableBarcode(label, { ...sized, hasCheckDigit: false })
    check('*** the trailing check digit is never priced ***',
      on?.value === 159.99 && off?.value === 159.99,
      `${on?.value} / ${off?.value}`)
  }

  /* ── VALUE LENGTH IS THE VALUE'S OWN WIDTH, TAKEN FROM THE END ─────────
   *
   * The case this exists for is a real Avery label:
   *
   *     2 | 12345 | 6 | 01599 | 6
   *     ^   ^       ^   ^       ^
   *     |   |       |   |       check digit
   *     |   |       |   the price, five digits
   *     |   |       a SECOND check digit, guarding the stock code
   *     |   the stock code
   *     the prefix
   *
   * Reading forward from the stock code — the way this worked before — takes
   * `601599` and rings up R6015.99 for a R15.99 item. Counting the last five
   * digits back from the check digit skips the middle one without needing a
   * field to describe it. */
  {
    const avery: ScaleBarcodeRule = {
      prefix: '2', pluLength: 5, hasCheckDigit: true, valueLength: 5, decimals: 2,
    }
    const r = parseVariableBarcode('2123456015996', avery)
    check('the stock code is read from the front', r?.plu === '12345', JSON.stringify(r))
    check('*** a middle check digit is NOT priced ***', r?.value === 15.99, JSON.stringify(r))

    /* The same digits with valueLength 0 — "everything left over" — must STILL
       skip the middle check digit, because the rule says there is one.

       This used to assert 6015.99, which is the exact mis-price the block
       comment above exists to warn about: the shopkeeper ticked the box saying
       "skip the digit guarding the stock code" and the parser spent it anyway.
       A leftover width says nothing about that digit; only the flag does. */
    const leftover = parseVariableBarcode('2123456015996', { ...avery, valueLength: 0 })
    check('valueLength 0 skips the middle check digit too',
      leftover?.value === 15.99, JSON.stringify(leftover))

    /* Untick the flag and the same digits become money, which is the whole
       consequence of the setting and so is asserted rather than implied. */
    const spent = parseVariableBarcode('2123456015996', {
      ...avery, valueLength: 0, hasCheckDigit: false,
    })
    check('without the flag the middle digit IS priced',
      spent?.value === 6015.99, JSON.stringify(spent))
  }
  {
    /* A width that would reach back into the stock code is refused rather than
       reading part of the PLU as money. */
    const wide = { ...LEGACY, valueLength: 10 }
    check('a value wider than the barcode holds is refused',
      parseVariableBarcode('2012340125007', wide) === null)

    /* And a shorter barcode than the shape describes fails the same way, which
       is what stops a rule claiming a code it cannot actually read.

       LEGACY carries hasCheckDigit, so a 6-digit value needs prefix 2 + stock 4
       + middle 1 + value 6 + trailing 1 = 14 digits. A 13-digit code no longer
       fits it — this used to assert that it did, back when the trailing digit
       was the only one counted. */
    const sized = { ...LEGACY, valueLength: 6 }
    check('a 13-digit code cannot hold a 6-digit value AND both check digits',
      parseVariableBarcode('2012340125007', sized) === null)

    /* Drop the middle check digit and the same 13 digits fit exactly. */
    const noMiddle = { ...sized, hasCheckDigit: false }
    check('a 13-digit code fits a 6-digit value without the middle digit',
      parseVariableBarcode('2012340125007', noMiddle) !== null)

    check('an 11-digit code cannot hold prefix + stock + 6 + check',
      parseVariableBarcode('20123401250', sized) === null)
  }

  /* ── THE DIAGRAM MUST AGREE WITH THE PARSER ───────────────────────────
   *
   * The setup screen draws a shape segment by segment so it can be checked as
   * a picture. A diagram that disagrees with the parser is worse than none at
   * all: it would show a shopkeeper a picture confirming the setup is right on
   * exactly the day it is wrong.
   *
   * So the picture's own segments are fed back through parseVariableBarcode and
   * the two must reach the same money. */
  {
    const shapes: ScaleShape[] = [
      { prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2 },
      { prefix: '2', pluLength: 5, hasCheckDigit: true, valueLength: 5, decimals: 2 },
      { prefix: '20', pluLength: 4, hasCheckDigit: false, valueLength: 6, decimals: 2 },
      { prefix: '21', pluLength: 3, hasCheckDigit: true, valueLength: 4, decimals: 3 },
    ]
    for (const shape of shapes) {
      const drawn = segmentScaleBarcode(shape)
      if (!drawn.ok) {
        check(`diagram draws ${shape.prefix}/${shape.pluLength}/${shape.valueLength}`, false, drawn.reason)
        continue
      }
      // Reassemble the label the picture shows, and read it as the till would.
      const label = drawn.segments.map((s) => s.digits).join('')
      const parsed = parseVariableBarcode(label, shape)
      const stock = drawn.segments.find((s) => s.key === 'stock')!.digits
      check(
        `diagram and parser agree on ${label}`,
        parsed !== null && parsed.plu === stock && parsed.value.toFixed(shape.decimals) === drawn.value,
        `picture says stock ${stock} / ${drawn.value}; parser says ${JSON.stringify(parsed)}`,
      )
      check(
        `  and the drawn length matches the label (${label.length})`,
        drawn.total === label.length,
        `total ${drawn.total} vs ${label.length}`,
      )
    }
  }
  {
    /* The screenshot's own example, spelled out: the middle 9 must be drawn as
       IGNORED rather than folded into the price. */
    const drawn = segmentScaleBarcode({
      prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2,
    })
    check(
      'the skipped digit is drawn as its own segment',
      drawn.ok && drawn.segments.some((s) => s.tone === 'skipped' && s.key === 'skipped'),
      drawn.ok ? JSON.stringify(drawn.segments.map((s) => s.key)) : drawn.reason,
    )
    /* The skipped digit must not reach the money. Asserted as a RELATIONSHIP
       rather than against a literal: the sample's magnitude is free to change,
       but the value must always be exactly the value segment — never the value
       with the ignored digit stuck on the front, which is the 400x mispricing
       this whole shape exists to prevent. */
    if (drawn.ok) {
      const valueSeg = drawn.segments.find((s) => s.key === 'value')!.digits
      const skippedSeg = drawn.segments.find((s) => s.key === 'skipped')!.digits
      check(
        '*** the ignored digit is NOT part of the price ***',
        drawn.value === (Number(valueSeg) / 100).toFixed(2),
        `value segment ${valueSeg} -> ${drawn.value}`,
      )
      check(
        '*** and reading it forward would have been 100x worse ***',
        Number(skippedSeg + valueSeg) / 100 > Number(drawn.value) * 50,
        `forward read would be ${(Number(skippedSeg + valueSeg) / 100).toFixed(2)}`,
      )
    }
  }
  {
    /* The sample must SCALE with the width, or the field looks inert.
       An earlier sample was a fixed '000001599' sliced from the end, so five
       digits and six both read 15.99 — the width control appeared to do nothing
       on the one diagram whose job is to show what the widths do. */
    const at4 = segmentScaleBarcode({ prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 4, decimals: 2 })
    const at5 = segmentScaleBarcode({ prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2 })
    const at6 = segmentScaleBarcode({ prefix: '60', pluLength: 4, hasCheckDigit: true, valueLength: 6, decimals: 2 })
    check(
      'a wider value draws a visibly bigger amount',
      at4.ok && at5.ok && at6.ok &&
        Number(at4.value) < Number(at5.value) && Number(at5.value) < Number(at6.value),
      [at4, at5, at6].map((d) => (d.ok ? d.value : d.reason)).join(' / '),
    )
  }
  {
    /* A flexible value still draws the skipped digit when the rule says there
       is one. "Everything left over" describes where the value STOPS, not
       whether a check digit guards the stock code — and the parser skips it at
       any width, so a diagram that omitted it here drew a label the till would
       have priced differently. It used to assert exactly that. */
    const drawn = segmentScaleBarcode({
      prefix: '20', pluLength: 4, hasCheckDigit: true, valueLength: 0, decimals: 2,
    })
    check(
      'a flexible value still draws the skipped digit',
      drawn.ok && drawn.segments.some((s) => s.key === 'skipped'),
      drawn.ok ? JSON.stringify(drawn.segments.map((s) => s.key)) : drawn.reason,
    )

    /* And drops it when the rule says the digit is money. */
    const spent = segmentScaleBarcode({
      prefix: '20', pluLength: 4, hasCheckDigit: false, valueLength: 0, decimals: 2,
    })
    check(
      'no flag, no skipped segment',
      spent.ok && !spent.segments.some((s) => s.key === 'skipped'),
      spent.ok ? JSON.stringify(spent.segments.map((s) => s.key)) : spent.reason,
    )

    /* The trailing check digit is on BOTH, because no setting removes it. */
    check(
      '*** every shape draws a trailing check digit ***',
      drawn.ok && spent.ok &&
        drawn.segments[drawn.segments.length - 1].key === 'check' &&
        spent.segments[spent.segments.length - 1].key === 'check',
      `${drawn.ok ? drawn.segments.map((s) => s.key).join(',') : '-'} / ${spent.ok ? spent.segments.map((s) => s.key).join(',') : '-'}`,
    )
  }
  {
    /* A half-typed form must say "not yet", not draw a broken picture. */
    const blank = segmentScaleBarcode({
      prefix: '', pluLength: 4, hasCheckDigit: true, valueLength: 5, decimals: 2,
    })
    check('an empty prefix explains itself rather than drawing', !blank.ok)
    const huge = segmentScaleBarcode({
      prefix: '60', pluLength: 7, hasCheckDigit: true, valueLength: 12, decimals: 2,
    })
    check('an impossible shape explains itself rather than drawing', !huge.ok)
  }

  /* ── AND IT MUST STILL REFUSE ORDINARY BARCODES ───────────────────────── */
  {
    check('a plain EAN-13 on another prefix is refused',
      parseVariableBarcode('6001234567890', LEGACY) === null)
    check('letters are refused', parseVariableBarcode('20ABC340125007', LEGACY) === null)
    check('an empty string is refused', parseVariableBarcode('', LEGACY) === null)
    check('a zero value is refused', parseVariableBarcode('2012340000000', LEGACY) === null)
    check('a code shorter than its own prefix+PLU is refused',
      parseVariableBarcode('201234', LEGACY) === null)
  }

  /* ── SEVERAL RULES: MOST SPECIFIC WINS ────────────────────────────────── */
  {
    const broad: ScaleBarcodeRule = { prefix: '2', pluLength: 5, hasCheckDigit: true, valueLength: 0, decimals: 2 }
    const narrow: ScaleBarcodeRule = { prefix: '21', pluLength: 4, hasCheckDigit: true, valueLength: 0, decimals: 2 }

    // Listed broad-first, which is the order that used to swallow the narrow one.
    const hit = parseWithRules('2112340125007', [broad, narrow])
    check('the longer prefix wins even when listed second',
      hit?.rule.prefix === '21', JSON.stringify(hit?.rule))
    check('and it is the narrow rule that read the PLU',
      hit?.parsed.plu === '1234', JSON.stringify(hit?.parsed))

    // A code only the broad rule matches still works.
    const other = parseWithRules('2212340125007', [broad, narrow])
    check('a code the narrow rule misses falls back to the broad one',
      other?.rule.prefix === '2', JSON.stringify(other?.rule))
  }
  {
    // Equal-length prefixes: list order is the tie-break, so the sort must be
    // STABLE. An unstable sort makes this pass or fail by engine version.
    const a: ScaleBarcodeRule = { prefix: '20', pluLength: 4, hasCheckDigit: true, valueLength: 0, decimals: 2 }
    const b: ScaleBarcodeRule = { prefix: '20', pluLength: 5, hasCheckDigit: true, valueLength: 0, decimals: 2 }
    const order = rulesByPrecedence([a, b])
    check('equal prefixes keep the shop\'s own order', order[0] === a && order[1] === b)
  }
  {
    check('no rules parses nothing', parseWithRules('2012340125007', []) === null)
  }

  /* ── THE OLD CONFIG SHAPE STILL READS ─────────────────────────────────
   *
   * An offline till holds cached settings and calls this with the pre-rules
   * shape until it next syncs. Refusing that would stop weighed items scanning
   * on exactly the tills that cannot phone home. */
  {
    const legacyCall = parseVariableBarcode('2012340125007', { prefix: '20', pluLength: 4, divisor: 100 })
    const ruleCall = parseVariableBarcode('2012340125007', LEGACY)
    check('a divisor of 100 reads identically to decimals 2',
      !!legacyCall && legacyCall.value === ruleCall?.value,
      `${legacyCall?.value} vs ${ruleCall?.value}`)
    const grams = parseVariableBarcode('2012340125007', { prefix: '20', pluLength: 4, divisor: 1000 })
    check('a divisor of 1000 reads as decimals 3',
      !!grams && grams.value === parseVariableBarcode('2012340125007', { ...LEGACY, decimals: 3 })?.value)
  }

  /* ── THE OFFLINE TILL'S FALLBACK LADDER ───────────────────────────────
   *
   * The rules reach an offline till as JSON on its cached settings map. Three
   * states have to behave differently and only one of them is obvious:
   *
   *   · rules present  -> use them
   *   · key absent     -> the till has not synced since the deploy, so fall
   *                       back to the three legacy settings; anything else
   *                       stops weighed items scanning on exactly the tills
   *                       that cannot phone home
   *   · EMPTY array    -> the shop deleted every rule. That is an answer, not
   *                       an absence, and falling back here would resurrect a
   *                       shape somebody deliberately removed.
   *
   * Modelled rather than imported: readScaleBarcode lives in a Dexie module
   * that pulls in IndexedDB on import. The LADDER is the logic worth pinning,
   * and it is copied here deliberately so a change to one is a visible
   * disagreement with the other rather than a silent drift. */
  {
    const legacySettings = {
      barcode_variable_prefix: '20',
      barcode_plu_length: '4',
      barcode_value_divisor: '100',
    } as Record<string, string | null>

    function ladder(settings: Record<string, string | null>) {
      const raw = settings.scale_barcode_rules
      if (raw) {
        try {
          const rules = JSON.parse(raw) as ScaleBarcodeRule[]
          if (Array.isArray(rules)) {
            return rules.length ? (parseWithRules(BARCODE, rules)?.parsed ?? null) : null
          }
        } catch {
          /* fall through */
        }
      }
      return parseVariableBarcode(BARCODE, {
        prefix: String(settings.barcode_variable_prefix ?? ''),
        pluLength: Number(settings.barcode_plu_length),
        divisor: Number(settings.barcode_value_divisor),
      })
    }

    check(
      'a till with no rules key falls back to the legacy settings',
      ladder(legacySettings)?.value === 125,
      JSON.stringify(ladder(legacySettings)),
    )
    check(
      'a till with rules uses them',
      ladder({ ...legacySettings, scale_barcode_rules: JSON.stringify([LEGACY]) })?.value === 125,
    )
    check(
      'an EMPTY rules array means no rules, NOT the legacy fallback',
      ladder({ ...legacySettings, scale_barcode_rules: '[]' }) === null,
    )
    check(
      'malformed JSON falls back rather than throwing',
      ladder({ ...legacySettings, scale_barcode_rules: '{oops' })?.value === 125,
    )
    check(
      'a rule that differs from the legacy setting actually wins',
      ladder({
        ...legacySettings,
        scale_barcode_rules: JSON.stringify([{ ...LEGACY, decimals: 3 }]),
      })?.value === 12.5,
    )
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
}

main()
process.exit(failures === 0 ? 0 : 1)
