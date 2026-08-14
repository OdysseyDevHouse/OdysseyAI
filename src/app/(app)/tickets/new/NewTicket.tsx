'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Combobox,
  Field,
  Icons,
  Input,
  PageBody,
  PageHeader,
  Select,
  Textarea,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import {
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_SOURCES,
  TICKET_SOURCE_LABEL,
  type TicketPriority,
  type TicketSource,
} from '@/lib/ticketModel'
import { saveTicketAction, searchTicketCustomersAction } from '../actions'

/**
 * Logging a ticket.
 *
 * ── ONLY THE SUBJECT IS REQUIRED ───────────────────────────────────────────
 *
 * The PRD's fast-intake principle, applied to a support desk: somebody is on
 * the phone, and a form that demands a customer and a category before it will
 * save is a form they abandon and write on paper instead. Everything else can
 * be filled in once the call has ended.
 *
 * A ticket also does NOT ask for a lane — it lands in the landing lane, which
 * is the whole point of that flag.
 */
export default function NewTicket({ canAssign }: { canAssign: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TicketPriority>('normal')
  const [source, setSource] = useState<TicketSource>('phone')
  const [category, setCategory] = useState('')

  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ComboboxOption<number>[]>([])
  const [searching, setSearching] = useState(false)
  const [customer, setCustomer] = useState<{ id: number; name: string } | null>(null)

  function search(term: string) {
    setQuery(term)
    if (term.trim().length < 2) {
      setOptions([])
      return
    }
    setSearching(true)
    start(async () => {
      const found = await searchTicketCustomersAction(term)
      // `value` is a string on ComboboxOption; the id rides in `data`, which is
      // what the generic is for.
      setOptions(
        found.map((c) => ({
          value: String(c.id),
          label: c.name,
          hint: c.code,
          data: c.id,
        })),
      )
      setSearching(false)
    })
  }

  function save() {
    if (!subject.trim()) return
    start(async () => {
      const result = await saveTicketAction({
        id: null,
        customerId: customer?.id ?? null,
        contactId: null,
        subject,
        description: description.trim() || null,
        priority,
        statusId: null,
        assigneeUserId: null,
        assigneeName: null,
        source,
        category: category.trim() || null,
        dueAt: null,
      })
      if (result.ok) {
        toast.success(`${result.documentNumber ?? 'Ticket'} logged.`)
        router.push(`/tickets/${result.id}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <PageHeader
        title="New ticket"
        subtitle="Say what was asked. Everything else can wait until the call has ended."
      />
      <PageBody>
        <Card>
          <CardHeader title="What was asked" />
          <CardBody className="space-y-4">
            <Field label="Subject" hint="One line somebody scanning a board will recognise.">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Printer will not feed from tray 2"
                maxLength={190}
                autoFocus
              />
            </Field>

            <Field label="Detail" hint="Optional. Their words, not a summary.">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Priority">
                <Select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                >
                  {TICKET_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {TICKET_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="How it reached us">
                <Select value={source} onChange={(e) => setSource(e.target.value as TicketSource)}>
                  {TICKET_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {TICKET_SOURCE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Who it is for"
            description="Optional — a ticket about the office printer belongs to nobody but us."
          />
          <CardBody className="space-y-4">
            <Field label="Customer">
              {customer ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink">{customer.name}</span>
                  <Button variant="ghost" size="sm" onClick={() => setCustomer(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <Combobox
                  options={options}
                  query={query}
                  onQueryChange={search}
                  loading={searching}
                  placeholder="Search a customer…"
                  emptyText={query.trim().length >= 2 ? 'No customer matches.' : 'Keep typing…'}
                  onSelect={(o) => {
                    if (o.data === undefined) return
                    setCustomer({ id: o.data, name: o.label })
                    setQuery('')
                    setOptions([])
                  }}
                />
              )}
            </Field>

            <Field label="Category" hint="Optional. Free text — whatever this desk sorts by.">
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Hardware, Account, Network…"
                maxLength={60}
              />
            </Field>

            {canAssign && (
              <p className="text-xs text-muted">
                Nobody is assigned yet. Assign it on the ticket once it is logged — that is also
                what decides whose clock runs on it.
              </p>
            )}
          </CardBody>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => router.push('/tickets/board')} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={pending || !subject.trim()}>
            <Icons.Plus size={16} />
            {pending ? 'Logging…' : 'Log the ticket'}
          </Button>
        </div>
      </PageBody>
    </>
  )
}
