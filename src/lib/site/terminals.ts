import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'

/**
 * Tills, registered as master data.
 *
 * A bare terminal_id pointing at nothing is the trap this avoids: a manager
 * must be able to see every till in the store, revoke one, or move it to
 * another counter without touching the machine itself.
 *
 * A machine CLAIMS a terminal. In the desktop shell the claim can be offered
 * automatically from a stable machine id; in a browser the user picks from a
 * list. Either way the claim ends as a signed cookie that is RE-VALIDATED
 * server-side on every sale — the same reasoning as requireSite() re-checking
 * access on every call rather than trusting the token. A terminal deactivated
 * in setup stops working on the next sale, not at the next sign-in.
 */

export type Terminal = {
  id: number
  code: string
  /**
   * The till's number as it appears IN AN INVOICE NUMBER — '01', '02'.
   *
   * Null on a till that has not been given one, which is a real state rather than
   * a missing value: such a till cannot ring up a sale under per-till numbering,
   * and numberSegmentsFor() refuses rather than quietly numbering it from the
   * shared run. See sql/site/064_pos_numbering.sql.
   */
  tillNumber: string | null
  name: string
  location: string | null
  deviceId: string | null
  deviceLabel: string | null
  isActive: boolean
  claimedAt: Date | null
  lastSeenAt: Date | null
  /** Documents rung up on this till. Shown before offering to delete it. */
  documentCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapTerminal(r: Row): Terminal {
  return {
    id: Number(r.id),
    code: String(r.code),
    tillNumber: (r.till_number as string | null) ?? null,
    name: String(r.name),
    location: (r.location as string | null) ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    deviceLabel: (r.device_label as string | null) ?? null,
    isActive: !!r.is_active,
    claimedAt: (r.claimed_at as Date | null) ?? null,
    lastSeenAt: (r.last_seen_at as Date | null) ?? null,
    documentCount: Number(r.document_count ?? 0),
  }
}

const SELECT_TERMINAL = `
  SELECT t.id, t.code, t.till_number, t.name, t.location, t.device_id, t.device_label,
         t.is_active, t.claimed_at, t.last_seen_at,
         (SELECT COUNT(*) FROM sales_documents d WHERE d.terminal_id = t.id) AS document_count
    FROM terminals t
`

export async function listTerminals(
  siteId: number,
  includeInactive = true,
): Promise<Terminal[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TERMINAL} ${includeInactive ? '' : 'WHERE t.is_active = 1'} ORDER BY t.code ASC`,
  )
  return rows.map(mapTerminal)
}

export async function getTerminal(siteId: number, id: number): Promise<Terminal | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TERMINAL} WHERE t.id = ? LIMIT 1`, [id])
  return row ? mapTerminal(row) : null
}

/** Whichever terminal this machine already holds, so it need not be asked again. */
export async function terminalForDevice(
  siteId: number,
  deviceId: string,
): Promise<Terminal | null> {
  if (!deviceId.trim()) return null
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TERMINAL} WHERE t.device_id = ? LIMIT 1`, [
    deviceId.trim(),
  ])
  return row ? mapTerminal(row) : null
}

export type TerminalInput = {
  code: string
  name: string
  location?: string | null
  isActive?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

export function validateTerminal(input: TerminalInput): string | null {
  if (!input.code?.trim()) return 'A till code is required.'
  // The code prints on the slip and groups every report, so it has to be short
  // and predictable.
  if (!/^[A-Z0-9-]{2,24}$/.test(input.code.trim().toUpperCase())) {
    return 'Code must be 2–24 characters, letters, digits and hyphens only.'
  }
  if (!input.name?.trim()) return 'A name is required.'
  if (input.name.trim().length > 60) return 'Name must be 60 characters or fewer.'
  return null
}

export async function createTerminal(siteId: number, input: TerminalInput): Promise<SaveResult> {
  const invalid = validateTerminal(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<RowDataPacket & { id: number }>(
    siteId,
    'SELECT id FROM terminals WHERE code = ? LIMIT 1',
    [code],
  )
  if (clash) return { ok: false, error: `A till with code "${code}" already exists.` }

  /*
   * A till number, assigned rather than asked for.
   *
   * Under per-till numbering a terminal with no `till_number` cannot ring up a sale at
   * all — `numberSegmentsFor` refuses it, deliberately, because falling back to the
   * shared sequence would drop that till's invoice into the middle of the site-wide run
   * with nothing to say it had happened.
   *
   * So it cannot be optional here. A till created without one was DEAD: registered,
   * listed, and unable to sell. The owner can still rename it afterwards — the setup
   * screen owns that, and freezes it once the till has issued a document — but the
   * default has to be a working one.
   *
   * Lowest free number rather than max+1, so deleting till 02 of three and adding
   * another reuses 02 instead of climbing to 04. Both are defensible; this one keeps a
   * small shop's numbers small, which is what shows on every invoice.
   */
  const tillNo = await nextFreeTillNumber(siteId)

  const res = await siteExecute(
    siteId,
    'INSERT INTO terminals (code, name, location, till_number, is_active) VALUES (?,?,?,?,?)',
    [
      code,
      input.name.trim(),
      input.location?.trim() || null,
      tillNo,
      input.isActive === false ? 0 : 1,
    ],
  )

  /* Its own numbering sequence, so the till can allocate offline from the moment it is
     registered. Created here rather than lazily on first sale: a till discovering at
     07:00 that it has no sequence is a till that cannot trade, and the fix would need a
     database. */
  await siteExecute(
    siteId,
    `INSERT INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
     VALUES (?, 'invoice', 'INV', 1, 6)
     ON DUPLICATE KEY UPDATE doc_type = doc_type`,
    [res.insertId],
  ).catch(() => {
    // A missing sequence is recoverable — the setup screen can create one, and an
    // online sale still numbers site-wide. Failing the whole registration over it
    // would be worse than a till that needs one more click.
  })

  return { ok: true, id: res.insertId }
}

/**
 * The lowest two-digit till number nobody is using.
 *
 * Two digits because that is what the invoice number carries — `INV_01_02_000097` — and
 * a three-digit till would change the shape of every number issued after it. Ninety-nine
 * tills per store is not a limit any shop on this system will meet; if one ever does, the
 * number's width is a settings decision rather than something to silently overflow.
 */
async function nextFreeTillNumber(siteId: number): Promise<string> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT till_number FROM terminals WHERE till_number IS NOT NULL',
  )
  const taken = new Set(rows.map((r) => String(r.till_number)))
  for (let n = 1; n <= 99; n++) {
    const candidate = String(n).padStart(2, '0')
    if (!taken.has(candidate)) return candidate
  }
  /* Every two-digit number used. Returning a duplicate would collide on
     uq_terminal_till_number, so this hands back a three-digit one: a wider number is a
     visible oddity on an invoice, where a failed registration is a shop that cannot add
     a till at all. */
  return '100'
}

export async function updateTerminal(
  siteId: number,
  id: number,
  input: TerminalInput,
): Promise<SaveResult> {
  const invalid = validateTerminal(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getTerminal(siteId, id)
  if (!existing) return { ok: false, error: 'Till not found.' }

  const code = input.code.trim().toUpperCase()
  if (code !== existing.code) {
    const clash = await siteQueryOne<RowDataPacket & { id: number }>(
      siteId,
      'SELECT id FROM terminals WHERE code = ? AND id <> ? LIMIT 1',
      [code, id],
    )
    if (clash) return { ok: false, error: `A till with code "${code}" already exists.` }
  }

  await siteExecute(
    siteId,
    'UPDATE terminals SET code = ?, name = ?, location = ?, is_active = ? WHERE id = ?',
    [code, input.name.trim(), input.location?.trim() || null, input.isActive === false ? 0 : 1, id],
  )
  return { ok: true, id }
}

/**
 * Binds a machine to a till.
 *
 * Takes the claim off whatever machine held it before: replacing a broken till
 * PC is routine, and requiring a manager to release the old one first would
 * mean a shop cannot trade until someone finds the setup screen.
 */
export async function claimTerminal(
  siteId: number,
  id: number,
  deviceId: string,
  deviceLabel?: string | null,
): Promise<SaveResult> {
  if (!deviceId.trim()) return { ok: false, error: 'This machine has no identifier to register.' }

  const terminal = await getTerminal(siteId, id)
  if (!terminal) return { ok: false, error: 'Till not found.' }
  if (!terminal.isActive) {
    return { ok: false, error: `${terminal.name} is deactivated and cannot be used.` }
  }

  // device_id is UNIQUE, so the old holder must be released in the same breath.
  await siteExecute(siteId, 'UPDATE terminals SET device_id = NULL WHERE device_id = ?', [
    deviceId.trim(),
  ])
  await siteExecute(
    siteId,
    `UPDATE terminals
        SET device_id = ?, device_label = ?, claimed_at = NOW(), last_seen_at = NOW()
      WHERE id = ?`,
    [deviceId.trim(), deviceLabel?.trim()?.slice(0, 120) || null, id],
  )
  return { ok: true, id }
}

/** Frees a till so another machine can take it. */
export async function releaseTerminal(siteId: number, id: number): Promise<DeleteResult> {
  await siteExecute(
    siteId,
    'UPDATE terminals SET device_id = NULL, device_label = NULL, claimed_at = NULL WHERE id = ?',
    [id],
  )
  return { ok: true }
}

/**
 * Re-checks a claimed terminal, on every sale.
 *
 * Returns null when the terminal is gone or deactivated, so the caller refuses
 * the sale rather than posting it against a till nobody recognises. Touches
 * last_seen_at so the setup screen can show which tills are actually trading.
 */
export async function validateTerminalClaim(
  siteId: number,
  id: number,
): Promise<Terminal | null> {
  const terminal = await getTerminal(siteId, id)
  if (!terminal || !terminal.isActive) return null

  // Best-effort: a failed heartbeat must never fail the sale.
  try {
    await siteExecute(siteId, 'UPDATE terminals SET last_seen_at = NOW() WHERE id = ?', [id])
  } catch {
    /* ignore */
  }

  return terminal
}

/**
 * Deletes a till, but only when nothing was rung up on it.
 *
 * The FK from sales_documents is ON DELETE SET NULL, so deleting one in use
 * would quietly orphan every document it rang up — and "which register was
 * this?" would become unanswerable for that history.
 */
export async function deleteTerminal(siteId: number, id: number): Promise<DeleteResult> {
  const terminal = await getTerminal(siteId, id)
  if (!terminal) return { ok: false, error: 'Till not found.' }

  if (terminal.documentCount > 0) {
    return {
      ok: false,
      error: `${terminal.name} has ${terminal.documentCount} document${
        terminal.documentCount === 1 ? '' : 's'
      } against it. Deactivate it instead — deleting it would orphan that history.`,
    }
  }

  await siteExecute(siteId, 'DELETE FROM terminals WHERE id = ?', [id])
  return { ok: true }
}
