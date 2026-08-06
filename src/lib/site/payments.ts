import 'server-only'
import { randomBytes } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { encryptSecret, tryDecryptSecret, encryptionKeyConfigured } from '../crypto/secrets'

/**
 * Store payments: the gateway a store has connected, and every attempt to pay
 * it.
 *
 * ── WHAT MAY MARK MONEY RECEIVED ─────────────────────────────────────────
 *
 * Exactly one thing: `settleIntent`, called from the verified webhook. Not the
 * shopper's browser, not a return URL, not a success page. Everything else in
 * this module either sets up a payment or reads its state.
 *
 * ── IDEMPOTENCY IS A WHERE CLAUSE ────────────────────────────────────────
 *
 * Gateways retry and duplicate. Settlement is `UPDATE … WHERE status =
 * 'pending'`, so a replayed callback updates zero rows and the caller can tell
 * the difference between "settled it" and "it was already settled". Without
 * that, a retry writes a second invoice for one payment.
 */

type Row = RowDataPacket & Record<string, unknown>

export type PaymentProvider = 'payfast'
export type IntentStatus = 'pending' | 'paid' | 'failed' | 'cancelled'

export type GatewayConfig = {
  id: number
  provider: PaymentProvider
  isActive: boolean
  isSandbox: boolean
  merchantId: string
  /** Decrypted. Never send this to a browser. */
  merchantKey: string
  /** Decrypted. Never leaves the server, not even inside a form. */
  passphrase: string
  /**
   * False when the stored secrets could not be decrypted — usually a changed
   * or missing ENCRYPTION_KEY. Surfaced rather than thrown, so the Setup
   * screen can explain it instead of the store discovering it at checkout.
   */
  credentialsUsable: boolean
  updatedBy: string
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/* ── The connected gateway ────────────────────────────────────────────────── */

export async function getGateway(
  siteId: number,
  provider: PaymentProvider = 'payfast',
): Promise<GatewayConfig | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM payment_gateways WHERE provider = ? LIMIT 1`,
    [provider],
  )
  if (!row) return null

  const merchantKey = tryDecryptSecret(String(row.merchant_key ?? '') || null)
  const passphrase = tryDecryptSecret(String(row.passphrase ?? '') || null)

  return {
    id: Number(row.id),
    provider: String(row.provider) as PaymentProvider,
    isActive: !!row.is_active,
    isSandbox: !!row.is_sandbox,
    merchantId: String(row.merchant_id ?? ''),
    merchantKey: merchantKey ?? '',
    passphrase: passphrase ?? '',
    // An empty stored passphrase is legitimate (PayFast allows it), so a null
    // from tryDecrypt only counts as failure when there was something to
    // decrypt in the first place.
    credentialsUsable: merchantKey !== null && passphrase !== null,
    updatedBy: String(row.updated_by ?? ''),
  }
}

/**
 * Can this store actually take money right now?
 *
 * The question the Setup screen asks before allowing "pay online", and the one
 * checkout asks before offering it. Deliberately strict: anything short of a
 * complete, decryptable, active configuration is a no.
 */
export async function canTakePayments(siteId: number): Promise<boolean> {
  const gateway = await getGateway(siteId)
  return Boolean(
    gateway?.isActive &&
      gateway.credentialsUsable &&
      gateway.merchantId &&
      gateway.merchantKey,
  )
}

export type GatewayInput = {
  isActive: boolean
  isSandbox: boolean
  merchantId: string
  /** Plaintext from the form. Encrypted before it touches the database. */
  merchantKey: string
  passphrase: string
}

export async function saveGateway(
  siteId: number,
  input: GatewayInput,
  updatedBy: string,
  provider: PaymentProvider = 'payfast',
): Promise<SaveResult> {
  // Storing a payment credential in plaintext because the key is missing would
  // be worse than refusing, and the refusal is recoverable.
  if (!encryptionKeyConfigured()) {
    return {
      ok: false,
      error: 'ENCRYPTION_KEY is not set, so payment credentials cannot be stored safely.',
    }
  }

  const merchantId = input.merchantId.trim()
  const merchantKey = input.merchantKey.trim()

  if (input.isActive) {
    if (!merchantId) return { ok: false, error: 'Enter your merchant ID.' }
    if (!merchantKey) return { ok: false, error: 'Enter your merchant key.' }
    if (!/^\d+$/.test(merchantId)) {
      return { ok: false, error: 'A PayFast merchant ID is all digits.' }
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO payment_gateways
       (provider, is_active, is_sandbox, merchant_id, merchant_key, passphrase, updated_by)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       is_active = VALUES(is_active), is_sandbox = VALUES(is_sandbox),
       merchant_id = VALUES(merchant_id), merchant_key = VALUES(merchant_key),
       passphrase = VALUES(passphrase), updated_by = VALUES(updated_by)`,
    [
      provider,
      input.isActive ? 1 : 0,
      input.isSandbox ? 1 : 0,
      merchantId,
      merchantKey ? encryptSecret(merchantKey) : '',
      input.passphrase.trim() ? encryptSecret(input.passphrase.trim()) : '',
      updatedBy.slice(0, 120),
    ],
  )

  return { ok: true }
}

/* ── Intents ──────────────────────────────────────────────────────────────── */

export type PaymentIntent = {
  id: number
  reference: string
  provider: PaymentProvider
  purpose: 'online_order'
  targetId: number
  amountIncl: number
  status: IntentStatus
  providerRef: string
  failureReason: string
  createdAt: Date
  settledAt: Date | null
}

function mapIntent(r: Row): PaymentIntent {
  return {
    id: Number(r.id),
    reference: String(r.reference),
    provider: String(r.provider) as PaymentProvider,
    purpose: String(r.purpose) as 'online_order',
    targetId: Number(r.target_id),
    amountIncl: toNum(r.amount_incl),
    status: String(r.status) as IntentStatus,
    providerRef: String(r.provider_ref ?? ''),
    failureReason: String(r.failure_reason ?? ''),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(0),
    settledAt: r.settled_at instanceof Date ? r.settled_at : null,
  }
}

/**
 * A reference that cannot be guessed or enumerated.
 *
 * 144 bits of randomness rather than a sequence: this value is the hinge the
 * whole callback design turns on, and a predictable one would let an attacker
 * aim a forged callback at a real payment. It is also visible to the shopper
 * (PayFast echoes it), so it must reveal nothing about volume.
 */
function newReference(): string {
  return `ODY-${randomBytes(18).toString('base64url')}`
}

export async function createIntent(
  siteId: number,
  input: { targetId: number; amountIncl: number; purpose?: 'online_order' },
): Promise<PaymentIntent> {
  const reference = newReference()
  const amount = round(input.amountIncl, 2)

  await siteExecute(
    siteId,
    `INSERT INTO payment_intents (reference, provider, purpose, target_id, amount_incl)
     VALUES (?, 'payfast', ?, ?, ?)`,
    [reference, input.purpose ?? 'online_order', input.targetId, amount.toFixed(4)],
  )

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM payment_intents WHERE reference = ?`,
    [reference],
  )
  if (!row) throw new Error('Could not start the payment.')
  return mapIntent(row)
}

export async function getIntent(
  siteId: number,
  reference: string,
): Promise<PaymentIntent | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT * FROM payment_intents WHERE reference = ?`,
    [reference],
  )
  return row ? mapIntent(row) : null
}

export type SettleOutcome =
  | { outcome: 'settled'; intent: PaymentIntent }
  /** A retry or a duplicate. Correct and expected, not an error. */
  | { outcome: 'already_settled'; intent: PaymentIntent }
  | { outcome: 'failed'; intent: PaymentIntent }
  | { outcome: 'unknown_reference' }

/**
 * Record the outcome of a VERIFIED callback.
 *
 * Callers must have verified the payload first — this function trusts what it
 * is told, and is the only place that writes a paid state.
 *
 * The `WHERE status = 'pending'` is the idempotency guard: a replayed callback
 * matches zero rows and comes back as `already_settled`, so the caller knows
 * not to invoice the order a second time.
 */
export async function settleIntent(
  siteId: number,
  reference: string,
  result: {
    paid: boolean
    providerRef?: string
    failureReason?: string
    rawPayload?: string
  },
): Promise<SettleOutcome> {
  return siteTransaction(siteId, async (tx) => {
    const [existing] = await tx.query<RowDataPacket[]>(
      // Locked for the duration: two callbacks arriving together must not both
      // see 'pending' and both proceed.
      `SELECT * FROM payment_intents WHERE reference = ? FOR UPDATE`,
      [reference],
    )
    const row = existing[0] as Row | undefined
    if (!row) return { outcome: 'unknown_reference' as const }

    if (String(row.status) !== 'pending') {
      return { outcome: 'already_settled' as const, intent: mapIntent(row) }
    }

    const status: IntentStatus = result.paid ? 'paid' : 'failed'
    await tx.query(
      `UPDATE payment_intents
          SET status = ?, provider_ref = ?, failure_reason = ?,
              raw_payload = ?, settled_at = NOW()
        WHERE reference = ? AND status = 'pending'`,
      [
        status,
        (result.providerRef ?? '').slice(0, 64),
        (result.failureReason ?? '').slice(0, 190),
        result.rawPayload ?? null,
        reference,
      ],
    )

    const [after] = await tx.query<RowDataPacket[]>(
      `SELECT * FROM payment_intents WHERE reference = ?`,
      [reference],
    )
    const intent = mapIntent(after[0] as Row)
    return result.paid
      ? { outcome: 'settled' as const, intent }
      : { outcome: 'failed' as const, intent }
  })
}
