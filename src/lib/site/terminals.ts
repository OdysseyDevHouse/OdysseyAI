import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'
import { toPosMode, type PosMode } from '../posMode'

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
  /**
   * Which screen this till runs — retail counter, tables, or trade counter.
   *
   * PER TILL, not per shop, and that is the whole point of it living here. A
   * builders' merchant runs a wholesale trade desk and a retail front counter
   * in one company: with one answer per site, one of them is always on the
   * wrong screen. See sql/site/180_terminal_pos_mode.sql.
   */
  posMode: PosMode
  /**
   * The stock room this till sells OUT of. Null means the main location.
   *
   * NOT `location` above, which is free text naming where the machine stands.
   * This one is a real reference to `stock_locations`, and it decides which
   * pile a sale comes off and which pile the sell screen counts.
   *
   * Null is the ordinary single-room shop rather than a missing value: it is
   * resolved to main at the moment of the sale, by the same fallback
   * recordMovement has always applied. See sql/site/194_terminal_stock_location.sql.
   */
  stockLocationId: number | null
  /** That room's name, for a screen that has to say which one. Null when unset. */
  stockLocationName: string | null
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
    /* Through `toPosMode` rather than cast. The column is an ENUM so the
       database already constrains it, but a row read from a site whose
       migration has not run yet has no such column at all — and `undefined`
       cast to PosMode is a value every switch silently mishandles. This turns
       it into 'retail', which is a till that trades. */
    posMode: toPosMode(r.pos_mode),
    /* Null-checked rather than `Number(x) || null`: location id 0 does not
       exist, but the coercion would also swallow a genuine id if one ever did,
       and the explicit form says which state is being represented. */
    stockLocationId: r.stock_location_id === null ? null : Number(r.stock_location_id),
    stockLocationName: (r.stock_location_name as string | null) ?? null,
    deviceId: (r.device_id as string | null) ?? null,
    deviceLabel: (r.device_label as string | null) ?? null,
    isActive: !!r.is_active,
    claimedAt: (r.claimed_at as Date | null) ?? null,
    lastSeenAt: (r.last_seen_at as Date | null) ?? null,
    documentCount: Number(r.document_count ?? 0),
  }
}

const SELECT_TERMINAL = `
  SELECT t.id, t.code, t.till_number, t.name, t.location, t.pos_mode, t.device_id, t.device_label,
         t.stock_location_id, sl.name AS stock_location_name,
         t.is_active, t.claimed_at, t.last_seen_at,
         (SELECT COUNT(*) FROM sales_documents d WHERE d.terminal_id = t.id) AS document_count
    FROM terminals t
    LEFT JOIN stock_locations sl ON sl.id = t.stock_location_id
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
 * Which screen this till runs.
 *
 * ── ITS OWN FUNCTION, NOT A FIELD ON `updateTerminal` ─────────────────────
 *
 * `TerminalInput` is what the edit dialog collects — code, name, location,
 * active. The mode is set from the till's ROW, one control per till, because
 * that is where a manager comparing "which of my four tills runs what" is
 * looking. Folding it into the dialog would mean opening a modal per till to
 * answer a question that is really a column.
 *
 * More importantly, a partial save through `updateTerminal` would carry the
 * OTHER fields with it — and an action that writes a whole aggregate from a
 * screen holding only part of it is how sibling fields get wiped. One narrow
 * write, one column.
 */
export async function setTerminalPosMode(
  siteId: number,
  id: number,
  mode: PosMode,
): Promise<SaveResult> {
  const existing = await getTerminal(siteId, id)
  if (!existing) return { ok: false, error: 'Till not found.' }

  /* Normalised rather than trusted. The value crosses a server-action
     boundary, so it is a string from the client until something proves
     otherwise, and an unrecognised one must become a till that trades rather
     than a column write the ENUM rejects at the driver. */
  const safe = toPosMode(mode)

  await siteExecute(siteId, 'UPDATE terminals SET pos_mode = ? WHERE id = ?', [safe, id])
  return { ok: true, id }
}

/**
 * Which stock room this till sells out of.
 *
 * Its own narrow write for the same two reasons `setTerminalPosMode` above is
 * one: it is set from the till's ROW rather than the edit dialog, because the
 * question is comparative — "which of my four tills sells from where" is a
 * column you read down — and because a partial save through `updateTerminal`
 * would carry the OTHER fields with it from a screen that is holding only part
 * of the record.
 *
 * `null` clears it back to "the main location", which is a real answer and the
 * one most shops want. See sql/site/194_terminal_stock_location.sql.
 */
export async function setTerminalStockLocation(
  siteId: number,
  id: number,
  locationId: number | null,
): Promise<SaveResult> {
  const existing = await getTerminal(siteId, id)
  if (!existing) return { ok: false, error: 'Till not found.' }

  if (locationId !== null) {
    /*
     * Checked rather than left to the FK.
     *
     * The constraint would refuse a bad id anyway, but as a driver error with a
     * constraint name in it — and these two cases have things worth SAYING. A
     * transit pile in particular is the one a person is most likely to pick by
     * accident, because it is the one that shows up in a list of locations and
     * looks like a room.
     */
    const row = await siteQueryOne<Row>(
      siteId,
      'SELECT id, name, is_transit, is_active FROM stock_locations WHERE id = ? LIMIT 1',
      [locationId],
    )
    if (!row) return { ok: false, error: 'That stock location no longer exists.' }

    /* A till selling out of the in-transit pile would be ringing up goods that
       are on a motorway between two branches — the same refusal, and the same
       reasoning, that setMainLocation applies to it. */
    if (row.is_transit) {
      return {
        ok: false,
        error: `${String(row.name)} holds goods on their way to another store, so a till cannot sell from it.`,
      }
    }
    if (!row.is_active) {
      return { ok: false, error: `${String(row.name)} is deactivated, so a till cannot sell from it.` }
    }
  }

  await siteExecute(siteId, 'UPDATE terminals SET stock_location_id = ? WHERE id = ?', [
    locationId,
    id,
  ])
  return { ok: true, id }
}

/**
 * The location a given till sells out of, as an id — or null for "use main".
 *
 * ── WHY THIS RETURNS NULL RATHER THAN RESOLVING MAIN ITSELF ───────────────
 *
 * Because `recordMovement` already resolves main, INSIDE the caller's open
 * transaction, precisely so a movement cannot straddle a change of which room
 * is main. Resolving it here — one query earlier, outside that transaction —
 * would reintroduce exactly the race that fallback exists to close.
 *
 * So null is passed onward as null and the existing fallback does its job. The
 * only thing this function decides is whether the till OVERRIDES it.
 *
 * Tolerant of a terminal that has gone: a sale must not fail because the till
 * row was deleted mid-transaction, and main is the right answer when nothing
 * says otherwise.
 */
export async function terminalStockLocationId(
  siteId: number,
  terminalId: number | null | undefined,
): Promise<number | null> {
  if (!terminalId) return null
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT stock_location_id FROM terminals WHERE id = ? LIMIT 1',
    [terminalId],
  ).catch(() => null)
  if (!row || row.stock_location_id === null) return null
  return Number(row.stock_location_id)
}

/**
 * Whether this machine is already registered at a DIFFERENT shop.
 *
 * Returns the shop and till holding it, so the refusal can name them. Null when
 * the machine is free, which is the ordinary case and costs one small query per
 * active site.
 *
 * Deliberately tolerant of a site that cannot be read: a shop whose database is
 * unreachable must not stop another shop registering a till. The cost of
 * skipping it is that this check is best-effort rather than a guarantee — which
 * is why `test-pos-unlock` also asserts the invariant across every site, and is
 * the thing that would catch a claim this missed.
 */
/** One shop this machine is a till in. */
export type DeviceSite = {
  siteId: number
  siteName: string
  terminalCode: string
}

/**
 * EVERY shop this machine holds a till in.
 *
 * ── WHY A LIST AND NOT THE FIRST MATCH ────────────────────────────────────
 *
 * This replaced a `siteForDevice` that returned the first site whose terminals
 * table matched and stopped there. That was safe only while a machine could
 * hold one till in total — and enforcing THAT was refusing a real arrangement:
 * an operator invoicing for two stores from one PC, with a separately paid
 * licence in each, which `claimSpot` has always allowed.
 *
 * So the ambiguity is resolved by ASKING rather than by forbidding. A machine
 * registered in one shop unlocks straight into it, exactly as before; one
 * registered in several offers the choice, and the person standing at the
 * counter knows which shop they are in better than a sort order does.
 *
 * ── ORDERED, SO THE ANSWER IS STABLE ──────────────────────────────────────
 *
 * By site id, which is `activeSiteIds`' own order. The unlock screen lists them
 * in this order, so the same machine offers the same list in the same sequence
 * every morning — a picker whose entries move is a picker somebody eventually
 * taps without reading.
 *
 * Inactive terminals are skipped: a deactivated till is not a shop this machine
 * may open, and offering it would be a door that refuses on the far side.
 */
export async function sitesForDevice(deviceId: string): Promise<DeviceSite[]> {
  const trimmed = deviceId.trim()
  /* Same shape check the unlock path used to apply, kept here so every caller
     gets it: this is a public identifier from a browser, not a credential. */
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(trimmed)) return []

  const { activeSiteIds, publicSiteName } = await import('../sites')
  const found: DeviceSite[] = []

  for (const siteId of await activeSiteIds()) {
    const row = await siteQueryOne<{ code: string }>(
      siteId,
      'SELECT code FROM terminals WHERE device_id = ? AND is_active = 1 LIMIT 1',
      [trimmed],
      /* A site whose database is unreachable is skipped rather than fatal — one
         sick shop must not stop a machine unlocking into a healthy one. */
    ).catch(() => null)
    if (!row) continue
    found.push({
      siteId,
      siteName: (await publicSiteName(siteId)) ?? `Site ${siteId}`,
      terminalCode: String(row.code),
    })
  }

  return found
}

/**
 * Binds a machine to a till.
 *
 * Takes the claim off whatever machine held it before: replacing a broken till
 * PC is routine, and requiring a manager to release the old one first would
 * mean a shop cannot trade until someone finds the setup screen.
 *
 * ── ONE MACHINE MAY WORK SEVERAL SHOPS ───────────────────────────────────
 *
 * `terminals.device_id` is UNIQUE, so one machine cannot hold two registers in
 * ONE shop — the database sees to that, and that limit is real: a shop paying
 * for two tills must not trade from one browser twice.
 *
 * Across shops it is the opposite. An operator invoicing for two stores from
 * one back-office PC is an ordinary arrangement, not an abuse — and the LICENCE
 * layer already says so in as many words (`claimSpot` in control/devices.ts:
 * "a machine may hold one licence in each store it works … each store's licence
 * is separately sold and separately paid"). A terminal claim that refused what
 * the licence permits made the two halves of one action disagree.
 *
 * This used to refuse it, for a reason that was real but was fixed in the wrong
 * place: `siteForDevice` in the unlock path returned the FIRST site whose
 * terminals table matched, so a machine claimed twice would unlock into
 * whichever sorted first — one company's counter opening another's data. The
 * answer is for that lookup to RETURN ALL the matches and let the person say
 * which shop they are standing in, which is what it now does. Blocking the
 * claim was making every multi-store customer pay for a single-store bug.
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

  /* NO CROSS-SITE REFUSAL. See the docblock: a machine working two stores is a
     real arrangement the licence layer already allows, and the unlock path now
     asks which shop rather than guessing. */
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
