'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Button,
  CATEGORY_SWATCHES,
  ColourPickerModal,
  GeneratedPictureModal,
  Icons,
  ProductTile,
  TileGlyph,
  TILE_NONE,
  FIELD_LABEL,
  buttonShape,
  tileClass,
  toneForId,
  toneForTileToken,
  useToast,
} from '@/components/ui'

import { IMAGE_ACCEPT, IMAGE_EXTENSIONS_LABEL } from '@/lib/productImageModel'
import {
  removeProductIconAction,
  setGeneratePictureFontAction,
  uploadProductIconAction,
} from './imageActions'

/**
 * How tall the preview stands.
 *
 * Above SHORT_TILE_MAX so the kit tile takes its TALL layout — glyph and name on
 * the top line, code and price beneath — which is the arrangement the till uses
 * at its default size. Below the threshold the kit flips to a one-line row and
 * drops the subtitle, and this preview would then be showing a till the shop has
 * not configured. The menu designer picks its own height for the same reason;
 * see TILE_H there.
 */
const TILE_H = 136

/**
 * How a product looks on the till: an icon, over a colour or gradient.
 *
 * ── THE ICON IS NOT A PHOTOGRAPH ─────────────────────────────────────────
 *
 * Photographs (the panel at the bottom of this screen) are merchandising for
 * the online store: several per product, ordered, with alt text for shoppers.
 * The icon is one picture on one button on the till. Keeping them apart means
 * a store can put a styled glyph on the till without that glyph turning up in
 * the shop as if it were a product photo.
 *
 * ── WHY THE ICON SAVES IMMEDIATELY AND THE COLOUR DOES NOT ───────────────
 *
 * The colour is a form field: it submits with everything else on Save. The
 * icon is a file, so there is nowhere to keep it until then — it is written on
 * choose and removed on remove, exactly like the photographs below. That also
 * means it needs a product to belong to, so on a new product the picker says
 * so rather than offering a button that cannot work.
 */

/* The kit's field caption. This heading labels a GROUP of controls, which Field
   itself cannot do — it labels exactly one — so it borrows the class rather than
   keeping a copy that drifts. */

export default function TillTilePanel({
  productId,
  initial,
  color,
  onColorChange,
  initialIcon,
  productName = '',
  pictureFont = '',
  description = '',
  code = '',
  price,
  departmentId = null,
}: {
  /** Null while the product is being created — see the note above. */
  productId: number | null
  /**
   * The letter shown when there is no icon.
   *
   * Still taken because the GENERATED icon is drawn from it. The preview no
   * longer shows it — the till draws a package glyph, not an initial, for a
   * product with no picture.
   */
  initial: string
  /** The description as it stands in the form, so the tile renames as it is typed. */
  description?: string
  /** The product code, shown as the tile's subtitle the way the till does. */
  code?: string
  /** Pre-formatted, like every other ProductTile caller. */
  price?: string
  /**
   * The chosen department, for the tone a product with NO colour of its own
   * falls back to — which is what the till does.
   */
  departmentId?: number | null
  /** The selected tile token, flat or gradient. Owned by the form. */
  color: string
  onColorChange: (token: string) => void
  /** The stored name of the current icon, or null. */
  initialIcon: string | null
  /**
   * The product's description as it stands in the form — seeds the generated
   * icon's letter, caption and suggested gradient.
   */
  productName?: string
  /** The site's saved typeface for generated icons — a PICTURE_FONTS id. */
  pictureFont?: string | null
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [icon, setIcon] = useState(initialIcon)
  const [generateOpen, setGenerateOpen] = useState(false)
  const [colourOpen, setColourOpen] = useState(false)
  const currentColour = CATEGORY_SWATCHES.find((c) => c.token === color)

  /*
   * The tile's tone, by the till's OWN rule — see productTile() in
   * pos/CatalogPane, which this deliberately mirrors: the stored colour where a
   * shop has set one, otherwise the department's.
   *
   * "No background" is the one case that is not a colour at all. The till has no
   * concept of a toneless tile, so it falls back to the department exactly as an
   * unset product does — showing a grey tile here would promise a till that does
   * not exist.
   */
  const tone =
    (color === TILE_NONE.token ? null : toneForTileToken(color)) ??
    toneForId(departmentId ?? productId ?? 0)
  // Held locally so a typeface chosen while generating is already in place the
  // next time the dialog opens, without waiting for the page to revalidate.
  const [font, setFont] = useState(pictureFont ?? '')
  const fileInput = useRef<HTMLInputElement>(null)

  /*
   * Bumped on every successful upload and appended to the icon's URL.
   *
   * The route is keyed by product id, so replacing an icon reuses the same URL
   * and the browser would keep showing the cached picture — the upload would
   * look like it had silently failed. This makes each version its own URL.
   */
  const [version, setVersion] = useState(0)

  /**
   * Save one file as the icon, and say whether it landed.
   *
   * Awaited rather than wrapped in a transition, because the generator needs to
   * know whether the icon actually saved before it closes its dialog — a dialog
   * that shuts on a rejected upload tells the user the opposite of what
   * happened.
   */
  async function saveIcon(file: File): Promise<boolean> {
    if (productId === null) return false
    const form = new FormData()
    form.set('file', file)
    const result = await uploadProductIconAction(productId, form)
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setIcon(result.storedName)
    setVersion((v) => v + 1)
    toast.success('Till icon updated.')
    return true
  }

  function upload(files: FileList | null) {
    const file = files?.[0]
    if (!file || productId === null) return

    startAction(async () => {
      await saveIcon(file)
      // Cleared either way, so choosing the SAME file again still fires change.
      if (fileInput.current) fileInput.current.value = ''
    })
  }

  function remove() {
    if (productId === null) return
    startAction(async () => {
      const result = await removeProductIconAction(productId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setIcon(null)
      toast.success('Till icon removed.')
    })
  }

  return (
    /* No gap between label and body: FIELD_LABEL brings its own mb-1.5, and a
       flex gap on top of it pushed this heading lower than "Product type"
       beside it, so the two labels missed the same baseline. */
    <div>
      {/* How the chosen colour reaches the server. The swatches are buttons, so
          without this the form submits no imageColor at all and every save
          writes null — the picker would look like it worked and change
          nothing. The icon does NOT go through the form; it commits on its own,
          which is why only the colour needs a field here. */}
      <input type="hidden" name="imageColor" value={color} />

      <span className={FIELD_LABEL}>Product preview in POS</span>

      {/* Boxed on the same hairline as the product type panel opposite. The two
          sit side by side under matching labels, so an unboxed picker beside a
          bordered card read as an unfinished half of one row. */}
      <div className="flex flex-wrap items-start gap-5 rounded-card border border-border bg-surface p-4">
        {/* ── The live till tile ───────────────────────────────────────────
            The REAL kit ProductTile the till draws, not a drawing of one.

            It used to be a plain coloured square, which quietly misdescribed
            the till twice over: the colour filled the whole tile (on the till
            it only tints the leading edge and the icon disc), and the name,
            code and price a cashier actually reads were not there at all. The
            menu designer already previews the till by mounting this same
            component — see setup/menu-designer/tiles.tsx — and this follows it
            for the same reason: a preview that is a COPY of the till drifts
            from it, a preview that IS the till cannot.

            Wrapped in a fixed-width, pointer-inert box: the tile is a drawing
            here, so it must not look pressable. */}
        <div aria-hidden className="pointer-events-none w-[210px] shrink-0">
          <ProductTile
            title={description.trim() || 'New product'}
            /* The till shows a stock note where it has one and falls back to
               the code — see productNote() in pos/CatalogPane. This screen has
               no live stock figure, so it shows the code, which is the branch a
               cashier sees on any product that is in stock. */
            subtitle={code || undefined}
            price={price}
            /* The saved icon by the SAME kit helper the till calls, so an
               uploaded picture appears here exactly as it will on the counter.
               `version` busts the cache after a replace, as the old preview
               did. */
            icon={
              <TileGlyph
                src={
                  icon && productId !== null
                    ? `/api/product-icon/${productId}?v=${version}`
                    : null
                }
                fallback={<Icons.Package size={20} />}
              />
            }
            /* Colour reaches the tile ONLY as a tone — the disc tint and the
               leading edge — which is the whole of what a stored colour does on
               the till. Falling back to the department is the till's own rule
               (CatalogPane): a product with no colour of its own is not
               grey there, it wears its department's. */
            tone={tone}
            edge={tone}
            tileHeight={TILE_H}
          />
        </div>

        {/* min-w-0 flex-1: without a flex basis this block claimed a whole line
            of the outer row and bumped the preview tile onto its own line
            above it. */}
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-5">
          <div className="flex flex-col items-start gap-2">
            {/* ── Background ─────────────────────────────────────────────── */}
            {/* One button, not a grid of twenty. The colours are named now, and
                twenty labelled tiles cannot sit in a form field without
                dominating the screen — so the choice moves to a dialog and the
                trigger carries the current answer, which is the only part worth
                standing room once it is made. */}
            {/* buttonShape() rather than a hand-written box, so this sits at
                exactly the kit's `sm` geometry — the same height, radius and
                type scale as Add icon and Remove icon beneath it. It had its
                own px-2 py-1 text-xs and stood visibly shorter than the pair it
                stacks with.

                Not a kit <Button>: the swatch inside is a runtime colour, which
                is the case buttonShape exists for — see the note on it in
                styles.ts. The border and text colours are written here because
                no ButtonVariant means "neutral outline". */}
            <button
              data-kit-ok
              type="button"
              onClick={() => setColourOpen(true)}
              className={`${buttonShape({ size: 'sm' })} border-border text-muted hover:bg-surface-2`}
            >
              <span
                /* The chosen colour itself, so the trigger answers "what is it
                   now?" without being opened. */
                className={`size-4 shrink-0 rounded-[4px] ${tileClass(color)}`}
              />
              {currentColour?.label ?? (color === TILE_NONE.token ? 'No background' : 'Colour')}
            </button>

            {/* ── The icon ───────────────────────────────────────────────── */}
            {/* A column, matching the stack it now lives in: side by side these
                three ran wider than the space beside the tile and wrapped. */}
            <div className="flex flex-col items-start gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={IMAGE_ACCEPT}
                hidden
                onChange={(e) => upload(e.target.files)}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || productId === null}
                onClick={() => fileInput.current?.click()}
              >
                <Icons.Upload size={15} />
                {busy ? 'Working…' : icon ? 'Replace icon' : 'Add icon'}
              </Button>

              {/* HIDDEN FOR NOW — the button only. Everything behind it is
                  still wired: GeneratedPictureModal is still mounted below,
                  still saves through the ordinary icon upload, and the site's
                  typeface setting is still read and written. Restoring the
                  feature means deleting this comment and nothing else.

                  It sat beside the upload, never instead of it — a real picture
                  is better when there is one. This was for the long tail of
                  products nobody will ever photograph, where a coloured tile
                  carrying the name still beats a bare glyph on the till.
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || productId === null}
                onClick={() => setGenerateOpen(true)}
              >
                Generate icon
              </Button>
              */}

              {icon && (
                <Button variant="danger-ghost" size="sm" disabled={busy} onClick={remove}>
                  <Icons.Trash size={15} />
                  Remove icon
                </Button>
              )}
            </div>
          </div>

          {/* Create only. The standing caption that used to sit here — what the
              tile is for, and where online-store photographs go instead — is
              gone; the label above says what this is. This one stays because it
              is not a caption but the REASON the icon buttons above it are
              disabled, and without it they read as broken.

              basis-full so it runs under both columns rather than being
              squeezed into one. */}
          {productId === null && (
            <p className="basis-full text-xs text-muted">
              Save this product first, then add its till icon. {IMAGE_EXTENSIONS_LABEL}.
            </p>
          )}
        </div>
      </div>

      <ColourPickerModal
        open={colourOpen}
        onClose={() => setColourOpen(false)}
        value={color}
        onChange={onColorChange}
        title="Product picture colour"
      />

      {/* An icon built from the product's own initial and name on a gradient.
          The rendered PNG rides the ordinary icon upload, so the till receives
          an ordinary icon and never learns it was generated. */}
      <GeneratedPictureModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        name={productName}
        busy={busy}
        fontId={font}
        onFontChange={async (next) => {
          setFont(next)
          const result = await setGeneratePictureFontAction(next)
          // Not fatal: the icon the user asked for is still made, and the
          // typeface simply stays as it was for the next product.
          if (!result.ok) toast.error(result.error)
        }}
        onPick={async (file) => {
          const saved = await saveIcon(file)
          // false keeps the dialog open, so the work isn't lost on a refusal.
          return saved
        }}
      />
    </div>
  )
}
