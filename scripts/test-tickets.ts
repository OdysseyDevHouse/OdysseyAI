/**
 * Tickets — inbound support, timed by the lane it sits in.
 *
 * THE INVARIANTS, and everything here exists to prove them:
 *
 *  (T1) A ticket carries NO MONEY. No lines, no billing state, no invoice. The
 *       moment it does, it is a job card with a different name and every rule
 *       in jobCards.ts exists twice.
 *  (T2) THE LANE OWNS THE CLOCK. Dragging into a `start` lane opens a segment,
 *       into `pause` or `end` closes it, and the status change and the segment
 *       commit in ONE transaction — a ticket in On Hold with a running clock is
 *       drift nothing on screen can explain.
 *  (T3) TIME BELONGS TO THE ASSIGNEE, never the mover. A dispatcher pushing
 *       twenty cards must not appear to have done twenty tickets of work — and
 *       an unassigned ticket is REFUSED a running lane rather than moving and
 *       silently timing nothing.
 *  (T4) THE CLOCK COUNTS BUSINESS HOURS, the same clock the SLA runs on. A
 *       ticket left open over a weekend reads as the hours the doors were open,
 *       so the work figure and the promise figure can never disagree.
 *  (T5) THE LEDGER IS THE TRUTH. Minutes are derived from segments on every
 *       read, never stored — so changing the trading week restates every total
 *       rather than leaving two incomparable eras.
 *  (T6) THE PER-USER CAP is a check, not a constraint, and that is safe ONLY
 *       because ticket time is never billed. It names what is already running,
 *       and 0 means no cap.
 *  (T7) THE THREE CARDINALITIES hold: exactly one landing lane, at most one
 *       lane per clock action, one or more closed lanes.
 *  (T8) NUMBERS ARE VERIFIABLE. `tickets` carries document_number, id and a
 *       status whose void value is 'cancelled', which is verifySequence's
 *       contract — without it every TK ever issued reports as missing.
 *  (T9) The suite leaves NOTHING behind.
 *
 *   npm run test:tickets
 */
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import {
  listLanes,
  saveLane,
  deleteLane,
  saveTicket,
  getTicket,
  listTickets,
  moveTicket,
  assignTicket,
  ticketTime,
  linkToJob,
  reconcileTickets,
  maxRunningPerUser,
} from '../src/lib/site/tickets'
import { validateLanes, clockTransition, type LaneShape } from '../src/lib/ticketModel'
import { setSetting, getSetting } from '../src/lib/site/settings'
import { listComments, createComment } from '../src/lib/site/partyComments'
import { verifySequence } from '../src/lib/site/sequences'
import type { Actor } from '../src/lib/site/activityLog'

const SITE = 1
const stamp = String(Date.now()).slice(-6)
const actor: Actor = { userId: 1, userName: 'Ticket Test' }

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/* Fixtures are matched by a reserved pattern so the sweep can only ever delete
   its own. TKT is not a subject any real ticket would carry. */
const SUBJECT_PATTERN = `^TKT${stamp} `
const LANE_PATTERN = `^tkt${stamp}_`

async function sweep() {
  const ids = await siteQuery<{ id: number }>(
    SITE,
    `SELECT id FROM tickets WHERE subject REGEXP ?`,
    [SUBJECT_PATTERN],
  )
  for (const { id } of ids) {
    await siteExecute(SITE, `DELETE FROM ticket_time_entries WHERE ticket_id = ?`, [id])
    await siteExecute(SITE, `DELETE FROM party_comments WHERE entity='ticket' AND entity_id = ?`, [id])
    await siteExecute(SITE, `DELETE FROM activity_log WHERE entity='ticket' AND entity_id = ?`, [id])
  }
  await siteExecute(SITE, `DELETE FROM tickets WHERE subject REGEXP ?`, [SUBJECT_PATTERN])
  await siteExecute(SITE, `DELETE FROM ticket_statuses WHERE code REGEXP ?`, [LANE_PATTERN])
  await siteExecute(
    SITE,
    `DELETE FROM activity_log WHERE entity='ticket_status' AND user_name = ?`,
    [actor.userName],
  )
}

async function main() {
  await sweep()

  const capWas = await getSetting(SITE, 'ticket_max_running_per_user')
  const lanes = await listLanes(SITE, false)
  const lane = (code: string) => lanes.find((l) => l.code === code)!

  console.log('\n── 1. (T7) The three cardinalities ────────────────────────────')

  ok(
    '(T7) the seeded board is valid',
    validateLanes(
      lanes.map(
        (l): LaneShape => ({
          id: l.id,
          clock: l.clock,
          isLanding: l.isLanding,
          isClosedStage: l.isClosedStage,
          isCancelledStage: l.isCancelledStage,
          isActive: l.isActive,
        }),
      ),
    ) === null,
  )

  const base: LaneShape = {
    id: 1, clock: '', isLanding: true, isClosedStage: false,
    isCancelledStage: false, isActive: true,
  }
  const done: LaneShape = { ...base, id: 2, isLanding: false, isClosedStage: true }

  ok(
    '(T7) *** two landing lanes are refused — "where does a new ticket go" needs one answer ***',
    validateLanes([base, { ...base, id: 3 }, done]) !== null,
  )
  ok(
    '(T7) *** no closed lane is refused — a queue nothing can leave ***',
    validateLanes([base, { ...done, isClosedStage: false }]) !== null,
  )
  ok(
    '(T7) *** two lanes starting the clock are refused ***',
    validateLanes([
      base,
      { ...base, id: 4, isLanding: false, clock: 'start' },
      { ...base, id: 5, isLanding: false, clock: 'start' },
      done,
    ]) !== null,
  )
  ok(
    '(T7) but TWO closed lanes are fine — a team may finish in Resolved and in Closed',
    validateLanes([base, done, { ...done, id: 6 }]) === null,
  )
  ok(
    '(T7) *** the landing lane cannot start the clock — nobody has picked it up yet ***',
    validateLanes([{ ...base, clock: 'start' }, done]) !== null,
  )

  console.log('\n── 2. (T2) What a move does to the clock ──────────────────────')

  ok('(T2) idle -> start opens one', clockTransition('', 'start').open && !clockTransition('', 'start').close)
  ok('(T2) start -> pause closes it', clockTransition('start', 'pause').close && !clockTransition('start', 'pause').open)
  ok('(T2) start -> end closes it', clockTransition('start', 'end').close)
  ok(
    '(T2) start -> start does nothing — two running lanes cannot exist anyway',
    !clockTransition('start', 'start').open && !clockTransition('start', 'start').close,
  )
  ok('(T2) pause -> end closes nothing, because nothing was open', !clockTransition('pause', 'end').close)

  console.log('\n── 3. The ticket itself ───────────────────────────────────────')

  const cust = await siteQuery<{ id: number }>(
    SITE, `SELECT id FROM customers WHERE status = 'active' LIMIT 1`,
  )
  const customerId = Number(cust[0]!.id)

  const made = await saveTicket(SITE, actor, {
    id: null, customerId, contactId: null,
    subject: `TKT${stamp} printer will not feed`,
    description: 'Jams on tray 2', priority: 'high', statusId: null,
    assigneeUserId: null, assigneeName: null, source: 'phone',
    category: null, dueAt: null,
  })
  ok('a ticket is logged', made.ok, made.ok ? '' : made.error)
  if (!made.ok) throw new Error('ticket fixture failed')
  const T = made.id

  ok(
    '(T8) it takes a TK number',
    (made.documentNumber ?? '').startsWith('TK'),
    String(made.documentNumber),
  )
  ok(
    'and lands in the landing lane without being told to',
    (await getTicket(SITE, T))!.statusId === lane('new').id,
  )
  ok('a subject is required', !(await saveTicket(SITE, actor, {
    id: null, customerId: null, contactId: null, subject: '   ', description: null,
    priority: 'normal', statusId: null, assigneeUserId: null, assigneeName: null,
    source: 'manual', category: null, dueAt: null,
  })).ok)

  console.log('\n── 4. (T3) Time belongs to the assignee ───────────────────────')

  const unassigned = await moveTicket(SITE, actor, T, lane('in_progress').id)
  ok(
    '(T3) *** an UNASSIGNED ticket is refused a running lane — it would time nobody ***',
    !unassigned.ok,
    unassigned.ok ? 'ACCEPTED' : unassigned.error,
  )
  ok(
    '(T3) and the refusal says what to do about it',
    !unassigned.ok && /assign/i.test(unassigned.error),
  )

  await assignTicket(SITE, actor, T, 1, 'Tiaan Smith')
  const started = await moveTicket(SITE, actor, T, lane('in_progress').id)
  ok('(T2) assigned, it starts the clock', started.ok && started.started)

  let t = await getTicket(SITE, T)
  ok('(T2) and the ticket says it is running', t!.isRunning)
  ok(
    'moving off the landing lane counts as the first reply',
    t!.respondedAt !== null,
  )

  const paused = await moveTicket(SITE, actor, T, lane('on_hold').id)
  ok('(T2) On Hold stops it', paused.ok && paused.stopped && !paused.started)
  t = await getTicket(SITE, T)
  ok('(T2) *** and the ticket stays OPEN — paused is not done ***', !t!.isRunning && t!.state === 'open')

  console.log('\n── 5. (T4)(T5) Business hours, from the ledger ────────────────')

  /*
   * A segment spanning a whole weekend. Written directly because no test can
   * wait three days, and the arithmetic is the thing under test.
   */
  await siteExecute(
    SITE,
    `INSERT INTO ticket_time_entries (ticket_id, user_id, user_name, started_at, ended_at)
     VALUES (?,1,'Tiaan Smith','2026-08-07 15:00:00','2026-08-10 10:00:00')`,
    [T],
  )
  const segs = await ticketTime(SITE, T)
  const weekend = segs.find((s) => s.startedAt?.startsWith('2026-08-07'))
  ok(
    '(T4) *** Fri 15:00 to Mon 10:00 is 2 hours, not 67 — business hours, like the SLA ***',
    weekend?.minutes === 120,
    `${weekend?.minutes ?? '?'}m`,
  )

  const stored = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets'
        AND column_name IN ('worked_minutes','minutes_worked','total_minutes')`,
  )
  ok(
    '(T5) *** no stored total on the ticket — the ledger is the only source ***',
    Number(stored[0]?.n ?? 0) === 0,
  )

  console.log('\n── 6. (T6) The per-user cap ───────────────────────────────────')

  await setSetting(SITE, 'ticket_max_running_per_user', '0')
  ok('(T6) 0 means no cap, and it is the default', (await maxRunningPerUser(SITE)) === 0)

  // Two more tickets, both assigned to the same person and both running.
  const others: number[] = []
  for (const n of [1, 2]) {
    const r = await saveTicket(SITE, actor, {
      id: null, customerId, contactId: null, subject: `TKT${stamp} spare ${n}`,
      description: null, priority: 'normal', statusId: null,
      assigneeUserId: 1, assigneeName: 'Tiaan Smith', source: 'manual',
      category: null, dueAt: null,
    })
    if (r.ok) others.push(r.id)
  }
  await moveTicket(SITE, actor, others[0]!, lane('in_progress').id)

  await setSetting(SITE, 'ticket_max_running_per_user', '1')
  const capped = await moveTicket(SITE, actor, others[1]!, lane('in_progress').id)
  ok(
    '(T6) *** at the cap, a second running ticket is REFUSED ***',
    !capped.ok,
    capped.ok ? 'ACCEPTED' : capped.error,
  )
  ok(
    '(T6) *** and the refusal NAMES what is already running, so somebody knows what to stop ***',
    !capped.ok && /TK\d/.test(capped.error),
    capped.ok ? '' : capped.error,
  )

  await setSetting(SITE, 'ticket_max_running_per_user', '0')
  ok(
    '(T6) with the cap off it goes through',
    (await moveTicket(SITE, actor, others[1]!, lane('in_progress').id)).ok,
  )

  console.log('\n── 7. (T3) Reassigning hands the clock over ───────────────────')

  const before = (await ticketTime(SITE, others[0]!)).length
  await assignTicket(SITE, actor, others[0]!, null, '')
  const afterUnassign = await ticketTime(SITE, others[0]!)
  ok(
    '(T3) *** unassigning closes the open segment — nobody is working on it ***',
    afterUnassign.every((s) => !s.isRunning),
    `${afterUnassign.length} segment(s)`,
  )
  ok(
    '(T3) and the segment stays on the ledger — that work really happened',
    afterUnassign.length === before,
  )

  console.log('\n── 8. (T1) A ticket carries no money ──────────────────────────')

  const moneyCols = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets'
        AND (column_name LIKE '%price%' OR column_name LIKE '%cost%'
             OR column_name LIKE '%total%' OR column_name LIKE '%invoice%'
             OR column_name LIKE '%billing%')`,
  )
  ok(
    '(T1) *** no price, cost, total, invoice or billing column on tickets ***',
    Number(moneyCols[0]?.n ?? 0) === 0,
    `${moneyCols[0]?.n} found`,
  )
  const lineTables = await siteQuery<{ n: number }>(
    SITE,
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'ticket_lines'`,
  )
  ok('(T1) and no ticket_lines table', Number(lineTables[0]?.n ?? 0) === 0)

  console.log('\n── 9. Sharing, not copying ────────────────────────────────────')

  await createComment(SITE, actor, 'ticket', T, `TKT${stamp} spoke to the customer`)
  const comments = await listComments(SITE, 'ticket', T)
  ok(
    '*** a ticket comment lives in party_comments — no second table ***',
    comments.length === 1 && comments[0]!.entity === 'ticket',
  )

  const job = await siteQuery<{ id: number }>(SITE, `SELECT id FROM job_cards LIMIT 1`)
  if (job[0]) {
    ok('a ticket links to the job it became', (await linkToJob(SITE, actor, T, Number(job[0].id))).ok)
    ok(
      'and the link reads back both ways',
      (await getTicket(SITE, T))!.jobCardId === Number(job[0].id),
    )
    await linkToJob(SITE, actor, T, null)
  }

  console.log('\n── 10. (T8) The numbers verify ────────────────────────────────')

  /*
   * ── WHAT THIS CAN AND CANNOT ASSERT ──────────────────────────────────────
   *
   * NOT `missing === 0`. This suite deletes its own fixtures, and a deleted
   * ticket IS a missing number — so that assertion would fail by design, every
   * run, and the fix would be to stop cleaning up. An earlier version made
   * exactly that mistake.
   *
   * What matters is that verifySequence can SEE the tickets at all. Without the
   * OWN_TABLE_TYPES entry the doc type falls back to sales_documents, finds
   * none of its numbers there, and reports every TK ever issued as missing —
   * `live` would be 0 while rows plainly exist. So: live counts the rows that
   * are really there, and issued has moved past zero.
   */
  const seq = await verifySequence(SITE, 'ticket')
  const liveNow = await siteQuery<{ n: number }>(
    SITE, `SELECT COUNT(*) AS n FROM tickets WHERE status <> 'cancelled'`,
  )
  ok(
    '(T8) *** verifySequence READS the tickets table — without OWN_TABLE_TYPES live would be 0 ***',
    seq.issued > 0 && seq.live === Number(liveNow[0]?.n ?? -1),
    JSON.stringify({ issued: seq.issued, live: seq.live, actual: liveNow[0]?.n, missing: seq.missing }),
  )

  console.log('\n── 11. Lanes refuse what would break the board ────────────────')

  const newLane = await saveLane(SITE, actor, {
    id: null, code: `tkt${stamp}_extra`, name: `TKT${stamp} extra`,
    tone: 'neutral', sortOrder: 90, clock: '', isLanding: false,
    isClosedStage: false, isCancelledStage: false, isActive: true,
  })
  ok('a lane is added', newLane.ok, newLane.ok ? '' : newLane.error)

  if (newLane.ok) {
    const stolen = await saveLane(SITE, actor, {
      id: newLane.id, code: `tkt${stamp}_extra`, name: `TKT${stamp} extra`,
      tone: 'neutral', sortOrder: 90, clock: 'start', isLanding: false,
      isClosedStage: false, isCancelledStage: false, isActive: true,
    })
    ok('(T7) giving it the start flag succeeds', stolen.ok, stolen.ok ? '' : stolen.error)
    const after = await listLanes(SITE, false)
    ok(
      '(T7) *** and TAKES it off the lane that had it — one flag, one lane ***',
      after.filter((l) => l.clock === 'start').length === 1 &&
        after.find((l) => l.clock === 'start')?.id === newLane.id,
      after.filter((l) => l.clock === 'start').map((l) => l.code).join(','),
    )
    // Put it back, or every later run starts from a different board.
    await saveLane(SITE, actor, {
      id: lane('in_progress').id, code: 'in_progress', name: 'In Progress',
      tone: 'brand', sortOrder: 20, clock: 'start', isLanding: false,
      isClosedStage: false, isCancelledStage: false, isActive: true,
    })
    ok('a lane holding no tickets can be removed', (await deleteLane(SITE, actor, newLane.id)).ok)
  }

  const held = await deleteLane(SITE, actor, lane('in_progress').id)
  ok(
    'a lane holding tickets refuses to go, and says how many',
    !held.ok && /ticket/i.test(held.error),
    held.ok ? 'DELETED' : held.error,
  )

  console.log('\n── 12. Reports, never repairs ─────────────────────────────────')

  /*
   * A ticket the suite has DELIBERATELY broken: in a running lane with no open
   * segment. reconcile has to see it — a bucket that never fires is a bucket
   * nobody can trust.
   *
   * `moveTicket` cannot produce this, because the move and the segment share a
   * transaction. So it is made by hand, which is also the only way it could
   * ever happen in production.
   */
  const broken = await saveTicket(SITE, actor, {
    id: null, customerId, contactId: null, subject: `TKT${stamp} broken clock`,
    description: null, priority: 'normal', statusId: null,
    assigneeUserId: 1, assigneeName: 'Tiaan Smith', source: 'manual',
    category: null, dueAt: null,
  })
  if (broken.ok) {
    await siteExecute(SITE, `UPDATE tickets SET status_id = ? WHERE id = ?`, [
      lane('in_progress').id, broken.id,
    ])
    const caught = await reconcileTickets(SITE)
    ok(
      '*** reconcile CATCHES a running lane with no clock — the drift a hand-edit could cause ***',
      caught.clockMismatch.some((m) => m.id === broken.id),
      `${caught.clockMismatch.length} reported`,
    )
    await siteExecute(SITE, `DELETE FROM tickets WHERE id = ?`, [broken.id])
  }

  console.log('\n── 13. (T9) Nothing left behind ───────────────────────────────')

  await setSetting(SITE, 'ticket_max_running_per_user', capWas ?? '0')
  await sweep()

  /*
   * Reconcile runs AFTER the sweep, deliberately.
   *
   * Running it mid-suite reports the suite's own half-finished fixtures, which
   * is drift the suite created rather than drift the module allows. Once the
   * fixtures are gone, anything left is real — and on a clean site that is
   * nothing.
   */
  const drift = await reconcileTickets(SITE)
  ok(
    '*** nothing is left disagreeing with its lane once the fixtures are gone ***',
    drift.clockMismatch.length === 0,
    drift.clockMismatch.map((m) => m.subject).join(', '),
  )
  ok('and no escalation claim is orphaned', drift.orphanedEscalations.length === 0)

  const litter: string[] = []
  for (const [label, sql, params] of [
    ['tickets', `SELECT id FROM tickets WHERE subject REGEXP ?`, [SUBJECT_PATTERN]],
    ['lanes', `SELECT id FROM ticket_statuses WHERE code REGEXP ?`, [LANE_PATTERN]],
    [
      'orphaned time entries',
      `SELECT id FROM ticket_time_entries WHERE ticket_id NOT IN (SELECT id FROM tickets)`,
      [],
    ],
    [
      'orphaned comments',
      `SELECT id FROM party_comments WHERE entity='ticket' AND entity_id NOT IN (SELECT id FROM tickets)`,
      [],
    ],
  ] as [string, string, unknown[]][]) {
    const rows = await siteQuery<{ id: number }>(SITE, sql, params)
    if (rows.length > 0) litter.push(`${label}: ${rows.length}`)
  }
  ok(
    '(T9) *** the suite leaves NOTHING behind — litter is how another suite fails ***',
    litter.length === 0,
    litter.join(', '),
  )
}

main()
  .then(() => {
    console.log(fails ? `\n${fails} failure(s)` : '\nAll ticket checks passed')
    process.exit(fails ? 1 : 0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
