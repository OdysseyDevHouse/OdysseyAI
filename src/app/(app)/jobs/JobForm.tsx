'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  Textarea,
  Select,
  Combobox,
  Badge,
  Icons,
  useToast,
  type ComboboxOption,
} from '@/components/ui'
import type { JobCardInput } from '@/lib/site/jobCards'
import {
  JOB_PRIORITIES,
  JOB_SOURCES,
  PRIORITY_LABEL,
  SOURCE_LABEL,
  validateJobCardFields,
  type JobPriority,
  type JobSource,
} from '@/lib/jobStatusModel'
import type { TillCustomer } from '@/lib/site/tillCustomers'
import type { ServiceAddress } from '@/lib/site/serviceAddresses'
import { saveJobAction, searchJobCustomersAction, customerAddressesAction } from './actions'

/**
 * Taking a job down.
 *
 * ── WHAT THIS SCREEN OPTIMISES FOR ─────────────────────────────────────────
 *
 * Somebody is on the phone. The fields are in the order the conversation happens:
 * who is calling, what is wrong, where, how urgent, when. Anything that can be
 * decided later — who does it, what it will cost — is deliberately absent, and
 * the job can be saved with three of them filled.
 *
 * Grouped into two cards rather than one column of eleven fields, because the two
 * halves are answered by two different parts of the conversation.
 *
 * ── THE CUSTOMER IS OPTIONAL, AND THE FORM SAYS SO ─────────────────────────
 *
 * A walk-in with a broken kettle is a real job. Typing a name without picking an
 * account is a supported outcome, not an unfinished one — so the hint says that
 * plainly rather than nagging for an account that need not exist. What a job with
 * no account cannot do is be invoiced, and the job screen says so at that point.
 */
export default function JobForm({
  defaultPriority,
  job,
}: {
  defaultPriority: JobPriority
  /** Set when editing. Absent when taking a new job down. */
  job?: {
    id: number
    customerId: number | null
    customerName: string | null
    customerPhone: string | null
    customerEmail: string | null
    serviceAddressId: number | null
    priority: JobPriority
    title: string
    description: string | null
    dueAt: string | null
    source: JobSource
    reference: string | null
    internalNote: string | null
  }
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [customerId, setCustomerId] = useState<number | null>(job?.customerId ?? null)
  const [customerName, setCustomerName] = useState(job?.customerName ?? '')
  const [customerPhone, setCustomerPhone] = useState(job?.customerPhone ?? '')
  const [customerEmail, setCustomerEmail] = useState(job?.customerEmail ?? '')
  const [addressId, setAddressId] = useState<number | null>(job?.serviceAddressId ?? null)
  const [addresses, setAddresses] = useState<ServiceAddress[]>([])

  const [title, setTitle] = useState(job?.title ?? '')
  const [description, setDescription] = useState(job?.description ?? '')
  const [priority, setPriority] = useState<JobPriority>(job?.priority ?? defaultPriority)
  const [source, setSource] = useState<JobSource>(job?.source ?? 'phone')
  const [dueAt, setDueAt] = useState(job?.dueAt ? job.dueAt.replace(' ', 'T').slice(0, 16) : '')
  const [reference, setReference] = useState(job?.reference ?? '')
  const [internalNote, setInternalNote] = useState(job?.internalNote ?? '')

  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<TillCustomer[]>([])
  const [searching, setSearching] = useState(false)

  // Debounced, because this fires per keystroke and a workshop's customer file
  // can be thousands of rows.
  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([])
      return
    }
    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      searchJobCustomersAction(query)
        .then((found) => {
          if (live) setMatches(found)
        })
        .catch(() => {
          if (live) setMatches([])
        })
        .finally(() => {
          if (live) setSearching(false)
        })
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  // Where the work happens, once we know whose work it is. A customer with one
  // address gets it chosen for them.
  useEffect(() => {
    if (customerId === null) {
      setAddresses([])
      return
    }
    let live = true
    customerAddressesAction(customerId)
      .then((found) => {
        if (!live) return
        setAddresses(found)
        if (addressId === null) {
          const preferred = found.find((a) => a.isDefault) ?? (found.length === 1 ? found[0] : null)
          if (preferred) setAddressId(preferred.id)
        }
      })
      .catch(() => {
        if (live) setAddresses([])
      })
    return () => {
      live = false
    }
    // addressId is deliberately not a dependency: this picks a default only on a
    // customer change, and re-running on every pick would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  const input: JobCardInput = {
    id: job?.id ?? null,
    customerId,
    customerName: customerName || null,
    customerPhone: customerPhone || null,
    customerEmail: customerEmail || null,
    serviceAddressId: addressId,
    locationId: null,
    statusId: null,
    priority,
    ownerUserId: null,
    ownerName: '',
    title,
    description: description || null,
    dueAt: dueAt ? dueAt.replace('T', ' ') + ':00' : null,
    source,
    reference: reference || null,
    internalNote: internalNote || null,
  }

  // The same function the server runs, so the form refuses the same things for
  // the same reasons rather than round-tripping to find out.
  const refusal = validateJobCardFields(input)

  const options: ComboboxOption<TillCustomer>[] = matches.map((customer) => ({
    value: String(customer.id),
    label: customer.name,
    hint: [customer.code, customer.phone].filter(Boolean).join(' · '),
    data: customer,
  }))

  function save() {
    start(async () => {
      const result = await saveJobAction(input)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        job ? 'Job saved.' : `Job ${result.documentNumber ?? ''} logged.`.replace('  ', ' '),
      )
      router.push(`/jobs/${result.id}`)
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Who it is for" description="Search an account, or type a name for a walk-in." />
        <CardBody>
          <div className="flex flex-col gap-4">
            {customerId === null ? (
              <>
                <Field
                  label="Customer account"
                  hint="Type at least two letters to search by name, code or phone number."
                >
                  <Combobox
                    options={options}
                    query={query}
                    onQueryChange={setQuery}
                    onSelect={(option) => {
                      const customer = option.data
                      if (!customer) return
                      setCustomerId(customer.id)
                      setCustomerName(customer.name)
                      if (customer.phone) setCustomerPhone(customer.phone)
                      setQuery('')
                      setMatches([])
                    }}
                    loading={searching}
                    placeholder="Search customers…"
                    emptyText={
                      query.trim().length < 2 ? 'Keep typing…' : 'No account matches — a walk-in is fine'
                    }
                  />
                </Field>
                <Field
                  label="Or a name for a walk-in"
                  hint="No account needed to log the job. One is needed before it can be invoiced."
                >
                  <Input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Mrs Naidoo"
                  />
                </Field>
              </>
            ) : (
              <div className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-3 py-2.5">
                <div className="flex flex-col">
                  <span className="text-sm text-ink">{customerName}</span>
                  <span className="text-xs text-muted">On account</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setCustomerId(null)
                    setAddressId(null)
                    setAddresses([])
                  }}
                >
                  Change
                </Button>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phone">
                <Input
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="082 555 1234"
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="name@example.co.za"
                />
              </Field>
            </div>

            {addresses.length > 0 && (
              <Field
                label="Where the work happens"
                hint="The service address, which need not be where the invoice goes."
              >
                <Select
                  value={addressId === null ? '' : String(addressId)}
                  onChange={(e) => setAddressId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Not specified</option>
                  {addresses.map((address) => (
                    <option key={address.id} value={address.id}>
                      {address.name}
                      {address.city ? ` — ${address.city}` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What needs doing" description="A short line for the list, and the detail underneath." />
        <CardBody>
          <div className="flex flex-col gap-4">
            <Field label="The work" hint="What a dispatcher reads in the list. Keep it short.">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Aircon not cooling — unit 4"
                autoFocus
              />
            </Field>

            <Field label="What the customer told us" hint="The fault as reported, in their words.">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                placeholder="Started making a noise on Friday, now blowing warm air. Tenant is home mornings only."
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Priority">
                <Select value={priority} onChange={(e) => setPriority(e.target.value as JobPriority)}>
                  {JOB_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {PRIORITY_LABEL[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="How it came in" hint="For reporting.">
                <Select value={source} onChange={(e) => setSource(e.target.value as JobSource)}>
                  {JOB_SOURCES.filter((s) => s !== 'portal' && s !== 'public_form').map((value) => (
                    <option key={value} value={value}>
                      {SOURCE_LABEL[value]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Due by" hint="Optional.">
                <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Their reference" hint="A PO or order number they gave you.">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} />
              </Field>
              <Field label="Internal note" hint="Never shown to the customer.">
                <Input value={internalNote} onChange={(e) => setInternalNote(e.target.value)} />
              </Field>
            </div>
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted">
              {refusal ? (
                <span className="text-warning">{refusal}</span>
              ) : job ? (
                'Changes are recorded against the job.'
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Badge tone="neutral">JC</Badge>
                  A job number is issued as soon as it is saved, so you can read it out.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => router.back()} disabled={pending}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={pending || refusal !== null}>
                <Icons.Save size={15} />
                {job ? 'Save job' : 'Log the job'}
              </Button>
            </div>
          </div>
        </CardFooter>
      </Card>
    </div>
  )
}
