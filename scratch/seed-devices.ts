/* Two fixture phones for the revoke-list probe, on the dev account. Cleaned up
   by scratch/clean-devices.ts — a leaked row on a UNIQUE column is how an
   unrelated suite starts failing. */
import { enrolDevice } from '../src/lib/control/mobileDevices'
import { queryOne } from '../src/lib/db'
import type { RowDataPacket } from 'mysql2'

async function main() {
  const email = process.env.DEV_LOGIN_EMAIL
  if (!email) throw new Error('DEV_LOGIN_EMAIL is not set')

  const row = await queryOne<RowDataPacket & Record<string, unknown>>(
    'SELECT id FROM cp2_users WHERE email = ? LIMIT 1',
    [email],
  )
  if (!row) throw new Error(`No cp2_users row for ${email}`)
  const userId = Number(row.id)

  const a = await enrolDevice(userId, 'ios', 'PROBE iPhone')
  const b = await enrolDevice(userId, 'android', 'PROBE tablet')
  console.log(`seeded devices ${a.deviceId} and ${b.deviceId} for user ${userId}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
