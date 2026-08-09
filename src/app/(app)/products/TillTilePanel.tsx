'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Button,
  Icons,
  TILE_GRADIENTS,
  TILE_NONE,
  TILE_SWATCHES,
  tileClass,
  useToast,
} from '@/components/ui'
import { IMAGE_ACCEPT, IMAGE_EXTENSIONS_LABEL } from '@/lib/productImageModel'
import { removeProductIconAction, uploadProductIconAction } from './imageActions'

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
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [icon, setIcon] = useState(initialIcon)
  const fileInput = useRef<HTMLInputElement>(null)

  /*
   * Bumped on every successful upload and appended to the icon's URL.
   *
   * The route is keyed by product id, so replacing an icon reuses the same URL
   * and the browser would keep showing the cached picture — the upload would
   * look like it had silently failed. This makes each version its own URL.
   */
  const [version, setVersion] = useState(0)

  function upload(files: FileList | null) {
    const file = files?.[0]
    if (!file || productId === null) return

    startAction(async () => {
      const form = new FormData()
      form.set('file', file)
      const result = await uploadProductIconAction(productId, form)
      if (!result.ok) {
        toast.error(result.error)
      } else {
        setIcon(result.storedName)
        setVersion((v) => v + 1)
        toast.success('Till icon updated.')
      }
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
          className={`relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-card text-white ${tileClass(color)}`}
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
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {TILE_SWATCHES.map((c) => (
                /* Not a kit control: a colour swatch is a coloured target with
                   no label, which no Button variant should ever become. */
                <button
                  key={c.token}
                  data-kit-ok
                  type="button"
                  aria-label={`Colour ${c.token}`}
                  aria-pressed={color === c.token}
                  onClick={() => onColorChange(c.token)}
                  className={`size-6 rounded-pill border-2 transition ${c.className} ${
                    color === c.token ? 'border-ink' : 'border-transparent'
                  }`}
                />
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {TILE_GRADIENTS.map((c) => (
                /* Same as above — see the note on the flat swatches. */
                <button
                  key={c.token}
                  data-kit-ok
                  type="button"
                  aria-label={`Gradient ${c.token}`}
                  aria-pressed={color === c.token}
                  onClick={() => onColorChange(c.token)}
                  className={`size-6 rounded-pill border-2 transition ${c.className} ${
                    color === c.token ? 'border-ink' : 'border-transparent'
                  }`}
                />
              ))}

              {/* No colour. Set apart by a divider and drawn as an outlined
                  blank rather than a filled circle, because "none" is a
                  different KIND of answer from the sixteen colours before it —
                  another circle in the row would read as a seventeenth. */}
              <span aria-hidden className="mx-0.5 h-5 w-px bg-border" />
              <button
                data-kit-ok
                type="button"
                title="No background colour"
                aria-label="No background colour"
                aria-pressed={color === TILE_NONE.token}
                onClick={() => onColorChange(TILE_NONE.token)}
                className={`flex size-6 items-center justify-center rounded-pill border-2 bg-surface-2 transition ${
                  color === TILE_NONE.token ? 'border-ink' : 'border-border'
                }`}
              >
                <Icons.Ban size={13} className="text-muted" />
              </button>
            </div>
          </div>

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
    </div>
  )
}
