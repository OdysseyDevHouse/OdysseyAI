// How often the shell asks the server to renew the licence lease.
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
//
// The number has to agree with `REFRESH_HOURS` in src/lib/licence/leaseRules.ts,
// and the two live in different dependency trees — the shell's and the app's —
// so neither can import the other (see appModules.js). Two hand-copied numbers
// in two files is how they drift.
//
// It cannot be shared as code, so it is shared as a stated contract with a test
// that fails when they disagree: scripts/test-licence-refresh.ts reads both and
// compares them. That is the same posture portalApi.ts takes with the signing
// string it cannot share with the portal's own repository.
//
// ── WHAT HAPPENS IF THEY DO DRIFT ───────────────────────────────────────────
//
// Nothing dangerous, which is worth saying plainly so nobody guards this too
// hard. Only LEASE_DAYS decides when a machine locks. If this timer is slower
// than the app's freshness window, some page loads fall through and ask the
// control database themselves — the pre-existing behaviour, just slower. If it
// is faster, the machine asks more often than it needs to. Neither weakens the
// lock; both are waste.

/** Must equal REFRESH_HOURS in src/lib/licence/leaseRules.ts. */
const REFRESH_HOURS = 5

const REFRESH_MS = REFRESH_HOURS * 60 * 60 * 1000

/**
 * The first attempt after launch.
 *
 * A minute, not immediately: the first page the shop opens does an entitlement
 * read of its own, which renews the lease when the line is up and makes this
 * first tick a no-op. Starting them together would mean two machines asking the
 * same question at once on every launch.
 */
const FIRST_RUN_MS = 60_000

module.exports = { REFRESH_HOURS, REFRESH_MS, FIRST_RUN_MS }
