import { createPublicIntakeToken } from '../src/lib/publicIntakeToken'
import { setSetting } from '../src/lib/site/settings'
import { siteExecute, siteQuery } from '../src/lib/siteDb'

/** Switch the public form on for a browser check, and off again afterwards. */
async function main() {
  const mode = process.argv[2]

  if (mode === 'clean') {
    await siteExecute(1, `DELETE FROM job_cards WHERE title LIKE 'BROWSER PROBE%'`)
    await siteExecute(1, `DELETE FROM job_requests WHERE title LIKE 'BROWSER PROBE%'`)
    await siteExecute(
      1,
      `DELETE FROM activity_log WHERE entity = 'job_card' AND action = 'raised_from_request'`,
    )
    await setSetting(1, 'job_intake_enabled', '0')
    const left = await siteQuery<any>(1, `SELECT COUNT(*) AS n FROM job_requests`)
    console.log('cleaned. requests left:', left[0].n)
    return
  }

  await setSetting(1, 'job_intake_enabled', '1')
  const token = await createPublicIntakeToken(1)
  console.log('URL=/request/' + token)
}

main().then(() => process.exit(0))
