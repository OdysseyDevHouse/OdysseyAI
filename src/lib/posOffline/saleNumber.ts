'use client'

import { formatNumber } from '../numberFormat'
import { KV } from './db'
import { kvGet, kvPut } from './store'

/**
 * Numbering a sale with no server.
 *
 * ── WHY THIS IS POSSIBLE AT ALL ───────────────────────────────────────────
 *
 * Because the store is on PER-TILL numbering. This till owns its own sequence, so
 * it can advance it locally and no other till can collide with it — there is no
 * shared cursor to coordinate over. That is the whole reason per-till was chosen:
 * a pocket of pre-reserved numbers runs out, and a till offline for hours needs a
 * runway that does not.
 *
 * ── THE SEED RULE: HIGHER, NEVER LOWER ────────────────────────────────────
 *
 * The counter is seeded from the server on every catalog refresh, and only ever
 * moves FORWARD:
 *
 *     counter = max(serverNextNumber - 1, localCounter)
 *
 * The `max` is not defensive tidiness. A till with unsynced sales is AHEAD of what
 * the server knows — the server's `next_number` has not seen them yet — so taking
 * the server's figure would hand out numbers this till has already printed on
 * customers' slips. Two different sales under one invoice number is the one
 * outcome the whole numbering design exists to prevent, and offline there is no
 * unique index to catch it.
 */

export type LocalSequence = {
  terminalId: number
  /** The doc-type prefix, e.g. 'INV'. */
  prefix: string
  storeNumber: string
  tillNumber: string
  padding: number
  /** Yearly-reset key, or null. Carried so the shape matches the server's. */
  periodKey: string | null
  /** The last counter this till SPENT. The next sale is this + 1. */
  counter: number
}

/**
 * Seeds or advances the local sequence from the server.
 *
 * Idempotent and seed-if-higher, so calling it on every catalog refresh is safe.
 * `serverNextNumber` is what the server would issue NEXT, so the last one it
 * knows about is one less.
 */
/**
 * Which of this till's sequences a call means.
 *
 * Two, not one: a credit note that consumed an invoice number would leave a gap in the
 * invoice register that nothing explains, and `verifySequence` would report it as a
 * missing sale. Every function below takes this rather than being duplicated per
 * sequence — the seed-if-higher rule, the burn-on-crash rule and the release rule are
 * identical for both, and a second copy is a second place for them to drift.
 */
export type SequenceKind = 'sale' | 'return'

const KEY_FOR: Record<SequenceKind, string> = {
  sale: KV.numberSeq,
  return: KV.creditNumberSeq,
}

export async function seedSequence(
  siteId: number,
  seed: Omit<LocalSequence, 'counter'> & { serverNextNumber: number },
  kind: SequenceKind = 'sale',
): Promise<void> {
  const key = KEY_FOR[kind]
  const existing = await kvGet<LocalSequence>(siteId, key)
  const serverLast = Math.max(0, Math.trunc(seed.serverNextNumber) - 1)

  await kvPut(siteId, key, {
    terminalId: seed.terminalId,
    prefix: seed.prefix,
    storeNumber: seed.storeNumber,
    tillNumber: seed.tillNumber,
    padding: seed.padding,
    periodKey: seed.periodKey,
    // NEVER lower. See the module note.
    counter: Math.max(existing?.counter ?? 0, serverLast),
  } satisfies LocalSequence)
}

/** Whether this till can number a sale — or a return — offline at all. */
export async function hasSequence(
  siteId: number,
  kind: SequenceKind = 'sale',
): Promise<boolean> {
  return (await kvGet<LocalSequence>(siteId, KEY_FOR[kind])) !== null
}

/**
 * Takes the next number for this till.
 *
 * Advances the stored counter BEFORE returning, so a crash between numbering and
 * printing burns a number rather than reusing one. A burnt number is an
 * explainable gap; a reused one is two sales under one invoice number.
 *
 * Returns null when the till has no sequence — which means it has never been
 * online, or the store is not on per-till numbering. The caller must refuse the
 * sale rather than invent something.
 */
export async function nextLocalNumber(
  siteId: number,
  kind: SequenceKind = 'sale',
): Promise<{ documentNumber: string; counter: number } | null> {
  const key = KEY_FOR[kind]
  const seq = await kvGet<LocalSequence>(siteId, key)
  if (!seq) return null

  const counter = seq.counter + 1
  await kvPut(siteId, key, { ...seq, counter } satisfies LocalSequence)

  return {
    // The SAME formatter the server uses, so an offline number and an online one
    // are indistinguishable in shape. A second implementation here is how
    // INV_01_02_000097 and INV_01_2_97 end up in one invoice register.
    documentNumber: formatNumber(seq.prefix, counter, seq.padding, seq.periodKey, {
      store: seq.storeNumber,
      till: seq.tillNumber,
    }),
    counter,
  }
}

/**
 * Hands a number back, when the sale it was taken for never happened.
 *
 * Only safe for the number most recently issued, and only if nothing has printed
 * since — which is why it takes the counter it expects to be undoing and refuses
 * otherwise. A cancelled sale whose slip already printed must BURN its number: the
 * customer may be holding it, and reissuing it would put two sales under one.
 */
export async function releaseLocalNumber(
  siteId: number,
  counter: number,
  kind: SequenceKind = 'sale',
): Promise<boolean> {
  const key = KEY_FOR[kind]
  const seq = await kvGet<LocalSequence>(siteId, key)
  if (!seq || seq.counter !== counter) return false
  await kvPut(siteId, key, { ...seq, counter: counter - 1 } satisfies LocalSequence)
  return true
}
