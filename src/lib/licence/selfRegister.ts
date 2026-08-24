import 'server-only'
import {
  claimSpot,
  deviceOffer,
  startTrial,
  takePaidSlot,
  type DeviceOffer,
  type SelfRegisterResult,
} from '@/lib/control/devices'
import {
  claimTerminal,
  createTerminal,
  listTerminals,
  terminalForDevice,
} from '@/lib/site/terminals'

/**
 * A machine putting itself into service.
 *
 * ── WHY THIS IS NOT IN devices.ts ───────────────────────────────────────────
 *
 * Because registering a till is two writes in two DIFFERENT databases, and
 * `devices.ts` only knows one of them. The licence is a row in `cp2_devices` in
 * the control database; the till it rings up as is a row in `terminals` in the
 * shop's own. Neither module may import the other's pool, so the act that needs
 * both lives here.
 *
 * ── AND WHY BOTH, RATHER THAN JUST THE LICENCE ──────────────────────────────
 *
 * A licensed machine with no till numbers its invoices from the shop-wide
 * sequence instead of its own. That is the exact fault `LicencesPanel` links the
 * two together to avoid, and it is worse when a machine registers itself,
 * because there is no supervisor at the keyboard to notice the picker was never
 * filled in. So the till is resolved here — reused, adopted, or created — and
 * the licence is written pointing at it.
 *
 * ── THE ORDER THE TWO WRITES HAPPEN IN ──────────────────────────────────────
 *
 * Licence first, till second, and the licence is updated to point at the till
 * once there is one. Deliberately that way round: if the second write fails, the
 * machine is left LICENSED with no till chosen — a state the setup screen
 * already recognises, already explains, and a supervisor can fix in one click.
 * The other order fails to a claimed till with no licence, which looks like
 * nothing happened at all and quietly consumes a terminal.
 */

/**
 * Take whatever the door is offering.
 *
 * The KIND is re-decided here rather than trusted from the client. The button
 * the browser drew was based on an offer computed before it was pressed, and a
 * client that asks for a trial when a paid slot is free — whether through a
 * stale screen or a hand-written request — must get the paid slot, not thirty
 * free days it was not entitled to choose.
 */
export async function registerThisMachine(
  siteId: number,
  serial: string,
  label: string,
  startedBy: string | null,
): Promise<SelfRegisterResult> {
  const trimmed = serial.trim()
  if (!trimmed) return { ok: false, error: 'This machine has no identifier to register.' }

  const offer = await deviceOffer(siteId, trimmed)

  let licence: SelfRegisterResult
  switch (offer.kind) {
    case 'paid':
      licence = await takePaidSlot(siteId, trimmed, label, null)
      break
    case 'trial':
      licence = await startTrial(siteId, trimmed, label, null, startedBy)
      break
    case 'none':
      return { ok: false, error: refusalFor(offer) }
  }
  if (!licence.ok) return licence

  /* From here the machine IS licensed. Everything below improves it, and a
     failure must therefore not undo it or report failure — see the docblock. */
  const terminalId = await resolveTerminal(siteId, trimmed, label).catch(() => null)
  if (terminalId !== null) {
    await claimSpot(siteId, licence.deviceRowId, trimmed, label, terminalId).catch(() => {
      /* The licence stands; only the link to the till is missing. Setup → Tills
         shows exactly this and offers the one click that fixes it. */
    })
  }

  return licence
}

function refusalFor(offer: Extract<DeviceOffer, { kind: 'none' }>): string {
  switch (offer.reason) {
    case 'no-serial':
      return 'This browser cannot be registered, because it is not allowed to store a device number. Use the desktop till, or allow site data for this address.'
    case 'trial-used':
      return offer.paidFor === 0
        ? 'This machine has already had its free trial. Contact Odyssey to buy a till licence.'
        : `This machine has already had its free trial, and all ${offer.paidFor} paid licences are in use. Free one under Setup → Tills, or contact Odyssey to buy another.`
  }
}

/**
 * Which till this machine rings up as.
 *
 * Three answers, in the order that does least damage:
 *
 *   1. THE ONE IT ALREADY HOLDS. A machine that has been a till before — its
 *      licence released and re-taken, say — keeps its own invoice sequence and
 *      its own number on every slip it has already printed.
 *   2. AN UNCLAIMED ACTIVE ONE. The shop registered tills before it registered
 *      machines, which is the ordinary way round. Adopting one is what a
 *      supervisor would have picked in the modal.
 *   3. A NEW ONE. Only when there is genuinely nothing to adopt. `createTerminal`
 *      issues the code and the till number itself, and creates the sequences, so
 *      the result can trade immediately rather than needing a second visit.
 *
 * Never STEALS a claimed till: taking one would silently move another machine's
 * invoice numbering onto this one, and two tills sharing a sequence is the fault
 * per-till numbering exists to prevent.
 */
async function resolveTerminal(
  siteId: number,
  serial: string,
  label: string,
): Promise<number | null> {
  const mine = await terminalForDevice(siteId, serial)
  if (mine) return mine.id

  const all = await listTerminals(siteId)
  const spare = all.find((t) => t.isActive && !t.deviceId)
  if (spare) {
    const claimed = await claimTerminal(siteId, spare.id, serial, label)
    return claimed.ok ? spare.id : null
  }

  /* NOT named after the machine. `terminals.name` is the shop's own master data
     — "Front counter", "Trade desk" — and it prints on slips and heads reports;
     "Chrome on Windows" sitting in that column reads as a fault. What the
     machine calls itself already has a home, `terminals.device_label`, which
     `claimTerminal` fills in below.

     "Till N" matches the code `createTerminal` issues alongside it (TILL01,
     TILL02) and the licence name `takePaidSlot` uses, so a shop that never
     renames anything still sees one consistent set of names. */
  const name = `Till ${all.length + 1}`

  /* ── THE CODE, AND WHY THERE IS A FALLBACK ────────────────────────────────
     A blank code is the RIGHT first try: `resolveMasterCode` turns it into the
     shop's next issued terminal code, which is the one a person would have got
     from the dialog, and keeps this machine inside the shop's own numbering.

     But it only does that when terminal auto-numbering is ON. With it off, a
     blank code stays blank and `createTerminal` refuses with "a till code is
     required" — correct for a form, useless here, where there is nobody to type
     one and the machine ends up licensed with no till.

     So a plain code is generated instead. Taken in order and stopped after a few
     attempts because `createTerminal` refuses a clash rather than overwriting
     one: the loop is skipping codes a shop already uses, not retrying a failure.
     Blank is tried first so the fallback never overrides a shop that HAS a
     numbering scheme. */
  for (const code of ['', ...Array.from({ length: 9 }, (_, i) => `POS${all.length + i + 1}`)]) {
    const created = await createTerminal(siteId, { code, name })
    if (!created.ok) continue
    const claimed = await claimTerminal(siteId, created.id, serial, label)
    return claimed.ok ? created.id : null
  }
  return null
}
