'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icons } from '@/components/ui'
import { BannerFrame } from './HomeSections'

/**
 * A rotating banner.
 *
 * ── MOVING CONTENT IS A COST, SO IT PAYS FOR ITSELF OR IT STOPS ──────────
 *
 * A carousel takes control of the page away from the person reading it. That is
 * the whole complaint about them, and everything below is an answer to it:
 *
 *   it STOPS on hover, on focus, and when the tab is hidden;
 *   it never rotates at all for a reader who asked for reduced motion;
 *   it never rotates when there is only one slide to rotate to;
 *   the arrows and dots are real controls, so nobody has to wait for it;
 *   and it can be turned off entirely by setting the interval to 0.
 *
 * A shopper who takes hold of it keeps hold of it — see `stopped` — because a
 * banner that yanks itself away mid-sentence is worse than one that never moved.
 *
 * ── IT IS NOT A LIST OF LINKS TO A SCREEN READER ─────────────────────────
 *
 * Only the current slide is in the accessibility tree; the rest are
 * `aria-hidden` and have their links taken out of the tab order. Otherwise a
 * keyboard user tabs through eight invisible banners to reach the products,
 * which is the single most common way a carousel breaks a page.
 */

export type CarouselSlide = {
  id: string
  /** Where this slide goes when clicked. Empty means it is not a link. */
  href: string
  /** The picture and its words — a `BannerFace`. See HomeSections. */
  face: ReactNode
}

export default function Carousel({
  slides,
  autoplaySeconds,
}: {
  slides: CarouselSlide[]
  /** 0 means the shopper moves it themselves. See HomeSection.autoplaySeconds. */
  autoplaySeconds: number
}) {
  const [index, setIndex] = useState(0)

  /**
   * Whether the shopper has taken hold of it — hovering, focused inside, or
   * having pressed an arrow or a dot.
   *
   * ── PRESSING AN ARROW STOPS IT FOR GOOD ──────────────────────────────
   *
   * Not for a while, and not until the pointer leaves: for the rest of the
   * visit. Somebody who reaches for the arrows is reading at their own pace,
   * and resuming the timer behind them means the slide they navigated to slides
   * away while they are looking at it. The play button brings it back.
   */
  const [stopped, setStopped] = useState(false)
  const [hovering, setHovering] = useState(false)

  /**
   * Whether the browser is willing to animate at all.
   *
   * Read in an effect rather than during render because the server has no
   * matchMedia and no reader preference to read — starting at `false` and
   * correcting on mount keeps the markup identical on both sides. The
   * correction lands before the first tick could fire, so a reader who asked
   * for reduced motion never sees a rotation.
   */
  const [reducedMotion, setReducedMotion] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  /**
   * Whether this tab is the one being looked at.
   *
   * A carousel rotating in a background tab burns a timer to advance past
   * slides nobody saw — so a shopper returning to the tab arrives at whichever
   * slide the clock happened to land on rather than the one they left.
   */
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const count = slides.length

  /*
   * Guard the index against the slide list shrinking underneath it.
   *
   * The builder edits this live: deleting the last slide while it is the one
   * showing would otherwise leave `index` past the end and render nothing at
   * all — a blank frame where a banner was, with no way to tell it apart from a
   * broken picture.
   */
  const safeIndex = count === 0 ? 0 : Math.min(index, count - 1)

  const go = useCallback(
    (next: number) => {
      if (count === 0) return
      // Wraps both ways, so "previous" from the first slide lands on the last
      // rather than doing nothing — a control that silently refuses reads as
      // broken.
      setIndex(((next % count) + count) % count)
    },
    [count],
  )

  /** Moving it by hand takes it off the timer. See `stopped`. */
  const take = useCallback(
    (next: number) => {
      setStopped(true)
      go(next)
    },
    [go],
  )

  const rotating = autoplaySeconds > 0 && count > 1 && !stopped && !reducedMotion

  /*
   * The timer.
   *
   * Keyed on `safeIndex` as well as the conditions, so each tick restarts the
   * clock from the slide that just arrived. Without that, a shopper who hovers
   * for four of a six-second interval and leaves gets two seconds on the next
   * slide.
   */
  useEffect(() => {
    if (!rotating || hovering || !visible) return
    const timer = setTimeout(() => go(safeIndex + 1), autoplaySeconds * 1000)
    return () => clearTimeout(timer)
  }, [rotating, hovering, visible, safeIndex, autoplaySeconds, go])

  /*
   * The height of the TALLEST slide, which every slide then sits in.
   *
   * ── WHY THE TALLEST AND NOT THE ONE SHOWING ──────────────────────────
   *
   * Following the showing slide meant the frame resized on every rotation, and
   * everything below it — the departments, the products, whatever a shopper was
   * reaching for — moved with it. A page that rearranges itself every few
   * seconds is worse than one that reserves a little space.
   *
   * So the frame is sized once, to the biggest picture, and never moves again.
   * Shorter slides are centred in it with space above and below. That space is
   * the cost, and it is the right one: it is quiet, it is predictable, and a
   * shop can remove it entirely by using pictures of one shape.
   *
   * ── WHY THIS IS MEASURED RATHER THAN DECLARED ────────────────────────
   *
   * A banner shows its picture whole, so its height is whatever that picture's
   * proportions make it — and nothing on the server knows that: the images
   * table stores no width or height, and the file is not read at render time.
   * The browser learns it as each image decodes, and this is where that
   * knowledge is captured.
   *
   * `null` means "nothing measured yet", which renders as `height: auto` — the
   * honest first paint, before any picture has loaded.
   */
  const [frameHeight, setFrameHeight] = useState<number | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  /*
   * Watch EVERY slide and keep the frame at the largest.
   *
   * A ResizeObserver rather than load handlers, because the heights move for
   * three different reasons and only one of them is a load: the pictures
   * decoding one by one, the window being resized (these are full-width, so a
   * narrower window is a shorter banner), and the slide list changing in the
   * builder. One observer covers all three; three handlers would have to agree
   * with each other.
   *
   * Every slide is measurable even while hidden: they are `opacity-0`, not
   * `display:none`, so each has a real height as soon as its picture decodes.
   * That is what makes "the tallest" knowable before a shopper has ever
   * advanced to it — the frame is right on the first paint rather than growing
   * as they click through.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    /*
     * The slide BODIES, not the slides themselves.
     *
     * A slide is pinned to the frame's own edges, so its height IS the frame's
     * height — measuring those would feed the value back into itself and the
     * frame could never shrink. The body inside is a normal flex child whose
     * height is the picture's.
     */
    const bodies = [...stage.querySelectorAll<HTMLElement>('[data-slide-body]')]
    if (bodies.length === 0) return

    /*
     * The max, and it only ever GROWS within a measuring pass.
     *
     * Taken across all slides each time rather than accumulated into the
     * previous value, so the frame still shrinks when it genuinely should — a
     * narrower window, or the tallest slide being deleted in the builder.
     * Accumulating would leave the frame stuck at the tallest height any
     * picture ever reached during the session.
     */
    const measure = () => {
      const tallest = Math.max(...bodies.map((b) => b.offsetHeight))
      setFrameHeight(tallest > 0 ? tallest : null)
    }
    measure()

    const observer = new ResizeObserver(measure)
    for (const body of bodies) observer.observe(body)
    return () => observer.disconnect()
  }, [count])

  /**
   * Left and right arrow keys, when the focus is inside the carousel.
   *
   * Bound to the region rather than the document: this is one widget on a page
   * of them, and stealing the arrow keys from the whole shop would break
   * scrolling everywhere else.
   */
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      take(safeIndex - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      take(safeIndex + 1)
    }
  }

  if (count === 0) return null

  /*
   * One slide is not a carousel.
   *
   * Drawn as a plain banner, with no controls and no live region: arrows that
   * go nowhere and a dot that cannot be pressed are worse than nothing, and a
   * shop whose other slides all lost their pictures should look like a shop
   * with one banner, not like a broken carousel.
   */
  if (count === 1) {
    return <BannerFrame href={slides[0].href}>{slides[0].face}</BannerFrame>
  }

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label="Featured banners"
      className="relative"
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      /* Focus anywhere inside pauses it too — a keyboard user reading a slide
         gets the same courtesy a mouse user gets by resting the pointer on it. */
      onFocus={() => setHovering(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovering(false)
      }}
    >
      {/*
        The slides are STACKED, not laid side by side. Only the current one is
        in the accessibility tree — see the header.

        ── THE FRAME IS FIXED TO THE TALLEST SLIDE ──────────────────────────

        Every slide is absolutely positioned, so none of them gives this
        container a height; it gets one from `frameHeight`, measured across all
        of them. The frame therefore does not move when the banner turns, and
        neither does anything below it.

        Every slide stays mounted rather than swapping one in, for two reasons:
        the pictures are already decoded when their turn comes, so a rotation is
        a fade rather than a flash of empty frame — and a hidden slide still has
        a measurable height, which is what makes "the tallest" knowable at all.
      */}
      <div
        ref={stageRef}
        /* `height: auto` only until the first picture decodes. After that an
           explicit pixel height — which is also what lets the rare, legitimate
           resize (a narrower window) animate: CSS cannot tween to or from
           `auto`. */
        style={frameHeight === null ? undefined : { height: frameHeight }}
        className="relative transition-[height] duration-500 motion-reduce:transition-none"
      >
        {slides.map((slide, i) => {
          const showing = i === safeIndex
          return (
            <div
              key={slide.id}
              /* How the effect above finds the slides to measure. A data
                 attribute rather than an array of refs: the DOM already holds
                 them, and a parallel array would be a second list to keep in
                 step with this one. */
              data-slide=""
              aria-hidden={!showing}
              /* `inert` keeps the links of a hidden slide out of the tab order.
                 aria-hidden alone hides them from a screen reader while leaving
                 them tabbable, which is the worst of both. */
              {...(showing ? {} : { inert: '' as unknown as boolean })}
              /*
                Every slide absolute and pinned to all four edges, so each one
                is exactly as tall as the frame — and `items-center` then puts a
                shorter picture in the MIDDLE of that space rather than at the
                top, which is what stops a short slide reading as a tall one
                that failed to load.

                `inset-0` rather than `top-0` alone is load-bearing for the
                centring: without a bottom edge the slide has no height of its
                own to centre within.
              */
              className={`absolute inset-0 flex items-center transition-opacity duration-500 motion-reduce:transition-none ${
                showing ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              {/*
                THIS is what gets measured, not the slide around it.

                The slide is pinned to `inset-0`, so its own height is the
                frame's height — measuring that would feed the frame its own
                value and it could never shrink again. This wrapper is a normal
                flex child, so its height is the picture's real one.

                w-full because a flex child would otherwise shrink to its
                content and the banner would stop spanning the column.
              */}
              <div data-slide-body className="w-full">
                <BannerFrame href={slide.href}>{slide.face}</BannerFrame>
              </div>
            </div>
          )
        })}
      </div>

      {/*
        What changed, for a screen reader.

        `polite` and text-only: announcing the slide's own markup would read a
        heading, a paragraph and a link every few seconds. "2 of 4" is what a
        sighted shopper gets from the dots, and it is enough.
      */}
      <span className="sr-only" aria-live="polite" aria-atomic>
        {`Slide ${safeIndex + 1} of ${count}`}
      </span>

      {/* The arrows. Over the picture, vertically centred, and always present
          rather than appearing on hover — a control that has to be discovered
          by sweeping the mouse does not exist on a touchscreen. */}
      <CarouselButton
        className="left-2"
        label="Previous banner"
        onClick={() => take(safeIndex - 1)}
      >
        <Icons.ChevronLeft size={18} />
      </CarouselButton>
      <CarouselButton className="right-2" label="Next banner" onClick={() => take(safeIndex + 1)}>
        <Icons.ChevronRight size={18} />
      </CarouselButton>

      {/* The dots, and the pause control beside them. Inside the frame at the
          bottom, where a carousel's controls are expected to be. */}
      <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2">
        {slides.map((slide, i) => (
          /* Not a kit Button: this is a 10px dot drawn over a photograph, at no
             kit size and with no kit variant. A Button variant for it would be
             used nowhere else in the app. */
          <button
            data-kit-ok
            key={slide.id}
            type="button"
            onClick={() => take(i)}
            aria-label={`Show banner ${i + 1}`}
            aria-current={i === safeIndex}
            /* on-image, not surface: these sit ON the photograph, and `surface`
               flips to near-black in the dark theme — see BannerFace. */
            className={`size-2.5 rounded-pill border border-on-image/70 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-image ${
              i === safeIndex ? 'bg-on-image' : 'bg-on-image/30 hover:bg-on-image/60'
            }`}
          />
        ))}

        {/*
          Stop and start, but only when there is a timer to stop.

          WCAG asks for a way to pause anything that moves for more than five
          seconds on its own, and hover is not that way — it does not exist on a
          touchscreen and it cannot be reached by keyboard. This is the control
          that satisfies it, and it is also simply what somebody wants when a
          banner keeps sliding away mid-read.

          Absent entirely when the owner set the interval to 0: there is nothing
          to pause, and a paused-looking control on a carousel that never moves
          is a puzzle rather than a feature.
        */}
        {autoplaySeconds > 0 && !reducedMotion && (
          /* Same reasoning as the dots — a small round control over a
             photograph, at no kit size. */
          <button
            data-kit-ok
            type="button"
            onClick={() => setStopped((was) => !was)}
            aria-label={stopped ? 'Start the banners turning' : 'Stop the banners turning'}
            className="ml-1 flex size-6 items-center justify-center rounded-pill bg-image-scrim/50 text-on-image transition hover:bg-image-scrim/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-image"
          >
            {stopped ? <Icons.Play size={12} /> : <Icons.Pause size={12} />}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One of the two arrows.
 *
 * `data-kit-ok`: a translucent circle drawn ON a photograph, sized to the
 * picture rather than to `h-control`. The kit's ghost button assumes a surface
 * background and would be invisible here — and adding an "over an image"
 * variant to the kit for two buttons on one storefront widget is the wrong
 * trade. Everything else about it — the focus ring, the transition — matches.
 *
 * Coloured with the on-image tokens rather than ink/surface, for the reason
 * BannerFace spells out: these do not flip with the theme.
 */
function CarouselButton({
  className,
  label,
  onClick,
  children,
}: {
  className: string
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      data-kit-ok
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 z-[1] flex size-9 -translate-y-1/2 items-center justify-center rounded-pill bg-image-scrim/50 text-on-image transition hover:bg-image-scrim/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-image ${className}`}
    >
      {children}
    </button>
  )
}
