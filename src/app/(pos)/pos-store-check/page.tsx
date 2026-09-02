'use client'

import { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  EmptyState,
  Icons,
  PageBody,
  PageHeader,
  useToast,
} from '@/components/ui'
import { dexieStore } from '@/lib/posOffline/dexieStore'
import { sqliteStore } from '@/lib/posOffline/sqliteStore'
import { activeEngineName, posStore, type PosStore } from '@/lib/posOffline/store'
import {
  CONFORMANCE_SITE_ID,
  runStoreConformance,
  type ConformanceReport,
} from '@/lib/posOffline/storeConformance'
import {
  runStoreBenchmark,
  type BenchmarkReport,
  type Measurement,
} from '@/lib/posOffline/storeBenchmark'

/**
 * Proves this machine's store keeps the contract.
 *
 * ── WHY IT IS A PAGE AND NOT A TEST SCRIPT ────────────────────────────────
 *
 * There are two stores — Dexie in Chrome and Electron, SQLite in the Android
 * shell — and neither runs in Node: Dexie needs a real browser, and the SQLite
 * plugin only exists inside the app. So the only place both can be asked the
 * same questions is on the machine itself. Open this in Chrome and it exercises
 * Dexie; open it on a till and it exercises whatever that till uses.
 *
 * `docs/plans/android-till-sqlite.md` makes one test suite over both engines the
 * condition of allowing two implementations at all. This is where it is run.
 *
 * ── IT IS SAFE TO RUN ON A TRADING TILL ───────────────────────────────────
 *
 * The suite writes and clears tables, so it is handed a store opened on
 * `CONFORMANCE_SITE_ID` — a sentinel no shop can be. `posDb` keys its database
 * on the site id, so the real till's outbox is in a different database that this
 * page never opens. That is the whole reason the site id is a parameter rather
 * than something the store reads for itself.
 */
export default function PosStoreCheckPage() {
  const toast = useToast()
  const [report, setReport] = useState<ConformanceReport | null>(null)
  const [running, setRunning] = useState(false)
  const [bench, setBench] = useState<BenchmarkReport | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [survivor, setSurvivor] = useState<string | null | undefined>(undefined)

  async function run() {
    setRunning(true)
    try {
      const { store, label } = chosenStore()
      const result = await runStoreConformance(store, label)
      setReport(result)
      if (result.failed === 0) toast.success(`All ${result.passed} checks passed.`)
      else toast.error(`${result.failed} of ${result.passed + result.failed} checks failed.`)
    } catch (err) {
      /* The suite catches its own case failures, so reaching here means the store
         could not be opened at all — which is itself the answer, and has to be
         shown rather than swallowed. */
      toast.error(err instanceof Error ? err.message : 'The store could not be opened.')
    } finally {
      setRunning(false)
    }
  }

  async function measure() {
    setMeasuring(true)
    try {
      const { store, label } = chosenStore()
      setBench(await runStoreBenchmark(store, label))
      toast.success('Measured.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'The store could not be measured.')
    } finally {
      setMeasuring(false)
    }
  }

  /* Read on mount, so arriving after an app kill immediately answers the
     only question that matters: is the sale still there. */
  useEffect(() => {
    let live = true
    chosenStore()
      .store.outboxGet(SURVIVAL_UID)
      .then((row) => {
        if (live) setSurvivor(row ? String(row.takenAt) : null)
      })
      .catch(() => {
        if (live) setSurvivor(null)
      })
    return () => {
      live = false
    }
  }, [])

  async function writeSurvivor() {
    try {
      const { store } = chosenStore()
      const takenAt = new Date().toISOString()
      await store.outboxPut({
        saleUid: SURVIVAL_UID,
        status: 'pending',
        attempts: 0,
        lastError: null,
        syncedAt: null,
        takenAt,
        lines: [],
        tenders: [],
      } as unknown as Parameters<PosStore['outboxPut']>[0])
      setSurvivor(takenAt)
      toast.success('Marker written. Now kill the app and come back.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not write the marker.')
    }
  }

  return (
    <>
      <PageHeader
        title="Till store check"
        subtitle="Runs the storage contract against this machine, on a throwaway database"
        action={
          <span className="flex gap-2">
            <Button variant="secondary" onClick={measure} disabled={measuring}>
              {measuring ? 'Measuring…' : 'Measure'}
            </Button>
            <Button onClick={run} disabled={running}>
              {running ? 'Running…' : 'Run the checks'}
            </Button>
          </span>
        }
      />
      <PageBody>
        <Card>
          <CardHeader
            title={report ? `${report.engine} — ${report.passed} passed, ${report.failed} failed` : 'Not run yet'}
            description={
              report
                ? `Finished in ${report.durationMs}ms. A failure here means this machine cannot be trusted to hold a sale.`
                : 'Nothing is written to this till’s own data — the checks use a separate database.'
            }
          />
          <CardBody>
            {!report ? (
              <EmptyState
                title="No results yet"
                hint="Press “Run the checks” to exercise this machine’s store."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {report.cases.map((c) => (
                  <li
                    key={c.name}
                    className="flex items-start gap-3 rounded-card border border-border bg-surface p-3"
                  >
                    <span className="mt-0.5 shrink-0">
                      {c.ok ? (
                        <Icons.StatusSuccess className="h-4 w-4 text-success" aria-hidden />
                      ) : (
                        <Icons.StatusError className="h-4 w-4 text-danger" aria-hidden />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-ink">{c.name}</span>
                      <span className={c.ok ? 'text-muted' : 'text-danger'}>{c.detail}</span>
                    </span>
                    <span className="ml-auto shrink-0">
                      <Badge tone={c.ok ? 'success' : 'danger'}>{c.ok ? 'pass' : 'fail'}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Survives being killed"
            description="A pending outbox row is a sale that happened. Write one, kill the app, come back: it must still be here."
            action={
              <Button variant="secondary" onClick={writeSurvivor}>
                Write a marker
              </Button>
            }
          />
          <CardBody>
            {survivor === undefined ? (
              <span className="text-muted">Looking…</span>
            ) : survivor === null ? (
              <span className="flex items-center gap-2">
                <Badge tone="neutral">none</Badge>
                <span className="text-muted">No marker stored on this machine.</span>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Badge tone="success">present</Badge>
                <span className="text-ink">Written {survivor}</span>
              </span>
            )}
          </CardBody>
        </Card>

        {bench ? (
          <Card>
            <CardHeader
              title={`${bench.engine} — timings`}
              description={`A shop of ${bench.catalogSize} products. Per-operation is the figure a cashier feels.`}
            />
            <CardBody>
              <DataTable
                columns={[
                  { key: 'name', header: 'Operation', cell: (m: Measurement) => m.name },
                  { key: 'detail', header: 'What it is', cell: (m: Measurement) => m.detail },
                  {
                    key: 'perOp',
                    header: 'Per op',
                    numeric: true,
                    cell: (m: Measurement) => `${m.perOpMs} ms`,
                    sortValue: (m: Measurement) => m.perOpMs,
                  },
                  {
                    key: 'total',
                    header: 'Total',
                    numeric: true,
                    cell: (m: Measurement) => `${m.totalMs} ms / ${m.iterations}`,
                    sortValue: (m: Measurement) => m.totalMs,
                  },
                ]}
                rows={bench.measurements}
                getRowKey={(m: Measurement) => m.name}
              />
            </CardBody>
          </Card>
        ) : null}
      </PageBody>
    </>
  )
}

/**
 * The marker row.
 *
 * It lives in the throwaway database like everything else on this page, and
 * it is deliberately shaped as a PENDING outbox row — the exact thing the
 * whole SQLite change exists to protect. Anything else would prove less.
 */
const SURVIVAL_UID = 'survival-marker'

/**
 * Which store to exercise: the one this machine uses, or a named one.
 *
 * `?engine=dexie` and `?engine=sqlite` exist so BOTH implementations can be
 * put through the same cases on one machine. That matters on Android, where
 * the till uses SQLite and nothing would otherwise re-check that the Dexie
 * path still works after a change to the shared code above it — the two are
 * meant to be interchangeable, and a claim like that is worth testing rather
 * than assuming.
 *
 * Read from the URL at press time rather than through `useSearchParams`, which
 * would drag a Suspense boundary into a page that is a button and a list.
 */
function chosenStore(): { store: PosStore; label: string } {
  const asked =
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('engine') ?? '').toLowerCase()

  if (asked === 'dexie') return { store: dexieStore(CONFORMANCE_SITE_ID), label: 'Dexie / IndexedDB (forced)' }
  if (asked === 'sqlite') return { store: sqliteStore(CONFORMANCE_SITE_ID), label: 'SQLite (forced)' }
  return { store: posStore(CONFORMANCE_SITE_ID), label: activeEngineName() }
}
