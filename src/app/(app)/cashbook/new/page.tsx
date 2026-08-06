import { requireSiteId } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import { AccountForm } from '../AccountForm'

export const dynamic = 'force-dynamic'

export default async function NewBankAccountPage() {
  await requireSiteId()

  return (
    <>
      <PageHeader
        title="New account"
        subtitle="A bank account, a cash float, or a card settlement account"
      />
      <PageBody>
        <AccountForm />
      </PageBody>
    </>
  )
}
