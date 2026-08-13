/**
 * Clocking in and out.
 *
 *   npm run test:staff-time
 *
 * Three properties matter more than the rest:
 *
 *   ONE OPEN ENTRY PER PERSON, enforced by the database rather than by a
 *   SELECT-then-INSERT that two taps can race through.
 *
 *   ONE PIN, ONE ACTION. The same tap clocks in or out depending on where the
 *   person currently is — asking somebody to remember is how a second open
 *   entry gets created.
 *
 *   A CORRECTION IS NEVER SILENT. BCEA s31 requires accurate records, and a
 *   timesheet a manager can quietly rewrite is one staff will not trust.
 */
import { siteExecute, siteQueryOne, siteQuery } from '../src/lib/siteDb'
import {
  clock,
  openEntryFor,
  whoIsOnTheClock,
  entriesBetween,
  createManual,
  editEntry,
  deleteEntry,
  closeForgotten,
} from '../src/lib/site/staffTime'
import { workedMinutes, formatDuration, toHours, looksForgotten } from '../src/lib/timeModel'

const SITE = 1
let failures = 0

function check(label: string, condition: boolean, detail = '') {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

function eq(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} — got ${actual}, expected ${expected}`)
  if (!ok) failures++
}

const PIN = '7391'
let userId = 0
let roleId = 0
const actor = { userId: 1, userName: 'Test Manager' }

/** An ISO string N hours from now, for building entries by hand. */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
}

async function main() {
  /* ── Pure arithmetic ───────────────────────────────────────────────── */
  console.log('\narithmetic')
  eq('a plain eight-hour shift', workedMinutes('2026-08-07T08:00:00Z', '2026-08-07T16:00:00Z', 0), 480)
  eq('a break comes off', workedMinutes('2026-08-07T08:00:00Z', '2026-08-07T16:00:00Z', 30), 450)
  eq('still on the clock is null', workedMinutes('2026-08-07T08:00:00Z', null, 0), null)
  // A break longer than the shift is a typo, not negative work.
  eq('a break longer than the shift floors at zero', workedMinutes('2026-08-07T08:00:00Z', '2026-08-07T09:00:00Z', 120), 0)
  eq('formatted', formatDuration(450), '7h 30m')
  eq('whole hours drop the minutes', formatDuration(480), '8h')
  eq('under an hour', formatDuration(45), '45m')
  eq('nothing worked', formatDuration(0), '0h')
  eq('decimal hours for costing', toHours(450), 7.5)
  check('a twelve-hour entry looks forgotten', looksForgotten(new Date(Date.now() - 13 * 3600_000).toISOString()))
  check('a normal shift does not', !looksForgotten(new Date(Date.now() - 6 * 3600_000).toISOString()))

  /* ── A person who can clock ────────────────────────────────────────── */
  const role = await siteExecute(
    SITE,
    `INSERT INTO roles (name, description) VALUES ('Test Clocker','Temporary, from the test script.')`,
  )
  roleId = role.insertId
  await siteExecute(
    SITE,
    `INSERT INTO role_permissions (role_id, capability, allowed) VALUES (?,'staff.clock',1)`,
    [roleId],
  )

  const bcrypt = (await import('bcryptjs')).default
  const made = await siteExecute(
    SITE,
    `INSERT INTO users (name, user_type, role_id, pin_hash, is_active)
     VALUES ('Test Clocker','pos_only',?,?,1)`,
    [roleId, await bcrypt.hash(PIN, 10)],
  )
  userId = made.insertId

  /* ── Clocking ──────────────────────────────────────────────────────── */
  console.log('\nclocking')
  const inResult = await clock(SITE, PIN, null)
  check('the right PIN clocks in', inResult.ok && inResult.action === 'in', inResult.ok ? '' : inResult.error)

  const open = await openEntryFor(SITE, userId)
  check('an open entry exists', !!open && open.endedAt === null)
  check('it records how they clocked', open?.source === 'pin')

  const onClock = await whoIsOnTheClock(SITE)
  check('they appear on the clock', onClock.some((e) => e.userId === userId))

  // The whole point of one-PIN-one-action: the same tap now clocks them out.
  const outResult = await clock(SITE, PIN, null)
  check('the same PIN clocks out', outResult.ok && outResult.action === 'out')
  check('and the entry now has a duration', (outResult.ok ? outResult.entry.minutes : null) !== null)

  check('they are no longer on the clock', (await openEntryFor(SITE, userId)) === null)

  const backIn = await clock(SITE, PIN, null)
  check('clocking in again starts a new entry', backIn.ok && backIn.action === 'in')

  /* ── One open entry, enforced by the database ──────────────────────── */
  //
  // Not by a prior SELECT — two taps a hundred milliseconds apart would both
  // pass a check-then-insert. This proves the unique index is what refuses it.
  console.log('\none open entry')
  let refused = false
  try {
    await siteExecute(
      SITE,
      `INSERT INTO staff_time_entries (user_id, user_name, started_at, source)
       VALUES (?, 'Test Clocker', NOW(), 'pin')`,
      [userId],
    )
  } catch {
    refused = true
  }
  check('the database refuses a second open entry', refused)

  const stillOne = await siteQuery<{ n: number }>(
    SITE,
    'SELECT COUNT(*) AS n FROM staff_time_entries WHERE user_id = ? AND ended_at IS NULL',
    [userId],
  )
  eq('exactly one is open', Number(stillOne[0].n), 1)

  const manualClash = await createManual(
    SITE,
    { userId, startedAt: hoursAgo(2), endedAt: null, breakMinutes: 0, note: null },
    actor,
  )
  check('a manual open entry is refused too', !manualClash.ok, manualClash.ok ? '' : manualClash.error)

  // Close it so the rest of the suite starts clean.
  await clock(SITE, PIN, null)

  /* ── Who may clock ─────────────────────────────────────────────────── */
  console.log('\npermission')
  await siteExecute(SITE, 'UPDATE role_permissions SET allowed = 0 WHERE role_id = ?', [roleId])
  const denied = await clock(SITE, PIN, null)
  check('without staff.clock they are refused', !denied.ok, denied.ok ? '' : denied.error)
  await siteExecute(SITE, 'UPDATE role_permissions SET allowed = 1 WHERE role_id = ?', [roleId])

  const wrongPin = await clock(SITE, '999999', null)
  check('an unknown PIN is refused', !wrongPin.ok)

  /* ── Manual entry and validation ───────────────────────────────────── */
  console.log('\nmanual entry')
  const manual = await createManual(
    SITE,
    { userId, startedAt: hoursAgo(9), endedAt: hoursAgo(1), breakMinutes: 30, note: 'Forgot to clock' },
    actor,
  )
  check('a manager can enter a shift', manual.ok, manual.ok ? '' : manual.error)

  const backwards = await createManual(
    SITE,
    { userId, startedAt: hoursAgo(1), endedAt: hoursAgo(5), breakMinutes: 0, note: null },
    actor,
  )
  check('ending before starting is refused', !backwards.ok, backwards.ok ? '' : backwards.error)

  const bigBreak = await createManual(
    SITE,
    { userId, startedAt: hoursAgo(5), endedAt: hoursAgo(4), breakMinutes: 120, note: null },
    actor,
  )
  check('a break longer than the shift is refused', !bigBreak.ok, bigBreak.ok ? '' : bigBreak.error)

  const future = await createManual(
    SITE,
    {
      userId,
      startedAt: new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 19).replace('T', ' '),
      endedAt: null,
      breakMinutes: 0,
      note: null,
    },
    actor,
  )
  check('a start time in the future is refused', !future.ok, future.ok ? '' : future.error)

  /* ── The audit trail ───────────────────────────────────────────────── */
  console.log('\ncorrections')
  if (!manual.ok) throw new Error('need the manual entry to test edits')

  const noReason = await editEntry(
    SITE,
    manual.id,
    { startedAt: hoursAgo(9), endedAt: hoursAgo(2), breakMinutes: 30, note: null },
    '',
    actor,
  )
  check('an edit with no reason is refused', !noReason.ok, noReason.ok ? '' : noReason.error)

  const edited = await editEntry(
    SITE,
    manual.id,
    { startedAt: hoursAgo(9), endedAt: hoursAgo(2), breakMinutes: 30, note: null },
    'Left an hour earlier than recorded',
    actor,
  )
  check('an edit with a reason is accepted', edited.ok, edited.ok ? '' : edited.error)

  const after = await siteQueryOne<{
    edited_by_name: string
    edited_reason: string
    original_started_at: string | null
    original_ended_at: string | null
  }>(
    SITE,
    `SELECT edited_by_name, edited_reason, original_started_at, original_ended_at
       FROM staff_time_entries WHERE id = ?`,
    [manual.id],
  )
  check('it records who changed it', after?.edited_by_name === 'Test Manager')
  check('and why', after?.edited_reason === 'Left an hour earlier than recorded')
  check('and what it said before', !!after?.original_started_at && !!after?.original_ended_at)

  const firstOriginal = after?.original_ended_at

  // A second correction must not overwrite the trail, or it records the last
  // mistake rather than what was actually clocked.
  await editEntry(
    SITE,
    manual.id,
    { startedAt: hoursAgo(9), endedAt: hoursAgo(3), breakMinutes: 30, note: null },
    'Corrected again',
    actor,
  )
  const twice = await siteQueryOne<{ original_ended_at: string | null }>(
    SITE,
    'SELECT original_ended_at FROM staff_time_entries WHERE id = ?',
    [manual.id],
  )
  check(
    'a second edit keeps the ORIGINAL, not the last value',
    String(twice?.original_ended_at) === String(firstOriginal),
    `${twice?.original_ended_at} vs ${firstOriginal}`,
  )

  /* ── Approval freezes it ───────────────────────────────────────────── */
  console.log('\napproval')
  await siteExecute(
    SITE,
    'UPDATE staff_time_entries SET approved_at = NOW(), approved_by_name = ? WHERE id = ?',
    ['Test Manager', manual.id],
  )
  const afterApproval = await editEntry(
    SITE,
    manual.id,
    { startedAt: hoursAgo(9), endedAt: hoursAgo(4), breakMinutes: 0, note: null },
    'Trying to change an approved entry',
    actor,
  )
  check('an approved entry cannot be edited', !afterApproval.ok, afterApproval.ok ? '' : afterApproval.error)

  const removeApproved = await deleteEntry(SITE, manual.id)
  check('nor deleted', !removeApproved.ok, removeApproved.ok ? '' : removeApproved.error)

  await siteExecute(SITE, 'UPDATE staff_time_entries SET approved_at = NULL WHERE id = ?', [manual.id])
  check('unapproving allows it again', (await deleteEntry(SITE, manual.id)).ok)

  /* ── A forgotten clock-out ─────────────────────────────────────────── */
  console.log('\nforgotten clock-out')
  const forgotten = await siteExecute(
    SITE,
    `INSERT INTO staff_time_entries (user_id, user_name, started_at, source)
     VALUES (?, 'Test Clocker', ?, 'pin')`,
    [userId, hoursAgo(20)],
  )

  const tooEarly = await closeForgotten(SITE, forgotten.insertId, hoursAgo(22), actor)
  check('closing before they clocked in is refused', !tooEarly.ok, tooEarly.ok ? '' : tooEarly.error)

  const closed = await closeForgotten(SITE, forgotten.insertId, hoursAgo(12), actor)
  check('a manager can close it', closed.ok, closed.ok ? '' : closed.error)

  const closedRow = await siteQueryOne<{ edited_reason: string; ended_at: string }>(
    SITE,
    'SELECT edited_reason, ended_at FROM staff_time_entries WHERE id = ?',
    [forgotten.insertId],
  )
  check('and the reason writes itself', !!closedRow?.edited_reason?.includes('no clock-out'))
  check('closing twice is refused', !(await closeForgotten(SITE, forgotten.insertId, hoursAgo(11), actor)).ok)

  /* ── Ranges ────────────────────────────────────────────────────────── */
  //
  // A night shift beginning at 22:00 on the 31st belongs to that month. A range
  // test on started_at alone would drop it from both.
  console.log('\nranges')
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  const mine = await entriesBetween(SITE, today, today, userId)
  check('today’s entries come back', mine.length > 0, `${mine.length} entries`)
  check('and only this person’s', mine.every((e) => e.userId === userId))
}

async function cleanup() {
  console.log('\ncleaning up...')
  if (userId) {
    await siteExecute(SITE, 'DELETE FROM staff_time_entries WHERE user_id = ?', [userId]).catch(() => {})
    await siteExecute(SITE, 'DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
  if (roleId) {
    await siteExecute(SITE, 'DELETE FROM roles WHERE id = ?', [roleId]).catch(() => {})
  }
  console.log('removed the test user and role')
}

main()
  .then(async () => {
    await cleanup()
    console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n')
    process.exit(failures ? 1 : 0)
  })
  .catch(async (error) => {
    await cleanup()
    console.error('\n', error)
    process.exit(1)
  })
