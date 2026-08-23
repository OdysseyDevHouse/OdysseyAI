/**
 * The names the mobile shell signal travels under.
 *
 * A separate file from `mobileShell.ts` because the PROXY needs them and that
 * module is `server-only` and reads `next/headers` — importing it from the
 * proxy pulls a Node-only module into the edge runtime, which fails at request
 * time rather than at build time. Constants with no imports load anywhere.
 */

/** What the native shell sets on the requests it makes itself. */
export const MOBILE_SHELL_HEADER = 'x-odyssey-shell'

/** What the proxy writes so in-page navigations keep the mobile chrome. */
export const MOBILE_SHELL_COOKIE = 'odyssey_shell'

export const MOBILE_SHELL_VALUE = 'mobile'
