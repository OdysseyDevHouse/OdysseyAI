/**
 * The column picker's two rules, as behaviour rather than as reading.
 *
 * ── WHAT BROKE ────────────────────────────────────────────────────────────
 *
 * Both faults were reported as one complaint about the products grid, and
 * neither is visible to tsc — the types were right throughout:
 *
 *   1. The toolbar button and the table each called `useProductColumns`
 *      independently, under a comment claiming that made them agree. It does
 *      the opposite: the same hook called twice is two `useState`s. Ticking a
 *      column updated the button's copy while the table went on rendering its
 *      own, so a new column showed up only after a reload rebuilt both from
 *      the same props — "you must refresh the page before it shows".
 *
 *   2. On the store path the save did the server round trip and then
 *      `prefs.reset()`, which lands on the `storeColumns` PROP — still the
 *      pre-save value until `router.refresh()` repaints. The box went back to
 *      unticked and only came right on the refresh, which reads as a checkbox
 *      needing two clicks.
 *
 * Fixing 2 naively then produced an on-off-on flicker, because reset() after a
 * SUCCESSFUL save still snaps to the stale prop. That is why `forget()` exists,
 * and it is the case this file exercises hardest — it is the one a reader is
 * most likely to "simplify" back into reset().
 *
 *   npm run test:column-prefs
 */

export {} // module scope: these top-level names would otherwise collide with sibling scripts

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * The store-path save, as ProductColumnsButton performs it.
 *
 * Modelled rather than rendered: the bug is a SEQUENCE — set, await, clear —
 * against a prop that changes only at the end, and the order is the whole
 * defect. A model that replays the order catches a reordering; a render test
 * of the final state would pass on every version including the broken ones.
 */
function storeSave({
  storeColumns,
  tick,
  clearWith,
}: {
  storeColumns: string[]
  tick: string
  /** What the success path calls: 'forget' keeps the set, 'reset' restores it. */
  clearWith: 'forget' | 'reset'
}) {
  const frames: string[][] = []
  // fallback is memoised on the PROP, which does not change until the refresh.
  const fallback = new Set(storeColumns)
  let live = new Set(fallback)

  live = new Set([...live, tick]) // prefs.setVisible(next)
  frames.push([...live])

  // ...server round trip; the prop is still the old one here...
  if (clearWith === 'reset') live = new Set(fallback)
  frames.push([...live])

  // router.refresh() lands the saved set as the new prop.
  live = new Set([...storeColumns, tick])
  frames.push([...live])

  return frames
}

function main() {
  /* ── ONE CLICK IS ENOUGH ─────────────────────────────────────────────── */
  const withForget = storeSave({ storeColumns: ['name'], tick: 'barcode', clearWith: 'forget' })
  check(
    'the column is on immediately after one click',
    withForget[0].includes('barcode'),
    JSON.stringify(withForget[0]),
  )

  /* ── AND IT STAYS ON ─────────────────────────────────────────────────── */
  check(
    'it is still on in every later frame (no flicker)',
    withForget.every((f) => f.includes('barcode')),
    withForget.map((f) => f.join('+')).join(' -> '),
  )

  /* ── AND THE OLD BEHAVIOUR IS STILL DETECTABLE ─────────────────────────
   *
   * Without this the two checks above would pass on an implementation that
   * simply never clears anything — proving the assertions are about the fix
   * and not merely about the model. */
  const withReset = storeSave({ storeColumns: ['name'], tick: 'barcode', clearWith: 'reset' })
  check(
    'reset() on the success path WOULD flicker (so the check above is real)',
    !withReset[1].includes('barcode') && withReset[2].includes('barcode'),
    withReset.map((f) => f.join('+')).join(' -> '),
  )

  /* ── THE HOOK MUST NOT BE CALLABLE WITHOUT A PROVIDER ──────────────────
   *
   * Fault 1 was silent precisely because a second instance is a legal, working
   * hook call. Reading the source is the only way to assert the guard exists
   * short of rendering React, and the string is stable because it is the error
   * a developer would see. */
  const fs = require('node:fs') as typeof import('node:fs')
  const src = fs.readFileSync('src/app/(app)/products/ProductColumnsButton.tsx', 'utf8')
  check(
    'useProductColumns throws without a provider rather than making its own state',
    /useProductColumns needs a <ProductColumnsProvider>/.test(src),
  )
  check(
    'the provider exists and is exported',
    /export function ProductColumnsProvider/.test(src),
  )
  check(
    'the success path forgets rather than resets',
    /prefs\.forget\(\)/.test(src) && !/prefs\.reset\(\)\s*\n\s*toast\.success/.test(src),
  )

  /* ── AND ONLY ONE COMPONENT MAY RESOLVE THE STATE ──────────────────────
   *
   * The regression is re-introduced by a second `useColumnPrefs` for the same
   * storage key, which is exactly what a future screen wanting these columns
   * would reach for. */
  const client = fs.readFileSync('src/app/(app)/products/ProductListClient.tsx', 'utf8')
  check(
    'the table reads the shared state and does not resolve its own',
    /useProductColumns\(\)/.test(client) && !/useColumnPrefs/.test(client),
  )

  /* Not vacuous: prove the file was actually read. */
  check('the source files were read', src.length > 500 && client.length > 500)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
}

main()
process.exit(failures === 0 ? 0 : 1)
