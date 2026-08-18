'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Button,
  GeneratedPictureModal,
  Icons,
  PICTURE_TILE_GRADIENTS,
  TILE_NONE,
  tileInkClass,
  tileClass,
  useToast,
} from '@/components/ui'
import { IMAGE_ACCEPT, IMAGE_EXTENSIONS_LABEL } from '@/lib/productImageModel'
import {
  removeProductIconAction,
  setGeneratePictureFontAction,
  uploadProductIconAction,
} from './imageActions'

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

const labelText = 'mb-1.5 block text-sm font-medium text-ink-2'

export default function TillTilePanel({
  productId,
  initial,
  color,
  onColorChange,
  initialIcon,
  productName = '',
  pictureFont = '',
}: {
  /** Null while the product is being created — see the note above. */
  productId: number | null
  /** The letter shown when there is no icon. */
  initial: string
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
    <div className="flex flex-col gap-3">
      {/* How the chosen colour reaches the server. The swatches are buttons, so
          without this the form submits no imageColor at all and every save
          writes null — the picker would look like it worked and change
          nothing. The icon does NOT go through the form; it commits on its own,
          which is why only the colour needs a field here. */}
      <input type="hidden" name="imageColor" value={color} />

      <span className={labelText}>How this product looks on the till</span>

      <div className="flex flex-wrap items-start gap-5">
        {/* The preview. The icon sits ON the colour rather than replacing it,
            so a transparent glyph keeps its background. */}
        <div
          /* Ink follows the ramp: the pale ones (yellow, gold, amber, lime)
             take dark text, exactly as the generated icon does. Hard-coded
             white here left the letter invisible on four of the twenty. */
          className={`relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-card ${tileInkClass(color)} ${tileClass(color)}`}
        >
          {icon && productId !== null ? (
            <img
              src={`/api/product-icon/${productId}?v=${version}`}
              alt=""
              className="size-full object-contain p-1.5"
            />
          ) : (
            <span className="text-2xl font-semibold">{initial}</span>
          )}
        </div>

        <div className="flex flex-col gap-3">
          {/* ── Backgrounds ──────────────────────────────────────────────── */}
          {/* The SAME twenty ramps the generator offers, so choosing a colour
              here and generating an icon there are one palette rather than two
              that nearly match. Ten per row, as in the dialog. Squares, not
              circles: these are gradients, and a two-stop ramp is far easier to
              read across a square than around a disc. */}
          {/* A ten-column grid rather than a wrapping row: the twenty ramps are
              meant to read as two even rows of ten, and with "no colour" in the
              same flex line the wrap fell 10/9/1. */}
          <div className="grid w-fit grid-cols-10 gap-1.5">
            {PICTURE_TILE_GRADIENTS.map((c) => (
              /* Not a kit control: a colour swatch is a coloured target with no
                 label, which no Button variant should ever become. */
              <button
                key={c.token}
                data-kit-ok
                type="button"
                title={c.token.replace('pic-', '').replace('-', ' ')}
                aria-label={`Colour ${c.token.replace('pic-', '')}`}
                aria-pressed={color === c.token}
                onClick={() => onColorChange(c.token)}
                className={`size-7 rounded-control border-2 transition ${c.className} ${
                  color === c.token ? 'border-ink' : 'border-transparent'
                }`}
              />
            ))}

          </div>

          {/* No colour, on its own line BELOW the grid — "none" is a different
              KIND of answer from the twenty ramps, and sitting in the grid it
              read as a twenty-first colour while also breaking the 10/10 wrap. */}
          <button
            data-kit-ok
            type="button"
            title="No background colour"
            aria-label="No background colour"
            aria-pressed={color === TILE_NONE.token}
            onClick={() => onColorChange(TILE_NONE.token)}
            className={`flex w-fit items-center gap-1.5 rounded-control border px-2 py-1 text-xs transition ${
              color === TILE_NONE.token
                ? 'border-ink text-ink'
                : 'border-border text-muted hover:bg-surface-2'
            }`}
          >
            <Icons.Ban size={13} />
            No background
          </button>

          {/* ── The icon ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2">
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

            {/* Beside the upload, never instead of it — a real picture is
                better when there is one. This is for the long tail of products
                nobody will ever photograph, where a coloured tile carrying the
                name still beats a bare letter on the till button. */}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || productId === null}
              onClick={() => setGenerateOpen(true)}
            >
              Generate icon
            </Button>

            {icon && (
              <Button variant="danger-ghost" size="sm" disabled={busy} onClick={remove}>
                <Icons.Trash size={15} />
                Remove icon
              </Button>
            )}
          </div>

          <p className="max-w-80 text-xs text-muted">
            {productId === null ? (
              <>Save this product first, then add its till icon. {IMAGE_EXTENSIONS_LABEL}.</>
            ) : (
              <>
                Shown on the point-of-sale button. Photographs for your online store are separate —
                add those under <span className="font-medium text-ink">Photographs</span> below.
              </>
            )}
          </p>
        </div>
      </div>

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
