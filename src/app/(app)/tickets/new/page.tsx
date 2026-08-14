import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import NewTicket from './NewTicket'

export const dynamic = 'force-dynamic'

export default async function NewTicketPage() {
  const { capabilities } = await requireCapability('tickets.edit')
  return <NewTicket canAssign={can(capabilities, 'tickets.assign')} />
}
