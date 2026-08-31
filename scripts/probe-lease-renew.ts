/**
 * Renew this machine's licence lease once, the way the five-hour timer does.
 *
 * Calls the same refreshEntitlements() the /api/licence/refresh route calls, so
 * this exercises the real renewal path rather than a copy of it — including the
 * part that matters most, which is that `checked_at` moves only on a genuine
 * answer from the control database.
 *
 * Run with the machine's own ODYSSEY_SITE_* environment (see
 * electron/machineConfig.js for where those values live on a provisioned box):
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-lease-renew.ts
 */
import { refreshEntitlements } from '../src/lib/control/modules'
import { readLease, leaseState } from '../src/lib/licence/lease'
import { leaseIsFresh } from '../src/lib/licence/leaseRules'

async function main() {
  const siteId = Number(process.env.ODYSSEY_SITE_ID)

  if (!Number.isFinite(siteId) || siteId <= 0) {
    console.error('Set ODYSSEY_SITE_ID (and the other ODYSSEY_SITE_DB_* values) first.')
    process.exit(1)
  }

  console.log(`\nRenewing the lease for site ${siteId}\n`)

  const before = await readLease(siteId)
  console.log('  before:', before ? `checked ${before.checkedAt.toISOString()}` : 'no lease row')

  const result = await refreshEntitlements(siteId)
  console.log('  refreshEntitlements ->', result)

  const after = await readLease(siteId)
  if (!after) {
    console.log('  after:  still no lease row')
  } else {
    console.log('  after:  checked', after.checkedAt.toISOString())
    console.log('          expires', after.expiresAt.toISOString())
    console.log('          status ', after.licenceStatus)
    console.log('          modules', [...after.held].join(', ') || '(none)')
    console.log('          fresh  ', leaseIsFresh(after))
    console.log('          state  ', leaseState(after).status)
  }

  process.exit(0)
}

void main()
