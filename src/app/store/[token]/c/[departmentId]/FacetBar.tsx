import Link from 'next/link'
import { Icons } from '@/components/ui'

/**
 * The facet bar: brand chips and a few price bands, as LINKS.
 *
 * Server-rendered URL state, deliberately — a facet is a narrower page, and
 * a shopper sharing the URL shares the filter. An active facet renders as a
 * removable chip; the price bands are derived from the department's actual
 * span, rounded to figures a person would say out loud.
 */
export default function FacetBar({
  basePath,
  q,
  brands,
  activeBrand,
  bands,
  activeBand,
}: {
  basePath: string
  q: string
  brands: { name: string; count: number }[]
  activeBrand: string
  bands: { label: string; min: number | null; max: number | null }[]
  activeBand: number
  /** Index into bands, or -1. */
}) {
  const href = (over: { brand?: string | null; band?: number | null }) => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    const brand = over.brand === undefined ? activeBrand : (over.brand ?? '')
    if (brand) params.set('brand', brand)
    const band = over.band === undefined ? activeBand : (over.band ?? -1)
    if (band >= 0 && bands[band]) {
      if (bands[band].min !== null) params.set('min', String(bands[band].min))
      if (bands[band].max !== null) params.set('max', String(bands[band].max))
      params.set('band', String(band))
    }
    const text = params.toString()
    return text ? `${basePath}?${text}` : basePath
  }

  if (brands.length === 0 && bands.length === 0) return null

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {brands.slice(0, 8).map((brand) =>
        activeBrand === brand.name ? (
          <Link
            key={brand.name}
            href={href({ brand: null })}
            className="inline-flex items-center gap-1 rounded-pill bg-brand-soft px-3 py-1 text-xs font-medium text-brand ring-1 ring-brand/40"
          >
            {brand.name}
            <Icons.Close size={12} aria-label={`Remove the ${brand.name} filter`} />
          </Link>
        ) : (
          <Link
            key={brand.name}
            href={href({ brand: brand.name })}
            className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-3 py-1 text-xs text-ink-2 hover:border-border-strong"
          >
            {brand.name}
            <span className="text-faint">{brand.count}</span>
          </Link>
        ),
      )}

      {brands.length > 0 && bands.length > 0 && (
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      )}

      {bands.map((band, index) =>
        activeBand === index ? (
          <Link
            key={band.label}
            href={href({ band: null })}
            className="inline-flex items-center gap-1 rounded-pill bg-brand-soft px-3 py-1 text-xs font-medium text-brand ring-1 ring-brand/40"
          >
            {band.label}
            <Icons.Close size={12} aria-label={`Remove the ${band.label} filter`} />
          </Link>
        ) : (
          <Link
            key={band.label}
            href={href({ band: index })}
            className="rounded-pill border border-border bg-surface px-3 py-1 text-xs text-ink-2 hover:border-border-strong"
          >
            {band.label}
          </Link>
        ),
      )}
    </div>
  )
}

/** Four sayable bands over the department's actual span. */
export function priceBands(
  minPrice: number,
  maxPrice: number,
): { label: string; min: number | null; max: number | null }[] {
  if (maxPrice <= 0 || maxPrice - minPrice < 20) return []
  const steps = [50, 100, 200, 500, 1000, 2000, 5000]
  const edge1 = steps.find((s) => s > maxPrice / 4) ?? 5000
  const edge2 = steps.find((s) => s > maxPrice / 2) ?? edge1 * 2
  if (edge2 <= edge1) return []
  return [
    { label: `Under R${edge1}`, min: null, max: edge1 },
    { label: `R${edge1} – R${edge2}`, min: edge1, max: edge2 },
    { label: `Over R${edge2}`, min: edge2, max: null },
  ]
}
