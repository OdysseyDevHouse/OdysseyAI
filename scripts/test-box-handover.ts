/**
 * Handing a finalised sale from the till to the shop's box.
 *
 * The rule under test: a sale is pending in EXACTLY ONE queue, and the till
 * knows which. Both ways of getting that wrong cost real money —
 *
 *   · Left in both, the till's pending count double-counts takings and a
 *     manager cashes up against a figure that is wrong. The books stay right
 *     (the cloud claims on the uid) but the number a person acts on does not.
 *   · Dropped from both, a customer holds a tax invoice for a sale nothing
 *     recorded. That one is unrecoverable.
 *
 * `offerToBox` is pure network handling, so `fetch` is stubbed: a real box
 * cannot be made to return HTML, time out and 401 on demand, and those are
 * exactly the answers the rule has to survive.
 *
 *   npx tsx scripts/test-box-handover.ts
 */
import { offerToBox } from '../src/lib/posOffline/boxQueue'
import type { OfflineSale } from '../src/lib/posOffline/types'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sale = {
  saleUid: 'aaaaaaaa-0000-4000-8000-00000000000a',
  documentNumber: 'INV_01_01_000042',
  lines: [],
  tenders: [],
} as unknown as OfflineSale

/** Stands in for one answer from the box. */
function stubFetch(impl: () => Promise<Response> | never) {
  ;(globalThis as { fetch: unknown }).fetch = impl as unknown
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

async function main() {
  console.log('\nHanding a sale to the box\n')

  /* ── The box takes it ──────────────────────────────────────────────────── */

  stubFetch(async () => jsonResponse(200, { ok: true, duplicate: false, pending: 3 }))
  const taken = await offerToBox(sale)
  check('an accepted sale is taken', taken.taken)
  check('  and reports the queue depth', taken.taken && taken.pending === 3)

  /* A retry after a timeout is the ordinary shape of a flaky LAN. The box
     already has the sale, so the device must still let go of it — treating a
     duplicate as failure would leave it pending in both queues. */
  stubFetch(async () => jsonResponse(200, { ok: true, duplicate: true, pending: 3 }))
  const dupe = await offerToBox(sale)
  check('*** a duplicate is still TAKEN ***', dupe.taken)
  check('  and says so', dupe.taken && dupe.duplicate)

  /* ── Everything else means the device keeps it ─────────────────────────── */

  /* A lapsed session is not the sale's fault, and 409 means this site has no
     box. Both have the same right answer: the device delivers it the way every
     other till does. */
  for (const status of [401, 409, 500, 503]) {
    stubFetch(async () => jsonResponse(status, { error: 'nope' }))
    const r = await offerToBox(sale)
    check(`a ${status} leaves the sale with the till`, !r.taken)
  }

  /* A 200 that is not JSON is a proxy or a cached login page, not an answer. */
  stubFetch(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('Unexpected token <')
        },
      }) as unknown as Response,
  )
  check('HTML dressed as a 200 is not an acceptance', !(await offerToBox(sale)).taken)

  /* ok:false with a 200 — a box that answered but declined. */
  stubFetch(async () => jsonResponse(200, { ok: false }))
  check('a 200 that does not say ok is not an acceptance', !(await offerToBox(sale)).taken)

  /* The box is off, the cable is out, DNS is wrong. */
  stubFetch(async () => {
    throw new Error('Failed to fetch')
  })
  const dead = await offerToBox(sale)
  check('*** an unreachable box leaves the sale with the till ***', !dead.taken)
  check('  with a reason for the log', !dead.taken && dead.reason.length > 0)

  /* THE one that must never throw. finaliseOffline calls this after the sale is
     already recorded and printed; an exception escaping here would surface as a
     failed sale to a cashier holding the customer's money. */
  let threw = false
  stubFetch(() => {
    throw new Error('synchronous explosion')
  })
  try {
    const r = await offerToBox(sale)
    check('*** a synchronous throw is caught, not propagated ***', !r.taken)
  } catch {
    threw = true
  }
  check('  offerToBox never throws', !threw)

  console.log(`\n${failures === 0 ? 'The handover holds.' : `${failures} FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n  ${err?.message || err}\n`)
  process.exit(1)
})
