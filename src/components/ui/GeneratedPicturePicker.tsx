'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { Button } from './Button'
import { Field, Input } from './Field'
import {
  PICTURE_FONTS,
  PICTURE_GRADIENTS,
  captionFor,
  drawGeneratedPicture,
  fontById,
  generatedPictureFile,
  gradientById,
  initialFor,
  suggestGradient,
  type PictureGradient,
} from '@/lib/generatedPicture'

/* ── Generated picture picker ─────────────────────────────────────────────────
   For a product (or anything else with a name) that has no photograph: build a
   picture from the item's OWN initial and name on a gradient.

   It sits ALONGSIDE the ordinary upload, never instead of it — a real
   photograph is always better. A pick becomes a PNG `File` that the caller
   saves through its normal image upload, so nothing downstream changes: the
   till and the storefront receive an ordinary product picture and never learn
   it was generated. */

/**
 * The controls + live preview, INLINE — for a form that already sits inside a
 * modal and so cannot open a second one on top.
 */
export function GeneratedPictureGallery({
  name,
  disabled = false,
  busy = false,
  onPick,
  fontId,
  onFontChange,
  renderAction,
}: {
  /** The item's name — seeds the initial, the caption and the default gradient. */
  name: string
  disabled?: boolean
  /** Show the button as working while the caller uploads. */
  busy?: boolean
  /**
   * Receives a ready-to-upload PNG File. Return `false` to say the save failed,
   * which keeps the dialog open on whatever the user had built — closing it on
   * a rejected upload would tell them the opposite of what happened.
   */
  onPick: (file: File) => boolean | void | Promise<boolean | void>
  /**
   * The site's saved typeface (a PICTURE_FONTS id). SITE-WIDE, not per product —
   * every generated picture uses it.
   */
  fontId?: string | null
  /**
   * Persist a newly chosen typeface. Called only when the user actually
   * generates, so browsing fonts and closing the dialog changes nothing
   * site-wide; skipped when the font is unchanged.
   */
  onFontChange?: (fontId: string) => void | Promise<void>
  /**
   * Render the confirm button through the caller rather than under the controls
   * — the modal puts it in its FOOTER, where every other dialog in the app
   * keeps its primary action. An inline caller omits this and gets the button
   * where it stands.
   */
  renderAction?: (action: ReactNode) => ReactNode
}) {
  const [gradientId, setGradientId] = useState<string | null>(null)
  const [initial, setInitial] = useState(() => initialFor(name))
  const [caption, setCaption] = useState(() => captionFor(name))
  const [rendering, setRendering] = useState(false)
  const previewRef = useRef<HTMLCanvasElement>(null)

  // Local font choice, seeded from the saved setting. Held separately so the
  // preview updates instantly while the SAVE is deferred to "Use this picture".
  const [pickedFont, setPickedFont] = useState<string | null>(null)
  const font = fontById(pickedFont ?? fontId)

  // Follow the saved setting when it arrives/changes, unless the user has
  // already chosen something else in this dialog.
  useEffect(() => {
    setPickedFont(null)
  }, [fontId])

  // Re-seed when the item changes (the same picker instance serves whichever
  // product is open). Deliberately keyed on `name`, so a user's own edits to
  // the initial/caption survive re-renders but not a switch to another item.
  const seeded = useRef(name)
  useEffect(() => {
    if (seeded.current === name) return
    seeded.current = name
    setInitial(initialFor(name))
    setCaption(captionFor(name))
    setGradientId(null)
  }, [name])

  // No explicit pick yet → suggest one from the name, so the dialog opens on a
  // sensible colour rather than always green.
  const gradient: PictureGradient = useMemo(
    () => (gradientId ? gradientById(gradientId) : suggestGradient(name || 'product')),
    [gradientId, name],
  )

  // The preview is painted by the SAME renderer that writes the saved PNG, at a
  // smaller size — so what the user approves is what gets stored.
  useEffect(() => {
    const canvas = previewRef.current
    if (!canvas) return
    drawGeneratedPicture(canvas, { initial, caption, gradient, font, size: 320 })
  }, [initial, caption, gradient, font])

  const hasContent = initial.trim() !== '' || captionFor(caption) !== ''
  const blocked = disabled || busy || rendering || !hasContent

  async function generate() {
    if (blocked) return
    setRendering(true)
    try {
      const file = await generatedPictureFile({ initial, caption, gradient, font })
      // Persist the typeface BEFORE handing over the file: onPick usually closes
      // the dialog, and a save fired after that would race the unmount. The font
      // is a site-wide default, so it is only written when it actually changed.
      if (onFontChange && font.id !== (fontId || PICTURE_FONTS[0].id)) {
        await onFontChange(font.id)
      }
      await onPick(file)
    } finally {
      setRendering(false)
    }
  }

  const action = (
    <Button variant="primary" disabled={blocked} onClick={() => void generate()}>
      {busy || rendering ? 'Working…' : 'Use this picture'}
    </Button>
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">Preview</h3>
        <p className="mt-0.5 text-xs text-muted">
          Builds a picture from the product’s initial and name — handy when there’s no photo
          to upload.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {/* Live preview. Drawn at 320px and displayed at 160px so it stays sharp
            on a high-DPI screen. */}
        <canvas
          ref={previewRef}
          aria-label="Preview of the generated picture"
          className="size-40 shrink-0 rounded-card border border-border"
        />

        <div className="flex min-w-[260px] flex-1 flex-col gap-4">
          <div className="flex gap-3">
            <Field label="Letter" className="w-20 shrink-0">
              <Input
                value={initial}
                maxLength={2}
                disabled={disabled || busy}
                onChange={(e) => setInitial(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Caption" className="min-w-0 flex-1">
              <Input
                value={caption}
                maxLength={40}
                disabled={disabled || busy}
                onChange={(e) => setCaption(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Font"
            hint="Applies to every generated picture, not just this product."
          >
            <div className="flex flex-wrap gap-2">
              {PICTURE_FONTS.map((f) => {
                const selected = f.id === font.id
                return (
                  /* data-kit-ok: a type SPECIMEN, not a button — each chip is
                     set in the face it offers, which is the whole point of the
                     row. A kit Button forces its own type styles, so the eight
                     choices would render as eight identical labels. */
                  <button
                    data-kit-ok
                    key={f.id}
                    type="button"
                    disabled={disabled || busy}
                    onClick={() => setPickedFont(f.id)}
                    aria-pressed={selected}
                    style={{ fontFamily: f.stack }}
                    className={`inline-flex h-control-sm items-center rounded-control border px-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected
                        ? 'border-brand bg-brand-soft font-semibold text-ink'
                        : 'border-border bg-surface text-ink hover:bg-surface-2'
                    }`}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field label="Gradient">
            <div className="flex flex-wrap gap-2">
              {PICTURE_GRADIENTS.map((g) => {
                const selected = g.id === gradient.id
                return (
                  /* data-kit-ok: a colour swatch IS its own colour, so the fill
                     has to be the gradient itself rather than a token. See the
                     note at the top of lib/generatedPicture on why these hexes
                     are not theme colours. */
                  <button
                    data-kit-ok
                    key={g.id}
                    type="button"
                    disabled={disabled || busy}
                    aria-label={g.label}
                    aria-pressed={selected}
                    title={g.label}
                    onClick={() => setGradientId(g.id)}
                    className={`size-9 rounded-control border transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-50 ${
                      selected ? 'border-ink ring-2 ring-ink' : 'border-border'
                    }`}
                    style={{ backgroundImage: `linear-gradient(135deg, ${g.from}, ${g.to})` }}
                  />
                )
              })}
            </div>
          </Field>
        </div>
      </div>

      {renderAction ? (
        renderAction(action)
      ) : (
        <div>{action}</div>
      )}
    </div>
  )
}

/**
 * The same thing as its own dialog — for a screen whose image controls are a
 * row of buttons, where the gallery has nowhere to live inline.
 */
export function GeneratedPictureModal({
  open,
  onClose,
  name,
  busy = false,
  onPick,
  title = 'Generate a picture',
  fontId,
  onFontChange,
}: {
  open: boolean
  onClose: () => void
  name: string
  busy?: boolean
  /** Return `false` to keep the dialog open — see GeneratedPictureGallery. */
  onPick: (file: File) => boolean | void | Promise<boolean | void>
  title?: string
  /** The site's saved typeface, loaded server-side by the host page. */
  fontId?: string | null
  /** Persist a newly chosen typeface. See GeneratedPictureGallery. */
  onFontChange?: (fontId: string) => void | Promise<void>
}) {
  // The confirm button belongs in the modal's FOOTER, but only the gallery
  // knows whether it is blocked or mid-render. So the gallery still builds the
  // button and hands it back through renderAction, and this holds it until the
  // footer is rendered — one button, one source of truth about its state.
  const [footerAction, setFooterAction] = useState<ReactNode>(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={title}
      description="Pick a font and a gradient — the picture is built from the product’s name."
      footer={footerAction}
    >
      <GeneratedPictureGallery
        name={name}
        busy={busy}
        fontId={fontId}
        onFontChange={onFontChange}
        renderAction={(action) => <FooterPortal action={action} onReady={setFooterAction} />}
        onPick={async (file) => {
          // Only an explicit `false` holds the dialog open, so a caller that
          // returns nothing keeps the ordinary close-on-save behaviour.
          if ((await onPick(file)) === false) return false
          onClose()
        }}
      />
    </Modal>
  )
}

/**
 * Lifts the gallery's confirm button up to the modal's footer.
 *
 * Renders nothing itself — it exists only to run the effect that hands the
 * button to the parent, which is the one thing a child cannot do during its own
 * render without React complaining about updating a parent mid-render.
 */
function FooterPortal({
  action,
  onReady,
}: {
  action: ReactNode
  onReady: (action: ReactNode) => void
}) {
  useEffect(() => {
    onReady(action)
  }, [action, onReady])
  return null
}
