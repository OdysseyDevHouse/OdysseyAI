import { requireCapability } from '@/lib/auth'
import { listLocks } from '@/lib/site/periodLocks'
import { PageHeader, PageBody, Card, CardHeader, CardBody } from '@/components/ui'
import { PeriodsClient } from './PeriodsClient'

export const dynamic = 'force-dynamic'

/**
 * Closing an accounting period.
 *
 * Without this, someone posts a journal into March in July, after the VAT
 * return went in, and the first anyone hears is from an auditor. The cost of
 * refusing the posting is nothing; the cost of finding and unwinding it later
 * is enormous.
 */
export default async function PeriodsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')
  const locks = await listLocks(siteId, { includeUnlocked: true })

  return (
    <>
      <PageHeader
        title="Accounting periods"
        subtitle="Close a period so nothing can be posted into it"
      />
      <PageBody>
        <PeriodsClient locks={locks} />

        <Card>
          <CardHeader title="How locking works" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="font-medium text-ink">Hard lock</dt>
                <dd className="text-muted">
                  Postings dated inside the period are refused outright. Use it once the return
                  has been filed.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Soft lock</dt>
                <dd className="text-muted">
                  Postings are allowed but warn. Use it during the week between &ldquo;we think
                  it is closed&rdquo; and &ldquo;the return is filed&rdquo; — a hard lock during
                  that gap just gets unlocked, which teaches everyone that locks come off on
                  request.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Scope</dt>
                <dd className="text-muted">
                  A lock covering everything is the usual choice. The narrower scopes let a VAT
                  period close while stock adjustments continue.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Reopening</dt>
                <dd className="text-muted">
                  Always possible, always recorded. The row is kept and stamped with who
                  reopened it and why, because that is exactly what an auditor asks.
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
