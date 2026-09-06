/**
 * The names the layout-preference signal travels under.
 *
 * A separate file from `phoneLayout.ts` for the reason `mobileShellKeys.ts` is
 * separate from `mobileShell.ts`: the PROXY needs these, and that module is
 * `server-only` and reads `next/headers`. Importing it from the proxy pulls a
 * Node-only module into the edge runtime, which fails at request time rather
 * than at build time. Constants with no imports load anywhere.
 */

/**
 * An explicit choice, made by the person, that outranks every guess.
 *
 * Written by the "Desktop site" / "Phone layout" switch in the drawer and read
 * BEFORE any sniffing — see `phoneLayout.ts` for why that order is the whole
 * point of the cookie existing.
 */
export const LAYOUT_PREF_COOKIE = 'odyssey_layout'

/** Force the phone layout, whatever the device claims to be. */
export const LAYOUT_PREF_PHONE = 'phone'

/** Force the full desktop layout, whatever the device claims to be. */
export const LAYOUT_PREF_DESKTOP = 'desktop'
