/**
 * Permission enforcement — is the roles screen telling the truth?
 *
 *   npm run test:permissions
 *
 * A permission system that only filters the menu is worse than none: it LOOKS
 * like it is protecting you. These checks are structural rather than
 * behavioural — they read the route files and assert that every page, server
 * action and API route consults a capability, because the alternative is
 * signing in as forty different roles and typing URLs.
 *
 * The behavioural half — that `can()` returns false and the guard then fires —
 * is covered by test-users-pins.ts.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP = path.join(ROOT, 'src', 'app')

let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

/** Every file under `dir` matching `match`, recursively. */
async function walk(dir: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/')

/**
 * Anything that consults a capability, however it is spelled.
 *
 * The `requireModuleCapability` / `actorForModule` / `actorForModuleOrThrow`
 * forms ask a module FIRST and then the same capability — see
 * src/lib/control/modules.ts — so they satisfy this check too. `actorFor` and
 * `requireCapability` are listed with the module variants explicitly rather
 * than relying on a prefix match, because `requireModuleCapability` does not
 * start with `requireCapability`, and a silent non-match here would report a
 * properly guarded page as unguarded.
 */
const GUARD =
  /requireCapability|requireModuleCapability|requireAnyCapability|requireModule\b|actorFor|actorForModule|actorForOrThrow|actorForModuleOrThrow|siteIdForCapability|can\(\s*(capabilities|ctx\.capabilities)/

/**
 * Is this file actually a server-actions module?
 *
 * `'use server'` is a DIRECTIVE: it only counts at the top of the file, before
 * any statement, and comments and blank lines may precede it. So the check
 * strips those and looks at what comes first — rather than searching the whole
 * text, which cannot tell an endpoint from a paragraph about endpoints.
 */
function isServerActionFile(src: string): boolean {
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .trim()
  return /^(['"])use server\1\s*;?/.test(withoutComments)
}

/**
 * Pages that are deliberately open.
 *
 * /not-allowed is where every refused guard redirects TO — guarding it would
 * bounce a user between two pages forever.
 */
const OPEN_PAGES = new Set([
  'src/app/(app)/not-allowed/page.tsx',
  /* A pure redirect to /invoicing, kept because /sales is on printed
     references and bookmarks. It reads NOTHING — no query, no siteId, no
     document — so there is nothing here to guard; it only rewrites the query
     string and redirects. The capability lives where the data is: the target
     requires sales.view, so someone without it lands on not-allowed either
     way. A check here would refuse the visitor a millisecond earlier and
     duplicate an authority that belongs on one screen. */
  'src/app/(app)/sales/page.tsx',
  /* Own account only: /security reads and writes the VISITOR'S cp2_user_totp
     row via requireSession, never anybody else's. A capability here would let
     an owner forbid people from protecting their own login — backwards. */
  'src/app/(app)/security/page.tsx',
  /* Session-only like /security: the feed is personal, and which rows appear
     is decided inside the lib from the visitor's OWN CapabilitySet — a page
     capability would only duplicate that decision, wrongly. */
  'src/app/(app)/notifications/page.tsx',
])

/** Action files that guard with requireSession alone, each for the same
    documented own-account reason as its page above. */
const OPEN_ACTIONS = new Set([
  'src/app/(app)/security/actions.ts',
  'src/app/(app)/notifications/actions.ts',
  /* The telephone unlock, redeemed on a machine that has locked itself after a
     week offline. requireSession, deliberately no capability.

     The code IS the authority: it is machine-specific, single-use, time-boxed,
     and it only exists because a supervisor on the control panel already
     decided to issue it — that decision IS gated, on setup.edit, in
     setup/terminals/unlockActions.ts.

     A capability here would gate the same act twice and strand the shop the
     second time: the person typing it in is whoever answered the phone at
     07:00 on a Sunday, and a rule that only a manager may unlock means a
     cashier with support on the line still cannot open the till. */
  'src/app/(app)/leaseActions.ts',
])

/**
 * API routes guarded by the SESSION alone — requireSiteUser, no single
 * capability — each because what the caller may see is decided per row inside
 * the lib from their own CapabilitySet. Distinct from OPEN_ROUTES below:
 * these still demand a signed-in site user.
 */
const SESSION_ROUTES = new Set([
  // The bell: personal feed; visibility filtered per capability in
  // src/lib/site/notifications.ts, mutations touch only the visitor's rows.
  'src/app/api/notifications/route.ts',
  /*
   * The business's own logo, for the letterhead on a printed document.
   *
   * Deliberately session-gated rather than capability-gated, and the route says
   * why at length: the picture belongs to no one screen — it is on the purchase
   * order a buyer prints, the invoice a clerk prints and the preview a designer
   * looks at — so gating it on `setup.stationery` would blank the logo on
   * everyone's paperwork except the person who uploaded it.
   *
   * Listed HERE and not in OPEN_ROUTES because it is not open: the check below
   * still proves `requireSiteUser` is present, which is what resolves the site
   * from the session. There is no id in the URL, so the route cannot be pointed
   * at another shop's file.
   */
  'src/app/api/document-logo/route.ts',
  /*
   * Its two siblings, session-gated for the same documented reason and verified
   * the same way — read individually, not swept in.
   *
   * `stationery-images` serves the pictures the shop chose to put ON the
   * invoice a clerk prints and the order a buyer prints; gating them on
   * `setup.stationery` would blank them for everyone but whoever uploaded them.
   * The id in the path is safe because `readImage` is scoped to the site the
   * SESSION resolves, so walking the range reaches only this shop's own
   * pictures.
   *
   * `pos/slip-design` hands the till its active slip layout, which has to reach
   * the client because printing.ts composes the slip in the browser at the
   * counter. Anyone standing at a till may print a slip, and the site again
   * comes from the session, so there is nothing in the URL to point elsewhere.
   */
  'src/app/api/stationery-images/[id]/route.ts',
  'src/app/api/pos/slip-design/route.ts',
])

/**
 * API routes that are deliberately unauthenticated, each for a documented
 * reason. Listed explicitly so adding a new open route is a decision somebody
 * makes rather than an omission nobody notices.
 */
const OPEN_ROUTES = new Set([
  'src/app/api/health/route.ts', // Electron's startup probe, before any session
  'src/app/api/auth/signout/route.ts', // signing out cannot require being signed in
  'src/app/api/payments/payfast/[token]/route.ts', // PayFast's server-to-server callback
  /* The platform's own PayFast callback — Odyssey collecting from a tenant,
     where the route above is a tenant collecting from its shoppers. PayFast
     posts with no cookie and no session, so a capability check is impossible.
     It is guarded instead by a signed account-scoped token in the URL, plus a
     valid PayFast signature, a PayFast source IP and PayFast's own
     confirmation of the payload before anything is written. */
  'src/app/api/billing/payfast/[token]/route.ts',
  /* The same again, for a once-off AI-credits top-up rather than the recurring
     subscription. A separate route because it settles a different thing, and a
     separate entry here rather than a prefix, so a future route under
     /api/billing/ cannot inherit an exemption nobody chose for it.

     Guarded identically: a signed token naming one billing account AND one
     checkout, a valid PayFast signature, a PayFast source IP, PayFast's own
     confirmation, and the amount checked against what this server recorded when
     it built the form. */
  'src/app/api/billing/topup/[token]/route.ts',
  // Cron's heartbeat for scheduled reports. There is nobody signed in at 07:00,
  // so it proves itself with REPORT_CRON_SECRET compared by timingSafeEqual,
  // and refuses everything when that is unset. A capability check would be the
  // wrong tool — there is no user to have one.
  'src/app/api/reports/schedules/tick/route.ts',
  // Cron's heartbeat for contract billing. Same reasoning as the reports tick:
  // there is nobody signed in at 05:00, so it proves itself with
  // CONTRACT_CRON_SECRET compared by timingSafeEqual and refuses every request
  // when that is unset. Raising invoices is exactly why it is a shared secret
  // rather than nothing — a biller running wide open would let anyone bill
  // every customer in the system.
  'src/app/api/contracts/tick/route.ts',
  // Platform billing's heartbeat — the annual increase and the sweep that makes
  // PayFast agree with the price held locally. Same reasoning again:
  // BILLING_CRON_SECRET compared by timingSafeEqual, refusing everything when
  // that is unset. It fails closed for a sharper reason than most — a
  // price-raising job that ran for anyone who found the URL would let a
  // stranger increase every customer's subscription.
  'src/app/api/billing/tick/route.ts',
  /*
   * Three more cron heartbeats, all on the same reasoning as the two above: a scheduled
   * price change, a stale-basket sweep and a storefront publish each run with nobody
   * signed in, so each proves itself with its own *_CRON_SECRET compared by
   * `timingSafeEqual` and refuses every request when that variable is unset.
   *
   * Listed here rather than the check being loosened. Verified individually before adding
   * — a route in this set is one somebody has read, which is the whole point of the set
   * being explicit.
   */
  'src/app/api/pricing/schedules/tick/route.ts',
  'src/app/api/store/baskets/tick/route.ts',
  // The low-stock digest heartbeat — LOW_STOCK_CRON_SECRET, same reasoning.
  'src/app/api/alerts/tick/route.ts',
  // The webhook delivery heartbeat — WEBHOOK_CRON_SECRET, same reasoning.
  'src/app/api/webhooks/tick/route.ts',
  // Two more cron heartbeats for job cards, on the reasoning above and verified
  // the same way: each proves itself with its OWN secret compared by
  // timingSafeEqual (JOB_AUTOMATION_CRON_SECRET, JOB_SERIES_CRON_SECRET) and
  // returns 503 doing nothing when that variable is unset — no open fallback.
  // Separate secrets on purpose: one shared across every tick would mean
  // rotating it for one reason silently breaks the others.
  'src/app/api/jobs/automations/tick/route.ts',
  'src/app/api/jobs/series/tick/route.ts',
  /*
   * A technician's calendar subscription. Google, Outlook and Apple fetch it on
   * a schedule with no browser and no cookie, so a capability check is the wrong
   * tool — there is no session to carry one, and behind the gate the feed would
   * silently render empty for ever.
   *
   * The gate is the URL: a signed token naming ONE user on ONE site, with its
   * own audience. The query reads only that user's own appointments, so a forged
   * or widened token cannot reach anybody else's, and the feed carries no
   * financial data at all. An invalid token 404s — indistinguishable from a URL
   * that never existed. Rotating SESSION_SECRET revokes every subscription.
   */
  'src/app/api/jobs/calendar/[token]/route.ts',
  'src/app/api/storefront/publish/route.ts',
  'src/app/store-images/[token]/[imageId]/route.ts',
  'src/app/api/store-images/[token]/[imageId]/route.ts', // public storefront asset
  // The shop's OWN pictures — a front-page banner or the masthead logo — for the
  // public storefront. Listed for the same reason as its product-image sibling
  // above: a shopper has no session and must not need one, so the gate is a signed
  // store token plus `storefrontContext` agreeing the shop is open, not a
  // capability. A closed shop or a bad token both 404, indistinguishably.
  'src/app/api/store-images/[token]/shop/[imageId]/route.ts',
  /*
   * ── The mobile app's three auth endpoints ────────────────────────────────
   *
   * All three authenticate; none of them can do it with a capability, which is
   * why the check cannot see it. Read individually before being added here.
   *
   * `login` is enrolment — the one time the app asks for a password. Requiring
   * a session to sign in is the same contradiction as requiring one to sign
   * out. It defers to `signIn()` rather than comparing a password itself, so
   * the lockout counter, the account-enumeration rule, the sign-in log and the
   * 2FA branch are the same ones the web form gets.
   *
   * `session` trades that enrolment token for a fresh session on each cold
   * start. The bearer token IS the credential: it resolves a user, then re-reads
   * the account and refuses a suspended one, a deleted one, or one told to
   * change its password — with the same 401 a bad token gets, so an
   * unauthenticated caller cannot learn which tokens name real accounts.
   *
   * `revoke` is the app's own "sign out", authenticated by the token because it
   * is the token's holder asking to destroy it. It answers 204 either way, for
   * that same non-enumeration reason, and scopes the delete by user AND token
   * so no id but this token's own can be revoked through it.
   */
  'src/app/api/mobile/auth/login/route.ts',
  'src/app/api/mobile/auth/session/route.ts',
  'src/app/api/mobile/auth/revoke/route.ts',
  /*
   * The local box's overnight flush — the batch a shop's own machine hands to
   * the cloud's posting path at 03:00, when nobody is signed in.
   *
   * Same shape and same reasoning as the cron ticks above: BOX_CRON_SECRET
   * compared by `timingSafeEqual`, length-guarded first so a mismatch cannot
   * leak the length, and every request refused when that variable is unset. It
   * fails closed for a sharp reason — this posts real money to the books, so an
   * open version would let anyone on the shop's LAN drive it.
   */
  'src/app/api/pos/box-flush/route.ts',
])

async function main() {
  /* ── Pages ─────────────────────────────────────────────────────────── */
  console.log('\npages')
  const pages = (await walk(path.join(APP, '(app)'), (n) => n === 'page.tsx')).map(rel)
  const unguardedPages: string[] = []

  for (const p of pages) {
    if (OPEN_PAGES.has(p)) continue
    const src = await readFile(path.join(ROOT, p), 'utf8')
    if (!GUARD.test(src)) unguardedPages.push(p)
  }

  check(
    `every page checks a capability (${pages.length - unguardedPages.length}/${pages.length})`,
    unguardedPages.length === 0,
    // All of them, for the reason given at the routes check below.
    unguardedPages.join(', '),
  )

  /* ── Server actions ────────────────────────────────────────────────── */
  //
  // The real boundary. A page guard stops someone LOOKING; the action behind
  // it is a public endpoint any client can call directly, so an unguarded
  // action is reachable no matter what the screen shows.
  console.log('\nserver actions')
  const actionFiles = (await walk(path.join(APP, '(app)'), (n) => n.endsWith('.ts'))).map(rel)
  const unguardedActions: string[] = []
  let actionFileCount = 0

  for (const f of actionFiles) {
    if (OPEN_ACTIONS.has(f)) continue
    const src = await readFile(path.join(ROOT, f), 'utf8')
    /*
     * The DIRECTIVE, not the words.
     *
     * `'use server'` only does anything at the very top of a file, before any
     * statement. Matching the string anywhere counted a module that merely
     * MENTIONS it in prose — cashup/declare/visible.ts is a pure filter whose
     * docblock explains why it is deliberately not an actions file, and it was
     * reported as an unguarded endpoint for saying so.
     *
     * That is not a harmless false positive. This check is the one that finds a
     * genuinely open action, and a permanent red line beside it is how the real
     * one gets waved past.
     */
    if (!isServerActionFile(src)) continue
    actionFileCount++
    // A file-level helper (setup/users, commission) counts — what matters is
    // that a capability is consulted, not which spelling was used.
    if (!GUARD.test(src)) unguardedActions.push(f)
  }

  check(
    `every action file checks a capability (${actionFileCount - unguardedActions.length}/${actionFileCount})`,
    unguardedActions.length === 0,
    unguardedActions.slice(0, 5).join(', '),
  )

  /* ── API routes ────────────────────────────────────────────────────── */
  //
  // Sharpest of the three: api/ is outside the (app) route group, so the
  // layout never runs, and these URLs are directly typeable. An unguarded
  // export route hands over the whole customer base.
  console.log('\napi routes')
  const routes = (await walk(path.join(APP, 'api'), (n) => n === 'route.ts')).map(rel)
  const unguardedRoutes: string[] = []

  for (const r of routes) {
    if (OPEN_ROUTES.has(r)) continue
    // Session-guarded personal routes: verify the session check is present
    // rather than skipping blind, so the entry cannot outlive the guard.
    if (SESSION_ROUTES.has(r)) {
      const src = await readFile(path.join(ROOT, r), 'utf8')
      if (!/requireSiteUser|requireSession/.test(src)) unguardedRoutes.push(r)
      continue
    }
    // The public API authenticates with API keys, not sessions: every route
    // under /api/v1 must run through withApiKey, so one cannot ship open.
    // One deliberate exception: the OpenAPI spec is documentation — it
    // describes the API without exposing any store's data, and an integrator
    // needs it BEFORE they have a key.
    if (r === 'src/app/api/v1/openapi.json/route.ts') continue
    if (r.startsWith('src/app/api/v1/')) {
      const src = await readFile(path.join(ROOT, r), 'utf8')
      if (!/withApiKey\(/.test(src)) unguardedRoutes.push(r)
      continue
    }
    const src = await readFile(path.join(ROOT, r), 'utf8')
    if (!GUARD.test(src)) unguardedRoutes.push(r)
  }

  check(
    `every non-public api route checks a capability (${routes.length - OPEN_ROUTES.size - unguardedRoutes.length} of ${routes.length - OPEN_ROUTES.size})`,
    unguardedRoutes.length === 0,
    /* ALL of them, not the first five. The cap hid two unguarded routes behind
       the five it printed: fixing the named ones turned the line green-ish and
       the rest only appeared on the next run. A list this check wants somebody
       to act on has to show what there is to act on. */
    unguardedRoutes.join(', '),
  )

  /* ── The old role must be gone ─────────────────────────────────────── */
  //
  // `cp2_user_sites.site_role` decided permissions before 041. Anything still
  // reading it is enforcing the control panel's three-value role rather than
  // the store's own, which both refuses people who were granted access and
  // admits people who were not.
  console.log('\nno stale role checks')
  /*
   * EVERY route group, not just (app) and api.
   *
   * This used to walk `(app)` and `api` alone, which left `(pos)`,
   * `(invoicing)`, `(print)`, `store`, `portal` and the rest unscanned — so the
   * stale-role check below never looked at the till, and the enforcement count
   * further down reported a capability as unused when the only place enforcing
   * it was the POS. `sales.cashup_other` is exactly that: guarded in
   * (pos)/pos/shiftActions.ts, and listed as "not yet enforced" for it.
   *
   * Walking src/app wholesale rather than naming the groups, so a group added
   * later is covered without anybody remembering to add it here.
   */
  const everything = (
    await walk(path.join(ROOT, 'src', 'app'), (n) => n.endsWith('.ts') || n.endsWith('.tsx'))
  ).map(rel)

  const stale: string[] = []
  for (const f of everything) {
    const src = await readFile(path.join(ROOT, f), 'utf8')
    // Comments explaining the migration are fine; a live comparison is not.
    for (const line of src.split('\n')) {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (/(site|ctx\.site)\.role\s*[=!]==/.test(code)) {
        stale.push(`${f}: ${line.trim().slice(0, 70)}`)
        break
      }
    }
  }
  check('nothing decides access from the control-panel role', stale.length === 0, stale.slice(0, 3).join(' | '))

  /* ── Capabilities are real ─────────────────────────────────────────── */
  //
  // A guard naming a capability that does not exist is deny-by-default
  // forever: nobody can be granted it, so the screen is unreachable for
  // everyone including an owner — who passes only because owners bypass.
  console.log('\ncapabilities exist')
  const permissionsSrc = await readFile(
    path.join(ROOT, 'src', 'lib', 'site', 'permissions.ts'),
    'utf8',
  )
  const declared = new Set(
    [...permissionsSrc.matchAll(/\{\s*key:\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]),
  )
  check(`permissions.ts declares capabilities`, declared.size > 20, `${declared.size} found`)

  // Wider than `everything`: a capability can legitimately be enforced deep in
  // a library rather than at the entry point — `sales.edit_finalised` is
  // checked inside salesEdit.ts, because the correction path is reached from
  // several callers and guarding each one would be the easy thing to forget.
  // Scanning only pages/actions/routes reported it as an unenforced gap.
  const guardSites = [
    ...everything,
    ...(await walk(path.join(ROOT, 'src', 'lib'), (n) => n.endsWith('.ts'))).map(rel),
  ]

  const used = new Set<string>()
  for (const f of guardSites) {
    const src = await readFile(path.join(ROOT, f), 'utf8')
    for (const m of src.matchAll(
      /(?:requireCapability|actorFor|actorForOrThrow|siteIdForCapability)\(\s*'([a-z_]+\.[a-z_]+)'/g,
    )) {
      used.add(m[1])
    }
    /* The module-gated forms take the module first and the capability second:
       requireModuleCapability('loyalty', 'loyalty.view'). Without this, every
       capability used only behind a module would look unreferenced and this
       suite would ask for it to be deleted. */
    for (const m of src.matchAll(
      /(?:requireModuleCapability|actorForModule|actorForModuleOrThrow)\(\s*'[a-z_]+',\s*'([a-z_]+\.[a-z_]+)'/g,
    )) {
      used.add(m[1])
    }
    for (const m of src.matchAll(/can\(\s*(?:ctx\.)?capabilities,\s*'([a-z_]+\.[a-z_]+)'/g)) {
      used.add(m[1])
    }
  }

  const unknown = [...used].filter((c) => !declared.has(c))
  check('every guard names a real capability', unknown.length === 0, unknown.join(', '))

  console.log(`\n${used.size} of ${declared.size} capabilities are enforced somewhere`)
  const unenforced = [...declared].filter((c) => !used.has(c))
  if (unenforced.length) {
    console.log(`not yet enforced: ${unenforced.join(', ')}`)
  }

  /* ── The nav promise ───────────────────────────────────────────────── */
  //
  // Every capability the sidebar filters on must be one the pages actually
  // enforce, or the menu is making a promise the app does not keep.
  console.log('\nnav matches enforcement')
  const navSrc = await readFile(path.join(ROOT, 'src', 'lib', 'nav.ts'), 'utf8')
  const navCaps = new Set(
    [...navSrc.matchAll(/capability:\s*'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]),
  )
  const navUnknown = [...navCaps].filter((c) => !declared.has(c))
  check('every nav capability is declared', navUnknown.length === 0, navUnknown.join(', '))

  /* ── Setup labels ──────────────────────────────────────────────────────
     The Setup hub's tiles take their name from SUBPAGE_LABELS while the sidebar
     takes its own from NAV. Both lists exist on purpose — the hub needs literal
     keys so a tile pointing nowhere is a compile error — so the risk is drift,
     and a screen renamed in one place would be called two different things.

     THE HUB, NOT THE SIDEBAR, IS THE SET TO CHECK AGAINST. Setup used to be a
     sidebar group listing every screen, so "a label with no menu item" meant an
     unreachable screen. It is now one link to /setup, and the catalogue there is
     what makes a screen reachable — so a label whose href is absent from the
     SIDEBAR is normal, while one absent from the CATALOGUE is the real orphan.
     Checking the sidebar reported all fourteen hub screens as dropped.

     Read as SOURCE, not imported, for the same reason the capability scan above
     is: nav.ts pulls in lucide-react, which needs a React runtime this test has
     no business booting. */
  const setupItems = [
    ...navSrc.matchAll(/label:\s*'([^']+)',\s*href:\s*'(\/setup\/[a-z-]+)'/g),
  ].map((m) => ({ label: m[1].replace(/\\'/g, "'"), href: m[2] }))
  const labelBlock = navSrc.match(/export const SUBPAGE_LABELS = \{([\s\S]*?)\n\} as const/)
  const declaredLabels = new Map(
    [...(labelBlock?.[1] ?? '').matchAll(/'(\/setup\/[a-z-]+)':\s*'([^']+)'/g)].map((m) => [
      m[1],
      m[2].replace(/\\'/g, "'"),
    ]),
  )

  check('SUBPAGE_LABELS was found and parsed', declaredLabels.size > 0, `${declaredLabels.size} entries`)
  check(
    'every Setup menu item has a label entry',
    setupItems.every((i) => declaredLabels.has(i.href)),
    setupItems.filter((i) => !declaredLabels.has(i.href)).map((i) => i.href).join(', '),
  )

  const drift = setupItems.filter(
    (i) => declaredLabels.has(i.href) && declaredLabels.get(i.href) !== i.label,
  )
  check(
    'the Setup menu and the Setup hub agree on every screen name',
    drift.length === 0,
    drift.map((i) => `${i.href}: menu "${i.label}" vs hub "${declaredLabels.get(i.href)}"`).join('; '),
  )

  const catalogueSrc = await readFile(
    path.join(ROOT, 'src', 'app', '(app)', 'setup', 'catalogue.ts'),
    'utf8',
  )
  const catalogueHrefs = new Set(
    [...catalogueSrc.matchAll(/href:\s*'(\/setup\/[a-z-]+)'/g)].map((m) => m[1]),
  )
  check('the Setup catalogue was found and parsed', catalogueHrefs.size > 0, `${catalogueHrefs.size} tiles`)

  // Every tile resolves its name through SUBPAGE_LABELS, so a tile with no
  // label entry renders nameless.
  const unnamed = [...catalogueHrefs].filter((href) => !declaredLabels.has(href))
  check('every Setup hub tile has a label entry', unnamed.length === 0, unnamed.join(', '))

  /*
   * And the reverse: a label for a screen no longer on the hub is dead weight,
   * and points at a screen nothing links to.
   *
   * Unless another hub has CLAIMED it in SUBPAGE_OWNER. A route's prefix is not
   * the same question as which hub lists it — /setup/audit is listed in the
   * reports catalogue, because it answers a question rather than deciding
   * something, while its route stays where it always was. Such a screen is
   * linked, named and reachable; it is simply not Setup's.
   */
  const ownedElsewhere = new Set(
    [...navSrc.matchAll(/'(\/setup\/[a-z-]+)':\s*'(\/[a-z-]+)'/g)]
      .filter((m) => m[2] !== '/setup')
      .map((m) => m[1]),
  )
  const orphans = [...declaredLabels.keys()].filter(
    (href) => !catalogueHrefs.has(href) && !ownedElsewhere.has(href),
  )
  check('no label entry points at a screen the hub has dropped', orphans.length === 0, orphans.join(', '))
  check(
    'a setup-routed screen listed by another hub is claimed in SUBPAGE_OWNER',
    ownedElsewhere.has('/setup/audit'),
    [...ownedElsewhere].join(', ') || 'none claimed',
  )

  await tillAttributionIsTheOperator()
}

/**
 * A till write must name the PIN OPERATOR, not the browser session.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * `actorFor` resolves the browser session — on a shared shop-floor machine,
 * whoever opened it that morning. `withTillOperator` swaps in the PIN operator.
 * The sales actions used to resolve the operator for the PRICE check and then
 * attribute the sale with `actorFor`'s browser actor, so every line's
 * `sales_rep_user_id` — the column commission is PAID on — named the wrong
 * person, and the restaurant table actions skipped attribution altogether.
 *
 * ── WHY IT IS A STATIC CHECK ───────────────────────────────────────────────
 *
 * Every behavioural test injects its actor directly (`test-sales-posting.ts`,
 * `test-cashup-modes.ts`, `test-commission.ts` all hand-build one and call the
 * lib), which is precisely the seam the bug lived in: they prove the engine is
 * right GIVEN an attribution, never that the action resolved the right person.
 * Reading the source is what catches a re-introduction.
 */
async function tillAttributionIsTheOperator() {
  console.log('\ntill sales name the operator')

  const files = await walk(APP, (name) => name === 'actions.ts' || name.endsWith('Actions.ts'))

  // A file that writes a sale: it stamps lines, or hands an actor to the two
  // functions that persist and post one.
  const WRITES_A_SALE = /attributeTo\(|saveDraft\(|finaliseDocument\(/

  const offenders: string[] = []
  for (const file of files) {
    const src = await readFile(file, 'utf8')
    if (!WRITES_A_SALE.test(src)) continue
    // Only the till paths. A back-office screen has no PIN session, so
    // `actorFor` there already resolves the only person there is.
    if (!/'sales\.till'/.test(src)) continue
    if (!/withTillOperator/.test(src)) offenders.push(rel(file))
  }

  check(
    'every till action that writes a sale resolves the PIN operator',
    offenders.length === 0,
    offenders.join(', '),
  )

  /* The helper itself must keep BOTH halves. An edit that dropped the
     capability swap would silently hand a junior the manager's discount rights,
     and one that dropped the identity swap is the original bug returning. */
  const auth = await readFile(path.join(ROOT, 'src', 'lib', 'auth.ts'), 'utf8')
  const helper = auth.slice(auth.indexOf('export async function withTillOperator'))
  /* To the next top-level declaration rather than the first `\n}\n`: the generic
     parameter list puts a closing brace at column 0 before the body even starts,
     so the obvious boundary reads an empty function and passes vacuously. */
  const end = helper.search(/\n(export |\/\*\*)/)
  const body = end === -1 ? helper : helper.slice(0, end)
  check(
    'withTillOperator swaps identity as well as rights',
    /getTillSession/.test(body) && /actor:/.test(body) && /capabilitiesForRole/.test(body),
  )
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
    process.exit(failures ? 1 : 0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
