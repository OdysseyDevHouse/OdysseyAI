import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'

/**
 * The people at a customer or supplier.
 *
 * Distinct from the account's own email and phone, which stay on the customers
 * and suppliers rows. That column is where the BUSINESS is reached — the
 * address a statement run posts to. These are PEOPLE, who come and go. See the
 * header of 028_party_contacts_documents_comments.sql for why folding one into
 * the other would misdirect a statement run.
 *
 * One module for both parties because the two tables are identical in shape.
 * The party is a parameter rather than a copy-pasted second module, but the
 * TABLES stay separate with real foreign keys — a contact without its account
 * is not a record worth keeping, and CASCADE says so in the schema rather than
 * in whichever call site remembers.
 */

/** Which book the contact belongs to. Selects the table and the FK column. */
export type PartyKind = 'customer' | 'supplier'

export type PartyContact = {
  id: number
  partyId: number
  name: string
  role: string | null
  email: string | null
  phone: string | null
  notes: string | null
  isPrimary: boolean
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

export type ContactInput = {
  name: string
  role?: string | null
  email?: string | null
  phone?: string | null
  notes?: string | null
  isPrimary?: boolean
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type DeleteResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/**
 * The table and its foreign key, in one place.
 *
 * Every query below interpolates these into SQL. That is only safe because the
 * values come from this frozen map and never from a caller — PartyKind is a
 * union of two literals, so an unknown party cannot reach the string. Column
 * VALUES are still bound as parameters, always.
 */
const TABLES = {
  customer: { table: 'customer_contacts', fk: 'customer_id' },
  supplier: { table: 'supplier_contacts', fk: 'supplier_id' },
} as const

function mapContact(r: Row, fk: string): PartyContact {
  return {
    id: Number(r.id),
    partyId: Number(r[fk]),
    name: String(r.name),
    role: (r.role as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    isPrimary: !!r.is_primary,
    sortOrder: Number(r.sort_order),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

/**
 * One account's contacts, primary first then in display order.
 *
 * The primary sorts to the top here rather than being pulled out separately, so
 * a caller that just renders the list gets the right order for free.
 */
export async function listContacts(
  siteId: number,
  party: PartyKind,
  partyId: number,
): Promise<PartyContact[]> {
  const { table, fk } = TABLES[party]
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, ${fk}, name, role, email, phone, notes, is_primary, sort_order,
            created_at, updated_at
       FROM ${table}
      WHERE ${fk} = ?
      ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    [partyId],
  )
  return rows.map((r) => mapContact(r, fk))
}

/** Contacts for several accounts at once, grouped by account id. */
export async function listContactsFor(
  siteId: number,
  party: PartyKind,
  partyIds: number[],
): Promise<Map<number, PartyContact[]>> {
  const grouped = new Map<number, PartyContact[]>()
  if (partyIds.length === 0) return grouped

  const { table, fk } = TABLES[party]
  // Placeholders rather than a joined string: the ids are numbers here, but
  // binding them keeps this correct if that ever stops being true.
  const holes = partyIds.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, ${fk}, name, role, email, phone, notes, is_primary, sort_order,
            created_at, updated_at
       FROM ${table}
      WHERE ${fk} IN (${holes})
      ORDER BY is_primary DESC, sort_order ASC, id ASC`,
    partyIds,
  )

  for (const row of rows) {
    const contact = mapContact(row, fk)
    const list = grouped.get(contact.partyId)
    if (list) list.push(contact)
    else grouped.set(contact.partyId, [contact])
  }
  return grouped
}

/** Longest field lengths, matching the column widths in the migration. */
const LIMITS = { name: 120, role: 60, email: 190, phone: 40, notes: 400 } as const

export function validateContact(input: ContactInput): string | null {
  const name = input.name?.trim() ?? ''
  if (!name) return 'A contact needs a name.'
  if (name.length > LIMITS.name) return `A contact name is at most ${LIMITS.name} characters.`

  // A contact with neither an email nor a phone cannot be contacted, which is
  // the only thing this row exists to record. Rejecting it here beats a list
  // of names nobody can use.
  const email = input.email?.trim() ?? ''
  const phone = input.phone?.trim() ?? ''
  if (!email && !phone) return `Give ${name} an email address or a phone number.`

  // Deliberately loose: presence of @ with something either side. A stricter
  // pattern rejects addresses that are perfectly deliverable, and the real test
  // is whether mail arrives.
  if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) return `"${email}" is not a valid email address.`
  if (email.length > LIMITS.email) return `An email address is at most ${LIMITS.email} characters.`
  if (phone.length > LIMITS.phone) return `A phone number is at most ${LIMITS.phone} characters.`
  if ((input.role?.trim().length ?? 0) > LIMITS.role) {
    return `A role is at most ${LIMITS.role} characters.`
  }
  if ((input.notes?.trim().length ?? 0) > LIMITS.notes) {
    return `A contact note is at most ${LIMITS.notes} characters.`
  }
  return null
}

/**
 * Demotes every other contact when one is made primary.
 *
 * The "only one primary" rule lives here rather than in a unique index because
 * MariaDB has no partial index, and a plain UNIQUE (party, is_primary) would
 * cap an account at one non-primary contact — the opposite of the point. Every
 * write path that can set the flag calls this inside its own transaction.
 */
async function demoteOthers(
  tx: PoolConnection,
  party: PartyKind,
  partyId: number,
  keepId: number | null,
): Promise<void> {
  const { table, fk } = TABLES[party]
  await tx.execute(
    `UPDATE ${table} SET is_primary = 0
      WHERE ${fk} = ? AND is_primary = 1 AND id <> ?`,
    // -1 never matches a real auto-increment id, so "keep nobody" needs no
    // second statement.
    [partyId, keepId ?? -1] as never,
  )
}

export async function createContact(
  siteId: number,
  actor: Actor,
  party: PartyKind,
  partyId: number,
  input: ContactInput,
): Promise<SaveResult> {
  const invalid = validateContact(input)
  if (invalid) return { ok: false, error: invalid }

  const { table, fk } = TABLES[party]

  // The first contact on an account is its primary whether or not the form
  // said so. An account with contacts but no primary makes every "who do I
  // call" read fall back to nothing.
  const existing = await siteQueryOne<RowDataPacket & { n: number }>(
    siteId,
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${fk} = ?`,
    [partyId],
  )
  const isFirst = Number(existing?.n ?? 0) === 0
  const primary = input.isPrimary || isFirst

  return siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO ${table} (${fk}, name, role, email, phone, notes, is_primary, sort_order)
       VALUES (?,?,?,?,?,?,?, COALESCE((SELECT next_order FROM
         (SELECT MAX(sort_order) + 1 AS next_order FROM ${table} WHERE ${fk} = ?) AS t), 0))`,
      [
        partyId,
        input.name.trim(),
        input.role?.trim() || null,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        input.notes?.trim() || null,
        primary ? 1 : 0,
        partyId,
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    if (primary) await demoteOthers(tx, party, partyId, id)

    return { ok: true as const, id }
  }).then(async (result) => {
    if (result.ok) {
      await logActivity(siteId, actor, {
        entity: party,
        entityId: partyId,
        action: 'contact',
        detail: `Added contact ${input.name.trim()}`,
      })
    }
    return result
  })
}

export async function updateContact(
  siteId: number,
  actor: Actor,
  party: PartyKind,
  contactId: number,
  input: ContactInput,
): Promise<SaveResult> {
  const invalid = validateContact(input)
  if (invalid) return { ok: false, error: invalid }

  const { table, fk } = TABLES[party]
  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id, ${fk}, is_primary FROM ${table} WHERE id = ? LIMIT 1`,
    [contactId],
  )
  if (!existing) return { ok: false, error: 'That contact no longer exists.' }

  const partyId = Number(existing[fk])
  // Refusing to unset the last primary, rather than silently allowing an
  // account whose contacts have no default.
  const primary = input.isPrimary || !!existing.is_primary

  return siteTransaction(siteId, async (tx) => {
    await tx.execute(
      `UPDATE ${table}
          SET name = ?, role = ?, email = ?, phone = ?, notes = ?, is_primary = ?
        WHERE id = ?`,
      [
        input.name.trim(),
        input.role?.trim() || null,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        input.notes?.trim() || null,
        primary ? 1 : 0,
        contactId,
      ] as never,
    )

    if (primary) await demoteOthers(tx, party, partyId, contactId)

    return { ok: true as const, id: contactId }
  }).then(async (result) => {
    if (result.ok) {
      await logActivity(siteId, actor, {
        entity: party,
        entityId: partyId,
        action: 'contact',
        detail: `Updated contact ${input.name.trim()}`,
      })
    }
    return result
  })
}

/**
 * Removes a contact, promoting a replacement if it was the primary.
 *
 * Leaving an account with contacts but no primary is the state every read here
 * assumes cannot happen, so the promotion is part of the delete rather than a
 * cleanup job.
 */
export async function deleteContact(
  siteId: number,
  actor: Actor,
  party: PartyKind,
  contactId: number,
): Promise<DeleteResult> {
  const { table, fk } = TABLES[party]
  const existing = await siteQueryOne<Row>(
    siteId,
    `SELECT id, ${fk}, name, is_primary FROM ${table} WHERE id = ? LIMIT 1`,
    [contactId],
  )
  if (!existing) return { ok: false, error: 'That contact no longer exists.' }

  const partyId = Number(existing[fk])
  const wasPrimary = !!existing.is_primary
  const name = String(existing.name)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM ${table} WHERE id = ?`, [contactId] as never)

    if (wasPrimary) {
      await tx.execute(
        `UPDATE ${table} SET is_primary = 1
          WHERE ${fk} = ?
          ORDER BY sort_order ASC, id ASC
          LIMIT 1`,
        [partyId] as never,
      )
    }
  })

  await logActivity(siteId, actor, {
    entity: party,
    entityId: partyId,
    action: 'contact',
    detail: `Removed contact ${name}`,
  })

  return { ok: true }
}
