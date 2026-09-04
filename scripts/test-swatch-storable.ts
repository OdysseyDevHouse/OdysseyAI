/**
 * Every colour the pickers offer must be storable.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────
 *
 * The SAME mistake has now shipped four times across three screens, and every
 * one was invisible to tsc and to every other suite. The shape never varies: a
 * picker moves to a new palette, and a rule that named the old one by hand
 * stays behind and refuses everything on screen.
 *
 *   1. `validateDepartment` demanded `#RRGGBB`, from when the colour control
 *      was a wheel. Once the form moved to the shared SwatchPicker it rejected
 *      all twenty swatches with "Colour must be a hex value like #2f6fed." —
 *      a message naming a format no screen can produce.
 *   2. `patchDepartment` was updated to `tile-1…7` when the palette became
 *      tokens. The palette later moved to `cat-*` and it went stale the same
 *      way, so the inline colour control on the list refused every swatch too.
 *   3. `departments.color` was VARCHAR(9), sized for hex. `cat-deli` fits and
 *      `cat-fresh-produce` does not, so the palette was split by string length:
 *      eleven swatches saved and nine were refused by MariaDB with
 *      ER_DATA_TOO_LONG — which fails the WHOLE record's save, not the colour.
 *   4. `quickKeys.ts` listed TILE_SWATCHES and TILE_GRADIENTS, from when the
 *      inspector drew those. It now draws the shared SwatchPicker, so all
 *      twenty visible colours were refused and only the None button worked.
 *   5. `menuDesigner.ts` matched 'tile-1…7|grad-*|#RRGGBB' against what
 *      TillTilePanel writes — and that panel draws CATEGORY_SWATCHES. Found by
 *      grepping for the pattern after fixing 4, not by anyone hitting it.
 *
 * A type cannot catch any of these: a palette is data, a hand-written list is a
 * string, and a column width is in the database. So this walks the real palettes
 * through the real validators and checks the column is still wide enough — the
 * one place that fails when the next picker moves.
 *
 *   npm run test:swatch-storable
 */
import {
  CATEGORY_SWATCHES,
  TILE_SWATCHES,
  TILE_GRADIENTS,
  PICTURE_TILE_GRADIENTS,
  TILE_NONE,
  isStorableSwatch,
  longestSwatchToken,
  ALL_SWATCH_TOKENS,
} from '@/components/ui/tiles'
import { validateDepartment } from '@/lib/site/departments'
import { siteQuery } from '@/lib/siteDb'

const SITE = Number(process.env.SHOT_SITE || 1)

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function main() {
  /* ── EVERY PALETTE, THROUGH THE REAL VALIDATOR ─────────────────────────── */
  const palettes = [
    ['category', CATEGORY_SWATCHES.map((s) => s.token)],
    ['tile', TILE_SWATCHES.map((s) => s.token)],
    ['gradient', TILE_GRADIENTS.map((s) => s.token)],
    ['picture gradient', PICTURE_TILE_GRADIENTS.map((s) => s.token)],
    ['none', [TILE_NONE.token]],
  ] as const

  for (const [label, tokens] of palettes) {
    /* Vacuous otherwise: an empty palette would pass a loop of assertions
       while proving nothing at all. */
    check(`the ${label} palette is not empty`, tokens.length > 0)

    const rejected = tokens.filter((t) => validateDepartment({ name: 'D', color: t }) !== null)
    check(
      `all ${tokens.length} ${label} swatches pass validateDepartment`,
      rejected.length === 0,
      rejected.join(', '),
    )
  }

  /* ── AND THE LEGACY ROWS ────────────────────────────────────────────────
   *
   * Sites still hold `#ff0000` from before the palettes were tokens. A rule
   * that refused those would make every one of those departments unsaveable
   * the next time somebody edited its NAME. */
  check('a legacy hex colour still validates', validateDepartment({ name: 'D', color: '#ff0000' }) === null)
  check('no colour at all still validates', validateDepartment({ name: 'D', color: null }) === null)

  /* ── IT MUST STILL REFUSE SOMETHING ─────────────────────────────────────
   *
   * A validator that accepts everything passes every check above while
   * enforcing nothing. */
  check('a colour that is not in any palette is refused', !isStorableSwatch('purple'))
  check('a truncated token is refused', !isStorableSwatch('cat-fresh-produ'))
  check('a three-digit hex is refused', !isStorableSwatch('#fff'))

  /* ── AND THE COLUMN MUST BE WIDE ENOUGH TO HOLD THEM ────────────────────
   *
   * The half a validator cannot check. Fault 3 above passed every assertion
   * in this file except this one. */
  const longest = longestSwatchToken()
  const rows = await siteQuery<{ t: string }>(
    SITE,
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='departments' AND COLUMN_NAME='color'`,
  )
  const type = rows[0]?.t ?? '(missing)'
  const width = Number(/varchar\((\d+)\)/i.exec(type)?.[1] ?? 0)
  check(
    `departments.color (${type}) fits the longest token "${longest}" (${longest.length} chars)`,
    width >= longest.length,
    `site ${SITE}`,
  )

  /* ── AND THE SAME RULE FOR QUICK KEYS ──────────────────────────────────
   *
   * The third surface to break this way, and the one the user saw: the Quick
   * Keys inspector draws the shared <SwatchPicker> (CATEGORY_SWATCHES) while
   * quickKeys.ts listed TILE_SWATCHES and TILE_GRADIENTS by hand. Every colour
   * on screen was one the server refused — the panel saves per change, so a few
   * clicks stacked up a toast each, which is how it was reported.
   *
   * A token column, so hex is NOT accepted here: unlike departments.color it has
   * never held one, and storing a hex would leave tileClass guessing. That is the
   * whole reason ALL_SWATCH_TOKENS is separate from isStorableSwatch. */
  for (const [label, tokens] of palettes) {
    const missing = tokens.filter((t) => !ALL_SWATCH_TOKENS.has(t))
    check(
      `all ${tokens.length} ${label} swatches are quick-key storable`,
      missing.length === 0,
      missing.join(', '),
    )
  }
  check('a quick key does not take a hex colour', !ALL_SWATCH_TOKENS.has('#2f6fed'))
  check('a quick key refuses an invented token', !ALL_SWATCH_TOKENS.has('cat-nonsense'))

  /* ── AND THE PRODUCT TILE COLOUR ───────────────────────────────────────
   *
   * menuDesigner.patch writes products.image_color, and TillTilePanel is what
   * feeds it. Hex IS allowed here, as on departments: the column holds legacy
   * values and tileClass still renders them. Checked against the SAME helper the
   * code now uses, so the two cannot drift apart again. */
  for (const [label, tokens] of palettes) {
    const rejected = tokens.filter((t) => !isStorableSwatch(t))
    check(
      `all ${tokens.length} ${label} swatches are storable as a product tile colour`,
      rejected.length === 0,
      rejected.join(', '),
    )
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
}

main().then(() => process.exit(failures === 0 ? 0 : 1))
