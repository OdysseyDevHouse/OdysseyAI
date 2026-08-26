/**
 * Local sign-in — name and PIN, against the shop's own users table.
 *
 * ── THE FAILURE WORTH TESTING ───────────────────────────────────────────────
 *
 * Not "does a good PIN work". It is that `session.userId` means two different
 * things depending on how somebody signed in: a `cp2_users.id` on a cloud site,
 * a `users.id` on a local one. Both are small integers, so reading one as the
 * other does not throw — `requireSiteUser` would look up `control_user_id = 4`,
 * find a different person, or adopt one who does not exist, and every screen
 * afterwards would quietly belong to the wrong user.
 *
 * `SessionPayload.scope` is what keeps them apart, so these check the parts of
 * that contract that can be checked without a database in front of them: the
 * token round-trips the field, and the pieces that decide who may sign in are
 * where the code says they are.
 *
 *   node scripts/test-local-signin.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nLocal sign-in\n')

/* ── The session field that keeps the two id spaces apart ─────────────────── */

const session = read('src/lib/session.ts')
check("SessionPayload carries a scope", /scope\?: 'site'/.test(session))
check(
  'scope is optional, so tokens minted before it keep working',
  /scope\?:/.test(session) && !/\n\s*scope: 'site'/.test(session),
)

const auth = read('src/lib/auth.ts')
/* The whole point: requireSiteUser must branch, and the local branch must NOT
   reach adoptControlUser — adopting on a site-scoped id invents a person. */
check("requireSiteUser branches on scope", /session\.scope === 'site'/.test(auth))
const localBranch = auth.slice(auth.indexOf("session.scope === 'site'"), auth.indexOf('} else {'))
check(
  'the local branch looks the user up by their own id',
  /getUser\(site\.id, session\.userId\)/.test(localBranch),
)
check('the local branch never adopts a control user', !/adoptControlUser/.test(localBranch))

/* ── Who is allowed in ────────────────────────────────────────────────────── */

const local = read('src/lib/localSignIn.ts')
check('a till-only operator cannot open the back office', /userType !== 'back_office'/.test(local))
check('the name is confirmed as well as the PIN', /toLowerCase\(\) !== typed\.toLowerCase\(\)/.test(local))
check("the minted session declares its scope", /scope: 'site'/.test(local))
check(
  'the session carries the site, so no picker is reached',
  /\n\s*siteId,/.test(local),
)
/* Enrolling in the one-live-session registry would be a claim this install
   cannot honour — the registry lives in a control database it never consults. */
check('no sid is enrolled', !/\bsid:/.test(local))

/* ── The rule that would otherwise block the store owner ──────────────────── */

const users = read('src/lib/site/users.ts')
check(
  'a back-office user may have a PIN instead of an email on a local install',
  /resolveOfflineSite/.test(users) && /needs a PIN to sign in with/.test(users),
)
/* The wizard runs as a CLOUD client while building a LOCAL site, so it cannot
   be recognised by asking what kind of install it is — resolveOfflineSite says
   "not local" and the rule demands an email the technician was never asked for.
   It has to say so explicitly. This shipped wrong once. */
check('the caller can declare the PIN is the credential', /pinIsCredential/.test(users))
check(
  'and the setup wizard does declare it',
  /pinIsCredential: true/.test(read('src/lib/dbSetup/firstUser.ts')),
)

/* ── A session from somewhere else must not survive here ──────────────────── */

/* Cookies live in userData, and userData survives reinstalling — deliberately,
   so an upgrade cannot lose a database password. The consequence is that a
   session signed in against the CLOUD, before this machine was provisioned,
   outlives every remedy a person would naturally try: it skips the login form
   entirely and lands them on a site picker for shops this machine cannot open,
   and "uninstall and reinstall" changes nothing.

   Cost an afternoon to recognise, twice. */
check('a session for another shop is refused', /session\.scope !== 'site' \|\| session\.siteId !== localSite/.test(auth))
/* Only ever narrows: a cloud install has no local site and skips the check. */
check('the check only applies to a local install', /isLocalInstall &&/.test(auth))
/* The cookie is cleared by the login page, not here: a cookie write during a
   render throws, and surfaces as "a server error occurred". */
check('it redirects rather than writing a cookie mid-render', /redirect\('\/\?kicked=1'\)/.test(auth))

/* ── The first user ───────────────────────────────────────────────────────── */

const first = read('src/lib/dbSetup/firstUser.ts')
check('the store owner gets the owner role', /is_owner = 1/.test(first))
check('the owner role is looked up, not assumed', !/roleId: 1\b/.test(first))
check('a second owner cannot be created', /hasAnyUser/.test(first))
check('it goes through createUser, inheriting the PIN rules', /createUser\(siteId/.test(first))

/* ── The screen ───────────────────────────────────────────────────────────── */

const page = read('src/app/page.tsx')
check('the login page decides on the server', /await localSiteId\(\)/.test(page))
check('it renders the local form when local', /local \? <LocalLoginForm/.test(page))

const form = read('src/app/login/LocalLoginForm.tsx')
check('the PIN field is numeric', /inputMode="numeric"/.test(form))
/* A shared shop machine must not offer the last person's PIN to the next one. */
check('the browser is not invited to remember the PIN', /autoComplete="one-time-code"/.test(form))
check('there is no forgot-password link', !/forgot/i.test(form.replace(/\/\*[\s\S]*?\*\//g, '')))

console.log(`\n${failures === 0 ? 'All local sign-in checks passed.' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
