/**
 * Pictures on printed documents.
 *
 *   npm run test:stationery-pictures
 *
 * ── THE BOUNDARY THIS GUARDS ─────────────────────────────────────────────
 *
 * A picture block names an id, and the renderer turns that id into an <img>
 * pointing at this app. The whole safety of that rests on ONE rule: the tag is
 * only ever built for an id the caller has confirmed belongs to this site.
 *
 * A design is copyable between documents and, in principle, editable by hand —
 * so an id in a spec is untrusted input. If naming any number were enough to
 * produce a tag, a design carried between sites would point at another shop's
 * file. Every check below is about that.
 *
 * ── AND THE SLIP BOUNDARY ────────────────────────────────────────────────
 *
 * A thermal head has no raster worth using, so the block must be ABSENT from a
 * slip rather than shown and refused. Offering a line that cannot print is a
 * promise the printer will break.
 *
 * Needs no database and no browser.
 */
import { compileDocument } from '../src/lib/stationery/compile'
import { renderTemplate, PICTURE_URL } from '../src/lib/stationery/render'
import { sanitiseTemplate } from '../src/lib/stationery/sanitise'
import {
  blockKindsFor,
  parseSpec,
  serialiseSpec,
  DEFAULT_IMAGE_H,
  MIN_IMAGE_H,
  MAX_IMAGE_H,
  type DocumentSpec,
} from '../src/lib/stationery/blocks'

let failures = 0
function ok(label: string, cond: boolean, extra = ''): void {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const caps = { isOwner: true, granted: new Set<string>() }

function specWith(imageId: number | undefined, height?: number): DocumentSpec {
  return {
    version: 1,
    blocks: [
      {
        id: 'pic-1',
        kind: 'image',
        band: 'header',
        x: 0,
        y: 0,
        w: 30,
        ...(imageId !== undefined ? { imageId } : {}),
        ...(height !== undefined ? { imageHeight: height } : {}),
      },
    ],
  }
}

/* ── which documents may have one ────────────────────────────────────────── */

console.log('\n-- where the block is offered --\n')

for (const doc of ['invoice', 'purchase_order', 'delivery_note', 'statement']) {
  ok(`${doc} offers a picture block`, blockKindsFor(doc).includes('image'))
}
ok(
  'a till slip does NOT',
  !blockKindsFor('slip').includes('image'),
  'a thermal head has no raster worth using',
)

/* ── the id only becomes a tag when the site owns it ─────────────────────── */

console.log('\n-- the boundary --\n')

const markup = compileDocument(specWith(7), 'invoice')
ok('the compiled page carries a marker, not a tag', markup.includes('{{picture:7:'))
ok('...and no <img> at all', !markup.includes('<img'), 'a stored tag is a tag someone can edit')

const mine = renderTemplate(markup, 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
  pictures: new Set([7]),
})
ok('a picture this site owns becomes a tag', mine.includes(`<img src="${PICTURE_URL}/7"`))
ok('...and the marker is gone', !mine.includes('{{picture'))

const notMine = renderTemplate(markup, 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
  pictures: new Set([9]),
})
ok(
  'an id this site does NOT own resolves to nothing',
  !notMine.includes('<img') && !notMine.includes('{{picture'),
  'this is the check that stops a copied design reaching another shop\'s file',
)

const noneSupplied = renderTemplate(markup, 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
})
ok(
  'a caller that supplies no list renders no pictures',
  !noneSupplied.includes('<img'),
  'absent must fail closed, not open',
)

/* ── the marker cannot be talked into anything else ──────────────────────── */

console.log('\n-- what a hand-written marker can do --\n')

const attacks: [string, string][] = [
  ['a path traversal', '{{picture:../../etc/passwd:90}}'],
  ['a URL', '{{picture:https://evil.example/x.png:90}}'],
  ['a quote break', '{{picture:7":90}}'],
  ['a tag', '{{picture:<script>:90}}'],
  ['a negative id', '{{picture:-1:90}}'],
]
for (const [label, payload] of attacks) {
  /*
   * Stored markup passes the sanitiser first, so that is the honest starting
   * point — testing the raw payload would flatter the result for the one case
   * (a <script> inside the marker) the sanitiser removes before the renderer
   * ever sees it.
   */
  const stored = sanitiseTemplate(`<div>${payload}</div>`)
  const out = renderTemplate(stored, 'invoice', {
    values: {},
    sections: {},
    capabilities: caps,
    pictures: new Set([7]),
  })
  /*
   * The test is that no TAG is produced. The marker's own text surviving as
   * inert text is fine and is what a `\d+`-only pattern should do — asserting
   * the string "evil" is absent would fail on harmless leftover characters and
   * teach nothing, which is exactly what the first version of this check did.
   */
  ok(`${label} produces no tag`, !out.includes('<img'), out.slice(0, 80))
  ok(`  ...and nothing executable survives`, !/<script|onerror=|javascript:/i.test(out))
}

/*
 * The height is clamped, not trusted. A marker asking for a 99999pt picture
 * would otherwise push every other block off the page.
 */
const huge = renderTemplate('<div>{{picture:7:99999}}</div>', 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
  pictures: new Set([7]),
})
const px = Number(huge.match(/max-height:(\d+)px/)?.[1] ?? 0)
ok('an absurd height is clamped', px > 0 && px <= 400, `${px}px`)

/* ── the sanitiser leaves the marker alone ───────────────────────────────── */

console.log('\n-- through the sanitiser --\n')

const cleaned = sanitiseTemplate(markup)
ok(
  'a picture block survives being saved',
  cleaned.includes('{{picture:7:'),
  'the sanitiser runs over compiled markup at save',
)
const stillWorks = renderTemplate(cleaned, 'invoice', {
  values: {},
  sections: {},
  capabilities: caps,
  pictures: new Set([7]),
})
ok('...and still renders afterwards', stillWorks.includes(`${PICTURE_URL}/7`))

/* ── storage ─────────────────────────────────────────────────────────────── */

console.log('\n-- storage --\n')

const round = parseSpec(serialiseSpec(specWith(7, 120)), 'invoice')
ok('the id survives a save and reload', round?.blocks[0]?.imageId === 7)
ok('...and the height', round?.blocks[0]?.imageHeight === 120)

const silly = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...specWith(7, 9999).blocks[0] }] }),
  'invoice',
)
ok(
  'a stored height is clamped on read too',
  (silly?.blocks[0]?.imageHeight ?? 0) <= MAX_IMAGE_H,
  String(silly?.blocks[0]?.imageHeight),
)

const negative = parseSpec(
  JSON.stringify({ version: 1, blocks: [{ ...specWith(7).blocks[0], imageId: -4 }] }),
  'invoice',
)
ok('a nonsense id is dropped', negative?.blocks[0]?.imageId === undefined)

const noId = compileDocument(specWith(undefined), 'invoice')
ok(
  'a block naming no picture yet compiles to nothing',
  !noId.includes('{{picture'),
  'a half-made block must not print a marker',
)

ok(
  'the default height sits inside its bounds',
  DEFAULT_IMAGE_H >= MIN_IMAGE_H && DEFAULT_IMAGE_H <= MAX_IMAGE_H,
  `${MIN_IMAGE_H} <= ${DEFAULT_IMAGE_H} <= ${MAX_IMAGE_H}`,
)

/* ── copying carries pictures between documents ──────────────────────────── */

console.log('\n-- copied to another document --\n')

const copied = parseSpec(serialiseSpec(specWith(7, 120)), 'delivery_note')
ok(
  'a picture block copies to another A4 document',
  copied?.blocks[0]?.kind === 'image' && copied.blocks[0].imageId === 7,
)
const toSlip = parseSpec(serialiseSpec(specWith(7)), 'slip')
ok(
  'but not onto a slip',
  (toSlip?.blocks.length ?? 0) === 0,
  'blockKindsFor keeps it out, so parseSpec drops it',
)

/* ── result ──────────────────────────────────────────────────────────────── */

console.log('')
if (failures > 0) {
  console.log(`${failures} picture check(s) failed.`)
  process.exit(1)
}
console.log('All picture checks passed.')
