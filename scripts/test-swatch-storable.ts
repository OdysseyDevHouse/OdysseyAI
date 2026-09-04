/**
 * Every colour the pickers offer must be storable.
 *
 * ── WHY THIS SUITE EXISTS ─────────────────────────────────────────────────
 *
 * This has now broken three times on the same field, and each break was
 * invisible to tsc and to every other suite:
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
 *
 * A type cannot catch any of these: a palette is data, a regex is a string and
 * a column width is in the database. So this walks the real palettes through
 * the real validator, and checks the column is still wide enough for them.
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

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
}

main().then(() => process.exit(failures === 0 ? 0 : 1))
