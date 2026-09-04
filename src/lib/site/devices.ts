import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'

/**
 * The machines this shop uses — tills and back-office PCs alike.
 *
 * ── WHY THIS EXISTS SEPARATELY FROM `terminals` ───────────────────────────
 *
 * A `terminals` row is a REGISTER: it has a till number, it appears in invoice
 * numbers, and a machine claims one. A back-office PC claims nothing and rings
 * up nothing, but it still prints — invoices, statements, purchase orders — and
 * it is exactly the machine that must be able to disagree with the till about
 * where an A4 document goes. So printer setup hangs off the machine, and the
 * machine is this table.
 *
 * The two are joined by `terminals.device_id`, LEFT, and optionally: a device
 * with no terminal is an office PC, and a terminal with no device is a till
 * nobody has claimed yet.
 *
 * ── NOT cp2_devices ───────────────────────────────────────────────────────
 *
 * That is the licence record. It lives in the CONTROL database, it is owned by
 * the v2 backend, and a packaged desktop install cannot open a socket to it at
 * all (`pool()` throws ControlDbUnavailableOnDesktop). Nothing here may join to
 * it, and nothing here needs to: whether a machine is licensed and where its
 * slips come out are unrelated questions.
 *
 * ── THE ID IS AN IDENTIFIER, NOT A CREDENTIAL ─────────────────────────────
 *
 * lib/deviceId.ts says this of itself, and it stays true here. Anyone who can
 * call the setup actions can read and rewrite another machine's printer setup
 * by naming its UUID. The blast radius is "which printer a document comes out
 * of", and `setup.edit` keeps it inside the shop — the same bargain `terminals`
 * and `user_offline_verifiers` already make. It is written down so it is a
 * known bargain rather than a discovered one.
 */

export type DeviceKind = 'desktop' | 'browser' | 'android' | 'unknown'

export type Device = {
  deviceId: string
  label: string
  kind: DeviceKind
  platform: string
  appRole: string
  pdfDir: string
  isActive: boolean
  firstSeenAt: Date
  lastSeenAt: Date
  /** The till this machine holds, or null on a back-office PC. */
  terminal: { id: number; code: string; name: string } | null
  /** Printers plugged into it, and documents it has an answer for. */
  printerCount: number
  assignedCount: number
}

export type DeviceResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

/**
 * The shape check, in one place.
 *
 * Every id this table ever sees was minted by `deviceId.ts` as a v4 UUID, but
 * the value arrives from a client and is about to become a primary key, so it
 * is checked rather than trusted. Deliberately looser than a UUID regex: a
 * machine whose id came from the non-secure-context fallback is still a
 * legitimate machine, and refusing it here would lock a shop on plain http out
 * of printer setup entirely.
 */
export function isValidDeviceId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(value)
}

function mapDevice(r: Row): Device {
  const terminalId = r.terminal_id == null ? 0 : Number(r.terminal_id)
  return {
    deviceId: String(r.device_id),
    label: String(r.label ?? ''),
    kind: (String(r.kind ?? 'unknown') as DeviceKind) ?? 'unknown',
    platform: String(r.platform ?? ''),
    appRole: String(r.app_role ?? ''),
    pdfDir: String(r.pdf_dir ?? ''),
    isActive: Number(r.is_active ?? 1) === 1,
    firstSeenAt: new Date(r.first_seen_at as string),
    lastSeenAt: new Date(r.last_seen_at as string),
    terminal:
      terminalId > 0
        ? { id: terminalId, code: String(r.terminal_code ?? ''), name: String(r.terminal_name ?? '') }
        : null,
    printerCount: Number(r.printer_count ?? 0),
    assignedCount: Number(r.assigned_count ?? 0),
  }
}

const SELECT_DEVICE = `
  SELECT d.*,
         t.id   AS terminal_id,
         t.code AS terminal_code,
         t.name AS terminal_name,
         /* Printers plugged into THIS machine. A network printer belongs to no
            machine in particular and is deliberately not counted here. */
         (SELECT COUNT(*) FROM printers p
           WHERE p.device_id = d.device_id AND p.is_active = 1) AS printer_count,
         (SELECT COUNT(*) FROM device_document_printers ddp
           WHERE ddp.device_id = d.device_id) AS assigned_count
    FROM devices d
    LEFT JOIN terminals t ON t.device_id = d.device_id
`

export async function listDevices(
  siteId: number,
  opts: { includeInactive?: boolean } = {},
): Promise<Device[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DEVICE}
      ${opts.includeInactive ? '' : 'WHERE d.is_active = 1'}
      ORDER BY t.code IS NULL, t.code ASC, d.label ASC, d.device_id ASC`,
  ).catch(() => [] as Row[])
  return rows.map(mapDevice)
}

export async function getDevice(siteId: number, deviceId: string): Promise<Device | null> {
  if (!isValidDeviceId(deviceId)) return null
  const row = await siteQueryOne<Row>(siteId, `${SELECT_DEVICE} WHERE d.device_id = ?`, [
    deviceId,
  ]).catch(() => null)
  return row ? mapDevice(row) : null
}

/**
 * Records that a machine exists and is being used. Never throws, never blocks.
 *
 * Called from the back-office heartbeat and from the POS catalog feed, so it
 * runs on a path where failing must cost nothing: a machine that cannot
 * register itself must still be able to trade, and the only thing it loses is a
 * row in a setup list.
 *
 * ── EVERY UPDATE IS A NARROWING ───────────────────────────────────────────
 *
 * Two callers describe the same machine with different amounts of knowledge.
 * The browser heartbeat knows it is a 'desktop' on 'win32'; the catalog feed
 * knows only that a till asked for products. So a blank or 'unknown' value
 * never overwrites a real one, in either direction — otherwise the two would
 * take turns undoing each other, and a machine would read as 'desktop' or
 * 'unknown' depending on which fired last.
 *
 * The LABEL is written once, when the machine is first seen, and never again.
 * It is the field a person renames, and a heartbeat that refreshed it would
 * quietly undo that on the next page load.
 *
 * `last_seen_at` is written only when it is more than fifteen minutes stale.
 * Without that guard every catalog poll from every till writes a row every
 * thirty seconds, which is a lot of disk for a column nobody reads to the
 * minute.
 */
export async function touchDevice(
  siteId: number,
  input: {
    deviceId: string
    label: string
    kind: DeviceKind
    platform: string
    appRole: string
  },
): Promise<void> {
  if (!isValidDeviceId(input.deviceId)) return
  await siteExecute(
    siteId,
    `INSERT INTO devices (device_id, label, kind, platform, app_role)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       /* A narrowing only — see the docblock. The caller that knows least must
          not be able to erase what the caller that knows most already said. */
       kind      = IF(VALUES(kind) = 'unknown', kind, VALUES(kind)),
       platform  = IF(VALUES(platform) = '', platform, VALUES(platform)),
       app_role  = IF(VALUES(app_role) = '', app_role, VALUES(app_role)),
       /* Only when genuinely stale. IF() rather than GREATEST() so the column is
          left completely untouched on the common path, which is what keeps the
          row out of the redo log. */
       last_seen_at = IF(last_seen_at < NOW() - INTERVAL 15 MINUTE, NOW(), last_seen_at)`,
    [
      input.deviceId,
      input.label.slice(0, 120),
      input.kind,
      input.platform.slice(0, 32),
      input.appRole.slice(0, 16),
    ],
  ).catch(() => undefined)
}

export async function renameDevice(
  siteId: number,
  deviceId: string,
  label: string,
): Promise<DeviceResult> {
  const clean = label.trim()
  if (!clean) return { ok: false, error: 'Give the machine a name.' }
  if (clean.length > 120) return { ok: false, error: 'That name is too long — 120 characters at most.' }
  if (!isValidDeviceId(deviceId)) return { ok: false, error: 'That is not a machine this shop knows.' }

  await siteExecute(siteId, `UPDATE devices SET label = ? WHERE device_id = ?`, [clean, deviceId])
  return { ok: true }
}

export async function setDevicePdfDir(
  siteId: number,
  deviceId: string,
  dir: string,
): Promise<DeviceResult> {
  if (!isValidDeviceId(deviceId)) return { ok: false, error: 'That is not a machine this shop knows.' }
  const clean = dir.trim().slice(0, 255)
  await siteExecute(siteId, `UPDATE devices SET pdf_dir = ? WHERE device_id = ?`, [clean, deviceId])
  return { ok: true }
}

/**
 * Forgets a machine entirely.
 *
 * Deletes rather than deactivates, and the difference from `printers` is the
 * point: a printer that has cooked food is referenced by history, while a
 * machine is referenced by nothing but its own setup. The FKs cascade its
 * connections and its assignments and touch nothing else — in particular the
 * `terminals` row survives, because releasing a till is a separate act with its
 * own licence consequences (see releaseTerminalAction).
 *
 * The machine reappears the next time it signs in, with no printer setup. That
 * is the intended outcome: this is how a shop clears out the staff phone that
 * logged in once, and how a mis-set-up machine is started again from nothing.
 */
export async function forgetDevice(siteId: number, deviceId: string): Promise<DeviceResult> {
  if (!isValidDeviceId(deviceId)) return { ok: false, error: 'That is not a machine this shop knows.' }
  await siteExecute(siteId, `DELETE FROM devices WHERE device_id = ?`, [deviceId])
  return { ok: true }
}

/**
 * Copies one machine's document assignments onto another.
 *
 * The recovery path for the thing a UUID key cannot avoid: re-imaging a machine
 * gives it a NEW id, so its setup does not follow it. It is also how a shop
 * sets up its second, third and fourth till without repeating itself.
 *
 * ── ASSIGNMENTS ONLY, AND THAT IS NOW THE WHOLE SETUP ─────────────────────
 *
 * Since 247 a printer owns its own location, so there is nothing per-machine
 * left to copy except which document goes where. A copied assignment pointing
 * at the SOURCE machine's USB printer reads as unreachable on the target and
 * says why — which is the honest outcome, because that printer genuinely is
 * plugged into the other machine.
 *
 * Replaces wholesale inside one transaction rather than merging: half a
 * configuration is one nobody can tell apart from a whole one by looking.
 */
export async function copyPrintingSetup(
  siteId: number,
  fromDeviceId: string,
  toDeviceId: string,
): Promise<DeviceResult> {
  if (!isValidDeviceId(fromDeviceId) || !isValidDeviceId(toDeviceId)) {
    return { ok: false, error: 'That is not a machine this shop knows.' }
  }
  if (fromDeviceId === toDeviceId) {
    return { ok: false, error: 'Pick a different machine to copy from.' }
  }

  const target = await getDevice(siteId, toDeviceId)
  if (!target) return { ok: false, error: 'That machine is not set up here.' }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM device_document_printers WHERE device_id = ?`, [toDeviceId])
    await tx.execute(
      `INSERT INTO device_document_printers (device_id, doc_key, mode, printer_id, copies)
       SELECT ?, doc_key, mode, printer_id, copies
         FROM device_document_printers WHERE device_id = ?`,
      [toDeviceId, fromDeviceId],
    )
  })
  return { ok: true }
}
