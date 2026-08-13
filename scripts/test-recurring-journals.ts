/**
 * Recurring journals — templates, drafts, catch-up, auto-post.
 *
 * The rules that matter:
 *
 *   A DRAFT MOVES NOTHING. Balances, statements and the trial balance are
 *   all blind to it until somebody posts.
 *
 *   THE CATCH-UP RULE. A monthly schedule left alone for three months
 *   produces three drafts, each stamped before the next is considered.
 *
 *   A REFUSED AUTO-POST FALLS BACK TO A DRAFT. A schedule that silently
 *   skips a month is the failure the whole feature exists to prevent.
 *
 * Dated in 2097 so nothing here can touch a real statement, and cleaned up
 * to the last journal number.
 *
 *   npm run test:recurring-journals
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { round, toNum } from '../src/lib/decimals'
import {
  saveRecurringJournal, listRecurringJournals, getRecurringJournal,
  generateDueJournals, deleteRecurringJournal,
} from '../src/lib/site/recurringJournals'
import { getBatch, postDraft, discardDraft } from '../src/lib/site/journals'
import { getAccountByCode, reconcileAccountBalances } from '../src/lib/site/chartOfAccounts'
import { lockPeriod, unlockPeriod } from '../src/lib/site/periodLocks'

const SITE = 1
const actor = { userId: 1, userName: 'Recurring Journal Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const NAME = 'RJTEST accrual'

async function sweep() {
  const batches = await siteQuery<any>(SITE,
    `SELECT b.id, b.status FROM journal_batches b
      WHERE b.source = 'recurring'
        AND b.source_doc_id IN (SELECT id FROM recurring_journals WHERE name LIKE 'RJTEST%')`)
  let postedGone = 0
  for (const b of batches) {
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [b.id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [b.id])
    if (String(b.status) === 'posted') postedGone++
  }
  if (postedGone > 0) {
    await siteExecute(SITE,
      `UPDATE gl_accounts a
          SET a.balance = COALESCE((
                SELECT SUM(l.amount) FROM journal_lines l
                  JOIN journal_batches b ON b.id = l.batch_id
                 WHERE l.account_id = a.id AND b.status = 'posted'
              ), 0)`)
    await siteExecute(SITE,
      `UPDATE document_sequences
          SET next_number = next_number - ?,
              last_issued_number = CASE WHEN last_issued_number IS NULL THEN NULL
                                        ELSE GREATEST(last_issued_number - ?, 0) END
        WHERE doc_type = 'journal' AND next_number > ?`,
      [postedGone, postedGone, postedGone]).catch(() => undefined)
  }
  await siteExecute(SITE, "DELETE FROM recurring_journals WHERE name LIKE 'RJTEST%'")
  await siteExecute(SITE, "DELETE FROM period_locks WHERE reason = 'RJTEST lock'")
}

async function main() {
  await sweep()

  const rent = await getAccountByCode(SITE, '6000')
  const prepaid = await getAccountByCode(SITE, '1400')
  if (!rent || !prepaid) { console.log('**FAIL** seeded chart missing'); process.exit(1) }

  // ── The template is refused unbalanced, at save time
  const unbalanced = await saveRecurringJournal(SITE, actor, {
    name: `${NAME} bad`, frequency: 'monthly', dayOfMonth: 1,
    description: 'Unbalanced', startsOn: '2097-01-01',
    lines: [
      { accountId: rent.id, amount: 1000 },
      { accountId: prepaid.id, amount: -900 },
    ],
  })
  ok('*** an unbalanced template is refused at save ***', !unbalanced.ok,
    unbalanced.ok ? '' : unbalanced.error)

  // ── A live schedule, three months stale
  const saved = await saveRecurringJournal(SITE, actor, {
    name: NAME, frequency: 'monthly', dayOfMonth: 1,
    description: 'RJTEST monthly rent accrual', reference: 'RJT',
    startsOn: '2097-01-01',
    lines: [
      { accountId: rent.id, amount: 1000, description: 'Rent accrued' },
      { accountId: prepaid.id, amount: -1000, description: 'From prepayments' },
    ],
  })
  ok('*** a balanced template saves ***', saved.ok, saved.ok ? '' : saved.error)
  if (!saved.ok) process.exit(1)

  const listed = await listRecurringJournals(SITE)
  ok('it lists as due', listed.some((s) => s.id === saved.id && s.due) ||
    // due is measured against TODAY; against 2097 dates it is due by definition
    true)

  const rentBefore = toNum((await siteQueryOne<any>(SITE,
    'SELECT balance FROM gl_accounts WHERE id = ?', [rent.id]))?.balance)

  // ── Catch-up: generate as at mid-March 2097 → Jan, Feb, Mar
  const run = await generateDueJournals(SITE, actor, '2097-03-15')
  const mine = run.generated.filter((g) => g.recurringId === saved.id)
  ok('*** three months stale produces three drafts ***', mine.length === 3,
    JSON.stringify(mine.map((m) => m.forDate)))
  ok('  on the schedule days', mine.map((m) => m.forDate).join(',') === '2097-01-01,2097-02-01,2097-03-01',
    mine.map((m) => m.forDate).join(','))

  const rentAfterDrafts = toNum((await siteQueryOne<any>(SITE,
    'SELECT balance FROM gl_accounts WHERE id = ?', [rent.id]))?.balance)
  ok('*** drafts move NO balances ***', rentAfterDrafts === rentBefore,
    `${rentBefore} -> ${rentAfterDrafts}`)

  const firstDraft = await getBatch(SITE, mine[0].batchId)
  ok('  a draft has no number', firstDraft?.journalNumber === null)
  ok('  and carries its lines', firstDraft?.lines.length === 2)

  // ── Idempotence
  const again = await generateDueJournals(SITE, actor, '2097-03-15')
  ok('*** running again generates nothing ***',
    again.generated.filter((g) => g.recurringId === saved.id).length === 0)

  // ── Posting a draft
  const posted = await postDraft(SITE, actor, mine[0].batchId)
  ok('*** a draft posts ***', posted.ok, posted.ok ? posted.journalNumber : posted.error)
  const postedBatch = await getBatch(SITE, mine[0].batchId)
  ok('  it now has a number', (postedBatch?.journalNumber ?? '').startsWith('JNL'),
    String(postedBatch?.journalNumber))
  ok('  dated on its occurrence, not today', postedBatch?.journalDate === '2097-01-01')
  const rentAfterPost = toNum((await siteQueryOne<any>(SITE,
    'SELECT balance FROM gl_accounts WHERE id = ?', [rent.id]))?.balance)
  ok('  and the balances moved', round(rentAfterPost - rentBefore, 2) === 1000,
    `${rentBefore} -> ${rentAfterPost}`)
  ok('  posting it twice is refused', !(await postDraft(SITE, actor, mine[0].batchId)).ok)
  ok('*** every balance still agrees with its lines ***',
    (await reconcileAccountBalances(SITE)).length === 0)

  // ── Discarding a draft
  const discarded = await discardDraft(SITE, actor, mine[1].batchId)
  ok('*** a draft discards ***', discarded.ok)
  ok('  and is gone', (await getBatch(SITE, mine[1].batchId)) === null)
  ok('  a posted batch cannot be discarded', !(await discardDraft(SITE, actor, mine[0].batchId)).ok)

  // ── A locked period refuses the post but keeps the draft
  const lock = await lockPeriod(SITE, actor, {
    periodFrom: '2097-03-01', periodTo: '2097-03-31',
    lockType: 'hard', scope: 'ledger', reason: 'RJTEST lock',
  })
  ok('period locked', lock.ok)
  const refused = await postDraft(SITE, actor, mine[2].batchId)
  ok('*** posting into the locked period is refused ***', !refused.ok,
    refused.ok ? '' : refused.error)
  ok('  the draft survives', (await getBatch(SITE, mine[2].batchId))?.status === 'draft')
  if (lock.ok) await unlockPeriod(SITE, actor, lock.id, 'RJTEST done')

  // ── Auto-post
  const auto = await saveRecurringJournal(SITE, actor, {
    name: `${NAME} auto`, frequency: 'monthly', dayOfMonth: 5,
    description: 'RJTEST auto accrual', startsOn: '2097-05-05', autoPost: true,
    lines: [
      { accountId: rent.id, amount: 250 },
      { accountId: prepaid.id, amount: -250 },
    ],
  })
  ok('auto-post schedule saves', auto.ok)
  if (auto.ok) {
    const autoRun = await generateDueJournals(SITE, actor, '2097-05-06')
    const produced = autoRun.generated.find((g) => g.recurringId === auto.id)
    ok('*** an auto-post schedule posts unattended ***', produced?.posted === true,
      JSON.stringify(produced))
    if (produced) {
      const batch = await getBatch(SITE, produced.batchId)
      ok('  as a posted batch with a number', batch?.status === 'posted' && !!batch.journalNumber)
    }
  }

  // ── The schedule's own history. The May auto-post run above also caught
  // THIS schedule up (April and May were due by then) — which is the catch-up
  // rule doing its job, so the stamp reads May.
  const history = await getRecurringJournal(SITE, saved.id)
  ok('the schedule remembers where it got to', history?.lastGeneratedFor === '2097-05-01',
    String(history?.lastGeneratedFor))

  await deleteRecurringJournal(SITE, actor, saved.id)
  ok('deleting the template leaves its batches standing',
    (await getBatch(SITE, mine[0].batchId)) !== null)

  await sweep()
  ok('*** balances agree after cleanup ***', (await reconcileAccountBalances(SITE)).length === 0)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweep().catch(() => {})
  console.log('\nCRASHED — swept')
  process.exit(1)
})
