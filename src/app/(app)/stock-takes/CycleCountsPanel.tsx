'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardBody,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  Switch,
  useToast,
} from '@/components/ui'
import type { CycleProgramme, SaveProgrammeInput } from '@/lib/site/cycleCounts'
import {
  generateCycleCountsAction,
  saveCycleProgrammeAction,
  deleteCycleProgrammeAction,
} from './actions'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/**
 * Cycle counting — the standing order to keep counting the shop in slices.
 *
 * Each programme names a slice and a rhythm; "Generate due counts" turns
 * whatever is due into ordinary draft stock takes in the table below. A
 * programme whose last sheet is still open is skipped with the reason — the
 * gate that stops the same shelf being counted against three snapshots.
 */
export default function CycleCountsPanel({
  programmes,
  locations,
  departments,
  brands,
  suppliers,
}: {
  programmes: CycleProgramme[]
  locations: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  brands: { id: number; name: string }[]
  suppliers: { id: number; name: string }[]
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState<CycleProgramme | 'new' | null>(null)

  function generate() {
    startTransition(async () => {
      const result = await generateCycleCountsAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.generated === 0 && result.skipped.length === 0) {
        toast.info('Nothing is due — every programme is up to date.')
      } else {
        const skips = result.skipped.map((s) => `${s.name}: ${s.reason}`).join(' · ')
        toast.success(
          `${result.generated} sheet${result.generated === 1 ? '' : 's'} created${skips ? ` — skipped: ${skips}` : ''}`,
        )
      }
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader
        title="Cycle counts"
        description="Standing programmes that keep counting the shop in slices, on a rhythm."
        action={
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing('new')}>
              <Icons.Plus size={14} />
              New programme
            </Button>
            <Button variant="secondary" size="sm" disabled={pending} onClick={generate}>
              <Icons.Repeat size={14} />
              {pending ? 'Generating…' : 'Generate due counts'}
            </Button>
          </div>
        }
      />
      <CardBody>
        {programmes.length === 0 ? (
          <p className="text-sm text-muted">
            No programmes yet. One programme per aisle or department, weekly, is how a shop
            counts everything without ever closing to count everything.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {programmes.map((p) => {
              // Local date, not toISOString() — UTC flips to yesterday before 2am SAST.
              const todayLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
                .toISOString()
                .slice(0, 10)
              const overdue = p.nextDue !== null && p.nextDue <= todayLocal
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border px-3 py-2"
                >
                  <span className="min-w-0">
                    <span className="text-sm font-medium text-ink">{p.name}</span>
                    <span className="ml-2 text-xs text-muted">
                      {p.scope === 'full' ? 'Everything' : (p.scopeName ?? p.scope)} · {p.locationName} ·{' '}
                      {p.frequency === 'weekly'
                        ? `weekly, ${DAYS[(p.dayOfWeek ?? 1) - 1] ?? 'Monday'}s`
                        : `${p.frequency}, day ${p.dayOfMonth ?? 1}`}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {p.openTakeId !== null ? (
                      <Link href={`/stock-takes/${p.openTakeId}`} className="text-xs text-brand underline underline-offset-2">
                        Sheet open
                      </Link>
                    ) : !p.isActive ? (
                      <Badge tone="default">Off</Badge>
                    ) : p.nextDue ? (
                      <Badge tone={overdue ? 'danger' : 'neutral'}>
                        {overdue ? `Due ${p.nextDue}` : `Next ${p.nextDue}`}
                      </Badge>
                    ) : (
                      <Badge tone="default">Ended</Badge>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardBody>

      {editing !== null && (
        <ProgrammeModal
          programme={editing === 'new' ? null : editing}
          locations={locations}
          departments={departments}
          brands={brands}
          suppliers={suppliers}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  )
}

function ProgrammeModal({
  programme,
  locations,
  departments,
  brands,
  suppliers,
  onClose,
}: {
  programme: CycleProgramme | null
  locations: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  brands: { id: number; name: string }[]
  suppliers: { id: number; name: string }[]
  onClose: () => void
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState<SaveProgrammeInput>({
    name: programme?.name ?? '',
    locationId: programme?.locationId ?? locations[0]?.id ?? 0,
    scope: programme?.scope ?? 'department',
    scopeRefId: programme?.scopeRefId ?? null,
    includeZeroStock: programme?.includeZeroStock ?? false,
    frequency: programme?.frequency ?? 'weekly',
    dayOfWeek: programme?.dayOfWeek ?? 1,
    dayOfMonth: programme?.dayOfMonth ?? 1,
    startsOn:
      programme?.startsOn ??
      new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    endsOn: programme?.endsOn ?? null,
    isActive: programme?.isActive ?? true,
  })

  const refOptions =
    form.scope === 'department' ? departments : form.scope === 'brand' ? brands : suppliers

  function save() {
    startTransition(async () => {
      const result = await saveCycleProgrammeAction(programme?.id ?? null, form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(programme ? 'Programme saved.' : 'Programme added.')
      onClose()
      router.refresh()
    })
  }

  function remove() {
    if (!programme) return
    startTransition(async () => {
      const result = await deleteCycleProgrammeAction(programme.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Programme deleted — its past sheets keep reading.')
      onClose()
      router.refresh()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={programme ? `Edit ${programme.name}` : 'New cycle count programme'}
      footer={
        <>
          {programme && (
            <Button variant="danger-ghost" onClick={remove} disabled={pending}>
              Delete
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            {pending ? 'Saving…' : 'Save programme'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Beverages, weekly"
          />
        </Field>
        <Field label="Location">
          <Select
            value={String(form.locationId)}
            onChange={(e) => setForm((f) => ({ ...f, locationId: Number(e.target.value) }))}
          >
            {locations.map((l) => (
              <option key={l.id} value={String(l.id)}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What it counts">
          <Select
            value={form.scope}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                scope: e.target.value as SaveProgrammeInput['scope'],
                scopeRefId: null,
              }))
            }
          >
            <option value="department">A department</option>
            <option value="brand">A brand</option>
            <option value="supplier">A supplier</option>
            <option value="full">Everything</option>
          </Select>
        </Field>
        {form.scope !== 'full' && (
          <Field label="Which one" className="sm:col-span-2">
            <Select
              value={form.scopeRefId === null ? '' : String(form.scopeRefId)}
              onChange={(e) =>
                setForm((f) => ({ ...f, scopeRefId: Number(e.target.value) || null }))
              }
            >
              <option value="">Choose…</option>
              {refOptions.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="How often">
          <Select
            value={form.frequency}
            onChange={(e) =>
              setForm((f) => ({ ...f, frequency: e.target.value as SaveProgrammeInput['frequency'] }))
            }
          >
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="quarterly">Every three months</option>
            <option value="annually">Once a year</option>
          </Select>
        </Field>
        {form.frequency === 'weekly' ? (
          <Field label="On which day">
            <Select
              value={String(form.dayOfWeek ?? 1)}
              onChange={(e) => setForm((f) => ({ ...f, dayOfWeek: Number(e.target.value) }))}
            >
              {DAYS.map((day, i) => (
                <option key={day} value={String(i + 1)}>
                  {day}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label="Day of month">
            <Input
              type="number"
              min={1}
              max={31}
              value={String(form.dayOfMonth ?? 1)}
              onChange={(e) => setForm((f) => ({ ...f, dayOfMonth: Number(e.target.value) || 1 }))}
            />
          </Field>
        )}
        <Field label="Starts on">
          <Input
            type="date"
            value={form.startsOn}
            onChange={(e) => setForm((f) => ({ ...f, startsOn: e.target.value }))}
          />
        </Field>
        <Field label="Ends on (optional)">
          <Input
            type="date"
            value={form.endsOn ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, endsOn: e.target.value || null }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Switch
            checked={form.includeZeroStock ?? false}
            onChange={(next) => setForm((f) => ({ ...f, includeZeroStock: next }))}
            label="Count zero-stock products too"
            hint="A shelf that should be empty is still worth an eye."
          />
        </div>
        <div className="sm:col-span-2">
          <Switch
            checked={form.isActive ?? true}
            onChange={(next) => setForm((f) => ({ ...f, isActive: next }))}
            label="Active"
            hint="Inactive programmes are never due."
          />
        </div>
      </div>
    </Modal>
  )
}
