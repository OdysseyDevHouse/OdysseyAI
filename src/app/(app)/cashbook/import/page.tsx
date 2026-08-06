import { requireSiteId } from '@/lib/auth'
import { listAccounts } from '@/lib/site/bankAccounts'
import { PageHeader, PageBody, Card, CardBody, EmptyState, ButtonLink, Icons } from '@/components/ui'
import { ImportClient } from './ImportClient'

export const dynamic = 'force-dynamic'

/**
 * Reading a bank statement into an account.
 *
 * Two steps on purpose: parse and show what was understood, THEN import. A
 * misread date format or the wrong account chosen is only obvious when you can
 * see the rows, and by then it is too late if the import already happened.
 */
export default async function ImportStatementPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams
  const accounts = await listAccounts(siteId)

  const preselected = Number(params.account)

  return (
    <>
      <PageHeader
        title="Import a statement"
        subtitle="Read a CSV or OFX export from your bank"
      />
      <PageBody>
        {accounts.length === 0 ? (
          <Card>
            <CardBody>
              <EmptyState
                title="No accounts to import into"
                hint="Create the bank account first, then import its statement."
                action={
                  <ButtonLink href="/cashbook/new">
                    <Icons.Plus size={15} />
                    New account
                  </ButtonLink>
                }
              />
            </CardBody>
          </Card>
        ) : (
          <ImportClient
            accounts={accounts.map((a) => ({
              id: a.id,
              code: a.code,
              name: a.name,
              lastReconciledDate: a.lastReconciledDate,
            }))}
            preselectedId={Number.isFinite(preselected) ? preselected : undefined}
          />
        )}
      </PageBody>
    </>
  )
}
