/* Removes the probe fixtures. Deletes by LABEL, so it can never touch a real
   enrolment even if one exists on the dev account. */
import { execute } from '../src/lib/db'

async function main() {
  const r = await execute("DELETE FROM odyssey_mobile_devices WHERE label LIKE 'PROBE %'")
  console.log(`removed ${r.affectedRows} fixture device(s)`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
