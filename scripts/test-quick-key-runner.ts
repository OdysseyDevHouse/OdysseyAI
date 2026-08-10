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
 */
import { QUICK_KEY_ACTIONS } from '../src/lib/quickKeys'
import { runQuickKey, type RunContext, type QuickKeyHandlers } from '../src/app/(pos)/pos/quickKeyRunner'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** Records which handler fired, and with what. */
function recorder() {
  const calls: { name: string; arg?: unknown }[] = []
  const handlers: QuickKeyHandlers = {
    say: (message: string, tone?: string) => calls.push({ name: 'say', arg: { message, tone } }),
    navigate: (to: string) => calls.push({ name: 'navigate', arg: to }),
    addProduct: (id: number) => calls.push({ name: 'addProduct', arg: id }),
    openDepartment: (id: number) => calls.push({ name: 'openDepartment', arg: id }),
    editLine: () => calls.push({ name: 'editLine' }),
    clear: () => calls.push({ name: 'clear' }),
    park: () => calls.push({ name: 'park' }),
    pickCustomer: () => calls.push({ name: 'pickCustomer' }),
    showSaved: () => calls.push({ name: 'showSaved' }),
    showOutbox: () => calls.push({ name: 'showOutbox' }),
    undo: () => calls.push({ name: 'undo' }),
  } as unknown as QuickKeyHandlers
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
     The assertion this file was written for. `/sales/new` is a redirect to `/pos` since
     phase 7 and the screen is deleted, so any message sending a cashier to "the desk
     till" sends them in a circle. Checked across every slug AND both connection states,
     because the offline branch is the one nobody looks at. */

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

  /* ── 3. Vouchers and points point at the tender pad ──────────────────────
     They are reachable — through Pay — so the message must say where, not "not yet". */

  const voucher = press('redeem-voucher')
  ok(
    'the voucher key points at the payment screen',
    voucher.some((c) => c.name === 'say' && /pay/i.test(String((c.arg as any).message))),
    JSON.stringify(voucher),
  )

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

  /* ── 4. Offline, neither pretends to work ────────────────────────────────
     Both need the server: a voucher is validated against it and points are a live
     balance. Saying so beats offering a tender that will be refused at the pad. */

  for (const slug of ['redeem-voucher', 'loyalty-payment']) {
    const offline = press(slug, { online: false })
    ok(
      `${slug} says it needs the connection when offline`,
      offline.some((c) => c.name === 'say' && /connection/i.test(String((c.arg as any).message))),
      JSON.stringify(offline),
    )
  }

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
