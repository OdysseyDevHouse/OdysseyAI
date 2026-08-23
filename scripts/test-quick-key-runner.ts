/**
 * Every quick key does something, and says something TRUE when it cannot.
 *
 *   npx tsx scripts/test-quick-key-runner.ts
 *
 * Pure — no database, no browser. `runQuickKey` takes handlers and a context and calls
 * one of them, so it can be driven with a recording stub.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A dead key is worse than an absent one, so the runner already answers every slug with
 * either an action or a reason. What nothing checked was whether those REASONS were
 * still true — and two of them had quietly rotted:
 *
 *   'redeem-voucher':  "Vouchers are not on this till yet — use the desk till."
 *   'loyalty-payment': "Paying with points is not on this till yet — use the desk till."
 *
 * Both were wrong twice over. Loyalty and vouchers were ported onto the touch tender pad
 * in phase 7, and the DESK TILL WAS DELETED in that same phase — so a cashier following
 * the instruction went looking for a screen that redirects them straight back to the one
 * they were already on. Two phases passed with nobody noticing, because a message is not
 * something a compiler can check.
 *
 * So this file checks the two things a compiler cannot: that no message names a screen
 * that no longer exists, and that every slug the catalogue offers is answered at all.
 *
 * `redeem-voucher` above is HISTORY — the key was retired outright once it was clear its
 * whole behaviour was pointing at the tender pad. It survives here as the retired slug
 * section 4a presses, because a board built before the removal still carries it.
 */
import { QUICK_KEY_ACTIONS } from '../src/lib/quickKeys'
import { runQuickKey, type RunContext, type QuickKeyHandlers } from '../src/app/(pos)/pos/quickKeyRunner'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/**
 * Records which handler fired, and with what.
 *
 * ── WHY A PROXY RATHER THAN A LIST ────────────────────────────────────────
 *
 * This used to be a hand-written object of a dozen stubs, cast with
 * `as unknown as QuickKeyHandlers` — and that cast is what let it rot. The
 * runner's contract grew to nearly thirty handlers; the stub stayed at twelve.
 * Every key added since resolved to `undefined` here, so pressing one threw
 * "handlers.saveSale is not a function" and the whole file died on its first
 * assertion. It reported no failures because it never reached one.
 *
 * A proxy answers for EVERY name by construction, so the next handler added to
 * the runner needs no change here and cannot silently go untested. Which is the
 * property the cast was pretending to have.
 */
function recorder() {
  const calls: { name: string; arg?: unknown }[] = []
  const handlers = new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        /* Anything the runner might legitimately probe rather than CALL. A
           promise-returning stub would change control flow, so keep it simple:
           only functions are handed back. */
        return (...args: unknown[]) => {
          /* `say` keeps its SHAPED record — the assertions below read
             `arg.message`, and it is the one handler whose payload they inspect
             rather than merely counting. Everything else records its first
             argument, which is all any of them takes. */
          calls.push({
            name: prop,
            arg:
              prop === 'say'
                ? { message: args[0], tone: args[1] }
                : args.length <= 1
                  ? args[0]
                  : args,
          })
          /* Nothing in the runner reads a handler's return value, so undefined
             is the honest answer for all of them. */
          return undefined
        }
      },
    },
  ) as QuickKeyHandlers
  return { calls, handlers }
}

function ctxFor(
  handlers: QuickKeyHandlers,
  over: Partial<RunContext> = {},
): RunContext {
  return {
    handlers,
    can: () => true,
    hospitality: false,
    online: true,
    hasSelection: true,
    hasLines: true,
    hasCustomer: true,
    returning: false,
    refundArmed: false,
    ...over,
  } as RunContext
}

/**
 * Presses one key.
 *
 * `capability` defaults to EMPTY, which matters: the runner gates on the capability
 * stored on the KEY ROW (what the designer validated and a manager can see), not on the
 * catalogue's. A synthetic row with no capability is therefore ungated — which is
 * correct behaviour, and is why the permission check below passes one explicitly rather
 * than relying on the catalogue.
 */
function press(slug: string, over: Partial<RunContext> = {}, capability = '') {
  const { calls, handlers } = recorder()
  runQuickKey(
    {
      id: 1,
      parentId: null,
      section: 'main',
      kind: 'action',
      actionSlug: slug,
      productId: null,
      departmentId: null,
      caption: slug,
      icon: '',
      colourToken: '',
      position: 0,
      isHidden: 0,
      requireAuth: 0,
      capability,
    } as never,
    ctxFor(handlers, over),
  )
  return calls
}

function main() {
  /* ── 1. Every action slug in the catalogue is ANSWERED ───────────────────
     Not necessarily wired — answered. A key that produces no call at all is a dead
     button, which is the failure the runner's two-table design exists to prevent. */

  const unanswered: string[] = []
  for (const action of QUICK_KEY_ACTIONS) {
    const calls = press(action.slug)
    if (calls.length === 0) unanswered.push(action.slug)
  }
  ok(
    `every one of ${QUICK_KEY_ACTIONS.length} catalogue slugs does something when pressed`,
    unanswered.length === 0,
    unanswered.join(', '),
  )

  /* ── 2. NO MESSAGE NAMES THE DESK TILL ───────────────────────────────────
     The assertion this file was written for. The desk till at `/sales/new` is gone —
     the screen since phase 7, the redirect that stood in for it since — so any message
     sending a cashier to "the desk till" sends them nowhere. Checked across every slug
     AND both connection states, because the offline branch is the one nobody looks at. */

  const offenders: string[] = []
  for (const action of QUICK_KEY_ACTIONS) {
    for (const online of [true, false]) {
      for (const hasCustomer of [true, false]) {
        for (const call of press(action.slug, { online, hasCustomer })) {
          if (call.name !== 'say') continue
          const message = String((call.arg as { message: string }).message)
          if (/desk till|\/sales\/new|old till/i.test(message)) {
            offenders.push(`${action.slug}: "${message}"`)
          }
        }
      }
    }
  }
  ok(
    '*** no key sends a cashier to the deleted desk till ***',
    offenders.length === 0,
    [...new Set(offenders)].slice(0, 4).join(' | '),
  )

  /* ── 3. Points point at the tender pad ───────────────────────────────────
     Reachable — through Pay — so the message must say where, not "not yet". */

  /* `redeem-voucher` used to be checked here beside points, saying the same thing about
     where codes are typed. The key is off the catalogue: its whole behaviour was telling
     a cashier to press Pay instead, which is a press that could never do anything. What
     is worth checking now is the RETIREMENT — a till that still carries the old key on a
     saved board must say it does not recognise it, not fall silent. That is the generic
     unknown-slug path, and section 4a below is where it is asserted. */

  const pointsWithCustomer = press('loyalty-payment', { hasCustomer: true })
  ok(
    'the points key points at the payment screen when a customer is attached',
    pointsWithCustomer.some((c) => c.name === 'say' && /pay/i.test(String((c.arg as any).message))),
    JSON.stringify(pointsWithCustomer),
  )

  /* The precondition, named. A loyalty standing is looked up per customer, so an
     unattached basket has no balance — and "attach the customer" is actionable where a
     flat refusal is not. */
  const pointsNoCustomer = press('loyalty-payment', { hasCustomer: false })
  ok(
    'and asks for the customer first when there is none',
    pointsNoCustomer.some(
      (c) => c.name === 'say' && /customer/i.test(String((c.arg as any).message)),
    ),
    JSON.stringify(pointsNoCustomer),
  )

  /* ── 4. Offline, points do not pretend to work ───────────────────────────
     A points balance is live on the server. Saying so beats offering a tender that will
     be refused at the pad. */

  const offlinePoints = press('loyalty-payment', { online: false })
  ok(
    'loyalty-payment says it needs the connection when offline',
    offlinePoints.some(
      (c) => c.name === 'say' && /connection/i.test(String((c.arg as any).message)),
    ),
    JSON.stringify(offlinePoints),
  )

  /* ── 4a. A RETIRED slug is refused out loud ───────────────────────────────
     Boards are stored rows, so removing an action from the catalogue does NOT remove it
     from the tills that already have it — `redeem-voucher` is on any board a shop built
     with it before it went. The runner has no branch for it any more, and the failure to
     guard against is SILENCE: a cashier pressing a key that does nothing presses it
     again, and blames the till rather than the board. `actionForSlug` returning null has
     to reach `say`, which is what this checks — with the real retired slug rather than a
     made-up one, so it stays true to what tills actually carry. */

  const retired = press('redeem-voucher')
  ok(
    'a key left on a board for a retired action says so instead of going quiet',
    retired.some((c) => c.name === 'say' && /recognise/i.test(String((c.arg as any).message))),
    JSON.stringify(retired),
  )

  /* ── 4b. CREDIT SALE opens the receipt finder ──────────────────────────────
     The `refund` key used to do this, under that name. Crediting a sale that EXISTS is
     the ordinary way goods come back — the customer gets the prices they paid — so it
     keeps the behaviour and gets an honest name. */

  const creditSale = press('credit-sale')
  ok(
    'the credit sale key opens the receipt finder',
    creditSale.some((c) => c.name === 'findReceipt'),
    JSON.stringify(creditSale),
  )
  /* Offline the finder cannot run at all — the over-credit guard needs every credit
     note raised against the invoice. It must say so and name the way through, not
     silently drop the cashier into a different kind of return than they asked for. */
  const creditOffline = press('credit-sale', { online: false })
  ok(
    '  offline it says so and names the no-receipt path',
    creditOffline.some(
      (c) =>
        c.name === 'say' &&
        /connection/i.test(String((c.arg as any).message)) &&
        /refund/i.test(String((c.arg as any).message)),
    ),
    JSON.stringify(creditOffline),
  )
  ok(
    '  and opens nothing offline',
    creditOffline.every((c) => c.name !== 'findReceipt'),
    JSON.stringify(creditOffline),
  )

  /* ── 4c. REFUND arms the next item, one press at a time ────────────────────
     A different act from the key above: no slip to find, one item handed back across
     the counter mid-sale. It lands on the SAME basket as a negative line, so the
     cashier rings the swap as one transaction with one total. */

  const arm = press('refund')
  ok(
    'the refund key arms the next item',
    arm.some((c) => c.name === 'armRefund' && c.arg === true),
    JSON.stringify(arm),
  )
  /* Pressing it again is the escape. A cashier who armed by mistake must not have to
     credit something to get out of it. */
  const disarm = press('refund', { refundArmed: true })
  ok(
    '  and pressing it again disarms',
    disarm.some((c) => c.name === 'armRefund' && c.arg === false),
    JSON.stringify(disarm),
  )
  /* THE property the whole feature rests on. SET_RETURNING empties the basket; arming
     must not, because the sale in progress is precisely what the refund is joining. */
  const armMidSale = press('refund', { hasLines: true })
  ok(
    '*** and it never clears a half-scanned basket ***',
    armMidSale.every((c) => c.name !== 'startReturn' && c.name !== 'clear'),
    JSON.stringify(armMidSale),
  )
  /* Offline it still works, unlike credit-sale. Nothing is asked of the server: the
     goods are in front of the cashier and the price is on the cached catalogue. That
     is what makes it the honest thing for the offline refusal above to point at. */
  const armOffline = press('refund', { online: false })
  ok(
    '  and it works offline, which is what the credit-sale refusal points at',
    armOffline.some((c) => c.name === 'armRefund' && c.arg === true),
    JSON.stringify(armOffline),
  )
  /* Inside return mode every line already goes back. Arming one more would flip that
     line positive and sell the customer something mid-return. */
  const armInReturn = press('refund', { returning: true, hasLines: true })
  ok(
    '  and it refuses inside return mode rather than inverting a line',
    armInReturn.every((c) => c.name !== 'armRefund') &&
      armInReturn.some((c) => c.name === 'say'),
    JSON.stringify(armInReturn),
  )

  /* ── 5. A missing capability refuses before anything happens ─────────────── */

  const refused = press('void-sale', { can: () => false } as Partial<RunContext>, 'sales.till')
  ok(
    'a key whose capability is missing says so rather than acting',
    refused.length > 0 && refused.every((c) => c.name === 'say'),
    JSON.stringify(refused),
  )
  /* And the converse, so the check above cannot pass by refusing everything: the same
     key with the capability granted ACTS. */
  const allowed = press('void-sale', { can: () => true } as Partial<RunContext>, 'sales.till')
  ok(
    '  and acts when the capability is granted',
    allowed.some((c) => c.name !== 'say'),
    JSON.stringify(allowed),
  )

  /* ── 6. A hospitality key on a retail till blames the SETUP, not the build ─
     Order matters: telling somebody a feature is unbuilt when really their shop is not
     set up for it sends them to the wrong place. */

  const hospitalityAction = QUICK_KEY_ACTIONS.find((a) => a.hospitalityOnly)
  if (hospitalityAction) {
    const retail = press(hospitalityAction.slug, { hospitality: false })
    ok(
      'a tables key on a retail till points at Setup, not at a release note',
      retail.some((c) => c.name === 'say' && /setup|tables/i.test(String((c.arg as any).message))),
      JSON.stringify(retail),
    )
  }

  console.log(fails === 0 ? '\nAll quick-key runner checks passed.' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
