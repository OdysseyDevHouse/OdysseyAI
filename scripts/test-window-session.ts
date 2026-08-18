/**
 * The rule that decides whether a reopened counter window is still signed in.
 *
 * Worth its own suite because the whole feature is four lines of policy, and
 * each way of getting it wrong is invisible in the UI:
 *
 *   • too strict and every till in the country meets a PIN pad at deploy time,
 *     mid-trade, with nothing on screen to explain why;
 *   • too lenient and the feature silently does nothing — the screens still
 *     work, still show the right operator, and still hand the last clerk's
 *     identity to whoever reopens the tab, which is the bug it exists to fix.
 *
 * Neither shows up in a typecheck or a page render, so it is asserted here.
 *
 *   npx tsx scripts/test-window-session.ts
 */
import { windowMatches, WINDOW_COOKIE } from '../src/lib/windowSession'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const TAB = 'a1b2c3d4-0000-4000-8000-000000000001'
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002'

console.log('\nThe window that signed in stays signed in')
check('the same tab is recognised', windowMatches(TAB, TAB))

console.log('\nThe case this feature exists for')
/* A closed and reopened tab: the till cookie is still valid and still within
   its eight hours, but sessionStorage went with the tab, so nothing is sent. */
check('a reopened tab is refused', !windowMatches(TAB, null))
check('a tab with no id is refused', !windowMatches(TAB, ''))

console.log('\nA second tab is a second person until it proves otherwise')
check('a different tab is refused', !windowMatches(TAB, OTHER))

console.log('\nTokens minted before this shipped are not evicted')
/* The deploy-time property. A token with no claim predates the binding, and
   refusing it would sign every counter out at once, mid-afternoon. */
check('an unbound token with a tab id is accepted', windowMatches(undefined, TAB))
check('an unbound token with no tab id is accepted', windowMatches(undefined, null))

console.log('\nA browser that cannot store an id is not locked out')
/* `ensureWindowId` returns '' when sessionStorage throws, and the sign-in
   actions store that as `undefined` rather than ''. This asserts the pairing:
   such a session must fall back to the old eight-hour rule rather than be
   refused on every single request. */
check('an empty claim behaves as unbound', windowMatches('', TAB))
check('an empty claim with no cookie behaves as unbound', windowMatches('', null))

console.log('\nThe cookie name is part of the contract')
/* Read on the server by getTillSession and written on the client by
   ensureWindowId. A rename in one place only is a silent, total failure of the
   check — it would read as "unbound" and let everything through. */
check('the cookie is named odyssey_wid', WINDOW_COOKIE === 'odyssey_wid', WINDOW_COOKIE)

console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)
