/**
 * How a pack range's product codes and names are built from its base rung.
 *
 * Plain module rather than part of ReferWizard.tsx, which is `'use client'` —
 * every export of that file is a client reference, so nothing on the server
 * (or in a test script) can import one. These two functions are the RULE for
 * what a range's rungs are called, and a rule that cannot be tested where it
 * is used ends up written twice.
 */

/**
 * The name a rung gets when nobody types one — "Beer 340ml × 6".
 *
 * ONE definition, because three things have to agree about it: the pre-filled
 * description box, the chain sentence under the table, and what is actually
 * created on submit. They were three copies of the same template, and a change
 * to one was a silent disagreement with the other two.
 */
export function derivedName(baseName: string, packSize: number): string {
  return `${baseName.trim() || 'Product'} × ${packSize || '?'}`
}

/** The longest a products.code may be — validateProduct refuses more. */
const MAX_CODE = 48

/**
 * The code a rung gets when nobody types one — "AMSTEL1-6" above "AMSTEL1".
 *
 * A pack range is ONE product in the shop's head, so its rungs should read
 * that way on a stock report: the base's own code with the pack size after it,
 * sorting next to the base instead of landing wherever the site sequence
 * happened to be. The alternative — three unrelated auto-numbers — makes a
 * ladder impossible to recognise in a list, which is what prompted this.
 *
 * The pack size is the suffix rather than a letter because it is the one thing
 * that distinguishes the rungs, and a code that says what it IS beats a code
 * that only says it is different. Re-derived when the size changes, exactly as
 * the name is.
 *
 * ── WHEN IT DECLINES TO ANSWER ───────────────────────────────────────────
 *
 * Empty, meaning "no opinion", in three cases — a base with no code yet, a
 * pack size not yet typed, and a suffix that would exceed the column. The
 * caller then falls back to the site's auto-numbering rather than saving
 * something truncated, which would no longer match the base it came from and
 * could silently collide with a real code.
 *
 * A collision with an EXISTING product is deliberately not checked here: the
 * server refuses it by name (see whyCodeTaken), which tells the user which
 * product holds it. Guessing a different suffix to dodge a clash would create
 * a code nobody chose and nobody expects.
 */
export function derivedCode(baseCode: string, packSize: number): string {
  const trimmed = baseCode.trim()
  if (!trimmed || !Number.isFinite(packSize) || packSize <= 0) return ''
  const candidate = `${trimmed}-${packSize}`
  return candidate.length > MAX_CODE ? '' : candidate
}
