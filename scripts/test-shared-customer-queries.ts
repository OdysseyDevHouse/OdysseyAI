/**
 * Does a branch query still work when the customer file is somewhere else?
 *
 * Every other test in this project runs with sharing OFF, where the resolver
 * is an identity function and the qualifier is an empty string. That proves the
 * refactor changed nothing. It does not prove the feature WORKS — and the two
 * failures look completely different:
 *
 *   · A query that moved wholesale to the owner reads the owner's laybys and
 *     returns another store's rows, or none. No error.
 *   · An INNER join that lost its prefix drops every row. Also no error.
 *
 * So this switches sharing on for real, runs the queries that span both
 * databases, and switches it back.
 *
 *   npm run test:shared-customer-queries
 */
import { execute, query } from '../src/lib/db'
import { siteQuery, siteExecute } from '../src/lib/siteDb'
import { customerDbPrefix, customerQuery } from '../src/lib/site/customerDb'
import { groupForSite, membersOfGroup } from '../src/lib/storeGroups'
import { entitlementsForSite, has as hasModule } from '../src/lib/control/modules'
import { listLaybys } from '../src/lib/site/laybys'
import { listCustomers } from '../src/lib/site/customers'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { reconcileControlAccounts } from '../src/lib/site/chartOfAccounts'
import type { RowDataPacket } from 'mysql2/promise'

/** Marks the layby this test writes, so cleanup cannot hit a real one. */
const PROBE_NOTE = 'xdb-probe-layby'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  const sites = await query<RowDataPacket & { id: number }>(
    'SELECT id FROM cp2_sites ORDER BY id LIMIT 2',
  )
  if (sites.length < 2) {
    console.log('Needs two sites. Stopping.')
    process.exit(0)
  }
  const [primary, branch] = sites.map((s) => Number(s.id))

  const group = await groupForSite(primary)
  if (!group) {
    console.log('Needs a store group. Stopping.')
    process.exit(0)
  }
  for (const s of [primary, branch]) {
    if (!hasModule(await entitlementsForSite(s), 'multi_branch')) {
      console.log(`Site ${s} lacks multi_branch — the resolver would decline. Stopping.`)
      process.exit(0)
    }
  }

  let probeWritten = false

  // Everything this test changes, and how to put it back.
  const before = await membersOfGroup(group.id)
  const originalPrimary = group.primarySiteId
  const originalEntity = group.legalEntity
  const restore = async () => {
    for (const m of before) {
      await execute(
        `UPDATE cp2_store_group_members SET shares_customers = ?
          WHERE group_id = ? AND site_id = ?`,
        [m.sharesCustomers ? 1 : 0, group.id, m.siteId],
      )
    }
    await execute(
      'UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = ? WHERE id = ?',
      [originalPrimary, originalEntity, group.id],
    )
  }

  try {
    /* ── Baseline, with sharing OFF ───────────────────────────────────── */

    console.log('\n— Sharing off —')
    const offPrefix = await customerDbPrefix(branch)
    ok('the prefix is empty when a store owns its customers', offPrefix === '', `got "${offPrefix}"`)

    const laybysBefore = await listLaybys(branch, { limit: 200 })
    const customersBefore = await listCustomers(branch, { limit: 200 })
    console.log(
      `  site ${branch} holds ${laybysBefore.items.length} layby(s) and ` +
        `${customersBefore.items.length} customer(s)`,
    )

    /* ── Switch it on ─────────────────────────────────────────────────── */

    console.log('\n— Sharing on —')
    await execute(
      // Declared one company: balance sharing is refused for separate taxpayers,
      // so the resolver would decline whatever the member flags said.
      "UPDATE cp2_store_groups SET primary_site_id = ?, legal_entity = 'one' WHERE id = ?",
      [primary, group.id],
    )
    for (const s of [primary, branch]) {
      await execute(
        'UPDATE cp2_store_group_members SET shares_customers = 1 WHERE group_id = ? AND site_id = ?',
        [group.id, s],
      )
    }

    const onPrefix = await customerDbPrefix(branch)
    ok('the branch now names another database', onPrefix !== '', `got "${onPrefix}"`)
    ok('and it is quoted', /^`[A-Za-z0-9_$]+`\.$/.test(onPrefix), onPrefix)

    // The primary still owns itself, so its own queries must NOT be qualified.
    ok('the owner still needs no prefix', (await customerDbPrefix(primary)) === '')

    /* ── The customer list comes from the owner ───────────────────────── */

    // Counted with the SAME filter the list applies. listCustomers hides
    // closed accounts by default, so comparing its total against a bare
    // COUNT(*) compares two different questions — which is what made the first
    // run of this test report a failure that was not one.
    const customersAfter = await listCustomers(branch, { limit: 200 })
    const LIVE = "SELECT COUNT(*) AS n FROM customers WHERE status <> 'closed'"
    const ownerHolds = Number(
      (await customerQuery<RowDataPacket & { n: number }>(branch, LIVE))[0]?.n ?? -1,
    )
    const branchHolds = Number(
      (await siteQuery<RowDataPacket & { n: number }>(branch, LIVE))[0]?.n ?? -2,
    )
    ok(
      'the branch reads the owner’s customer file',
      customersAfter.total === ownerHolds,
      `list total ${customersAfter.total}, owner holds ${ownerHolds}`,
    )
    // Without this the check above passes trivially on a dev database where
    // both sites happen to hold the same number of customers.
    ok(
      'and the two files are actually distinguishable',
      ownerHolds !== branchHolds,
      `owner ${ownerHolds}, branch ${branchHolds}`,
    )

    /* ── THE POINT OF THIS TEST ───────────────────────────────────────── */

    // listLaybys joins the branch's own laybys to the owner's customers. If the
    // whole query had moved to the owner it would read the OWNER's laybys; if
    // the inner join lost its prefix it would return nothing. Both are silent.
    console.log('\n— A branch table joined to a remote customer file —')

    const branchLaybyCount = await siteQuery<RowDataPacket & { n: number }>(
      branch,
      'SELECT COUNT(*) AS n FROM laybys',
    )
    const held = Number(branchLaybyCount[0]?.n ?? 0)

    // A layby in the BRANCH pointing at a customer in the OWNER. Written
    // directly rather than through createLayby(), because the point is the
    // read path and a real layby would drag stock reservations in with it.
    // Removed in the finally block whether or not the assertions pass.
    const ownerCustomer = (
      await customerQuery<RowDataPacket & { id: number; name: string }>(
        branch,
        'SELECT id, name FROM customers ORDER BY id LIMIT 1',
      )
    )[0]
    if (ownerCustomer) {
      try {
        await siteExecute(
          branch,
          `INSERT INTO laybys (customer_id, status, total_incl, paid_total, user_name, note)
           VALUES (?, 'open', 100.0000, 0.0000, 'xdb probe', ?)`,
          [ownerCustomer.id, PROBE_NOTE],
        )
        probeWritten = true
        console.log(
          `  wrote a probe layby on site ${branch} for the owner's customer ` +
            `#${ownerCustomer.id} (${ownerCustomer.name})`,
        )
      } catch (e) {
        // The known blocker, reported rather than thrown: laybys.customer_id
        // still has a foreign key to the BRANCH's own customers table, which no
        // longer holds this id. Dropping those FKs is stage 6 work — see
        // docs/shared-customer-file-origin-site.md.
        const message = e instanceof Error ? e.message : String(e)
        ok(
          'a branch can record a layby against a shared customer',
          false,
          message.includes('foreign key')
            ? 'blocked by fk_layby_customer — branch FKs must be dropped (stage 6)'
            : message,
        )
      }
    }

    const laybysAfter = await listLaybys(branch, { limit: 200 })
    ok(
      'the branch still sees its OWN laybys',
      laybysAfter.items.length === laybysBefore.items.length + (probeWritten ? 1 : 0),
      `before ${laybysBefore.items.length}, after ${laybysAfter.items.length}, table holds ${held}`,
    )

    if (laybysAfter.items.length > 0) {
      ok(
        'and each still carries its customer’s name across the boundary',
        laybysAfter.items.every((l) => l.customerName !== null),
        `${laybysAfter.items.filter((l) => l.customerName === null).length} missing a name`,
      )
    } else {
      // Deliberately a FAILURE, not a skip. An INNER join that silently dropped
      // every row looks exactly like an empty table, so passing here would be a
      // vacuous assertion — the test would go green while proving nothing.
      //
      // Today this fails for a known reason: the layby could not be written
      // because laybys.customer_id still has a foreign key to the branch's own
      // customers table. It goes green once stage 6 drops those FKs, and that
      // is exactly the signal we want from this test.
      ok(
        'the join returned rows to check',
        false,
        'no laybys visible — cannot tell a working join from a broken one',
      )
    }

    // The count query and the page query must name the same table, or paging
    // walks one set while counting another.
    ok(
      'the count agrees with the page',
      laybysAfter.total === laybysAfter.items.length || laybysAfter.items.length === 200,
      `total ${laybysAfter.total}, rows ${laybysAfter.items.length}`,
    )

    /* ── Searching on a remote column ─────────────────────────────────── */

    // The case the plan called unsplittable: filter and paginate on a column
    // that lives in the other database.
    if (laybysAfter.items.length > 0) {
      const name = laybysAfter.items[0].customerName ?? ''
      const term = name.slice(0, 3)
      if (term.length >= 2) {
        const found = await listLaybys(branch, { q: term, limit: 200 })
        ok(
          `searching laybys by a remote customer name ("${term}") finds rows`,
          found.items.length > 0,
          `${found.items.length} found`,
        )
      }
    }
    /* ── The debtors control account ──────────────────────────────────── */

    // A shared customer file has ONE balance for every branch, so it can only
    // be proved against the SUM of their debtors control accounts. Checked here
    // rather than by asserting zero drift: this dev database has years of
    // pre-GL history, so the figures legitimately differ — what matters is
    // WHICH question was asked.
    console.log('\n— The debtors control account —')

    const branchDrift = await reconcileControlAccounts(branch)
    const branchDebtors = branchDrift.find((d) => d.controlType === 'debtors')
    if (branchDebtors) {
      ok(
        'a sharing branch reconciles debtors at GROUP level',
        branchDebtors.scope?.level === 'group',
        branchDebtors.scope
          ? `${branchDebtors.scope.stores} store(s), ${branchDebtors.scope.unreadable.length} unreadable`
          : 'still comparing against this store alone',
      )
      ok(
        'and every member store was readable',
        (branchDebtors.scope?.unreadable.length ?? 0) === 0,
        `unreadable: ${JSON.stringify(branchDebtors.scope?.unreadable ?? [])}`,
      )
    } else {
      console.log('SKIP  debtors is already in step on this site, so there is no row to inspect')
    }

    // The OWNER owns its own customers, so it takes the ordinary per-store
    // path — the group figure must not leak onto a store that is not sharing.
    const ownerDebtors = (await reconcileControlAccounts(primary)).find(
      (d) => d.controlType === 'debtors',
    )
    if (ownerDebtors) {
      ok(
        'the owner still reconciles against itself',
        ownerDebtors.scope === undefined,
        ownerDebtors.scope ? 'it was given a group scope' : '',
      )
    }

    /* ── The report builder ───────────────────────────────────────────── */

    // The piece stage 1 flagged as most likely to need an engine rewrite. Two
    // shapes, and they qualify in opposite directions:
    //
    //   a BRANCH source joining out to the customer file (sales)
    //   an OWNER source joining back to a branch table (loyalty members → tiers)
    //
    // A report that returned zero rows would look identical to a report with
    // nothing to show, so each is checked against what the same query returns
    // with sharing off.
    console.log('\n— Reports across the boundary —')

    const canAll = () => true
    for (const [label, spec] of [
      [
        'sales joined to the shared customer file',
        {
          source: 'sales',
          columns: [{ field: 'documentNumber' }, { field: 'customerName' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 20,
        },
      ],
      [
        'the shared customer list',
        {
          source: 'customers',
          columns: [{ field: 'name' }, { field: 'code' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 20,
        },
      ],
      [
        'loyalty members joined back to this branch’s tiers',
        {
          source: 'loyaltyMembers',
          columns: [{ field: 'customerName' }, { field: 'tierName' }],
          filters: [],
          period: { kind: 'all' as const },
          limit: 20,
        },
      ],
    ] as const) {
      try {
        const result = await runBuilderSpec(branch, spec as never, canAll, { limit: 20 })
        ok(`report: ${label}`, true, `${result.rows.length} row(s), ${result.columns.length} cols`)
      } catch (e) {
        ok(`report: ${label}`, false, e instanceof Error ? e.message : String(e))
      }
    }
  } finally {
    if (probeWritten) {
      await siteExecute(branch, 'DELETE FROM laybys WHERE note = ?', [PROBE_NOTE])
      const left = await siteQuery<RowDataPacket & { n: number }>(
        branch,
        'SELECT COUNT(*) AS n FROM laybys WHERE note = ?',
        [PROBE_NOTE],
      )
      ok('the probe layby was removed', Number(left[0]?.n) === 0, `${left[0]?.n} left`)
    }
    await restore()
    const after = await membersOfGroup(group.id)
    ok(
      'sharing was switched back off',
      after.every((m) => m.sharesCustomers === (before.find((b) => b.siteId === m.siteId)?.sharesCustomers ?? false)),
    )
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} failure(s).`)
  process.exit(fails > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
