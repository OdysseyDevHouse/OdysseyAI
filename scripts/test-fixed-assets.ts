/**
 * Fixed assets and depreciation.
 *
 * The rules that matter, and what breaks if they slip:
 *
 *   AN ASSET NEVER DEPRECIATES BELOW ITS RESIDUAL. Rounding a monthly figure
 *   and multiplying it by the life almost never lands exactly on
 *   (cost − residual), so the final month must be a balancing figure. Without
 *   it an asset either goes negative or stops a few rand short for ever.
 *
 *   A MONTH IS NEVER CHARGED TWICE. Doubling depreciation understates profit
 *   and takes every asset past its residual, silently.
 *
 *   A DISPOSED OR NOT-YET-USED ASSET IS SKIPPED, with a reason rather than a
 *   silent zero.
 *
 *   THE REGISTER AND THE LEDGER AGREE. accumulated_depreciation equals the
 *   posted run items, and the journal balances.
 *
 *   npm run test:fixed-assets
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  listCategories, createAsset, updateAsset, getAsset, listAssets,
  assetSummary, disposeAsset, reconcileAssets, assetSchedule,
} from '../src/lib/site/fixedAssets'
import {
  proposeRun, postRun, listItems, getRun, cancelRun, excludeItem, nextPeriod,
} from '../src/lib/site/depreciationRuns'
import { getBatch } from '../src/lib/site/journals'
import { trialBalance } from '../src/lib/site/financialStatements'
import { reconcileAccountBalances } from '../src/lib/site/chartOfAccounts'
import {
  chargeFor, schedule, monthlyAmount, depreciableAmount, disposalResult,
  refuseAsset, bookValue, monthsBetween,
} from '../src/lib/assetModel'
import { round, toNum } from '../src/lib/decimals'

const SITE = 1
const actor = { userId: 1, userName: 'Asset Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const stamp = Date.now().toString().slice(-6)
const created = { assets: [] as number[], runs: [] as number[], batches: [] as number[] }

async function main() {
  console.log('\n── The arithmetic ──────────────────────────────────────────\n')

  ok('depreciable amount is cost less residual', depreciableAmount(24000, 0) === 24000)
  ok('  and residual is excluded', depreciableAmount(300000, 60000) === 240000)
  ok('  never negative when residual exceeds cost', depreciableAmount(1000, 5000) === 0)

  ok('R24 000 over 36 months is 666.67 a month', monthlyAmount(24000, 0, 36) === 666.67)
  ok('a zero life charges nothing', monthlyAmount(24000, 0, 0) === 0)

  const laptop = {
    id: 1, status: 'active' as const, cost: 24000, residualValue: 0, lifeMonths: 36,
    depreciationStart: '2026-01-01', accumulatedDepreciation: 0, lastDepreciatedTo: null,
  }

  const first = chargeFor(laptop, '2026-01-15')
  ok('the first month charges the even amount', first.amount === 666.67, String(first.amount))
  ok('  and reports the closing book value', first.closingBookValue === round(24000 - 666.67, 2))

  ok('a month before the start charges nothing',
      chargeFor(laptop, '2025-12-01').amount === 0)
  ok('  and says why', chargeFor(laptop, '2025-12-01').skipReason !== null)

  // THE over-depreciation guard.
  const nearlyDone = { ...laptop, accumulatedDepreciation: 23800, lastDepreciatedTo: '2028-10-01' }
  const final = chargeFor(nearlyDone, '2028-11-01')
  ok('*** the final month charges only what remains ***', final.amount === 200,
      String(final.amount))
  ok('  and is flagged as the last one', final.isFinal)
  ok('*** it lands exactly on zero, not below ***', final.closingBookValue === 0,
      String(final.closingBookValue))

  const done = { ...laptop, accumulatedDepreciation: 24000, lastDepreciatedTo: '2028-11-01' }
  ok('*** a fully depreciated asset charges nothing ***', chargeFor(done, '2028-12-01').amount === 0)
  ok('  and says so', chargeFor(done, '2028-12-01').skipReason === 'Fully depreciated.')

  // THE double-charge guard.
  const charged = { ...laptop, accumulatedDepreciation: 666.67, lastDepreciatedTo: '2026-01-01' }
  ok('*** a month already charged is refused ***',
      chargeFor(charged, '2026-01-20').amount === 0)
  ok('  and the next month proceeds', chargeFor(charged, '2026-02-01').amount === 666.67)

  ok('a disposed asset charges nothing',
      chargeFor({ ...laptop, status: 'disposed' }, '2026-06-01').amount === 0)
  ok('a pending asset charges nothing',
      chargeFor({ ...laptop, status: 'pending' }, '2026-06-01').amount === 0)

  // The full schedule must sum to exactly the depreciable amount.
  const rows = schedule(laptop)
  const scheduleTotal = rows.reduce((sum, r) => round(sum + r.amount, 2), 0)
  ok('*** THE SCHEDULE SUMS TO THE DEPRECIABLE AMOUNT ***', scheduleTotal === 24000,
      `${scheduleTotal} over ${rows.length} months`)
  ok('  ending at zero book value', rows[rows.length - 1]?.bookValue === 0)

  // An awkward number: 7 months does not divide evenly.
  const awkward = { ...laptop, cost: 10000, lifeMonths: 7 }
  const awkwardRows = schedule(awkward)
  const awkwardTotal = awkwardRows.reduce((sum, r) => round(sum + r.amount, 2), 0)
  ok('*** an awkward division still sums exactly ***', awkwardTotal === 10000,
      `${awkwardTotal} over ${awkwardRows.length} months`)

  // With a residual it must stop AT the residual.
  const vehicle = { ...laptop, cost: 300000, residualValue: 60000, lifeMonths: 60 }
  const vehicleRows = schedule(vehicle)
  ok('*** a residual is never depreciated through ***',
      vehicleRows[vehicleRows.length - 1]?.bookValue === 60000,
      String(vehicleRows[vehicleRows.length - 1]?.bookValue))

  // Disposal maths.
  const sold = disposalResult(300000, 180000, 150000)
  ok('a sale above book value is a profit', sold.isProfit && sold.result === 30000,
      `book ${sold.bookValue}, result ${sold.result}`)
  const scrapped = disposalResult(24000, 8000, 0)
  ok('scrapping mid-life is a loss', !scrapped.isProfit && scrapped.result === -16000,
      String(scrapped.result))

  // Refusals.
  ok('a residual above cost is refused',
      refuseAsset({ name: 'x', cost: 1000, residualValue: 2000, lifeMonths: 12 }) !== null)
  ok('a zero life is refused',
      refuseAsset({ name: 'x', cost: 1000, lifeMonths: 0 }) !== null)
  ok('*** depreciating before acquisition is refused ***',
      refuseAsset({ name: 'x', cost: 1000, lifeMonths: 12,
        acquiredOn: '2026-06-01', depreciationStart: '2026-01-01' }) !== null)
  ok('a valid asset passes',
      refuseAsset({ name: 'x', cost: 1000, lifeMonths: 12,
        acquiredOn: '2026-01-01', depreciationStart: '2026-01-01' }) === null)

  console.log('\n── The register ────────────────────────────────────────────\n')

  const categories = await listCategories(SITE)
  ok('categories are seeded', categories.length >= 4, `${categories.length}`)

  const computers = categories.find((c) => c.code === 'COMP')
  const vehicles = categories.find((c) => c.code === 'VEH')
  ok('computers depreciate over 3 years', computers?.defaultLifeMonths === 36)
  ok('*** vehicles carry a residual by default ***', (vehicles?.defaultResidualPct ?? 0) > 0,
      `${vehicles?.defaultResidualPct}%`)
  ok('  and are mapped to their own accounts',
      vehicles?.costAccountId !== null && vehicles?.accumAccountId !== null)

  if (!computers) return finish()

  // An asset that will be fully depreciated within the test, so the final-month
  // rule is exercised against the database rather than only in the pure layer.
  const asset = await createAsset(SITE, actor, {
    name: `Test laptop ${stamp}`,
    categoryId: computers.id,
    cost: 3000,
    residualValue: 0,
    lifeMonths: 3,
    acquiredOn: '2026-01-05',
    depreciationStart: '2026-01-01',
    serialNumber: `SN${stamp}`,
  })
  ok('an asset is created', asset.ok, asset.ok ? asset.assetCode : asset.error)
  if (!asset.ok) return finish()
  created.assets.push(asset.id)

  ok('  with a generated code', /^FA\d+/.test(asset.assetCode))

  const loaded = await getAsset(SITE, asset.id)
  ok('  it carries at cost before depreciation', loaded?.bookValue === 3000)
  ok('  and is not yet fully depreciated', loaded?.fullyDepreciated === false)

  const sched = await assetSchedule(SITE, asset.id)
  ok('  its schedule runs for the life', sched.length === 3, `${sched.length} months`)

  console.log('\n── A depreciation run ──────────────────────────────────────\n')

  const jan = await proposeRun(SITE, actor, '2026-01-01')
  ok('a run is proposed', jan.ok, jan.ok ? `${jan.charged} assets, ${jan.total}` : jan.error)
  if (!jan.ok) return finish()
  created.runs.push(jan.runId)

  const janItems = await listItems(SITE, jan.runId)
  const mine = janItems.find((i) => i.assetId === asset.id)
  ok('  our asset is on it', mine !== undefined)
  ok('  charging a third of the cost', mine?.amount === 1000, String(mine?.amount))
  ok('  with the workings kept', mine?.cost === 3000 && mine?.openingAccumulated === 0)

  const beforePost = await getAsset(SITE, asset.id)
  ok('*** a draft run charges nothing ***', beforePost?.accumulatedDepreciation === 0)

  const posted = await postRun(SITE, actor, jan.runId)
  ok('the run posts', posted.ok, posted.ok ? `${posted.posted} assets, ${posted.total}` : posted.error)
  if (posted.ok && posted.batchId) created.batches.push(posted.batchId)

  const afterPost = await getAsset(SITE, asset.id)
  ok('  the register moved', afterPost?.accumulatedDepreciation === 1000,
      String(afterPost?.accumulatedDepreciation))
  ok('  the book value dropped', afterPost?.bookValue === 2000)
  ok('  and the month is recorded', afterPost?.lastDepreciatedTo === '2026-01-01')

  if (posted.ok && posted.batchId) {
    const batch = await getBatch(SITE, posted.batchId)
    ok('*** the ledger entry balances ***', batch?.totalDebit === batch?.totalCredit,
        `${batch?.totalDebit} / ${batch?.totalCredit}`)
    ok('  debiting depreciation expense',
        batch?.lines.some((l) => l.accountCode === '6180' && l.debit > 0) === true)
    ok('  and crediting accumulated depreciation',
        batch?.lines.some((l) => l.accountCode === '1510' && l.credit > 0) === true)
  }

  // THE double-charge guard, against the database.
  const janAgain = await proposeRun(SITE, actor, '2026-01-01')
  ok('*** the same month cannot be charged twice ***', !janAgain.ok,
      janAgain.ok ? 'IT PROPOSED' : janAgain.error)

  // Run the remaining two months, so the final-month rule is exercised.
  for (const month of ['2026-02-01', '2026-03-01']) {
    const run = await proposeRun(SITE, actor, month)
    if (run.ok) {
      created.runs.push(run.runId)
      const result = await postRun(SITE, actor, run.runId)
      if (result.ok && result.batchId) created.batches.push(result.batchId)
    }
  }

  const finished = await getAsset(SITE, asset.id)
  ok('*** THE ASSET LANDS EXACTLY ON ZERO ***', finished?.bookValue === 0,
      `book ${finished?.bookValue}, accumulated ${finished?.accumulatedDepreciation}`)
  ok('  and is flagged fully depreciated', finished?.fullyDepreciated === true)

  // A fourth month must charge nothing at all.
  const april = await proposeRun(SITE, actor, '2026-04-01')
  if (april.ok) {
    created.runs.push(april.runId)
    const aprilItems = await listItems(SITE, april.runId)
    const ours = aprilItems.find((i) => i.assetId === asset.id)
    ok('*** a fully depreciated asset is skipped, not charged ***',
        ours?.status === 'skipped' && ours?.amount === 0, ours?.skipReason ?? '')
    await cancelRun(SITE, actor, april.runId)
    created.runs = created.runs.filter((r) => r !== april.runId)
  }

  console.log('\n── Editing guards ──────────────────────────────────────────\n')

  const costChange = await updateAsset(SITE, actor, asset.id, {
    name: `Test laptop ${stamp}`, categoryId: computers.id, cost: 5000,
    lifeMonths: 3, acquiredOn: '2026-01-05',
  })
  ok('*** the cost of a depreciated asset cannot change ***', !costChange.ok,
      costChange.ok ? 'IT CHANGED' : costChange.error)

  const rename = await updateAsset(SITE, actor, asset.id, {
    name: `Renamed ${stamp}`, categoryId: computers.id, cost: 3000,
    lifeMonths: 3, acquiredOn: '2026-01-05',
  })
  ok('  but it can still be renamed', rename.ok, rename.ok ? '' : rename.error)

  console.log('\n── Disposal ────────────────────────────────────────────────\n')

  const second = await createAsset(SITE, actor, {
    name: `Test bakkie ${stamp}`,
    categoryId: vehicles?.id ?? computers.id,
    cost: 100000,
    residualValue: 20000,
    lifeMonths: 60,
    acquiredOn: '2026-01-05',
    depreciationStart: '2026-01-01',
  })
  if (!second.ok) return finish()
  created.assets.push(second.id)

  ok('disposal needs a reason',
      !(await disposeAsset(SITE, actor, second.id, {
        disposedOn: '2026-06-30', proceeds: 90000, reason: '',
      })).ok)

  const disposal = await disposeAsset(SITE, actor, second.id, {
    disposedOn: '2026-06-30',
    proceeds: 90000,
    reason: 'Sold to a staff member',
  })
  ok('an asset can be disposed of', disposal.ok,
      disposal.ok ? `book ${disposal.bookValue}, result ${disposal.result}` : disposal.error)

  if (disposal.ok) {
    if (disposal.batchId) created.batches.push(disposal.batchId)

    const gone = await getAsset(SITE, second.id)
    ok('  its status changes', gone?.status === 'disposed')
    ok('  the proceeds are recorded', gone?.disposalProceeds === 90000)
    ok('*** and the profit on sale is computed ***', gone?.disposalResult === 90000 - 100000 + 0,
        String(gone?.disposalResult))

    if (disposal.batchId) {
      const batch = await getBatch(SITE, disposal.batchId)
      ok('  the disposal journal balances', batch?.totalDebit === batch?.totalCredit,
          `${batch?.totalDebit} / ${batch?.totalCredit}`)
      ok('  removing the asset at cost',
          batch?.lines.some((l) => l.credit === 100000) === true)
    }

    ok('disposing twice is refused',
        !(await disposeAsset(SITE, actor, second.id, {
          disposedOn: '2026-07-01', proceeds: 0, reason: 'again',
        })).ok)

    const register = await listAssets(SITE)
    ok('*** a disposed asset leaves the register by default ***',
        !register.some((a) => a.id === second.id))
  }

  console.log('\n── Invariants ──────────────────────────────────────────────\n')

  const drift = await reconcileAssets(SITE)
  ok('*** every asset agrees with the runs that depreciated it ***', drift.length === 0,
      JSON.stringify(drift.slice(0, 3)))

  const glDrift = await reconcileAccountBalances(SITE)
  ok('*** every GL balance agrees with its journal lines ***', glDrift.length === 0,
      JSON.stringify(glDrift.slice(0, 2)))

  const tb = await trialBalance(SITE, '2026-12-31')
  ok('*** the trial balance still balances ***', tb.balanced,
      `out by ${tb.difference}`)

  const summary = await assetSummary(SITE)
  ok('the register summarises', summary.count >= 1, `${summary.count} assets`)
  ok('  book value is cost less accumulated',
      summary.totalBookValue === round(summary.totalCost - summary.totalAccumulated, 2))

  await finish()
}

async function finish() {
  // Runs before assets: the FK from run items is RESTRICT.
  for (const id of created.runs) {
    await siteExecute(SITE, 'DELETE FROM depreciation_run_items WHERE run_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM depreciation_runs WHERE id = ?', [id])
  }
  for (const id of created.batches) {
    await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [id])
  }
  for (const id of created.assets) {
    await siteExecute(SITE, 'DELETE FROM depreciation_run_items WHERE asset_id = ?', [id])
    await siteExecute(SITE, 'DELETE FROM fixed_assets WHERE id = ?', [id])
  }

  // Balances were moved by journals now deleted; restore them so the ledger
  // stays consistent for the next run.
  await siteExecute(
    SITE,
    `UPDATE gl_accounts a
        SET a.balance = COALESCE((
              SELECT SUM(l.amount) FROM journal_lines l
                JOIN journal_batches b ON b.id = l.batch_id
               WHERE l.account_id = a.id AND b.status = 'posted'), 0)`,
  )

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
