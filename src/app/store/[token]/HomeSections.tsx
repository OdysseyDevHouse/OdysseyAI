import Link from 'next/link'
import type { ReactNode } from 'react'
import type { HomeSection, StorefrontTheme } from '@/lib/storefrontModel'
import type {
  StorefrontDepartment,
  StorefrontImage,
  StorefrontProduct,
} from '@/lib/site/storefront'
import ProductGrid from './ProductGrid'

export type ProductDisplay = {
  layout: 'grid' | 'list'
  showStock: boolean
  showPhotos: boolean
  showBrands: boolean
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
  { section, products, departments, image }: SectionContent,
  token: string,
  theme: StorefrontTheme,
  display: ProductDisplay,
  imageSrc: ImageSrc,
): ReactNode {
  if (section.kind === 'hero') {
    if (!theme.heroHeadline && !theme.heroSubtext) return null
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
    if (!departments || departments.length === 0) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="grid grid-cols-2 gap-3 @sm:grid-cols-3 @lg:grid-cols-4">
          {departments.map((department) => (
            <li key={department.id}>
              <Link
                href={`/store/${token}?department=${department.id}`}
                className="flex h-full flex-col justify-between rounded-card border border-border bg-surface p-4 shadow-card transition hover:bg-surface-2"
              >
                <span className="text-sm font-medium text-ink">{department.name}</span>
                <span className="mt-2 text-xs text-muted">
                  {department.productCount.toLocaleString('en-ZA')} item
                  {department.productCount === 1 ? '' : 's'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (section.kind === 'products') {
    if (!products || products.length === 0) return null
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
    if (!image) return null
    const href = section.linkUrl?.trim() ?? ''
    const hasWords = Boolean(section.title || section.bodyText)

    const picture = (
      <>
        {/*
          A plain <img>, not next/image. The bytes come from a route that
          re-sniffs them on the way out and serves them with a sandbox CSP;
          putting the optimiser in front would fetch and re-encode them
          through a second path that does none of that.

          16:9 and object-cover: a banner is a crop, and letting the natural
          height through means the page jumps as it loads.
        */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageSrc(image.id)}
          alt={section.imageAlt || image.altText || ''}
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/*
          The scrim. Only when there are words: darkening a picture nobody is
          reading over is just a worse picture. Without it, white text on a
          pale photograph is invisible — and the owner cannot fix it, because
          they do not choose the text colour.
        */}
        {hasWords && <span className="absolute inset-0 bg-ink/45" aria-hidden />}

        {hasWords && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
            {section.title && (
              <span className="text-2xl font-semibold text-surface @sm:text-3xl">
                {section.title}
              </span>
            )}
            {section.bodyText && (
              <span className="max-w-xl text-sm text-surface/90 @sm:text-base">
                {section.bodyText}
              </span>
            )}
            {/* A SPAN styled as a button, never a nested <a>: the whole banner
                is already the link, and an anchor inside an anchor is invalid
                HTML that browsers recover from unpredictably. */}
            {href && section.buttonLabel && (
              <span className="mt-1 inline-flex h-control items-center rounded-control bg-surface px-4 text-sm font-medium text-ink">
                {section.buttonLabel}
              </span>
            )}
          </span>
        )}
      </>
    )

    return (
      <section key={section.id}>
        <BannerFrame href={href}>{picture}</BannerFrame>
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

/**
 * The box a banner picture sits in — a link when it has somewhere to go, a plain div
 * when it does not.
 *
 * Exported because the carousel draws a single slide as a plain banner, and it has to be
 * the SAME box: two copies of "a banner is 16:6, clipped and rounded" would drift, and a
 * shop whose one-slide carousel is a slightly different shape from its banner section
 * looks like a rendering fault rather than a design.
 *
 * ── WHY THE ASPECT RATIO IS AN INLINE STYLE ───────────────────────────────
 *
 * 16:6 is not one of Tailwind's ratios and this is a storefront, not the back office —
 * it is the one place in the app that renders on a shopper's phone, so the crop is a
 * design decision rather than a token. `aspect-[16/6]` would work too; the style keeps
 * the number readable next to the reason for it.
 *
 * The ratio is what stops the page jumping as the picture loads: the box has its final
 * height before any bytes arrive.
 */
export function BannerFrame({ href, children }: { href: string; children: ReactNode }) {
  const className = 'relative block overflow-hidden rounded-card'
  const style = { aspectRatio: '16 / 6' }

  return href ? (
    <Link href={href} className={className} style={style}>
      {children}
    </Link>
  ) : (
    <div className={className} style={style}>
      {children}
    </div>
  )
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-base font-semibold text-ink">{children}</h2>
}
