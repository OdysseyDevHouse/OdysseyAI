'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  SegmentedControl,
  Select,
  TableToolbar,
  Textarea,
  ToolbarSearch,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  TRANSITION_LABEL,
  allowedNext,
  dateKey,
  dayLabel,
  dayOf,
  timeOf,
  type Reservation,
  type ReservationStatus,
} from '@/lib/reservationTypes'
import {
  createReservationAction,
  setReservationStatusAction,
  setReservationTableAction,
} from './actions'

/**
 * The shop-side reservations book.
 *
 * ORDERED BY TIME, NOT BY STATUS. A restaurant works tonight first and
 * everything else second, so the default view is "Today" and the table is in
 * booking-time order — the order parties will walk through the door.
 *
 * Every action offered is driven by `allowedNext` from the shared types, so a
 * button on screen can never propose a transition the server would refuse.
 */

type Filter = 'today' | 'upcoming' | 'all'

export default function ReservationsQueue({
  reservations,
  maxPartySize,
  onlineEnabled,
  canEdit,
  reservePath,
  tables,
}: {
  reservations: Reservation[]
  maxPartySize: number
  onlineEnabled: boolean
  canEdit: boolean
  reservePath: string
  /**
   * The shop's floor plan, for putting a booking on a table that exists.
   *
   * Empty on a shop that has never drawn one, and that case still has to work:
   * the table field falls back to free text, which is what it has always been.
   * A picker that offered nothing would be worse than a box.
   */
  tables: { code: string; name: string; section: string; seats: number }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [busy, startAction] = useTransition()

  const [filter, setFilter] = useState<Filter>('today')
  const [search, setSearch] = useState('')
  const [detail, setDetail] = useState<Reservation | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const today = dateKey(new Date())

  const counts = useMemo(() => {
    const upcoming = reservations.filter((r) => dayOf(r.reservedFor) >= today).length
    return {
      today: reservations.filter((r) => dayOf(r.reservedFor) === today).length,
      upcoming,
      all: reservations.length,
    }
  }, [reservations, today])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return reservations.filter((r) => {
      const day = dayOf(r.reservedFor)
      if (filter === 'today' && day !== today) return false
      if (filter === 'upcoming' && day < today) return false
      if (!q) return true
      return (
        r.contactName.toLowerCase().includes(q) ||
        r.contactPhone.toLowerCase().includes(q) ||
        r.reference.toLowerCase().includes(q) ||
        r.tableName.toLowerCase().includes(q)
      )
    })
  }, [reservations, filter, search, today])

  /**
   * The public booking link, for the shop's own website or a QR code.
   *
   * Built in the browser: the server has no reliable view of the public origin
   * behind a proxy, and getting it wrong would print a link that works for
   * nobody.
   */
  async function copyLink() {
    const url =
      typeof window === 'undefined' ? reservePath : `${window.location.origin}${reservePath}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(
        onlineEnabled
          ? 'Booking link copied — put it behind a “Book a table” button on your website.'
          : 'Booking link copied. Online bookings are switched off, so it will not take any yet.',
      )
    } catch {
      // Clipboard access is refused outside a secure context, and "nothing
      // happened" would look like a broken button.
      toast.info(url)
    }
  }

  /** Runs an action, reports it, and refreshes the server data behind it. */
  function run(
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    okMessage: string,
    onDone?: () => void,
  ) {
    startAction(async () => {
      const result = await fn()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(okMessage)
      onDone?.()
      router.refresh()
    })
  }

  const columns: Column<Reservation>[] = [
    {
      key: 'time',
      header: 'Time',
      width: 'w-28',
      sortable: true,
      sortValue: (r) => r.reservedFor,
      cell: (r) => (
        <div className="min-w-0">
          <span className="block font-medium text-ink">{timeOf(r.reservedFor)}</span>
          {/* The day is redundant in the Today view and essential in the others. */}
          {filter !== 'today' && (
            <span className="text-xs text-muted">{dayLabel(dayOf(r.reservedFor))}</span>
          )}
        </div>
      ),
    },
    {
      key: 'guest',
      header: 'Guest',
      sortable: true,
      sortValue: (r) => r.contactName.toLowerCase(),
      cell: (r) => (
        <div className="min-w-0">
          <span className="block truncate font-medium text-ink">{r.contactName}</span>
          <span className="text-xs text-muted">
            {r.contactPhone || 'No number'} · {r.reference}
          </span>
        </div>
      ),
    },
    {
      key: 'party',
      header: 'Party',
      numeric: true,
      width: 'w-20',
      sortable: true,
      sortValue: (r) => r.partySize,
      cell: (r) => r.partySize,
    },
    {
      key: 'table',
      header: 'Table',
      width: 'w-28',
      sortable: true,
      sortValue: (r) => r.tableName.toLowerCase(),
      cell: (r) =>
        r.tableName ? (
          <span className="text-ink-2">{r.tableName}</span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-32',
      sortable: true,
      sortValue: (r) => r.status,
      cell: (r) => (
        <Badge dot tone={STATUS_TONE[r.status]}>
          {STATUS_LABEL[r.status]}
        </Badge>
      ),
    },
    {
      /*
       * What the table is spending, for a party still eating.
       *
       * Blank for everyone else, and that is most rows: a booking still to
       * arrive has no bill, and a settled one is a party who has gone — a
       * figure beside either would be answering a question nobody asked.
       */
      key: 'bill',
      header: 'Bill',
      numeric: true,
      width: 'w-28',
      sortable: true,
      sortValue: (r) => r.billTotal ?? -1,
      cell: (r) =>
        r.billTotal === null ? (
          <span className="text-faint">—</span>
        ) : (
          <span className="font-medium tabular-nums text-ink">{formatMoney(r.billTotal)}</span>
        ),
    },
    {
      key: 'source',
      header: 'Source',
      width: 'w-24',
      cell: (r) => <span className="text-xs text-muted">{SOURCE_LABEL[r.source]}</span>,
    },
  ]

  return (
    <>
      <Card>
        <TableToolbar
          inCard
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={copyLink}>
                <Icons.Copy size={15} />
                Copy booking link
              </Button>
              {canEdit && (
                <Button onClick={() => setAddOpen(true)}>
                  <Icons.Plus size={15} />
                  Take a booking
                </Button>
              )}
            </div>
          }
        >
          <SegmentedControl
            value={filter}
            onChange={setFilter}
            aria-label="Which bookings to show"
            /* These slice by TIME, not by state, so the glyphs are a clock face
               for tonight, a forward calendar for what is still coming, and the
               grid for everything — not the tick/cross pair a status bar uses. */
            options={[
              {
                value: 'today',
                label: 'Today',
                count: counts.today,
                icon: <Icons.Clock size={15} />,
              },
              {
                value: 'upcoming',
                label: 'Upcoming',
                count: counts.upcoming,
                icon: <Icons.CalendarClock size={15} />,
              },
              { value: 'all', label: 'All', count: counts.all, icon: <Icons.LayoutGrid size={15} /> },
            ]}
          />
          <ToolbarSearch
            value={search}
            onChange={setSearch}
            placeholder="Name, phone, reference or table"
          />
        </TableToolbar>

        {visible.length === 0 ? (
          <EmptyState
            icon={<Icons.CalendarClock size={22} />}
            title={
              search
                ? 'No bookings match'
                : filter === 'today'
                  ? 'Nothing booked for today'
                  : 'No bookings yet'
            }
            hint={
              search
                ? 'Try a different name, number or reference.'
                : filter === 'today'
                  ? 'Bookings for later dates are under Upcoming.'
                  : onlineEnabled
                    ? 'When a guest books on your website, it lands here.'
                    : 'Take one over the phone, or switch on online bookings to take them from your website.'
            }
            action={
              search ? (
                <Button variant="secondary" onClick={() => setSearch('')}>
                  Clear the search
                </Button>
              ) : canEdit && filter !== 'today' ? (
                <Button onClick={() => setAddOpen(true)}>Take a booking</Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={visible}
            getRowKey={(r) => r.id}
            onRowClick={(r) => setDetail(r)}
            actionsOnHover
            actions={(r) => {
              // The one move staff make most from the list itself, and only
              // when it is legal. Everything else lives in the detail modal.
              const next = allowedNext(r.status)
              const quick: ReservationStatus | null = next.includes('confirmed')
                ? 'confirmed'
                : next.includes('seated')
                  ? 'seated'
                  : null
              if (!canEdit || !quick) return null
              return (
                <Button
                  variant={quick === 'confirmed' ? 'success' : 'secondary'}
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => setReservationStatusAction(r.id, quick),
                      quick === 'confirmed'
                        ? `${r.contactName}’s booking confirmed.`
                        : `${r.contactName} seated.`,
                    )
                  }
                >
                  {TRANSITION_LABEL[quick]}
                </Button>
              )
            }}
          />
        )}
      </Card>

      {detail && (
        <DetailModal
          reservation={detail}
          busy={busy}
          canEdit={canEdit}
          tables={tables}
          onClose={() => setDetail(null)}
          onStatus={(status, reason) =>
            run(
              () => setReservationStatusAction(detail.id, status, reason),
              `Booking ${STATUS_LABEL[status].toLowerCase()}.`,
              () => setDetail(null),
            )
          }
          onTable={(tableName) =>
            run(
              () => setReservationTableAction(detail.id, tableName),
              tableName ? `Put on ${tableName}.` : 'Table cleared.',
              () => setDetail(null),
            )
          }
        />
      )}

      <AddModal
        open={addOpen}
        busy={busy}
        maxPartySize={maxPartySize}
        tables={tables}
        onClose={() => setAddOpen(false)}
        onSave={(input) =>
          run(() => createReservationAction(input), 'Booking added.', () => setAddOpen(false))
        }
      />
    </>
  )
}

/* ── detail ───────────────────────────────────────────────────────────────── */

function DetailModal({
  reservation,
  busy,
  canEdit,
  tables,
  onClose,
  onStatus,
  onTable,
}: {
  reservation: Reservation
  busy: boolean
  canEdit: boolean
  tables: { code: string; name: string; section: string; seats: number }[]
  onClose: () => void
  onStatus: (status: ReservationStatus, reason?: string) => void
  onTable: (tableName: string) => void
}) {
  const [table, setTable] = useState(reservation.tableName)
  /*
   * A name on the booking that the floor plan does not have.
   *
   * Real and worth saying out loud: bookings taken over the phone before a plan
   * was drawn, or typed as "Patio 3" when the plan says "P3". The old screen
   * claimed these were matched to the till and they never were — so the honest
   * thing is to keep the name, keep it selectable, and say plainly that the till
   * will not find it.
   */
  const unknownTable =
    table.trim() !== '' && !tables.some((t) => t.code === table)
  const [reason, setReason] = useState('')
  const next = allowedNext(reservation.status)

  // A reason is worth capturing only where the booking is about to end badly —
  // it is what the guest is told, and what the book has to explain a week later.
  const canEndBadly = next.includes('cancelled') || next.includes('no_show')

  return (
    <Modal
      open
      onClose={onClose}
      title={reservation.contactName}
      description={`${reservation.reference} · ${dayLabel(dayOf(reservation.reservedFor))} at ${timeOf(
        reservation.reservedFor,
      )}`}
      size="lg"
      footer={
        next.length === 0 ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            {canEdit &&
              next.map((s) => (
                <Button
                  key={s}
                  variant={
                    s === 'cancelled' || s === 'no_show'
                      ? 'danger-ghost'
                      : s === 'confirmed' || s === 'seated'
                        ? 'primary'
                        : 'secondary'
                  }
                  disabled={busy}
                  onClick={() =>
                    onStatus(
                      s,
                      s === 'cancelled' || s === 'no_show' ? reason || undefined : undefined,
                    )
                  }
                >
                  {TRANSITION_LABEL[s]}
                </Button>
              ))}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/*
          One bordered block, hairline-divided into cells: the gaps are drawn as
          borders rather than space so the six facts read as a single record
          instead of six floating pairs.
        */}
        <div className="grid grid-cols-1 overflow-hidden rounded-card border border-border sm:grid-cols-2">
          <Detail icon={<Icons.Users size={16} />} label="Party" value={String(reservation.partySize)} />
          <Detail
            icon={<Icons.Clock size={16} />}
            label="Status"
            value={
              <Badge dot tone={STATUS_TONE[reservation.status]}>
                {STATUS_LABEL[reservation.status]}
              </Badge>
            }
          />
          <Detail icon={<Icons.Phone size={16} />} label="Phone" value={reservation.contactPhone || '—'} />
          <Detail icon={<Icons.Mail size={16} />} label="Email" value={reservation.contactEmail || '—'} />
          <Detail
            icon={<Icons.Calendar size={16} />}
            label="Source"
            value={SOURCE_LABEL[reservation.source]}
          />
          <Detail
            icon={<Icons.Clock size={16} />}
            label="Held for"
            value={`${reservation.durationMinutes} min`}
          />
        </div>

        {reservation.customerNote && (
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">Guest note</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{reservation.customerNote}</p>
          </div>
        )}

        {reservation.cancelReason && (
          <div className="rounded-card border border-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">Reason</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{reservation.cancelReason}</p>
          </div>
        )}

        {canEdit && next.length > 0 && (
          <div className="flex items-end gap-2">
            <Field
              label="Table"
              /*
               * The hint now depends on whether it can be TRUE.
               *
               * It used to say "matched by name to your floor plan and the till"
               * on every shop, including ones with no floor plan at all — and
               * nothing performed the match anyway. With a plan, the picker makes
               * the sentence true by construction. Without one, saying it would
               * be a claim about a thing that does not exist.
               */
              hint={
                tables.length > 0
                  ? unknownTable
                    ? `“${table}” is not on your floor plan — the till will not link to it.`
                    : 'Picked from your floor plan, so the till knows this table.'
                  : 'Free text — draw a floor plan under Setup → Tables to pick from it.'
              }
              className="flex-1"
            >
              {tables.length > 0 ? (
                <Select value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">No table yet</option>
                  {/* The party size is the reason a host is choosing at all, so
                      the seat count sits on every option rather than in a hint
                      nobody reads while deciding. */}
                  {tables.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.code}
                      {t.name && t.name !== t.code ? ` — ${t.name}` : ''}
                      {t.seats > 0 ? ` · seats ${t.seats}` : ''}
                      {t.section ? ` · ${t.section}` : ''}
                    </option>
                  ))}
                  {/* A booking made before the plan existed, or typed over the
                      phone, keeps its name rather than being silently blanked
                      the moment somebody opens this dialog. */}
                  {unknownTable && <option value={table}>{table} (not on the plan)</option>}
                </Select>
              ) : (
                <Input
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                  placeholder="e.g. 12"
                  maxLength={50}
                />
              )}
            </Field>
            <Button
              variant="secondary"
              // The hint sits inside the Field, so the button needs the same
              // nudge up to line up with the text box rather than the hint.
              className="mb-6"
              disabled={busy || table === reservation.tableName}
              onClick={() => onTable(table)}
            >
              Save
            </Button>
          </div>
        )}

        {canEdit && canEndBadly && (
          <Field
            label="Reason"
            hint="Only used if you cancel or mark a no-show — kept on the booking."
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={255}
              placeholder="e.g. Guest called to cancel"
            />
          </Field>
        )}

        {next.length === 0 && (
          <p className="text-sm text-muted">This booking is closed — no further changes.</p>
        )}
      </div>
    </Modal>
  )
}

/**
 * One fact in the detail grid.
 *
 * The cell draws its own right/bottom hairline rather than relying on grid gaps,
 * so the six cells read as one divided block. `-mb-px`/`-mr-px` collapses the
 * doubled line where cells meet, and the parent's `overflow-hidden` clips the
 * outermost edges against the card border.
 */
function Detail({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <div className="-mb-px -mr-px flex items-center gap-3 border-b border-r border-border p-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted">{label}</p>
        {/* `break-all`, not `truncate`: a phone number or address that is cut
            off is worse than useless to somebody about to dial or write to it. */}
        <div className="mt-0.5 break-all text-sm font-medium text-ink">{value}</div>
      </div>
    </div>
  )
}

/* ── take a booking ───────────────────────────────────────────────────────── */

function AddModal({
  open,
  busy,
  maxPartySize,
  tables,
  onClose,
  onSave,
}: {
  open: boolean
  busy: boolean
  maxPartySize: number
  tables: { code: string; name: string; section: string; seats: number }[]
  onClose: () => void
  onSave: (input: {
    contactName: string
    contactPhone: string
    contactEmail?: string
    partySize: number
    date: string
    time: string
    tableName?: string
    customerNote?: string
  }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [party, setParty] = useState('2')
  const [date, setDate] = useState(dateKey(new Date()))
  const [time, setTime] = useState('19:00')
  const [table, setTable] = useState('')
  const [note, setNote] = useState('')

  // A staff booking is not bound by the public form's slot rules — see
  // createStaffReservation — so party size here is a free number, not a list
  // capped at maxPartySize. That cap is only a hint for the common case.
  const canSave = name.trim().length >= 2 && Number(party) >= 1 && !!date && !!time && !busy

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take a booking"
      description="For a booking taken over the phone or at the door. It is confirmed straight away."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() =>
              onSave({
                contactName: name,
                contactPhone: phone,
                contactEmail: email,
                partySize: Number(party) || 0,
                date,
                time,
                tableName: table,
                customerNote: note,
              })
            }
          >
            {busy ? 'Saving…' : 'Add the booking'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Guest name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact number">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              maxLength={50}
            />
          </Field>
          {/* A party size is two digits. A full-width box for it tells the
              person on the phone the wrong thing about what goes in there. */}
          <Field
            label="Party size"
            hint={`Usually up to ${maxPartySize} online.`}
            className="max-w-28"
          >
            <Input
              value={party}
              onChange={(e) => setParty(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" hint="Optional — for the confirmation.">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={190}
            />
          </Field>
          {/* Same choice as the detail dialog: the floor plan where there is
              one, free text where there is not. A host taking a booking over
              the phone should not be able to invent a table that will not
              be there when the party arrives. */}
          <Field label="Table" hint="Optional.">
            {tables.length > 0 ? (
              <Select value={table} onChange={(e) => setTable(e.target.value)}>
                <option value="">Decide on the night</option>
                {tables.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.code}
                    {t.name && t.name !== t.code ? ` — ${t.name}` : ''}
                    {t.seats > 0 ? ` · seats ${t.seats}` : ''}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={table} onChange={(e) => setTable(e.target.value)} maxLength={50} />
            )}
          </Field>
        </div>

        <Field label="Note" hint="Optional — allergies, a high chair, a birthday.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
