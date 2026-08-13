/**
 * South African mobile numbers, normalised to E.164.
 *
 * Pure and browser-safe (no DB, no server-only) — the same rule runs in the
 * setup screen's test-send box and on the server, so the two cannot disagree
 * about what a valid number is.
 *
 * Deliberately narrow: this normalises the numbers a SOUTH AFRICAN shop's
 * customer file actually holds. A shop with foreign numbers types them in
 * full international form, which passes through untouched.
 */

/** '082 123 4567' → '+27821234567', or null when it cannot be a mobile. */
export function normaliseSaPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[\s\-().]/g, '')

  // Already international: +27…, with exactly nine digits after the code.
  if (/^\+27\d{9}$/.test(digits)) return digits
  if (/^27\d{9}$/.test(digits)) return `+${digits}`
  // Local: 0 + nine digits.
  if (/^0\d{9}$/.test(digits)) return `+27${digits.slice(1)}`
  // A +27 number that got here is the wrong LENGTH — refuse it rather than
  // letting the foreign passthrough below launder a typo into a send.
  if (/^\+?27/.test(digits)) return null
  // Any other full international number passes through as typed.
  if (/^\+\d{10,15}$/.test(digits)) return digits

  return null
}
