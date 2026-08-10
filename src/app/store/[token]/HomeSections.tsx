import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  DEFAULT_CONSENT_TEXT,
  groupRichBlocks,
  liveSlides,
  richBlockHasText,
  sectionIsEmpty,
  type HomeSection,
  type RichBlock,
  type RichSpan,
  type StorefrontTheme,
} from '@/lib/storefrontModel'
import type {
  StorefrontDepartment,
  StorefrontImage,
  StorefrontProduct,
} from '@/lib/site/storefront'
import type { ProductReview } from '@/lib/site/productReviews'
import ProductGrid from './ProductGrid'
import Carousel from './Carousel'
import Countdown from './Countdown'
import SignupForm from './SignupForm'
import RecentlyViewed from './RecentlyViewed'
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
  /** banner and split: the resolved picture, or null when missing or unset. */
  image?: StorefrontImage | null
  /** carousel: each slide's picture, keyed by image id. See SectionFill. */
  slideImages?: Map<number, StorefrontImage>
  /** reviews: the approved reviews the server resolved. */
  reviews?: ProductReview[]
  /** logos: the pictures that still resolve, keyed by id. */
  logoImages?: Map<number, StorefrontImage>
  /** countdown: the bound special's real end, when there is one. */
  specialEndsAt?: string
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
  anchorProductId,
}: {
  token: string
  content: SectionContent[]
  theme: StorefrontTheme
  /**
   * On a product page, the product the page is about.
   *
   * Only the 'recent' section uses it, to leave the product being looked at
   * out of its own "recently viewed" row. Absent on every other page.
   */
  anchorProductId?: number
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
        const node = toned(entry.section, sectionBody(entry, token, theme, display, imageSrc, anchorProductId))

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
  /** On a product page, the product being looked at — see the 'recent' branch. */
  anchorProductId?: number,
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
                // The dedicated department route, NOT `?department=`. See the
                // note in page.tsx: the query form redirects here, and a tile
                // that goes through a redirect costs every shopper a round
                // trip to reach the page it already knows the address of.
                href={`/store/${token}/c/${department.id}`}
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

  if (section.kind === 'split') {
    // Unreachable after the gate; narrows `image` for the src below.
    if (!image) return null
    const href = section.linkUrl?.trim() ?? ''
    const label = section.buttonLabel?.trim() ?? ''

    return (
      <section key={section.id}>
        {/*
          ── ORDER IS SET BY THE MARKUP, NOT BY `flex-row-reverse` ──────────
          The picture comes first in the DOM when it is on the left and second
          when it is on the right, so a screen reader and a narrow phone both
          get the same order the eye does. Reversing visually would leave the
          picture read first whichever side it appears on, and on a phone —
          where the columns stack — it would silently flip.
        */}
        <div className="grid items-center gap-5 @lg:grid-cols-2">
          {section.side === 'right' && <SplitWords section={section} href={href} label={label} />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc(image.id)}
            alt={section.imageAlt || image.altText || ''}
            className="w-full rounded-card object-cover"
          />
          {section.side !== 'right' && <SplitWords section={section} href={href} label={label} />}
        </div>
      </section>
    )
  }

  if (section.kind === 'reviews') {
    // Unreachable after the gate; narrows for the map below.
    if (!entry.reviews?.length) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
          {entry.reviews.map((review) => (
            <li
              key={review.id}
              className="flex flex-col rounded-card border border-border bg-surface p-4 shadow-card"
            >
              <Stars rating={review.rating} />
              {review.title && (
                <p className="mt-2 text-sm font-medium text-ink">{review.title}</p>
              )}
              {review.body && (
                // line-clamp, because a review is as long as the customer felt
                // like being and a grid of tiles cannot absorb one of them
                // writing an essay.
                <p className="mt-1 line-clamp-4 text-sm text-ink-2">{review.body}</p>
              )}
              <p className="mt-3 text-xs text-muted">
                {review.authorName || 'A customer'}
                {/* What it is ABOUT. A quote with no product attached is not
                    social proof — it could be about anything in the shop. */}
                {review.productDescription && ` · ${review.productDescription}`}
              </p>
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (section.kind === 'countdown') {
    /*
     * The special's own end wins over the typed one.
     *
     * Resolved fresh on every request — see the resolver. An owner who extends
     * a sale must not have to remember a clock on the front page.
     */
    const ends = entry.specialEndsAt?.trim() || section.endsAt?.trim() || ''
    if (!ends) return null
    return (
      <section key={section.id}>
        <Countdown
          endsAt={ends}
          heading={section.title}
          bodyText={section.bodyText ?? ''}
          finishedText={section.finishedText ?? ''}
        />
      </section>
    )
  }

  if (section.kind === 'richtext') {
    const blocks = (section.blocks ?? []).filter(richBlockHasText)
    if (blocks.length === 0) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        {/*
          max-w-prose for the same reason the plain paragraph has it: a line of
          text spanning a wide screen is genuinely hard to read.
        */}
        <div className="flex max-w-prose flex-col gap-3">
          {groupRichBlocks(blocks).map((group, index) => (
            <RichGroup key={index} group={group} />
          ))}
        </div>
      </section>
    )
  }

  if (section.kind === 'testimonial') {
    const quotes = (section.quotes ?? []).filter((q) => q.quote.trim())
    if (quotes.length === 0) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="grid gap-3 @sm:grid-cols-2 @lg:grid-cols-3">
          {quotes.map((quote) => (
            <li
              key={quote.id}
              className="flex flex-col rounded-card border border-border bg-surface p-5 shadow-card"
            >
              {/* A real <blockquote>, because that is what this is. */}
              <blockquote className="flex-1 text-sm text-ink-2">“{quote.quote}”</blockquote>
              {quote.author && (
                <p className="mt-3 text-sm font-medium text-ink">{quote.author}</p>
              )}
              {quote.detail && <p className="text-xs text-muted">{quote.detail}</p>}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (section.kind === 'logos') {
    const logos = (section.logoImageIds ?? [])
      .map((id) => entry.logoImages?.get(id))
      .filter((img): img is StorefrontImage => Boolean(img))
    if (logos.length === 0) return null
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-5">
          {logos.map((logo) => (
            <li key={logo.id}>
              {/*
                Bounded by HEIGHT and left to find its own width, so logos of
                wildly different proportions sit on one optical line — a wide
                wordmark and a square badge constrained to the same width would
                make the wordmark tiny.
              */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageSrc(logo.id)}
                alt={logo.altText || ''}
                className="h-10 w-auto max-w-36 object-contain @sm:h-12"
              />
            </li>
          ))}
        </ul>
      </section>
    )
  }

  if (section.kind === 'video') {
    const id = (section.videoId ?? '').trim()
    if (!id) return null
    /*
     * The URL is BUILT here from a validated id, never stored.
     *
     * `videoId` is normalised down to [A-Za-z0-9_-], so it cannot carry a
     * second host, a path traversal or a query string — which is what makes
     * this template safe without parsing anything. See the video branch of
     * normaliseSections.
     */
    const src =
      section.videoProvider === 'vimeo'
        ? `https://player.vimeo.com/video/${id}`
        : `https://www.youtube-nocookie.com/embed/${id}`

    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <div className="aspect-video overflow-hidden rounded-card border border-border bg-surface-2">
          <iframe
            src={src}
            title={section.title || 'Video'}
            className="size-full"
            // No allow="autoplay": a video that starts by itself on a shop's
            // front page is the thing people leave over.
            allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        </div>
      </section>
    )
  }

  if (section.kind === 'map') {
    const address = section.addressText?.trim() ?? ''
    if (!address) return null
    const directions = section.mapUrl?.trim() ?? ''
    return (
      <section key={section.id}>
        {section.title && <SectionHeading>{section.title}</SectionHeading>}
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <address className="whitespace-pre-line text-sm not-italic text-ink-2">
            {address}
          </address>
          {directions && (
            /*
              rel="noreferrer" like every outbound link in the footer: the
              shop's own URL carries its store token, and leaking it in a
              Referer header hands anyone the shop's private link.
            */
            <a
              href={directions}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-block text-sm font-medium text-brand hover:underline"
            >
              Get directions
            </a>
          )}
        </div>
      </section>
    )
  }

  if (section.kind === 'recent') {
    /*
     * The only section whose contents the server cannot know — the list lives
     * in the shopper's own browser. So this renders a client component that
     * fills itself, and decides for itself whether there is enough to show.
     * See RecentlyViewed, and the 'recent' case in sectionIsEmpty.
     */
    return (
      <RecentlyViewed
        key={section.id}
        token={token}
        title={section.title}
        exclude={anchorProductId}
        display={{
          layout: section.layout ?? display.layout,
          showStock: display.showStock,
          showPhotos: display.showPhotos,
          showBrands: display.showBrands,
        }}
      />
    )
  }

  if (section.kind === 'signup') {
    return (
      <section key={section.id}>
        <div
          className="flex flex-col items-center gap-3 rounded-card px-6 py-8 text-center"
          /* The same brand tint the hero and the countdown use, so the three
             "stop and read this" moments on a page look like one decision. */
          style={{ background: 'color-mix(in srgb, var(--color-brand) 10%, transparent)' }}
        >
          {section.title && (
            <h2 className="text-lg font-semibold text-ink @sm:text-xl">{section.title}</h2>
          )}
          {section.bodyText && <p className="text-sm text-ink-2">{section.bodyText}</p>}
          <SignupForm
            token={token}
            buttonLabel={section.buttonLabel ?? ''}
            consentText={section.consentText ?? DEFAULT_CONSENT_TEXT}
            thanksText={section.thanksText ?? ''}
            sourcePage={section.id}
          />
        </div>
      </section>
    )
  }

  if (section.kind === 'divider') {
    // aria-hidden and role="presentation": this is a visual pause, and a
    // screen reader announcing "separator" between every part of a page adds
    // nothing a heading has not already said.
    return (
      <section key={section.id}>
        <hr aria-hidden role="presentation" className="border-0 border-t border-border" />
      </section>
    )
  }

  if (section.kind === 'spacer') {
    const height =
      section.size === 'small' ? 'h-4' : section.size === 'large' ? 'h-16' : 'h-9'
    return <div key={section.id} aria-hidden className={height} />
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

/* ── The new sections' parts ──────────────────────────────────────────────── */

/**
 * The words half of a split section.
 *
 * Its own component because the markup appears TWICE — once before the picture
 * and once after it — so the section can put the picture on either side
 * without `flex-row-reverse`. See the split branch on why the DOM order is
 * what carries the arrangement.
 */
function SplitWords({
  section,
  href,
  label,
}: {
  section: HomeSection
  href: string
  label: string
}) {
  return (
    <div className="flex flex-col items-start gap-2">
      {section.title && <h2 className="text-lg font-semibold text-ink">{section.title}</h2>}
      {section.bodyText && (
        <p className="whitespace-pre-line text-sm text-ink-2 @sm:text-base">{section.bodyText}</p>
      )}
      {href && label && (
        <Link
          href={href}
          className="mt-1 inline-flex h-control items-center rounded-control bg-brand px-4 text-sm font-medium text-white"
        >
          {label}
        </Link>
      )}
    </div>
  )
}

/**
 * A star rating, drawn as text.
 *
 * ★ and ☆ rather than an icon component: this renders inside a server
 * component on the public shop, the characters are in every font a phone has,
 * and five inline SVGs per review across a grid of six is markup nobody needs.
 *
 * The visible stars are `aria-hidden` and the real value is a sentence, so a
 * screen reader hears "4 out of 5" rather than ten separate star characters.
 */
function Stars({ rating }: { rating: number }) {
  const filled = Math.max(0, Math.min(5, Math.round(rating)))
  return (
    <p className="text-sm leading-none text-warning">
      <span aria-hidden>{'★'.repeat(filled)}{'☆'.repeat(5 - filled)}</span>
      <span className="sr-only">{filled} out of 5</span>
    </p>
  )
}

/**
 * One run of rich-text blocks.
 *
 * The switch is exhaustive over RICH_BLOCK_TYPES and every arm names its tag
 * literally. There is no path from data to a tag name, which is the property
 * that makes storing a tree rather than HTML worth the extra code — see
 * RichBlock.
 */
function RichGroup({
  group,
}: {
  group: { type: 'p' | 'h3' | 'ul' | 'ol'; items: RichBlock[] }
}) {
  if (group.type === 'h3') {
    return (
      <h3 className="text-base font-semibold text-ink">
        <RichSpans spans={group.items[0].spans} />
      </h3>
    )
  }

  if (group.type === 'ul' || group.type === 'ol') {
    const List = group.type === 'ol' ? 'ol' : 'ul'
    return (
      <List
        className={`flex flex-col gap-1 pl-5 text-sm text-ink-2 @sm:text-base ${
          group.type === 'ol' ? 'list-decimal' : 'list-disc'
        }`}
      >
        {group.items.map((item, index) => (
          <li key={index}>
            <RichSpans spans={item.spans} />
          </li>
        ))}
      </List>
    )
  }

  return (
    <p className="text-sm text-ink-2 @sm:text-base">
      <RichSpans spans={group.items[0].spans} />
    </p>
  )
}

/** The spans of one block. Three booleans and a validated href — no markup. */
function RichSpans({ spans }: { spans: RichSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        let node: ReactNode = span.text
        /*
         * Bold does NOT set a colour when the span is also a link.
         *
         * `text-ink` on the inner <strong> wins over `text-brand` on the <a>
         * around it — so a bold link rendered as ordinary bold text, correct
         * in the markup and invisible as a link to anyone reading the page.
         * Weight is the thing bold is for; the colour belongs to whichever of
         * the two is outermost.
         */
        if (span.bold) {
          node = <strong className={span.href ? 'font-semibold' : 'font-semibold text-ink'}>{node}</strong>
        }
        if (span.italic) node = <em>{node}</em>
        // safeLinkTarget has already run on the way in — see normaliseSections.
        if (span.href) {
          node = (
            <Link href={span.href} className="text-brand underline">
              {node}
            </Link>
          )
        }
        return <span key={index}>{node}</span>
      })}
    </>
  )
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
