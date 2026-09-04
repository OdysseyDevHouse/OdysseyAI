'use client'

import { Icons, ProductTile, TileGlyph, FIELD_LABEL, toneForId } from '@/components/ui'
import PicturePicker from '@/components/PicturePicker'
import type { StorefrontImage } from '@/lib/site/storefrontImages'

/**
 * How tall the preview stands.
 *
 * The same 136 the menu designer uses (TILE_H there) and the same reason: above
 * the kit's short-tile threshold, so the tile takes its TALL layout — glyph and
 * name on the top line, the tally beneath — which is the arrangement the till
 * uses at its default size. Below it the kit flips to a one-line row and drops
 * the subtitle, and this preview would then be showing a till the shop has not
 * configured.
 */
const TILE_H = 136

/**
 * What a department looks like on the till: its picture, on a tinted disc.
 *
 * The mirror of the product form's TillTilePanel, and deliberately built the
 * same way — the REAL kit ProductTile the till draws, not a drawing of one. A
 * preview that is a COPY of the till drifts from it; a preview that IS the till
 * cannot. See the note on TileGlyph for the three screens that already had to
 * be dragged back into agreement about this.
 *
 * ── WHY THE COLOUR IS NOT ON THE TILE ────────────────────────────────────
 *
 * Because the till does not put it there. A department's tone comes from
 * `toneForId` on every till surface — the rail (DeptRail) and the catalogue
 * grid (CatalogPane) both derive it from the id, and the POS catalog API does
 * not ship the `color` column at all, so the till could not honour a stored
 * colour even if it wanted to. The colour IS real and does real work: the
 * department list, the pickers and the menu designer all paint from it. It just
 * is not what a cashier sees, so it is not what a preview OF the till may show.
 * Painting the picked swatch here would make this panel lie about the one thing
 * it exists to tell the truth about.
 */
export default function DepartmentTilePanel({
  departmentId,
  name,
  posImage,
  onPosImageChange,
  childCount,
  productCount,
}: {
  /**
   * Null while the department is being created.
   *
   * The tone is derived from it, so a new department has no stable tone to show
   * yet — see the fallback below.
   */
  departmentId: number | null
  /** The name as it stands in the form, so the tile renames as it is typed. */
  name: string
  /** The chosen picture, resolved, exactly as the form holds it. */
  posImage: StorefrontImage | null
  onPosImageChange: (image: StorefrontImage | null) => void
  /** Sub-departments and directly-filed products, for the till's own subtitle. */
  childCount: number
  productCount: number
}) {
  /*
   * The till's tone rule, unchanged: toneForId on the department's own id.
   *
   * A department being created has no id yet, so it borrows 0 — which gives a
   * stable, legitimate tone from the same palette rather than a grey tile
   * promising a till that draws grey. The real tone lands the moment it saves.
   */
  const tone = toneForId(departmentId ?? 0)

  /*
   * "2 sections · 306 products" — departmentTallyNote's exact wording and
   * ordering, rebuilt here rather than imported because that helper lives in
   * the (pos) route group and reaches the till's own basket types with it.
   * Singular/plural and the empty case are the parts that must match, and the
   * empty string is meaningful: ProductTile treats it as no subtitle at all,
   * which is how the till draws a department with nothing in it.
   */
  const parts: string[] = []
  if (childCount > 0) parts.push(`${childCount} ${childCount === 1 ? 'section' : 'sections'}`)
  if (productCount > 0) parts.push(`${productCount} ${productCount === 1 ? 'product' : 'products'}`)
  const tally = parts.join(' · ')

  return (
    /* No gap between label and body: FIELD_LABEL brings its own mb-1.5, and a
       flex gap on top of it would push this heading off the baseline its
       neighbours sit on. */
    <div>
      <span className={FIELD_LABEL}>Department preview in POS</span>

      {/* Boxed on the same hairline as the product form's panel, so the two
          screens read as the same control. */}
      <div className="flex flex-wrap items-start gap-5 rounded-card border border-border bg-surface p-4">
        {/* ── The live till tile ───────────────────────────────────────────
            Fixed-width and pointer-inert: the tile is a drawing here, so it
            must not look pressable. */}
        <div aria-hidden className="pointer-events-none w-[210px] shrink-0">
          <ProductTile
            title={name.trim() || 'New department'}
            /* What is in there — the same line the till puts under the name. */
            subtitle={tally || undefined}
            /* The CHOSEN picture, not the saved one.
               departmentGlyph() builds its URL from the department id, which
               serves whatever is on file — so a picture picked a moment ago and
               not yet saved would show the OLD one, and the preview would
               contradict the picker sitting beside it. Addressing the image by
               its own id is what makes this live. The fallback is the same tag
               glyph the till falls back to. */
            icon={
              <TileGlyph
                src={posImage ? `/api/storefront-images/${posImage.id}` : null}
                fallback={<Icons.Tag size={20} />}
              />
            }
            tone={tone}
            edge={tone}
            /* The till draws a chevron on EVERY department tile — see the note
               in CatalogPane: it is what separates "opens something" from the
               product tiles beside it in the same grid. */
            chevron
            tileHeight={TILE_H}
          />
        </div>

        {/* min-w-0 flex-1 so this block shares the row rather than claiming a
            whole line and bumping the tile above it. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* No thumbnail: the tile beside it IS the picture, at the size it
              will actually be seen. Two crops of one image, one of them
              misleading about how it reads on the counter, is exactly the
              second answer this panel exists to remove. */}
          <PicturePicker
            value={posImage?.id ?? null}
            current={posImage}
            onChange={onPosImageChange}
            showThumbnail={false}
          />
        </div>
      </div>
    </div>
  )
}
