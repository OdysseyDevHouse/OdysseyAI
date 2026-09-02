'use client'

import { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  PageBody,
  PageHeader,
  useToast,
} from '@/components/ui'
import { activeEngineName, posStore } from '@/lib/posOffline/store'
import {
  CONFORMANCE_SITE_ID,
  runStoreConformance,
  type ConformanceReport,
} from '@/lib/posOffline/storeConformance'

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

  async function run() {
    setRunning(true)
    try {
      const result = await runStoreConformance(posStore(CONFORMANCE_SITE_ID), activeEngineName())
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

  return (
    <>
      <PageHeader
        title="Till store check"
        subtitle="Runs the storage contract against this machine, on a throwaway database"
        action={
          <Button onClick={run} disabled={running}>
            {running ? 'Running…' : 'Run the checks'}
          </Button>
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
      </PageBody>
    </>
  )
}
