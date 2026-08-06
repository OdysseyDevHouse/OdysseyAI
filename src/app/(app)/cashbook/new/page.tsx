import { requireCapability } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import { AccountForm } from '../AccountForm'

export const dynamic = 'force-dynamic'

export default async function NewBankAccountPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  await requireCapability('cashbook.edit')

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
