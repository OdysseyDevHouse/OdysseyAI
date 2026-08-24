import type { DeviceOffer, LicenceRefusal } from './devices'

/**
 * What to tell somebody standing at a till that will not open.
 *
 * Kept out of `devices.ts` so it can be imported by a client component without
 * dragging `server-only` and the database pool with it.
 *
 * ── WRITTEN FOR THE PERSON WHO IS STUCK ────────────────────────────────────
 *
 * Whoever reads these is usually mid-service with a queue forming. So each one
 * says what is wrong in a sentence and then names what happens next — never a
 * code, never "contact your administrator" without saying what they will need
 * to do.
 *
 * ── THE SENTENCE DEPENDS ON WHAT THE DOOR CAN OFFER ────────────────────────
 *
 * It used to depend only on the refusal, and every refusal ended by sending the
 * reader to fetch a supervisor. That is the right advice for a shop whose
 * licences are all in use and the wrong advice for one that has a spare, or has
 * never had a till at all — in the second case the supervisor arrives, opens
 * Setup → Tills, and finds an empty panel with nothing to link.
 *
 * So the offer is part of the message. Where this machine may put itself into
 * service, the words say so and the screen shows the button. Where it may not,
 * they say WHY not, and that is when they name the supervisor.
 *
 * ── ONE SET OF WORDS, NOT ONE PER PLATFORM ─────────────────────────────────
 *
 * The till and the invoicing counter spend the same licence and refuse for the
 * same reasons, so the person at the counter reads the same sentence whichever
 * they are standing at, and whoever they call hears the same story.
 */
export function deviceLabelFor(reason: LicenceRefusal, offer?: DeviceOffer): string {
  /* An offer outranks the refusal, because it changes what the reader should DO.
     "Not set up yet" and "trial ended" are the same instruction — press the
     button — once there is a licence free to press it for. */
  if (offer && offer.kind !== 'none') {
    const lead = reason === 'expired' ? 'The trial for this till has ended.' : 'This device is not set up as a till yet.'
    return offer.kind === 'paid'
      ? `${lead} This shop has ${offer.free === 1 ? 'a till licence' : `${offer.free} till licences`} free, so you can put this machine into service now.`
      : `${lead} You can try it free for ${offer.days} days, starting now.`
  }

  switch (reason) {
    case 'unregistered':
      return offerRefusal(offer) ?? 'This device is not set up as a till yet. A supervisor can link it under Setup → Tills.'
    case 'inactive':
      return 'This till has been retired. A supervisor can link this device to another licence under Setup → Tills, or contact Odyssey.'
    case 'unpaid':
      return 'There is no active licence for this till. Contact Odyssey to activate it.'
    case 'expired':
      return offerRefusal(offer, 'The trial for this till has ended.') ?? 'The trial for this till has ended. Contact Odyssey to keep using it.'
  }
}

/**
 * Why there is no button, said in a way the reader can act on.
 *
 * Returns null when there is nothing offer-specific to add, so the caller falls
 * back to the sentence it has always used.
 */
function offerRefusal(offer: DeviceOffer | undefined, lead = 'This device is not set up as a till.'): string | null {
  if (!offer || offer.kind !== 'none') return null
  switch (offer.reason) {
    case 'no-serial':
      return `${lead} This browser is not allowed to store a device number, so it cannot hold a licence. Use the desktop till, or allow site data for this address.`
    case 'trial-used':
      return offer.paidFor === 0
        ? `${lead} This machine has already had its free trial. Contact Odyssey to buy a till licence.`
        : `${lead} All ${offer.paidFor} of this shop's till licences are in use. A supervisor can free one under Setup → Tills.`
  }
}

/**
 * The heading above it.
 *
 * A trial that has run out is not the same event as a machine that was never set
 * up, and reading "This device is not set up as a till" on a till that traded
 * yesterday is what makes somebody think the machine has been wiped.
 */
export function deviceTitleFor(reason: LicenceRefusal): string {
  switch (reason) {
    case 'expired':
      return 'This till’s trial has ended'
    case 'inactive':
      return 'This till has been retired'
    case 'unpaid':
      return 'This till has no licence'
    case 'unregistered':
      return 'This device is not set up as a till'
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

/**
 * What a licence check came back with, in the shape a screen can act on.
 *
 * ── WHY THE TYPE LIVES BESIDE THE WORDS AND NOT BESIDE AN ACTION ───────────
 *
 * Two windows now ask this question — the touch till and the invoicing counter
 * — and each has to guard it against its OWN front door, so there are two
 * server actions rather than one. One shared TYPE is what keeps them answering
 * in the same shape, so the screen that reads the answer can be shared too.
 *
 * This file is where it can be: it carries no `server-only` and no database
 * pool, which is the same reason the sentences above live here rather than in
 * `devices.ts`.
 */
export type DeviceState =
  | {
      /** Registered and entitled — the window may open. */
      status: 'licensed'
      terminalId: number | null
      name: string
      /** Set while an unpaid device is inside its evaluation period. */
      trialEndsOn: string | null
    }
  | {
      /** Anything else. The window does not open, and says why. */
      status: 'blocked'
      reason: LicenceRefusal
      message: string
      /**
       * What this machine may do about it without leaving the screen.
       *
       * Absent rather than `none` when the check could not work it out — an
       * offline till answering from its own cache, say. The screen shows no
       * button in that case, which is right: it cannot know the shop still has a
       * licence free, and a button that fails when pressed is worse than none.
       */
      offer?: DeviceOffer
    }

/**
 * What came back from pressing the button at the door.
 *
 * Here rather than beside either action for the same reason `DeviceState` is:
 * the till and the counter each need their OWN action, guarded on their own
 * permission, and a shared answer shape is what lets one screen read both.
 */
export type SelfRegisterActionResult =
  | { ok: true; trialEndsOn: string | null }
  | { ok: false; error: string }
