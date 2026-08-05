/**
 * Composing list-screen URLs.
 *
 * Every list in OdysseyAI keeps its search, filters, sort and page in the query
 * string, so a screen can be linked to, bookmarked and reloaded without a
 * client-side store. The catch is that a filter link written by hand replaces
 * the whole query string: `/products?low=1` silently drops whatever the user
 * had typed in the search box. `withParams` exists so no screen has to
 * hand-build a query string again.
 *
 * Deliberately not 'use client' — server components build most of these hrefs.
 */

/** What a list screen reads out of the URL. Values are always strings. */
export type ParamValue = string | number | null | undefined

/**
 * The current params, plus the changes, as a query string.
 *
 * `null` removes a key — that is how a "clear filter" link is written, and it
 * is distinct from `undefined`, which only means "not mentioned, leave alone".
 * Empty strings are removed too: `?q=` is noise, not a filter.
 *
 *   withParams(sp, { low: '1' })        // keeps q and department
 *   withParams(sp, { department: null })  // clears just that one
 */
export function withParams(
  current: URLSearchParams | Record<string, ParamValue> | undefined,
  changes: Record<string, ParamValue>,
): string {
  const next = new URLSearchParams()

  // Seed from whatever the caller has. Next 16 hands pages a plain object, but
  // client components read a real URLSearchParams, so accept both.
  if (current instanceof URLSearchParams) {
    for (const [key, value] of current.entries()) next.set(key, value)
  } else if (current) {
    for (const [key, value] of Object.entries(current)) {
      if (value !== null && value !== undefined && value !== '') next.set(key, String(value))
    }
  }

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue
    if (value === null || value === '') next.delete(key)
    else next.set(key, String(value))
  }

  const query = next.toString()
  return query ? `?${query}` : ''
}

/**
 * `withParams` bound to a path, for the common `hrefFor` prop.
 *
 *   const href = hrefBuilder('/products', searchParams)
 *   href({ page: 2 })   // '/products?q=milk&page=2'
 */
export function hrefBuilder(
  path: string,
  current: URLSearchParams | Record<string, ParamValue> | undefined,
) {
  return (changes: Record<string, ParamValue>) => `${path}${withParams(current, changes)}`
}

/**
 * A page number from the URL, clamped to something sane.
 *
 * Anything unparseable reads as page 1 rather than throwing: a hand-edited or
 * stale URL should show the first page, not an error screen.
 */
export function pageFrom(value: ParamValue, pageCount = Infinity): number {
  const page = Math.floor(Number(value))
  if (!Number.isFinite(page) || page < 1) return 1
  return Math.min(page, Math.max(Math.floor(pageCount), 1))
}

/** The SQL offset for a page. Pairs with `pageFrom`. */
export function offsetFor(page: number, pageSize: number): number {
  return Math.max(page - 1, 0) * pageSize
}

/** How many pages `total` rows make. Always at least 1, so "Page 1 of 1" reads right. */
export function pageCountFor(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(Math.ceil(total / pageSize), 1)
}

/**
 * True when any filter beyond the given keys is set.
 *
 * Used to decide whether to offer "Clear all" — a screen with only a sort and a
 * page applied has nothing to clear, and offering it there is noise.
 */
export function hasActiveFilters(
  current: Record<string, ParamValue> | undefined,
  ignore: readonly string[] = ['page', 'sort', 'dir'],
): boolean {
  if (!current) return false
  return Object.entries(current).some(
    ([key, value]) =>
      !ignore.includes(key) && value !== null && value !== undefined && value !== '',
  )
}
