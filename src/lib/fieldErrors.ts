/**
 * Which FIELD a validation message belongs to.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 *
 * Every validator in this app used to return a bare sentence: `string | null`.
 * A server action returned the same thing as `{ ok: false, error: string }`, and
 * the screen had nowhere to put it but a toast in the corner or a red bar at the
 * end of the form. So "Choose when this change should happen." appeared as a
 * popup with no way to know it meant the TIME box — on a form long enough that
 * the box was off-screen entirely.
 *
 * That is fine for somebody who already knows the form. It is not fine for
 * somebody meeting it for the first time, which is every shopkeeper on their
 * first week, and it is the difference between a form that corrects you and a
 * form that just refuses.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────
 *
 * A problem is now a `field` plus a `message`. The field is the NAME the screen
 * knows the control by — the key it passes to `useFieldErrors` — so the message
 * can be rendered under that control and the control scrolled to.
 *
 * ── WHY THE FIELD IS OPTIONAL EVERYWHERE IT TRAVELS ──────────────────────
 *
 * This lands in a codebase with 75 validators, 61 hand-declared result types and
 * something like 470 places that display an error. Converting all of them in one
 * commit would be one enormous untestable diff, and every screen not yet
 * converted would break the moment the error shape stopped being a string.
 *
 * So `field` is ADDITIVE. `{ ok: false, error: string }` stays exactly as valid
 * as it was; a converted validator adds `field` alongside it. An unconverted
 * screen reads `.error` and behaves as it always did, a converted screen reads
 * `.field` too and lights up the right box. The two coexist, which is what makes
 * this safe to roll out screen by screen rather than all at once.
 *
 * ── WHY ALL THE PROBLEMS, NOT THE FIRST ──────────────────────────────────
 *
 * Validators used to stop at the first failure, and the note in alerts/types.ts
 * said so plainly: "the modal shows one message at a time". Returning a list
 * instead means a form with three gaps is fixed in one pass rather than three
 * saves, each one revealing the next thing wrong. `validateAll` below is what
 * collects them.
 */

/** One problem, tied to the control that can fix it. */
export type FieldProblem = {
  /**
   * The screen's OWN name for the control — `name`, `startsAt`, `lines.3.qty`.
   *
   * Deliberately a plain string rather than a key of the input type: the control
   * a person must go and fix is not always a field of the row being saved. A
   * problem with the third line of a document belongs on that line's box, and
   * "you have not added anything" belongs on the picker, neither of which is a
   * column.
   */
  field: string
  /** What to say under the control. A sentence, already fit to read. */
  message: string
}

/**
 * The result of checking something: nothing, or everything that is wrong.
 *
 * An empty array means valid. That is the same test as `null` was (`if
 * (problems.length)`), and it means a caller never has to distinguish "no
 * problems" from "not checked".
 */
export type FieldProblems = FieldProblem[]

/** Shorthand for the common case of one problem. */
export function problem(field: string, message: string): FieldProblems {
  return [{ field, message }]
}

/**
 * The first problem's message, for a caller that still wants one sentence.
 *
 * This is the bridge that lets an unconverted screen keep working: an action
 * returns `error: firstMessage(problems)` alongside the list, so a toast still
 * says something useful while the form learns to place it properly.
 */
export function firstMessage(problems: FieldProblems): string {
  return problems[0]?.message ?? ''
}

/** The first problem's field, for scrolling to it. */
export function firstField(problems: FieldProblems): string | undefined {
  return problems[0]?.field
}

/**
 * Run a list of checks and collect every failure.
 *
 * Each check returns a message when the value is WRONG and null when it is fine
 * — written that way round because it reads as the condition being guarded
 * against, which is how the validators already read.
 *
 * Ordered: the problems come back in the order the checks are written, so the
 * field a form scrolls to is the topmost one on screen provided the checks are
 * written in the order the fields appear. That ordering is the caller's job and
 * worth keeping to; it is what makes "jump to the first problem" land somewhere
 * that looks like the top rather than somewhere arbitrary.
 */
export function validateAll(
  checks: Array<[field: string, message: string | null | false | undefined]>,
): FieldProblems {
  const out: FieldProblems = []
  for (const [field, message] of checks) {
    if (message) out.push({ field, message })
  }
  return out
}

/**
 * A failed result carrying both shapes at once.
 *
 * The single call every converted save function makes, so that adding the field
 * information can never mean forgetting the sentence an old screen still reads.
 */
export function failed(problems: FieldProblems): {
  ok: false
  error: string
  problems: FieldProblems
  field?: string
} {
  return {
    ok: false,
    error: firstMessage(problems),
    problems,
    field: firstField(problems),
  }
}

/**
 * A failure about one field, built in one call.
 *
 * For the checks that cannot live in a pure validator because they need the
 * database — "that name is already taken", which is a problem with the NAME box
 * every bit as much as "a name is required" is.
 */
export function failedField(field: string, message: string) {
  return failed(problem(field, message))
}
