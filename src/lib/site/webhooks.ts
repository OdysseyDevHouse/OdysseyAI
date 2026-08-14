import 'server-only'
import { createHmac, randomBytes } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'

/**
 * Outbound webhooks — events this store pushes to other systems.
 *
 * ── ENQUEUE-THEN-DELIVER, NEVER SEND INLINE ──────────────────────────────
 *
 * A producer writes a delivery ROW (cheap, local, reliable) and the tick
 * route sends it later with retries. Sending inline from finaliseDocument
 * would put a stranger's slow server inside the hottest path in the app.
 * enqueueEvent NEVER throws — the GL-mirror doctrine: a missed webhook is a
 * delivery gap, not a reason to fail a sale that already committed.
 *
 * ── SIGNATURES ───────────────────────────────────────────────────────────
 *
 * Every delivery carries X-Odyssey-Signature: `t=<unix>,v1=<hex>` where v1 =
 * HMAC-SHA256(secret, `${t}.${body}`). The timestamp inside the signed
 * material stops replay-with-old-signature; receivers should refuse stale t.
 *
 * ── PAYLOADS ARE THIN ────────────────────────────────────────────────────
 *
 * Ids and the totals the counterpart already knows. Detail is fetched back
 * through /api/v1 with a key — which keeps PII out of third-party request
 * logs and makes a redelivery harmless.
 */

export const WEBHOOK_EVENTS = [
  'order.placed',
  'order.paid',
  'sale.finalised',
  'sale.voided',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value)
}

export type WebhookEndpoint = {
  id: number
  url: string
  secret: string
  events: WebhookEvent[]
  isActive: boolean
  createdAt: Date | null
  lastSuccessAt: Date | null
  lastFailureAt: Date | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapEndpoint(r: Row): WebhookEndpoint {
  return {
    id: Number(r.id),
    url: String(r.url),
    secret: String(r.secret),
    events: String(r.events).split(',').filter(isWebhookEvent),
    isActive: Boolean(r.is_active),
    createdAt: (r.created_at as Date | null) ?? null,
    lastSuccessAt: (r.last_success_at as Date | null) ?? null,
    lastFailureAt: (r.last_failure_at as Date | null) ?? null,
  }
}

export async function listEndpoints(siteId: number): Promise<WebhookEndpoint[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, url, secret, events, is_active, created_at, last_success_at, last_failure_at
       FROM webhook_endpoints ORDER BY id`,
  )
  return rows.map(mapEndpoint)
}

function validUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'The URL must be http(s).'
    }
    const host = parsed.hostname.toLowerCase()
    // Pushing signed shop data at loopback or link-local targets is either a
    // mistake or an SSRF probe; both deserve the same refusal.
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
      return 'The URL must be a reachable public address.'
    }
    return null
  } catch {
    return 'That is not a valid URL.'
  }
}

export async function createEndpoint(
  siteId: number,
  input: { url: string; events: WebhookEvent[] },
): Promise<{ ok: true; id: number; secret: string } | { ok: false; error: string }> {
  const url = input.url.trim()
  const urlError = validUrl(url)
  if (urlError) return { ok: false, error: urlError }
  const events = [...new Set(input.events)].filter(isWebhookEvent)
  if (events.length === 0) return { ok: false, error: 'Pick at least one event.' }

  const secret = randomBytes(24).toString('base64url')
  const result = await siteExecute(
    siteId,
    'INSERT INTO webhook_endpoints (url, secret, events) VALUES (?,?,?)',
    [url.slice(0, 500), secret, events.join(',')],
  )
  return { ok: true, id: Number(result.insertId), secret }
}

export async function updateEndpoint(
  siteId: number,
  id: number,
  input: { url: string; events: WebhookEvent[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = input.url.trim()
  const urlError = validUrl(url)
  if (urlError) return { ok: false, error: urlError }
  const events = [...new Set(input.events)].filter(isWebhookEvent)
  if (events.length === 0) return { ok: false, error: 'Pick at least one event.' }
  await siteExecute(siteId, 'UPDATE webhook_endpoints SET url = ?, events = ? WHERE id = ?', [
    url.slice(0, 500),
    events.join(','),
    id,
  ])
  return { ok: true }
}

export async function setEndpointActive(siteId: number, id: number, active: boolean): Promise<void> {
  await siteExecute(siteId, 'UPDATE webhook_endpoints SET is_active = ? WHERE id = ?', [
    active ? 1 : 0,
    id,
  ])
}

export async function rotateEndpointSecret(
  siteId: number,
  id: number,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const secret = randomBytes(24).toString('base64url')
  const result = await siteExecute(siteId, 'UPDATE webhook_endpoints SET secret = ? WHERE id = ?', [
    secret,
    id,
  ])
  if (result.affectedRows === 0) return { ok: false, error: 'Endpoint not found.' }
  return { ok: true, secret }
}

export async function deleteEndpoint(siteId: number, id: number): Promise<void> {
  // Deliveries cascade — the log dies with the endpoint it belongs to.
  await siteExecute(siteId, 'DELETE FROM webhook_endpoints WHERE id = ?', [id])
}

/* ── Signing and backoff (pure, exported for the test) ────────────────────── */

export function signPayload(secret: string, body: string, timestampSec: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSec}.${body}`, 'utf8').digest('hex')
  return `t=${timestampSec},v1=${v1}`
}

/** 1, 5, 30, 120, 720 minutes; anything past the ladder is dead. */
export function backoffMinutes(attempt: number): number {
  const LADDER = [1, 5, 30, 120, 720]
  return LADDER[Math.min(Math.max(attempt - 1, 0), LADDER.length - 1)]
}

const MAX_ATTEMPTS = 5

/* ── Enqueue ──────────────────────────────────────────────────────────────── */

async function subscribedEndpoints(siteId: number, event: WebhookEvent): Promise<Row[]> {
  return siteQuery<Row>(
    siteId,
    `SELECT id, events FROM webhook_endpoints WHERE is_active = 1`,
  ).then((rows) => rows.filter((r) => String(r.events).split(',').includes(event)))
}

/** Fans one event out to every subscribed endpoint. NEVER throws. */
export async function enqueueEvent(
  siteId: number,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const endpoints = await subscribedEndpoints(siteId, event)
    if (endpoints.length === 0) return
    const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), ...payload })
    for (const endpoint of endpoints) {
      await siteExecute(
        siteId,
        `INSERT INTO webhook_deliveries (endpoint_id, event, payload, next_attempt_at)
         VALUES (?,?,?,NOW())`,
        [Number(endpoint.id), event, body],
      )
    }
  } catch (error) {
    console.error('enqueueEvent failed (webhook dropped):', error)
  }
}

/**
 * Same, on a transaction handle — for producers whose event IS the commit
 * (an online order): the delivery row exists exactly when the order does.
 * This one MAY throw; it runs inside the caller's tx, where a throw is the
 * rollback both of them want.
 */
export async function enqueueEventTx(
  siteId: number,
  tx: PoolConnection,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const endpoints = await subscribedEndpoints(siteId, event)
  if (endpoints.length === 0) return
  const body = JSON.stringify({ event, occurredAt: new Date().toISOString(), ...payload })
  for (const endpoint of endpoints) {
    await tx.execute(
      `INSERT INTO webhook_deliveries (endpoint_id, event, payload, next_attempt_at)
       VALUES (?,?,?,NOW())`,
      [Number(endpoint.id), event, body] as never,
    )
  }
}

/* ── Delivery ─────────────────────────────────────────────────────────────── */

export type DeliverOutcome = { attempted: number; delivered: number; failed: number }

/**
 * Sends every due pending delivery for one site. Driven by the tick route;
 * fetchImpl injection exists so the test never touches the network.
 */
export async function deliverDue(
  siteId: number,
  opts: { fetchImpl?: typeof fetch; batch?: number } = {},
): Promise<DeliverOutcome> {
  const doFetch = opts.fetchImpl ?? fetch
  const batch = Math.min(Math.max(opts.batch ?? 50, 1), 200)

  const due = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.endpoint_id, d.event, d.payload, d.attempts,
            e.url, e.secret, e.is_active
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= NOW()
      ORDER BY d.id
      LIMIT ${batch}`,
  )

  let delivered = 0
  let failed = 0

  for (const row of due) {
    const deliveryId = Number(row.id)
    const attempts = Number(row.attempts) + 1

    // An endpoint switched off with work still queued: park the rows as dead
    // rather than hammering a URL the shop said to stop calling.
    if (!row.is_active) {
      await siteExecute(
        siteId,
        `UPDATE webhook_deliveries SET status = 'dead', last_error = 'Endpoint deactivated' WHERE id = ?`,
        [deliveryId],
      )
      failed++
      continue
    }

    const body = String(row.payload)
    const signature = signPayload(String(row.secret), body, Math.floor(Date.now() / 1000))

    let statusCode: number | null = null
    let errorText: string | null = null
    try {
      const response = await doFetch(String(row.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-odyssey-event': String(row.event),
          'x-odyssey-delivery': String(deliveryId),
          'x-odyssey-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      statusCode = response.status
      if (response.ok) {
        await siteExecute(
          siteId,
          `UPDATE webhook_deliveries
              SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL,
                  delivered_at = NOW()
            WHERE id = ?`,
          [attempts, statusCode, deliveryId],
        )
        await siteExecute(
          siteId,
          'UPDATE webhook_endpoints SET last_success_at = NOW() WHERE id = ?',
          [Number(row.endpoint_id)],
        )
        delivered++
        continue
      }
      errorText = `HTTP ${statusCode}`
    } catch (error) {
      errorText = error instanceof Error ? error.message : 'Request failed'
    }

    const dead = attempts >= MAX_ATTEMPTS
    await siteExecute(
      siteId,
      `UPDATE webhook_deliveries
          SET status = ?, attempts = ?, last_status_code = ?, last_error = ?,
              next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE id = ?`,
      [
        dead ? 'dead' : 'pending',
        attempts,
        statusCode,
        (errorText ?? 'failed').slice(0, 300),
        backoffMinutes(attempts),
        deliveryId,
      ],
    )
    await siteExecute(siteId, 'UPDATE webhook_endpoints SET last_failure_at = NOW() WHERE id = ?', [
      Number(row.endpoint_id),
    ])
    failed++
  }

  return { attempted: due.length, delivered, failed }
}

/* ── The log ──────────────────────────────────────────────────────────────── */

export type WebhookDelivery = {
  id: number
  endpointId: number
  endpointUrl: string
  event: string
  status: 'pending' | 'delivered' | 'dead'
  attempts: number
  nextAttemptAt: Date | null
  lastStatusCode: number | null
  lastError: string | null
  createdAt: Date | null
  deliveredAt: Date | null
}

export async function listDeliveries(
  siteId: number,
  opts: { endpointId?: number; status?: 'pending' | 'delivered' | 'dead'; limit?: number } = {},
): Promise<WebhookDelivery[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.endpointId) {
    where.push('d.endpoint_id = ?')
    params.push(opts.endpointId)
  }
  if (opts.status) {
    where.push('d.status = ?')
    params.push(opts.status)
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.endpoint_id, d.event, d.status, d.attempts, d.next_attempt_at,
            d.last_status_code, d.last_error, d.created_at, d.delivered_at, e.url
       FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY d.id DESC
      LIMIT ${limit}`,
    params,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    endpointId: Number(r.endpoint_id),
    endpointUrl: String(r.url),
    event: String(r.event),
    status: String(r.status) as WebhookDelivery['status'],
    attempts: Number(r.attempts),
    nextAttemptAt: (r.next_attempt_at as Date | null) ?? null,
    lastStatusCode: r.last_status_code === null ? null : Number(r.last_status_code),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: (r.created_at as Date | null) ?? null,
    deliveredAt: (r.delivered_at as Date | null) ?? null,
  }))
}

/** Puts one delivery (dead or delivered) back in the queue for another try. */
export async function redeliver(
  siteId: number,
  deliveryId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM webhook_deliveries WHERE id = ? LIMIT 1',
    [deliveryId],
  )
  if (!row) return { ok: false, error: 'Delivery not found.' }
  await siteExecute(
    siteId,
    `UPDATE webhook_deliveries
        SET status = 'pending', next_attempt_at = NOW(), attempts = 0, last_error = NULL
      WHERE id = ?`,
    [deliveryId],
  )
  return { ok: true }
}
