import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import type { Capability } from './permissions'

/**
 * API keys — what lets an outside program read this store over /api/v1.
 *
 * ── THE KEY FORMAT SOLVES THE ROUTING PROBLEM ────────────────────────────
 *
 * Keys live in each site's own database, but a bare bearer token carries no
 * hint of which database to check. So the raw key embeds the site id:
 *
 *   odk_<siteId>_<prefix8>_<secret>
 *
 * The verifier parses the site id, opens that one site's DB, looks the row up
 * by prefix, and compares SHA-256 hashes in constant time. A guessed or
 * foreign site id simply fails the hash compare — the id routes, it never
 * authorises.
 *
 * Hash-only storage (the password-reset doctrine): the raw key is shown once
 * at creation and the row keeps only its SHA-256.
 *
 * ── READ-ONLY, DELIBERATELY ──────────────────────────────────────────────
 *
 * Every write path in this app runs through actor-attributed, capability-
 * guarded flows with heavy invariants. Exposing writes behind a machine key
 * means idempotency keys and synthetic actors — a real design job nothing
 * needs yet. Integrations read; mutations arrive by webhook + back office.
 */

export const API_SCOPES = [
  'products:read',
  'customers:read',
  'sales:read',
  'stock:read',
  'suppliers:read',
  'purchases:read',
  'gl:read',
  'gift-cards:read',
  'reports:run',
] as const
export type ApiScope = (typeof API_SCOPES)[number]

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value)
}

/**
 * What each scope lets the report engine (and field stripping) see.
 *
 * The retail scopes NEVER grant products.cost or reports.financial: a key is
 * standing access with no person behind it, and the engine already hides cost
 * and margin columns from callers without those — exactly the junior-user
 * treatment a key deserves.
 *
 * The two exceptions are scopes whose entire subject matter IS cost data,
 * granted by their own names so the mint screen says exactly what is being
 * handed over: purchases:read (supplier invoices carry cost prices — that is
 * what a purchase document is) and gl:read (the journal export an accounting
 * sync exists for; it carries reports.financial, so a key holding it plus
 * reports:run can also run financial reports — deliberate, that is the same
 * data by another door). reports:run ALONE still sees neither.
 */
const SCOPE_CAPABILITIES: Record<ApiScope, Capability[]> = {
  'products:read': ['products.view'],
  'customers:read': ['customers.view'],
  'sales:read': ['sales.view'],
  'stock:read': ['stock.view'],
  'suppliers:read': ['suppliers.view'],
  'purchases:read': ['purchasing.view'],
  'gl:read': ['reports.financial'],
  'gift-cards:read': ['giftcards.view'],
  'reports:run': ['reports.view'],
}

export function capabilityFnFor(scopes: ReadonlySet<ApiScope>): (c: Capability) => boolean {
  const granted = new Set<Capability>()
  for (const scope of scopes) for (const cap of SCOPE_CAPABILITIES[scope]) granted.add(cap)
  return (c) => granted.has(c)
}

export function sha256hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export type ApiKeySummary = {
  id: number
  name: string
  keyPrefix: string
  scopes: ApiScope[]
  createdBy: string
  createdAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date | null
  /** Computed in the database, where NOW() and expires_at share a clock. */
  expired: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapKey(r: Row): ApiKeySummary {
  return {
    id: Number(r.id),
    name: String(r.name),
    keyPrefix: String(r.key_prefix),
    scopes: String(r.scopes).split(',').filter(isApiScope),
    createdBy: String(r.created_by ?? ''),
    createdAt: (r.created_at as Date | null) ?? null,
    lastUsedAt: (r.last_used_at as Date | null) ?? null,
    revokedAt: (r.revoked_at as Date | null) ?? null,
    expiresAt: (r.expires_at as Date | null) ?? null,
    expired: Number(r.expired ?? 0) === 1,
  }
}

export async function listApiKeys(siteId: number): Promise<ApiKeySummary[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at, expires_at,
            (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
       FROM api_keys ORDER BY id DESC`,
  )
  return rows.map(mapKey)
}

export async function createApiKey(
  siteId: number,
  actor: { userName: string },
  input: { name: string; scopes: ApiScope[]; expiresInDays?: number | null },
): Promise<{ ok: true; id: number; rawKey: string } | { ok: false; error: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the key a name — the integration it belongs to.' }
  const scopes = [...new Set(input.scopes)].filter(isApiScope)
  if (scopes.length === 0) return { ok: false, error: 'Pick at least one scope.' }
  // Optional self-destruct: 1 day to 5 years out; null/absent means standing.
  const expiresInDays =
    input.expiresInDays == null ? null : Math.round(Number(input.expiresInDays))
  if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 1826)) {
    return { ok: false, error: 'Expiry must be between 1 day and 5 years.' }
  }

  // Retry on the (astronomically unlikely) prefix collision rather than
  // failing a legitimate creation on cosmic bad luck.
  for (let attempt = 0; attempt < 3; attempt++) {
    const prefix = randomBytes(6).toString('base64url').slice(0, 8)
    const secret = randomBytes(24).toString('base64url')
    const rawKey = `odk_${siteId}_${prefix}_${secret}`
    try {
      const result = await siteExecute(
        siteId,
        `INSERT INTO api_keys (name, key_prefix, token_hash, scopes, created_by, expires_at)
         VALUES (?,?,?,?,?, ${expiresInDays === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? DAY)'})`,
        [
          name.slice(0, 80),
          prefix,
          sha256hex(rawKey),
          scopes.join(','),
          actor.userName.slice(0, 120),
          ...(expiresInDays === null ? [] : [expiresInDays]),
        ],
      )
      return { ok: true, id: Number(result.insertId), rawKey }
    } catch (error) {
      const dup = error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ER_DUP_ENTRY'
      if (!dup) throw error
    }
  }
  return { ok: false, error: 'Could not mint a unique key. Try again.' }
}

export async function revokeApiKey(
  siteId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await siteExecute(
    siteId,
    'UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL',
    [id],
  )
  if (result.affectedRows === 0) return { ok: false, error: 'That key is already revoked, or gone.' }
  return { ok: true }
}

export type VerifiedKey = {
  ok: true
  siteId: number
  keyId: number
  name: string
  scopes: ReadonlySet<ApiScope>
}

/**
 * Parses and verifies a raw key. Never throws: a malformed key, an unknown
 * site, an unreachable database and a wrong secret all come back as the same
 * uniform refusal, so the response leaks nothing about which part failed.
 */
export async function verifyApiKey(
  rawKey: string,
): Promise<VerifiedKey | { ok: false; status: 401; error: string }> {
  const refused = { ok: false as const, status: 401 as const, error: 'Invalid API key.' }
  try {
    const match = /^odk_(\d{1,10})_([A-Za-z0-9_-]{8})_[A-Za-z0-9_-]{20,}$/.exec(rawKey)
    if (!match) return refused
    const siteId = Number(match[1])
    const prefix = match[2]

    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT id, name, token_hash, scopes, revoked_at,
              (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
         FROM api_keys WHERE key_prefix = ? LIMIT 1`,
      [prefix],
    )
    if (!row) return refused

    const stored = Buffer.from(String(row.token_hash), 'utf8')
    const presented = Buffer.from(sha256hex(rawKey), 'utf8')
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return refused
    if (row.revoked_at !== null) return refused
    // Expiry compared in the database, so app-server clock drift cannot
    // resurrect a key; the refusal is the same uniform 401 as everything else.
    if (Number(row.expired) === 1) return refused

    return {
      ok: true,
      siteId,
      keyId: Number(row.id),
      name: String(row.name),
      scopes: new Set(String(row.scopes).split(',').filter(isApiScope)),
    }
  } catch {
    return refused
  }
}

/* In-process throttle so a busy key stamps once a minute, not per request. */
const globalStamp = globalThis as unknown as { __apiKeyTouched?: Map<string, number> }
const touched = (globalStamp.__apiKeyTouched ??= new Map())

/** Fire-and-forget last_used_at stamp. */
export function touchLastUsed(siteId: number, keyId: number): void {
  const key = `${siteId}:${keyId}`
  const now = Date.now()
  const last = touched.get(key) ?? 0
  if (now - last < 60_000) return
  touched.set(key, now)
  void siteExecute(siteId, 'UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [keyId]).catch(
    () => undefined,
  )
}
