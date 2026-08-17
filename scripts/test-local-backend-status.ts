/**
 * The verdict a support agent reads first.
 *
 * A local-backend site has state in three places — the machine's lease, what it
 * escrowed, and whether its replica is keeping up — and this collapses them
 * into one sentence. Getting the ORDER wrong is the failure that matters: a
 * machine that is both locked and behind on replication has one problem worth
 * naming, and naming the wrong one sends an agent to the wrong subsystem while
 * a shop cannot trade.
 *
 *   npx tsx --conditions=react-server scripts/test-local-backend-status.ts
 */
import { overallVerdict, type LocalBackendStatus } from '../src/lib/licence/localBackendStatus'
import type { Lease } from '../src/lib/licence/leaseRules'
import type { ModuleKey } from '../src/lib/control/modules'

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const DAY = 86_400_000
const now = Date.now()

function machine(over = {}) {
  return {
    deviceSerial: 'TILL-A',
    dbPort: 33071,
    dbName: 'odyssey_site_7',
    escrowedAt: new Date(now - 30 * DAY),
    lastSeenAt: new Date(now - 60_000),
    hasEscrowedPassword: true,
    hasUnlockSecret: true,
    unlockCount: 0,
    lastUnlockAt: null,
    ...over,
  }
}

function lease(over: Partial<Lease> = {}): Lease {
  return {
    siteId: 7,
    deviceSerial: 'TILL-A',
    licenceStatus: 'licensed',
    held: new Set<ModuleKey>(['starter']),
    endingOn: new Map(),
    accountStatus: 'active',
    checkedAt: new Date(now - 60_000),
    expiresAt: new Date(now + 6 * DAY),
    unlockCounter: 0,
    lastUnlockAt: null,
    ...over,
  }
}

function replica(over = {}) {
  return {
    siteId: 7,
    deviceSerial: 'TILL-A',
    host: 'db-internal',
    port: 3306,
    databaseName: 'odyssey_replica_7',
    status: 'running' as const,
    secondsBehind: 2,
    lastContactAt: new Date(now - 5_000),
    lastError: null,
    credentialsUsable: true,
    ...over,
  }
}

function status(over: Partial<LocalBackendStatus> = {}): LocalBackendStatus {
  return {
    machines: [machine()],
    lease: lease(),
    replica: replica(),
    ...over,
  } as LocalBackendStatus
}

console.log('\nThe healthy case')
{
  const v = overallVerdict(status())
  check('reads as success', v.tone === 'success', v.headline)
  check('and says so plainly', /up to date/i.test(v.headline))
}

console.log('\nNothing installed yet')
{
  const v = overallVerdict(status({ machines: [], lease: null, replica: null }))
  check('is neutral, not an error', v.tone === 'neutral', v.headline)
  check('and says what is missing', /registered/i.test(v.headline))
}

console.log('\nA locked machine outranks everything else')
{
  /* Both problems at once. The lock is what stops the shop trading, so it is
     the one an agent must be sent to first. */
  const v = overallVerdict(
    status({
      lease: lease({ expiresAt: new Date(now - DAY), checkedAt: new Date(now - 9 * DAY) }),
      replica: replica({ status: 'stopped', secondsBehind: null }),
    }),
  )
  check('is danger', v.tone === 'danger', v.headline)
  check('and names the LOCK, not the replica', /locked/i.test(v.headline))
  check('with the number of days', /9 days/.test(v.headline), v.headline)
}

console.log('\nTrading but drifting toward a lock')
{
  const v = overallVerdict(status({ lease: lease({ checkedAt: new Date(now - 4 * DAY) }) }))
  check('warns', v.tone === 'warning', v.headline)
  check('and says it is still trading', /trading/i.test(v.headline))
  check('with the silence named', /4 days/.test(v.headline))
}

console.log('\nA day or two of silence is not worth a warning')
{
  const v = overallVerdict(status({ lease: lease({ checkedAt: new Date(now - 2 * DAY) }) }))
  check('stays quiet', v.tone === 'success', v.headline)
}

console.log('\nNo replica provisioned')
{
  const v = overallVerdict(status({ replica: null }))
  check('warns rather than fails', v.tone === 'warning', v.headline)
  check('and explains the consequence', /reporting replica/i.test(v.headline))
}

console.log('\nA stopped replica')
{
  const v = overallVerdict(status({ replica: replica({ status: 'stopped', secondsBehind: null }) }))
  check('is danger', v.tone === 'danger', v.headline)
  check('and names the state', /stopped/i.test(v.headline))
}

console.log('\nA lagging replica')
{
  const v = overallVerdict(status({ replica: replica({ secondsBehind: 1_800 }) }))
  check('warns', v.tone === 'warning', v.headline)
  check('in minutes a person can act on', /30 minutes/.test(v.headline), v.headline)
}

console.log('\nA few seconds behind is up to date')
{
  const v = overallVerdict(status({ replica: replica({ secondsBehind: 120 }) }))
  check('does not warn', v.tone === 'success', v.headline)
}

console.log('\nAn unreachable shop does not read as broken')
{
  /* From head office the shop's own database is normally unreachable — that is
     the premise of a local backend, not a fault. A null lease must not become
     a red verdict, or every healthy site would look broken from here. */
  const v = overallVerdict(status({ lease: null }))
  check('falls through to the replica', v.tone === 'success', v.headline)
}

console.log(failures === 0 ? '\nLocal-backend verdicts hold.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
