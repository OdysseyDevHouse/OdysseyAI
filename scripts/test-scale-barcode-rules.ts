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
    // hasCheckDigit false: the LAST digit is part of the value, so the price is
    // ten times bigger. Getting this backwards is a 10x pricing error.
    const withCd = parseVariableBarcode('2012340125007', LEGACY)
    const noCd = parseVariableBarcode('2012340125007', { ...LEGACY, hasCheckDigit: false })
    check(
      'without a check digit the last digit joins the value',
      !!withCd && !!noCd && Math.abs(noCd.value - (withCd.value * 10 + 0.07)) < 1e-6,
      `${withCd?.value} -> ${noCd?.value}`,
    )
  }

  /* ── VALUE LENGTH REJECTS THE WRONG SIZE ──────────────────────────────── */
  {
    const sized = { ...LEGACY, valueLength: 13 }
    check('a 13-digit code passes a valueLength of 13', parseVariableBarcode('2012340125007', sized) !== null)
    check('a 12-digit code is refused', parseVariableBarcode('201234012500', sized) === null)
    check('valueLength 0 accepts either', parseVariableBarcode('201234012500', LEGACY) !== null)
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
