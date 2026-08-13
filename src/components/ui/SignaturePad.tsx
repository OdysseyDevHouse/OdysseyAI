'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Input } from './Field'
import * as Icons from './icons'

/**
 * A pad a customer signs with a finger, producing a PNG.
 *
 * ── WHY A CANVAS AND NOT A TYPED NAME ───────────────────────────────────────
 *
 * A typed name is a valid electronic signature under ECTA and would have been a
 * tenth of this code. It was rejected because of what it looks like: a text box
 * reading "J. Malan" is an admission somebody typed, and the customer standing
 * at the van knows it. A mark they made themselves is the thing they recognise
 * as signing, and the thing that survives being shown back to them in a dispute.
 *
 * ── POINTER EVENTS, NOT MOUSE PLUS TOUCH ────────────────────────────────────
 *
 * One set of handlers covers finger, stylus and mouse. Two sets would fire both
 * on a touch laptop and draw every stroke twice.
 *
 * `touch-none` on the canvas is load-bearing: without it the browser claims the
 * gesture for scrolling and the signature comes out as a few disconnected dots.
 *
 * ── THE BACKING STORE IS SCALED, THE CSS SIZE IS NOT ────────────────────────
 *
 * The canvas is laid out by CSS and its pixel buffer sized separately from
 * devicePixelRatio, or a signature on a phone is a blurry enlargement of a
 * small bitmap. Every coordinate therefore goes through the bounding rect
 * rather than using offsetX directly.
 */
export function SignaturePad({
  onCapture,
  onCancel,
  statement,
  busy = false,
  width = 600,
}: {
  /** Called with the signature as a PNG blob, plus the typed name if given. */
  onCapture: (png: Blob, name: string) => void
  onCancel?: () => void
  /** What the customer is agreeing to. Shown above the pad. */
  statement?: string
  busy?: boolean
  /** Pixel width of the saved PNG. Height follows the pad aspect. */
  width?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef(false)
  const [hasInk, setHasInk] = useState(false)
  const [name, setName] = useState('')

  /*
   * Sizes the backing store to the element and re-applies the stroke style.
   *
   * Setting canvas.width WIPES the canvas and resets the 2d context, so this
   * runs on mount and on resize only — never mid-stroke. A signature in
   * progress when the phone rotates is lost, which is correct: the alternative
   * is a stroke that jumps to a different scale halfway through.
   */
  const fit = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // Read from the stylesheet rather than hard-coded, so the ink follows the
    // theme like everything else in the kit. Falls back to the ink token's own
    // value if the property is somehow unset.
    ctx.strokeStyle =
      getComputedStyle(canvas).getPropertyValue('--color-ink').trim() || '#1a1a1a'
    setHasInk(false)
  }, [])

  useEffect(() => {
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  function pointAt(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busy) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    // Capture, so a finger that slides off the pad mid-stroke keeps drawing to
    // the edge instead of ending the line wherever it happened to leave.
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const { x, y } = pointAt(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    // A tap with no movement is a dot, and a dot is ink: somebody who taps once
    // and presses Accept has signed something, however briefly.
    ctx.lineTo(x, y)
    ctx.stroke()
    setHasInk(true)
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const { x, y } = pointAt(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  function end() {
    drawing.current = false
  }

  function clear() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    // Cleared in CSS pixels, not canvas pixels: the context is scaled by dpr, so
    // clearing canvas.width would only wipe the top-left corner on a retina
    // screen and leave the rest of the signature visible.
    const rect = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, rect.width, rect.height)
    setHasInk(false)
  }

  function accept() {
    const canvas = canvasRef.current
    if (!canvas || !hasInk) return

    /*
     * Rendered onto a second canvas at the requested width, over an opaque white
     * ground.
     *
     * The white matters. The pad's ink is the theme's foreground colour, so a
     * signature captured in dark mode is near-white strokes on transparency —
     * invisible the moment it is opened in any viewer that assumes a white page,
     * which is every PDF and every printed job sheet.
     */
    const out = document.createElement('canvas')
    const rect = canvas.getBoundingClientRect()
    const scale = width / rect.width
    out.width = width
    out.height = Math.round(rect.height * scale)
    const ctx = out.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, 0, 0, out.width, out.height)

    out.toBlob((blob) => {
      if (blob) onCapture(blob, name.trim())
    }, 'image/png')
  }

  return (
    <div className="space-y-2">
      {statement && <p className="text-sm text-muted">{statement}</p>}

      <div className="rounded-card border border-border bg-surface">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          // touch-none: see the header. Without it the gesture scrolls the page.
          className="block h-40 w-full touch-none rounded-card"
          aria-label="Signature pad"
        />
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (optional)"
            maxLength={120}
            disabled={busy}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={clear} disabled={busy || !hasInk}>
          <Icons.Eraser size={15} />
          Clear
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {/* Disabled until there is ink: accepting an empty pad would store a blank
            white PNG as a customer signature, which is worse than no signature
            because it looks like one in a list. */}
        <Button size="sm" onClick={accept} disabled={busy || !hasInk}>
          {busy ? 'Saving…' : 'Accept'}
        </Button>
      </div>
    </div>
  )
}
