import { createFeedbackToken } from '../src/lib/feedbackToken'
import { siteExecute, siteQuery } from '../src/lib/siteDb'
import { setSetting } from '../src/lib/site/settings'

/**
 * Mint a feedback link for the browser check, WITHOUT sending an email.
 *
 * This is the "test by minting tokens directly" decision: the login path is
 * fully exercised, and nothing reaches a real inbox.
 */
async function main() {
  const mode = process.argv[2]
  const JOB = 12

  if (mode === 'clean') {
    await siteExecute(1, `DELETE FROM job_feedback WHERE job_card_id = ?`, [JOB])
    await siteExecute(
      1,
      `DELETE FROM activity_log WHERE entity = 'job_card' AND action = 'feedback_received'`,
    )
    await setSetting(1, 'job_feedback_enabled', '0')
    const left = await siteQuery<any>(1, `SELECT COUNT(*) AS n FROM job_feedback`)
    console.log('cleaned. rows left:', left[0].n)
    return
  }

  // Claim the row by hand rather than through requestFeedback, so no mail is
  // attempted at all.
  await siteExecute(
    1,
    `INSERT INTO job_feedback (job_card_id, customer_id)
     SELECT id, customer_id FROM job_cards WHERE id = ?
     ON DUPLICATE KEY UPDATE requested_at = NOW()`,
    [JOB],
  )
  const token = await createFeedbackToken({ siteId: 1, jobId: JOB })
  console.log('URL=/feedback/' + token)

  // And a token for a job nobody was asked about, to prove the dead end.
  const unasked = await createFeedbackToken({ siteId: 1, jobId: 999999 })
  console.log('UNASKED=/feedback/' + unasked)
}

main().then(() => process.exit(0))
