import type { LicenceRefusal } from './devices'

/**
 * What to tell somebody standing at a till that will not open.
 *
 * Kept out of `devices.ts` so it can be imported by a client component without
 * dragging `server-only` and the database pool with it.
 *
 * ── WRITTEN FOR THE PERSON WHO IS STUCK ────────────────────────────────────
 *
 * Whoever reads these is usually mid-service with a queue forming, and cannot
 * fix any of it themselves. So each one says what is wrong in a sentence and
 * then names WHO can fix it and WHERE — never a code, never "contact your
 * administrator" without saying what they will need to do.
 *
 * ── ONE SET OF WORDS, NOT ONE PER PLATFORM ─────────────────────────────────
 *
 * These used to differ between a desktop till and a browser, because a browser
 * could register itself and a desktop could not. It cannot any more — linking a
 * machine is a supervisor's job in Setup → Tills either way — so the person at
 * the counter reads the same sentence whichever they are standing at, and
 * whoever they call hears the same story.
 */
export function deviceLabelFor(reason: LicenceRefusal): string {
  switch (reason) {
    case 'unregistered':
      return 'This device is not set up as a till yet. A supervisor can link it under Setup → Tills.'
    case 'inactive':
      return 'This till has been retired. A supervisor can link this device to another licence under Setup → Tills, or contact Odyssey.'
    case 'unpaid':
      return 'There is no active licence for this till. Contact Odyssey to activate it.'
    case 'expired':
      return 'The trial for this till has ended. Contact Odyssey to keep using it.'
  }
}

/** The short version, for a chip or a table cell. */
export function deviceStateLabel(reason: LicenceRefusal): string {
  switch (reason) {
    case 'unregistered':
      return 'Not registered'
    case 'inactive':
      return 'Retired'
    case 'unpaid':
      return 'No licence'
    case 'expired':
      return 'Trial ended'
  }
}
