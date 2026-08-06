import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getAccount } from '@/lib/site/bankAccounts'
import { PageHeader, PageBody } from '@/components/ui'
import { AccountForm } from '../../AccountForm'

export const dynamic = 'force-dynamic'

export default async function EditBankAccountPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const siteId = await requireSiteId()
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId)) notFound()

  const account = await getAccount(siteId, accountId)
  if (!account) notFound()

  return (
    <>
      <PageHeader title={account.name} subtitle={`${account.code} · settings`} />
      <PageBody>
        <AccountForm
          account={{
            id: account.id,
            code: account.code,
            name: account.name,
            accountType: account.accountType,
            bankName: account.bankName,
            accountNumber: account.accountNumber,
            branchCode: account.branchCode,
            openingBalance: account.openingBalance,
            openingDate: account.openingDate,
            isDefaultReceipts: account.isDefaultReceipts,
            isDefaultPayments: account.isDefaultPayments,
            notes: account.notes,
            balance: account.balance,
          }}
        />
      </PageBody>
    </>
  )
}
