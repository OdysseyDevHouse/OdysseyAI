'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ColourInput,
  ConfirmModal,
  CurrencyInput,
  Field,
  FieldGroup,
  Icons,
  Input,
  Menu,
  MenuItem,
  Modal,
  NumberInput,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TenderType, TenderInput } from '@/lib/site/tenderTypes'
import {
  saveTenderTypeAction,
  deleteTenderTypeAction,
  reorderTenderTypesAction,
} from './actions'

/**
 * Tender setup.
 *
 * The flags are grouped as BEHAVIOUR and PRESENTATION, matching the schema,
 * because the distinction is the thing a store owner needs to understand: one
 * group changes what the till does, the other changes how the button looks.
 *
 * Up/down buttons rather than drag-and-drop. @dnd-kit is installed but unused,
 * and a list of six rows reordered twice a year does not justify the dependency
 * or the keyboard-accessibility work drag would need to be done properly.
 */
export default function TenderTypesClient({
  tenders,
  saleFieldCount,
}: {
  tenders: TenderType[]
  /** How many sale custom fields exist, so the toggle can say what it will ask. */
  saleFieldCount: number
}) {
  const [editing, setEditing] = useState<TenderType | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<TenderType | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditing(null)
        setAdding(false)
        setDeleting(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...tenders]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    run(() => reorderTenderTypesAction(next.map((t) => t.id)))
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Payment methods"
          description="Shown as buttons at the till, in this order. A card machine or online provider added later — Yoco, PayFast, a loyalty wallet — is just a new tender pointing at its integration."
          action={
            <Button variant="primary" onClick={() => setAdding(true)} disabled={pending}>
              <Icons.Plus size={15} />
              Add tender
            </Button>
          }
        />

        <div>
          {tenders.map((tender, index) => (
            <SettingRow
              key={tender.id}
              icon={<Icons.CreditCard size={16} />}
              label={tender.name}
              description={describe(tender)}
            >
              <div className="flex items-center gap-1.5">
                {!tender.isActive && <Badge tone="neutral">Off</Badge>}
                {tender.isSystem && <Badge tone="brand">Built-in</Badge>}
                <Button
                  variant="bare"
                  size="sm"
                  iconOnly
                  aria-label={`Move ${tender.name} up`}
                  disabled={index === 0 || pending}
                  onClick={() => move(index, -1)}
                >
                  <Icons.ChevronUp size={15} />
                </Button>
                <Button
                  variant="bare"
                  size="sm"
                  iconOnly
                  aria-label={`Move ${tender.name} down`}
                  disabled={index === tenders.length - 1 || pending}
                  onClick={() => move(index, 1)}
                >
                  <Icons.ChevronDown size={15} />
                </Button>
                {/* Reorder stays as bare arrows — it is THE act this list is
                    for. Everything else folds into one menu per row. */}
                <Menu label="More" variant="ghost">
                  <MenuItem onClick={() => setEditing(tender)}>
                    <Icons.Pencil size={15} />
                    Edit
                  </MenuItem>
                  <MenuItem
                    tone="danger"
                    disabled={tender.isSystem || pending}
                    onClick={() => setDeleting(tender)}
                  >
                    <Icons.Trash size={15} />
                    Delete
                  </MenuItem>
                </Menu>
              </div>
            </SettingRow>
          ))}
        </div>
      </Card>

      <TenderModal
        tender={adding ? null : editing}
        open={adding || editing !== null}
        pending={pending}
        saleFieldCount={saleFieldCount}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
        onSave={(input) => run(() => saveTenderTypeAction(editing?.id ?? null, input))}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && run(() => deleteTenderTypeAction(deleting.id))}
        title={`Delete ${deleting?.name}?`}
        message="This removes the button from the till. A tender that has already taken money cannot be deleted — deactivate it instead."
        confirmLabel="Delete tender"
        busy={pending}
      />
    </>
  )
}

/** The behaviour flags, as a sentence — so the grid explains itself. */
function describe(tender: TenderType): string {
  const parts: string[] = [tender.code]
  if (tender.postsToDebtor) parts.push('posts to the account')
  if (tender.countsAsDrawerCash) parts.push('counted in the drawer')
  if (tender.allowsChange) parts.push('gives change')
  if (tender.requiresReference) parts.push(`needs a ${tender.referenceLabel?.toLowerCase()}`)
  if (tender.roundsToCashDenomination) parts.push('rounds to cash')
  if (!tender.allowsRefund) parts.push('no refunds')
  /* Only the surprising states. "Over-payment is a tip" is worth saying because it means
     the till keeps money without asking; a cash tip landing in the drawer is the obvious
     default and would be noise on every row. */
  if (tender.tipOnOverTender) parts.push('over-payment is a tip')
  if (!tender.tipInDrawer && tender.countsAsDrawerCash) parts.push('tips not in the drawer')
  if (tender.minAmount > 0) parts.push(`min ${formatMoney(tender.minAmount)}`)
  if (tender.surchargePct > 0) parts.push(`${tender.surchargePct}% surcharge`)
  return parts.join(' · ')
}

function TenderModal({
  tender,
  open,
  pending,
  saleFieldCount,
  onClose,
  onSave,
}: {
  tender: TenderType | null
  open: boolean
  pending: boolean
  /** How many sale custom fields exist — the toggle's hint names the number. */
  saleFieldCount: number
  onClose: () => void
  onSave: (input: TenderInput) => void
}) {
  const [form, setForm] = useState<TenderInput>(() => blank())
  const [seeded, setSeeded] = useState<number | null>(null)

  // Seed from the row being edited the first time the modal opens for it.
  if (open && seeded !== (tender?.id ?? 0)) {
    setSeeded(tender?.id ?? 0)
    setForm(tender ? fromTender(tender) : blank())
  }
  if (!open && seeded !== null) setSeeded(null)

  const set = <K extends keyof TenderInput>(key: K, value: TenderInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tender ? `Edit ${tender.name}` : 'Add a tender'}
      description="Behaviour flags change what the till does. Presentation only changes how the button looks."
      size="lg"
      /* A long form: the default 60vh cap made it read through a letterbox with
         empty desktop above and below. Still a MAX, so a short one stays short. */
      bodyGrows
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onSave(form)} disabled={pending}>
            {pending ? 'Saving…' : tender ? 'Save changes' : 'Add tender'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field
          label="Code"
          hint={
            tender?.isSystem
              ? 'Built-in tenders keep their code — the engine matches on it.'
              : 'The stable handle. Letters, digits and underscores.'
          }
        >
          <div className="w-48">
            <Input
              value={form.code}
              onChange={(e) => set('code', e.target.value.toUpperCase())}
              disabled={tender?.isSystem}
              maxLength={24}
            />
          </div>
        </Field>

        <FieldGroup title="Presentation" hint="Only changes how the button looks at the till.">
          <Field label="Name" hint="What the cashier sees. Rename freely.">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={60} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Icon" hint="Optional — the glyph on the till button.">
              <Input
                value={form.icon ?? ''}
                onChange={(e) => set('icon', e.target.value || null)}
                maxLength={40}
              />
            </Field>
            <Field label="Colour" hint="Optional — the button’s tint.">
              <ColourInput value={form.color ?? ''} onChange={(next) => set('color', next || null)} />
            </Field>
          </div>
        </FieldGroup>

        <FieldGroup title="Behaviour" hint="Changes what the till actually does.">
            <Switch
              checked={!!form.postsToDebtor}
              onChange={(v) => setForm((c) => ({ ...c, postsToDebtor: v, requiresCustomer: v || c.requiresCustomer }))}
              label="Posts to the customer's account"
              hint="No money changes hands; the balance moves onto their debtor card."
            />
            <Switch
              checked={!!form.requiresCustomer}
              onChange={(v) => set('requiresCustomer', v)}
              disabled={!!form.postsToDebtor}
              label="Requires a customer"
              hint="The till refuses it for a walk-in."
            />
            <Switch
              checked={!!form.countsAsDrawerCash}
              onChange={(v) => setForm((c) => ({ ...c, countsAsDrawerCash: v, allowsChange: v && c.allowsChange }))}
              label="Counted in the cash drawer"
              hint="Included in the cash-up. Only these can give change."
            />
            <Switch
              checked={!!form.allowsChange}
              onChange={(v) => set('allowsChange', v)}
              disabled={!form.countsAsDrawerCash}
              label="Can give change"
              hint="R100 on an R87.50 sale is a R100 tender with R12.50 change."
            />
            <Switch
              checked={!!form.opensCashDrawer}
              onChange={(v) => set('opensCashDrawer', v)}
              label="Opens the cash drawer"
              hint="A card slip still goes in the drawer."
            />
            <Switch
              checked={!!form.roundsToCashDenomination}
              onChange={(v) => set('roundsToCashDenomination', v)}
              label="Rounds to the nearest coin"
              hint="Rounds the tender, never the invoice — VAT stays exact."
            />
            <Switch
              checked={!!form.requiresReference}
              onChange={(v) => set('requiresReference', v)}
              label="Requires a reference"
              hint="The only way a deposit is matched on the bank statement."
            />
            {form.requiresReference && (
              <Field label="Reference label" hint="What the cashier is asked for.">
                <Input
                  value={form.referenceLabel ?? ''}
                  onChange={(e) => set('referenceLabel', e.target.value)}
                  placeholder="Deposit reference"
                  maxLength={40}
                />
              </Field>
            )}
            {/* Beside the reference for a reason: both make the till ask for
                something before it will finalise, and a manager deciding one is
                thinking about the other. */}
            <Switch
              checked={!!form.asksCustomComments}
              onChange={(v) => set('asksCustomComments', v)}
              label="Asks for the sale's custom comments"
              hint={
                saleFieldCount > 0
                  ? `Prompts for your ${saleFieldCount} sale ${saleFieldCount === 1 ? 'field' : 'fields'} when a sale is finalised on this tender.`
                  : 'Define the questions first under Setup › Custom fields › Sales — with none set up, this asks nothing.'
              }
            />
            <Switch
              checked={form.allowsSplit !== false}
              onChange={(v) => set('allowsSplit', v)}
              label="Can be split with another tender"
            />
            <Switch
              checked={form.allowsRefund !== false}
              onChange={(v) => set('allowsRefund', v)}
              label="Can be refunded at the till"
            />
        </FieldGroup>

        <FieldGroup
          title="Tips"
          hint="What happens when a customer pays more than the bill."
        >
            {/*
              Only meaningful where the method gives NO change. Cash gives change back, so
              its excess is ambiguous — R100 on a R50 bill might be R50 change or R10 tip
              and R40 change — and the till asks the cashier instead. Disabled rather than
              hidden so the reason is visible on the screen that would otherwise look like
              it was missing a setting.
            */}
            <Switch
              checked={!!form.tipOnOverTender}
              onChange={(v) => set('tipOnOverTender', v)}
              disabled={!!form.allowsChange}
              label="Paying over the bill leaves a tip"
              hint={
                form.allowsChange
                  ? 'Only for methods that give no change — this one gives change, so the till asks the cashier how much of it is a tip.'
                  : 'R120 on a R100 bill records a R20 tip. With this OFF the till REFUSES the over-payment instead of keeping it.'
              }
            />
            {/*
              The flag that keeps a cash-up balancing. Defaults on, because the common case
              is cash; turned off for card and account by migration 091 and by the rule
              below, since that money never reaches the till.
            */}
            <Switch
              checked={form.tipInDrawer !== false}
              onChange={(v) => set('tipInDrawer', v)}
              disabled={!!form.postsToDebtor}
              label="Tips on this method land in the drawer"
              hint={
                form.postsToDebtor
                  ? 'An account tip is charged to the customer and collected later, so it never reaches the till.'
                  : 'Leave ON for cash. Turn OFF for card — that money arrives through the card machine and is paid out through payroll, so the drawer must not be expected to hold it.'
              }
            />
        </FieldGroup>

        <FieldGroup title="Limits" hint="Amount rules the till enforces per payment.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum" hint="Card machines often have a floor.">
              <CurrencyInput
                value={form.minAmount ?? 0}
                onChange={(e) => set('minAmount', money(e.target.value))}
              />
            </Field>
            <Field label="Maximum" hint="Zero means no ceiling.">
              <CurrencyInput
                value={form.maxAmount ?? 0}
                onChange={(e) => set('maxAmount', money(e.target.value))}
              />
            </Field>
            <Field label="Surcharge %" hint="Passed on to the customer.">
              <NumberInput
                value={form.surchargePct ?? 0}
                onChange={(e) => set('surchargePct', money(e.target.value))}
              />
            </Field>
          </div>
        </FieldGroup>

        <Switch
          checked={form.isActive !== false}
          onChange={(v) => set('isActive', v)}
          label="Available at the till"
          hint="Turn off to hide the button without losing its history."
        />
      </div>
    </Modal>
  )
}

function money(value: unknown): number {
  return Number(String(value).replace(',', '.')) || 0
}

function blank(): TenderInput {
  return {
    code: '',
    name: '',
    allowsSplit: true,
    allowsRefund: true,
    isActive: true,
  }
}

function fromTender(t: TenderType): TenderInput {
  return {
    code: t.code,
    name: t.name,
    postsToDebtor: t.postsToDebtor,
    requiresCustomer: t.requiresCustomer,
    countsAsDrawerCash: t.countsAsDrawerCash,
    opensCashDrawer: t.opensCashDrawer,
    allowsChange: t.allowsChange,
    allowsSplit: t.allowsSplit,
    allowsRefund: t.allowsRefund,
    requiresReference: t.requiresReference,
    asksCustomComments: t.asksCustomComments,
    referenceLabel: t.referenceLabel,
    roundsToCashDenomination: t.roundsToCashDenomination,
    minAmount: t.minAmount,
    maxAmount: t.maxAmount,
    surchargePct: t.surchargePct,
    integrationKey: t.integrationKey,
    icon: t.icon,
    color: t.color,
    position: t.position,
    isActive: t.isActive,
  }
}
