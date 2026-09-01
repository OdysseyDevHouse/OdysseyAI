import 'server-only'
import { portalConfig, send } from './portalApi'

/**
 * The buttons on the billing screen, over HTTPS.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * billingPortal made the Plan & billing screen READABLE on a desktop install.
 * That left a worse state than before: the screen rendered perfectly and every
 * button on it failed, because each one wrote over a MySQL socket the machine
 * cannot open. A page that looks healthy until you press something is a poorer
 * failure than one that says it cannot load.
 *
 * ── WHY A REFUSAL IS NOT null HERE ──────────────────────────────────────────
 *
 * The read clients return null for everything and let the caller fall back.
 * These cannot, and the difference is that these WRITE.
 *
 *   · `unreachable` -> null. Nothing happened, so the caller may try SQL. On a
 *     cloud install that succeeds; on a desktop it fails the same way it would
 *     have anyway, and the person sees one honest error.
 *   · `refused` -> a REFUSAL, carried back. "The Starter Pack cannot be
 *     removed" is an answer, and the person who clicked needs to read it.
 *     Falling back to SQL on a refusal would be worse than useless: it would
 *     re-attempt a write the portal has already declined, and on a cloud
 *     install it might even succeed — quietly routing around the rule.
 *
 * ── NOTHING HERE SENDS A PRICE ──────────────────────────────────────────────
 *
 * Every amount is derived by the portal from cp2_module_prices. The body says
 * WHAT to buy and for which store; it can never say what to pay.
 */

export type WriteOutcome =
  /** The portal did it. */
  | { ok: true }
  /** The portal answered, and the answer was no. Show `error` to the person. */
  | { ok: false; error: string }
  /** No portal, no line, or not an answer. The caller should try SQL. */
  | null

/** Is there a portal to ask? Read per call so a test can flip the env. */
export function portalAvailable(): boolean {
  return portalConfig() !== null
}

type Actor = { name: string; email: string }

/** Everything these calls share: the actor label and the target store. */
function bodyFor(siteId: number, actor: Actor, extra: Record<string, unknown>) {
  return {
    siteId,
    /* A label for the change log, gated on nothing. The site key already proved
       which shop is asking; believing the client about its own staff would not
       be a permission check. */
    actorName: actor.name,
    actorEmail: actor.email,
    ...extra,
  }
}

async function post(path: string, body: unknown, what: string): Promise<WriteOutcome> {
  if (!portalAvailable()) return null

  const res = await send<{ ok: true }>('POST', path, body)
  if (res.ok) return { ok: true }

  if (res.reason === 'refused') {
    console.error(`[portal] ${what} refused (${res.code}): ${res.error}`)
    return { ok: false, error: res.error }
  }
  return null
}

/** Buy a module for a store on this account. */
export function addModule(
  siteId: number,
  moduleKey: string,
  actor: Actor,
): Promise<WriteOutcome> {
  return post('/billing/modules/add', bodyFor(siteId, actor, { moduleKey }), 'billing/modules/add')
}

/**
 * Schedule a module to end.
 *
 * Not a deletion: the shop has paid to the end of the period, so the portal ends
 * it at the billing anniversary and the module keeps working until then.
 */
export function scheduleRemoval(
  siteId: number,
  moduleKey: string,
  actor: Actor,
): Promise<WriteOutcome> {
  return post(
    '/billing/modules/remove',
    bodyFor(siteId, actor, { moduleKey }),
    'billing/modules/remove',
  )
}

/** Undo a scheduled removal before it takes effect. */
export function cancelRemoval(
  siteId: number,
  moduleKey: string,
  actor: Actor,
): Promise<WriteOutcome> {
  return post(
    '/billing/modules/cancel-removal',
    bodyFor(siteId, actor, { moduleKey }),
    'billing/modules/cancel-removal',
  )
}

/**
 * Record how many till licences a store is buying.
 *
 * This does NOT create a licence. It records the order; payment confirms it and
 * provisioning happens on the gateway callback. Anything else would let a shop
 * licence tills for free by dragging a stepper.
 */
export function setRequestedDevices(
  siteId: number,
  requested: number,
  actor: Actor,
): Promise<WriteOutcome> {
  return post('/billing/devices', bodyFor(siteId, actor, { requested }), 'billing/devices')
}
