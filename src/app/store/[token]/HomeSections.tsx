import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  liveSlides,
  sectionIsEmpty,
  type HomeSection,
  type StorefrontTheme,
} from '@/lib/storefrontModel'
import type {
  StorefrontDepartment,
  StorefrontImage,
  StorefrontProduct,
} from '@/lib/site/storefront'
import ProductGrid from './ProductGrid'
import Carousel from './Carousel'
import { DepartmentImage } from './ShopBits'

export type ProductDisplay = {
  layout: 'grid' | 'list'
  showStock: boolean
  showPhotos: boolean
  showBrands: boolean
  /**
   * Whether departments show their picture, here and on the rail.
   *
   * Travels with the product display flags because it reaches the page the
   * same way — one settings row, passed whole — and because the builder must
   * pass exactly what the shop passes or the preview stops matching.
   */
  showDepartmentImages: boolean
}

/**
 * The shop's front page, as the owner arranged it.
 *
 * ── EVERY SECTION RENDERS NOTHING WHEN EMPTY ─────────────────────────────
 *
 * A products row with no matches draws no heading, no frame, nothing. That is
 * what lets an owner switch every section on to see what each does without
 * ending up with a page of empty headings.
 *
 * ── ONE COMPONENT, TWO CALLERS ───────────────────────────────────────────
 *
 * The page builder renders THIS, not a copy of it. `renderSection` is how: the
 * shop passes nothing and gets the plain page, while the builder passes a
 * wrapper that adds a drag handle, a toolbar and a click target around each
 * real section.
 *
 * That is the whole reason the preview cannot drift from the shop — there is
 * no second implementation to drift. A mock preview is a promise you have to
 * keep updated by hand, and it is always the thing that goes stale first.
 */

export type SectionContent = {
  section: HomeSection
  products?: StorefrontProduct[]
  departments?: StorefrontDepartment[]
  /** banner: the resolved picture, or null when it is missing or unset. */
  image?: StorefrontImage | null
  /** carousel: each slide's picture, keyed by image id. See SectionFill. */
  slideImages?: Map<number, StorefrontImage>
}

/**
 * Where a banner's picture comes from.
 *
 * The shop and the builder read the same bytes through DIFFERENT routes: the
 * public one requires an open store, and the builder must work on a closed
 * one. Passing the resolver in rather than building a URL here keeps that
 * difference in the two callers that actually have the context to decide it.
 */
export type ImageSrc = (imageId: number) => string

export default function HomeSections({
  token,
  content,
  theme,
  display,
  imageSrc,
  renderSection,
}: {
  token: string
  content: SectionContent[]
  theme: StorefrontTheme
  /**
   * The shop's display choices, passed straight through to the tiles.
   *
   * Bundled rather than four separate props because they always travel
   * together, and because the builder must pass exactly what the shop passes
   * or the preview stops matching the thing it is previewing.
   */
  display: ProductDisplay
  /** Turns a banner's image id into a URL. See ImageSrc. */
  imageSrc: ImageSrc
  /**
   * Wraps each section. `node` is null when the section would render nothing,
   * which the shop skips entirely and the builder replaces with a placeholder
   * explaining why.
   */
  renderSection?: (section: HomeSection, node: ReactNode) => ReactNode
}) {
  return (
    /*
     * ── @container, AND WHY EVERY BREAKPOINT BELOW IS A @ ONE ────────────
     *
     * The page builder draws this shop inside a panel that is narrower than
     * the window, and narrower again when the owner switches the preview to
     * phone width. Tailwind's `sm:`/`lg:` prefixes watch the VIEWPORT, so in
     * the builder they answered a question nobody asked — a phone-width
     * preview kept desktop column counts, and the owner was arranging a page
     * they would never see.
     *
     * Declaring the container here and using `@sm:`/`@lg:` inside makes every
     * grid respond to THIS box instead. The shop is unaffected — at full width
     * the container and the viewport are the same thing — and the builder's
     * preview becomes exact rather than approximate.
     */
    <div className="@container flex flex-col gap-8">
      {content.map((entry) => {
        const node = toned(entry.section, sectionBody(entry, token, theme, display, imageSrc))

        if (renderSection) return renderSection(entry.section, node)
        // The shop: an empty section is simply absent.
        return node
      })}
    </div>
  )
}

/**
 * Put a section on its coloured band, if it asked for one.
 *
 * ── WHY IT BLEEDS SIDEWAYS ───────────────────────────────────────────────
 *
 * A tinted section that stopped at the content column would read as a wide
 * card, not as a band — and a page of those is busier than the plain page it
 * replaced. The negative margin plus matching padding pushes the colour to the
 * edge of the page's gutter while the content stays exactly where it was, so
 * switching a section to 'tinted' moves nothing.
 *
 * Applied OUTSIDE sectionBody so it wraps the null case too — which it must
 * not, and does not: a section with nothing to show returns null here as well,
 * so an empty tinted section draws no stripe rather than an empty coloured
 * band with nothing in it.
 */
function toned(section: HomeSection, node: ReactNode): ReactNode {
  if (node === null || section.tone !== 'tinted') return node
  return (
    <div
      className="-mx-4 rounded-card px-4 py-6 @sm:-mx-6 @sm:px-6"
      /* A tint of the shop's own colour, mixed rather than a token: the value
         is the store's data. Validated to a hex before it is ever stored. */
      style={{ background: 'color-mix(in srgb, var(--color-brand) 7%, transparent)' }}
    >
      {node}
    </div>
  )
}

/**
 * One section's content, or null when it has nothing to show.
 *
 * Split out from the map so the builder can ask "would this render?" without
 * duplicating the rule — `node == null` IS the answer, and the placeholder it
 * draws instead is keyed off exactly that.
 */
function sectionBody(
  entry: SectionContent,
  token: string,
  theme: StorefrontTheme,
  display: ProductDisplay,
  imageSrc: ImageSrc,
): ReactNode {
  const { section, products, departments, image } = entry

  /*
   * ONE gate, at the top, rather than a guard inside each branch.
   *
   * Every branch below used to re-test its own emptiness, which meant the rule
   * lived in seven places and the publish summary would have made an eighth.
   * Asking `sectionIsEmpty` once means the shop, the builder's placeholder and
   * the pre-publish warning cannot disagree about what "shows nothing" means.
   */
  if (sectionIsEmpty(entry, theme)) return null

  if (section.kind === 'hero') {
    return (
      <section key={section.id}>
        <div
          className="rounded-card px-6 py-10 text-center"
          /* A tint of the shop's own colour. Inline because the value is the
             store's data, not a token — and it is validated to a hex before it
             is ever stored. */
          style={{ background: `color-mix(in srgb, ${theme.brandColour} 10%, transparent)` }}
        >
          {/* The loudest thing on the page, deliberately — this is a shop
              window, and a headline set at body weight reads as a notice
              rather than as a welcome. */}
          {theme.heroHeadline && (
            <h1 className="text-2xl font-semibold text-ink @sm:text-3xl">{theme.heroHeadline}</h1>
          )}
          {theme.heroSubtext && (
            <p className="mx-auto mt-2 max-w-xl text-base text-ink-2">{theme.heroSubtext}</p>
          )}
        </div>
      </section>
    )
  }

  if (section.kind === 'categories') {
    // Unreachable after the gate above — kept only so `departments` narrows
    // from `T[] | undefined` for the map below.
    if (!departments) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="grid grid-cols-2 gap-3 @sm:grid-cols-3 @lg:grid-cols-4">
          {departments.map((department) => (
            <li key={department.id}>
              <Link
                href={`/store/${token}?department=${department.id}`}
                className="flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card transition hover:bg-surface-2"
              >
                {/*
                  The picture, when the shop has switched them on. A 4:3 band
                  across the top of the tile rather than a thumbnail beside the
                  name: this section is the shop's own aisle signage, and a
                  photograph of the produce is what makes somebody pick an aisle.

                  Square-cropped via object-cover on a fixed ratio, unlike a
                  banner: these sit in a GRID, and letting each keep its own
                  proportions would give four tiles in a row four heights.
                */}
                {display.showDepartmentImages && (
                  <DepartmentImage
                    department={department}
                    // Resolved HERE, on the server, because DepartmentImage is
                    // a client component — see its `src` prop.
                    src={department.imageId ? imageSrc(department.imageId) : null}
                    rounded=""
                    className="aspect-[4/3] w-full text-2xl"
                  />
                )}
                <span className="flex flex-1 flex-col justify-between p-4">
                  <span className="text-sm font-medium text-ink">{department.name}</span>
                  <span className="mt-2 text-xs text-muted">
                    {department.productCount.toLocaleString('en-ZA')} item
                    {department.productCount === 1 ? '' : 's'}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (section.kind === 'products') {
    // Unreachable after the gate; narrows `products` for ProductGrid.
    if (!products) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        {/* The row's own layout wins when it has one, else the shop's. Spread
            first so `layout` overrides rather than being overridden. */}
        <ProductGrid
          token={token}
          products={products}
          {...display}
          layout={section.layout ?? display.layout}
        />
      </section>
    )
  }

  if (section.kind === 'banner') {
    // No picture means no banner. A coloured box with words in it is what the
    // welcome section already does, and doing it twice is not a second design.
    // Unreachable after the gate; narrows `image` for the src below.
    if (!image) return null

    return (
      <section key={section.id}>
        <BannerFrame href={section.linkUrl?.trim() ?? ''}>
          <BannerFace
            src={imageSrc(image.id)}
            alt={section.imageAlt || image.altText || ''}
            heading={section.title}
            bodyText={section.bodyText ?? ''}
            buttonLabel={section.buttonLabel ?? ''}
            hasLink={Boolean(section.linkUrl?.trim())}
          />
        </BannerFrame>
      </section>
    )
  }

  if (section.kind === 'carousel') {
    /*
     * The slides that can actually draw, through the SAME helper the gate
     * above used — so what is rotated is exactly what was counted. Asking the
     * question twice, two ways, is how a carousel ends up with a blank frame
     * in the rotation.
     */
    const slides = liveSlides(section, entry.slideImages)
    if (slides.length === 0) return null

    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <Carousel
          autoplaySeconds={section.autoplaySeconds ?? 0}
          slides={slides.map(({ slide, image: picture }) => ({
            id: slide.id,
            href: slide.linkUrl.trim(),
            face: (
              <BannerFace
                src={imageSrc(picture.id)}
                alt={slide.imageAlt || picture.altText || ''}
                heading={slide.heading}
                bodyText={slide.bodyText}
                buttonLabel={slide.buttonLabel}
                hasLink={Boolean(slide.linkUrl.trim())}
              />
            ),
          }))}
        />
      </section>
    )
  }

  if (section.kind === 'text') {
    const body = section.text?.trim() ?? ''
    if (!body && !section.title) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        {body && (
          /*
            whitespace-pre-line, so the paragraph breaks where the owner
            pressed Enter. The alternative is a rich-text editor, which brings
            HTML the owner can paste from anywhere onto a page that takes
            payments — this renders TEXT, and cannot render a tag.

            max-w-prose because a line of text spanning a wide screen is
            genuinely hard to read; mx-auto only when centred, so a left-aligned
            note stays flush with the products above it.
          */
          <p
            className={`max-w-prose whitespace-pre-line text-sm text-ink-2 @sm:text-base ${
              section.align === 'center' ? 'mx-auto text-center' : ''
            }`}
          >
            {body}
          </p>
        )}
      </section>
    )
  }

  if (section.kind === 'cards') {
    // A card with nothing written on it is not worth a tile.
    const cards = (section.cards ?? []).filter((c) => c.heading || c.text)
    if (cards.length === 0) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
          {cards.map((card, index) => (
            <li key={index} className="rounded-card border border-border bg-surface p-4 shadow-card">
              {card.icon && (
                <span className="text-xl" aria-hidden>
                  {card.icon}
                </span>
              )}
              {card.heading && <p className="mt-1 text-sm font-medium text-ink">{card.heading}</p>}
              {card.text && <p className="mt-0.5 text-sm text-muted">{card.text}</p>}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return null
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-base font-semibold text-ink">{children}</h2>
}

/* ── The banner, shared by the single one and every carousel slide ────────── */

/**
 * The box a banner picture sits in — a link when it has somewhere to go, a
 * plain div when it does not.
 *
 * Exported because the carousel draws its slides through the same box: two
 * copies of "a banner is clipped and rounded" would drift, and a shop whose
 * carousel is a slightly different shape from its banner section looks like a
 * rendering fault rather than a design.
 *
 * ── THE PICTURE DECIDES THE HEIGHT ───────────────────────────────────────
 *
 * This used to be a hard 16:6 box with the image absolutely positioned inside
 * it under `object-cover`, which meant a tall or square photograph had its
 * middle cut out and its top and bottom thrown away. An owner who uploads a
 * poster wants the poster, not a letterbox slice of it.
 *
 * So the frame has no height of its own: the `<img>` is a normal block element
 * and the box is whatever the picture makes it. `overflow-hidden` still applies
 * for the rounded corners; nothing is cropped because nothing overflows.
 */
export function BannerFrame({ href, children }: { href: string; children: ReactNode }) {
  const className = 'relative block overflow-hidden rounded-card'

  if (!href) return <div className={className}>{children}</div>
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

/**
 * A picture with words over it.
 *
 * ── ONE COMPONENT, TWO CALLERS ───────────────────────────────────────────
 *
 * The single banner section and every carousel slide draw through this. They
 * were the same markup twice for exactly as long as it took to add the second
 * one, and the parts that would have drifted are the parts that matter: the
 * scrim, and the rule that the button is a SPAN.
 */
export function BannerFace({
  src,
  alt,
  heading,
  bodyText,
  buttonLabel,
  hasLink,
}: {
  src: string
  alt: string
  heading: string
  bodyText: string
  buttonLabel: string
  /** Whether the frame around this is a link — the button only shows if so. */
  hasLink: boolean
}) {
  const hasWords = Boolean(heading || bodyText)

  return (
    <>
      {/*
        A plain <img>, not next/image. The bytes come from a route that
        re-sniffs them on the way out and serves them with a sandbox CSP;
        putting the optimiser in front would fetch and re-encode them through a
        second path that does none of that.

        A BLOCK element in normal flow, not an absolute fill: this is what
        gives the frame its height, so the whole picture shows rather than a
        16:6 slice of its middle.

        ── WHY IT IS CAPPED, AND WHY IT IS CENTRED ──────────────────────────

        `w-full` alone was not enough. A small portrait — the real case is a
        316x400 poster — was stretched to the full content width and came out
        1086px tall, taller than the window, pushing the entire shop below the
        fold to show one banner.

        So: `max-h-[70svh]` bounds it to most of the viewport whatever its
        proportions, `w-auto` lets a tall picture stop at the width that height
        implies rather than being forced wider, and `mx-auto` centres what is
        then narrower than the column. `object-contain` guarantees the whole
        picture is inside the box even at the cap — the one thing this change
        exists to promise.

        svh, not vh: on a phone the browser's chrome slides away as you scroll,
        and vh is measured against the LARGEST viewport, so a 70vh banner is
        taller than the screen it is first painted on.
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="mx-auto block h-auto max-h-[70svh] w-auto max-w-full object-contain"
      />

      {/*
        The scrim. Only when there are words: darkening a picture nobody is
        reading over is just a worse picture. Without it, white text on a pale
        photograph is invisible — and the owner cannot fix it, because they do
        not choose the text colour.

        `image-scrim` and `on-image`, NOT `ink` and `surface`. Those two invert
        with the theme, so in dark mode the wash came out pale and the words
        came out black — over a bright yellow photograph the text disappeared
        into exactly the picture the scrim existed to separate it from. A
        shopper's photograph is not themed; what sits on it must not be either.
      */}
      {hasWords && <span className="absolute inset-0 bg-image-scrim/45" aria-hidden />}

      {hasWords && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
          {heading && (
            <span className="text-2xl font-semibold text-on-image @sm:text-3xl">{heading}</span>
          )}
          {bodyText && (
            <span className="max-w-xl text-sm text-on-image/90 @sm:text-base">{bodyText}</span>
          )}
          {/* A SPAN styled as a button, never a nested <a>: the whole banner is
              already the link, and an anchor inside an anchor is invalid HTML
              that browsers recover from unpredictably. */}
          {hasLink && buttonLabel && (
            <span className="mt-1 inline-flex h-control items-center rounded-control bg-on-image px-4 text-sm font-medium text-image-scrim">
              {buttonLabel}
            </span>
          )}
        </span>
      )}
    </>
  )
}
