/**
 * How many things a shopper may save.
 *
 * Its own module, belonging to NEITHER the client context nor the server
 * action. Exporting it from the `use client` context and importing it into a
 * server action does not give the server the number — it gives it a client
 * reference function, so `slice(0, MAX_WISHLIST)` silently returned nothing
 * and every saved item was reported as no longer available.
 *
 * Matched to publishedProducts`s own ceiling on `limit`, so a saved item is
 * never dropped by the query and then blamed on the shop.
 */
export const MAX_WISHLIST = 120
