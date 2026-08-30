import 'server-only'
import { getSettings, setSetting } from './settings'
import { STEPS, STEP_KEYS, type StepKey } from './onboardingSteps'

/**
 * The first-run wizard: how far a shop has got.
 *
 * The step LIST lives in `onboardingSteps.ts` beside this, because the wizard
 * renders it in the browser and this module is `server-only` — see the header
 * there. This half is the part that touches the database.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM THE SCREEN ─────────────────────────
 *
 * Two different places need to agree on "has this shop been set up": the setup
 * hub, which offers to resume the wizard, and the wizard itself. Deriving that
 * answer twice is how they end up disagreeing — a shop that finished the wizard
 * still being nagged by a banner is the obvious failure.
 *
 * ── WHAT THE WIZARD IS AND IS NOT ───────────────────────────────────────────
 *
 * It is a guided pass over settings that ALREADY have a home under Setup. It is
 * NOT a second way to configure a shop: every step writes through the same
 * function the setup screen behind it calls — `setSetting`, `createVatRate`,
 * `setLogo` — so the validation lives in one place and the two can never
 * disagree about what a legal value is.
 *
 * That is also why no step is required. Every one of these has a working
 * default, and a store that skips the lot can still trade; the wizard exists to
 * put the expensive-to-change decisions in front of somebody BEFORE they have
 * six months of documents priced against the wrong answer.
 *
 * ── WHY SOME STEPS ARE COUNTED AND SOME ARE REMEMBERED ──────────────────────
 *
 * `gettingStarted.ts` beside this file makes the case against a stored tick,
 * and it is correct: a tick and the shop can disagree, because a step done by
 * an import, the API or another user never writes it. Everything it can count
 * — products, users, locations, tenders — should be counted, and this module
 * does not duplicate that.
 *
 * What a count cannot express is a CONFIRMATION. A fresh site is seeded with a
 * 15% standard rate, one Retail price type and the average cost basis, so
 * `COUNT(*)` on any of them is already non-zero before the owner has seen a
 * screen. "Has a VAT rate" is not the question this wizard asks — it asks "is
 * 15% right for you", and no query can tell an untouched default from a
 * deliberate answer. That is a fact about a PERSON, not about the data, and it
 * is the only thing recorded here.
 */

export type { StepKey, OnboardingStep } from './onboardingSteps'
export { STEPS } from './onboardingSteps'


export type OnboardingProgress = {
  /** False once somebody has reached the end. Nothing redirects on it today — see the page header. */
  pending: boolean
  /** Steps finished, in STEPS order, unknown keys dropped. */
  done: StepKey[]
  /** The first unfinished step, or null when every one is done. */
  next: StepKey | null
  doneCount: number
  totalCount: number
}

/**
 * Parse the stored list into steps this version actually has.
 *
 * Unknown keys are DROPPED rather than kept: a step removed in a later version
 * would otherwise keep counting towards "3 of 7 done" forever, and the count is
 * the thing the resume banner shows.
 */
function parseDone(raw: string): StepKey[] {
  const stored = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => STEP_KEYS.has(s)),
  )
  // Rebuilt in STEPS order rather than stored order, so `next` below is a
  // simple find rather than depending on how the strings happened to be saved.
  return STEPS.filter((s) => stored.has(s.key)).map((s) => s.key)
}

/**
 * How far this shop has got.
 *
 * Reads BOTH keys in one query rather than two, because the setup hub calls
 * this to decide whether to offer the wizard — a screen somebody opened to do
 * something else, which should not pay two round trips for a banner.
 *
 * ── A FAILED READ MEANS "DONE", NOT "PENDING" ───────────────────────────────
 *
 * Deliberately the opposite of the defensive default everywhere else in
 * settings.ts. Everything keyed off `pending` is an OFFER — a banner, a tile,
 * and a redirect if one is ever added. Guessing "pending" on a database hiccup
 * would nag an established shop that finished this a year ago; guessing "done"
 * means a genuinely new store is not offered the wizard until its next page
 * load, which is a nuisance rather than a fault.
 */
export async function onboardingProgress(siteId: number): Promise<OnboardingProgress> {
  const values = await getSettings(siteId, ['onboarding_state', 'onboarding_done_steps']).catch(
    () => null,
  )

  if (values === null) {
    return { pending: false, done: [], next: null, doneCount: 0, totalCount: STEPS.length }
  }

  const done = parseDone(values.onboarding_done_steps ?? '')
  const doneSet = new Set<StepKey>(done)

  return {
    pending: values.onboarding_state !== 'done',
    done,
    next: STEPS.find((s) => !doneSet.has(s.key))?.key ?? null,
    doneCount: done.length,
    totalCount: STEPS.length,
  }
}

/**
 * Mark one step finished. Idempotent — a person who goes back and re-saves a
 * step they had already done should not see the count change.
 *
 * Read-modify-write on a comma list, which is safe here for the reason the rest
 * of this KV is: one person is in the setup wizard at a time, and the worst a
 * genuine race could do is drop a step from the progress count, which the
 * person then re-completes. Nothing about the shop's actual configuration
 * depends on this value — the settings the step wrote are already saved.
 */
export async function markStepDone(siteId: number, key: StepKey): Promise<void> {
  const raw = await getSettings(siteId, ['onboarding_done_steps'])
  const done = new Set(parseDone(raw.onboarding_done_steps ?? ''))
  if (done.has(key)) return

  done.add(key)
  const ordered = STEPS.filter((s) => done.has(s.key)).map((s) => s.key)
  await setSetting(siteId, 'onboarding_done_steps', ordered.join(','))
}

/**
 * Stop redirecting into the wizard.
 *
 * Called both when somebody finishes it and when they skip it, and that is
 * intentional: the redirect is the intrusive part, and a person who has said
 * "not now" has answered it. The Setup hub keeps offering the wizard, because
 * `onboarding_done_steps` still shows unfinished steps — which is exactly the
 * distinction the two keys exist to hold.
 */
export async function finishOnboarding(siteId: number): Promise<void> {
  await setSetting(siteId, 'onboarding_state', 'done')
}
