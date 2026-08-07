import Link from 'next/link'
import type { ReactNode } from 'react'
import type { HomeSection, StorefrontTheme } from '@/lib/storefrontModel'
import type { StorefrontDepartment, StorefrontProduct } from '@/lib/site/storefront'
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
}

export default function HomeSections({
  token,
  content,
  theme,
  display,
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
  /**
   * Wraps each section. `node` is null when the section would render nothing,
   * which the shop skips entirely and the builder replaces with a placeholder
   * explaining why.
   */
  renderSection?: (section: HomeSection, node: ReactNode) => ReactNode
}) {
  return (
    <div className="flex flex-col gap-8">
      {content.map((entry) => {
        const node = sectionBody(entry, token, theme, display)

        if (renderSection) return renderSection(entry.section, node)
        // The shop: an empty section is simply absent.
        return node
      })}
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
  { section, products, departments }: SectionContent,
  token: string,
  theme: StorefrontTheme,
  display: ProductDisplay,
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
            <h1 className="text-2xl font-semibold text-ink sm:text-3xl">{theme.heroHeadline}</h1>
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
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
        <ProductGrid token={token} products={products} {...display} />
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
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
