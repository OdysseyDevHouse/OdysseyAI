/*
 * Can a machine be LICENSED and still have no till?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-till-licence-split.ts
 *
 * That combination is what produces "Choose a till." on the float screen: the
 * licence gate lets the machine through, and then `PosShell` resolves the
 * terminal SEPARATELY by matching `device_id` in the SITE database. Two
 * different records answer "which till is this", and nothing keeps them in
 * step — so a till released or deactivated on one side leaves the other
 * pointing at nothing.
 *
 * Prints both sides for every licensed device, so the disagreement is visible
 * rather than inferred.
 */
import { activeSiteIds } from '../src/lib/sites'
import { siteQuery } from '../src/lib/siteDb'
import { query } from '../src/lib/db'

type Device = {
  id: number
  serial: string
  name: string | null
  terminal_id: number | null
  site_id: number
}

type Terminal = {
  id: number
  code: string
  device_id: string | null
  is_active: number
}

async function main() {
  for (const siteId of await activeSiteIds()) {
    console.log(`\n── site ${siteId} ─────────────────────────────────────────`)

    const devices = await query<Device & import('mysql2').RowDataPacket>(
      `SELECT id, serial_number AS serial, device_name AS name, terminal_id, site_id
         FROM cp2_devices WHERE site_id = ? ORDER BY id`,
      [siteId],
    ).catch((e) => {
      console.log(`  could not read cp2_devices: ${e.message}`)
      return [] as Device[]
    })

    const terminals = await siteQuery<Terminal>(
      siteId,
      'SELECT id, code, device_id, is_active FROM terminals ORDER BY id',
    ).catch(() => [] as Terminal[])

    if (!devices.length) {
      console.log('  no licensed devices')
      continue
    }

    for (const d of devices) {
      /* The two answers, side by side. The LICENCE names a terminal id; the
         SITE table is matched on the serial, which is what PosShell actually
         does. Either can be null while the other is not. */
      const bySite = terminals.find((t) => t.device_id === d.serial)
      const byLicence = d.terminal_id
        ? terminals.find((t) => t.id === d.terminal_id)
        : undefined

      const siteAnswer = bySite ? `${bySite.code} (#${bySite.id})${bySite.is_active ? '' : ' INACTIVE'}` : 'none'
      const licenceAnswer = d.terminal_id
        ? byLicence
          ? `${byLicence.code} (#${byLicence.id})`
          : `#${d.terminal_id} MISSING`
        : 'none'

      const agrees = (bySite?.id ?? null) === (d.terminal_id ?? null)
      console.log(
        `  device ${d.serial.slice(0, 8)}… "${d.name ?? ''}"\n` +
          `    licence says: ${licenceAnswer}\n` +
          `    site says:    ${siteAnswer}   ${agrees ? '' : '  <-- DISAGREE'}`,
      )

      if (!bySite && d.terminal_id) {
        console.log(
          '    => LICENSED but PosShell resolves NO terminal.\n' +
            '       This machine passes the licence gate, reaches the float screen,\n' +
            '       and is then refused with "Choose a till."',
        )
      }
      if (bySite && !bySite.is_active) {
        console.log('    => the claimed till is DEACTIVATED; openShift refuses it.')
      }
    }
  }
}

main().then(() => process.exit(0))
