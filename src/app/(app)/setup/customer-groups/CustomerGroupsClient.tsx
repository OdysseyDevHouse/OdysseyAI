'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  CurrencyInput,
  DataTable,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { CYCLE_LABELS, STATEMENT_CYCLES, type StatementCycle } from '@/lib/statementCycles'
import type { CustomerGroup } from '@/lib/site/customerLookups'
import { saveCustomerGroupAction, deleteCustomerGroupAction } from './actions'

type Structure = { id: number; name: string; isDefault: boolean }

type Draft = {
  name: string
  code: string
  defaultTermsDays: number
  defaultCreditLimit: number
  defaultDailyLimit: number
  defaultMonthlyLimit: number
  /** A string so the field can be genuinely EMPTY — blank means the group grants none. */
  defaultDiscountPct: string
  defaultInterestRatePct: number
  defaultInterestEnabled: boolean
  defaultInterestGraceDays: number
  defaultStatementCycle: StatementCycle
  defaultStatementAnchorDay: number
  priceStructureId: number | null
  sortOrder: number
  isActive: boolean
}

const BLANK: Draft = {
  name: '',
  code: '',
  defaultTermsDays: 30,
  defaultCreditLimit: 0,
  defaultDailyLimit: 0,
  defaultMonthlyLimit: 0,
  defaultDiscountPct: '',
  defaultInterestRatePct: 0,
  defaultInterestEnabled: false,
  defaultInterestGraceDays: 0,
  defaultStatementCycle: 'monthly',
  defaultStatementAnchorDay: 0,
  priceStructureId: null,
  sortOrder: 0,
  isActive: true,
}

/**
 * Maintaining the customer groups.
 *
 * ── WHAT A GROUP ACTUALLY DOES, SAID ON THE SCREEN ───────────────────────
 *
 * Two different things, and conflating them is the mistake this screen is
 * written to prevent:
 *
 *   THE DEFAULTS ARE A STARTING POINT. Terms, credit limit, interest and the
 *   statement cycle are copied onto a NEW account and can then be overridden.
 *   Changing them here never restates an account that already exists — the
 *   schema comment in 012 is explicit that it must not, because those accounts
 *   agreed to what they agreed to.
 *
 *   THE PRICE STRUCTURE IS LIVE. It is resolved through the group at the till
 *   on every sale, so changing it here reprices every account in the group
 *   immediately.
 *
 * The card description and the two hints in the dialog say exactly that, because
 * a manager editing a group cannot otherwise tell which half they are touching.
 *
 * ── DEACTIVATE, DON'T DELETE ─────────────────────────────────────────────
 *
 * The FK is ON DELETE SET NULL, so deleting a group in use would silently
 * unassign every account on it. deleteCustomerGroup() refuses in that case and
 * says how many; this screen offers the switch as the way out.
 */
export default function CustomerGroupsClient({
  groups,
  structures,
}: {
  groups: CustomerGroup[]
  structures: Structure[]
}) {
  const [editing, setEditing] = useState<CustomerGroup | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState<CustomerGroup | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const structureName = (id: number | null) =>
    id === null ? null : (structures.find((s) => s.id === id)?.name ?? null)

  function openNew() {
    // A new group lands at the bottom rather than fighting for position 0.
    setEditing(null)
    setDraft({ ...BLANK, sortOrder: (groups.at(-1)?.sortOrder ?? 0) + 10 })
    setOpen(true)
  }

  function openEdit(group: CustomerGroup) {
    setEditing(group)
    setDraft({
      name: group.name,
      code: group.code ?? '',
      defaultTermsDays: group.defaultTermsDays,
      defaultCreditLimit: group.defaultCreditLimit,
      defaultDailyLimit: group.defaultDailyLimit,
      defaultMonthlyLimit: group.defaultMonthlyLimit,
      // Null becomes an empty field, not "0" — the two say different things.
      defaultDiscountPct:
        group.defaultDiscountPct === null ? '' : String(group.defaultDiscountPct),
      defaultInterestRatePct: group.defaultInterestRatePct,
      defaultInterestEnabled: group.defaultInterestEnabled,
      defaultInterestGraceDays: group.defaultInterestGraceDays,
      defaultStatementCycle: group.defaultStatementCycle,
      defaultStatementAnchorDay: group.defaultStatementAnchorDay,
      priceStructureId: group.priceStructureId,
      sortOrder: group.sortOrder,
      isActive: group.isActive,
    })
    setOpen(true)
  }

  function save() {
    startTransition(async () => {
      const result = await saveCustomerGroupAction(
        {
          ...draft,
          code: draft.code.trim() || null,
          // Blank is NOT zero: it means this group grants no discount, and an
          // account under it falls back to nothing rather than to an explicit 0.
          defaultDiscountPct: draft.defaultDiscountPct.trim()
            ? Number(draft.defaultDiscountPct)
            : null,
        },
        editing?.id,
      )
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(editing ? `${draft.name} updated.` : `${draft.name} added.`)
      setOpen(false)
      router.refresh()
    })
  }

  function remove() {
    if (!removing) return
    const target = removing
    startTransition(async () => {
      const result = await deleteCustomerGroupAction(target.id)
      if (!result.ok) {
        // The refusal names the account count and what to do instead, so it is
        // shown as-is rather than replaced with a generic failure.
        toast.error(result.error)
        setRemoving(null)
        return
      }
      toast.success(`${target.name} deleted.`)
      setRemoving(null)
      router.refresh()
    })
  }

  const columns: Column<CustomerGroup>[] = [
    {
      key: 'name',
      header: 'Group',
      cell: (g) => (
        <div>
          <span className="text-ink">{g.name}</span>
          {g.code && <span className="ml-2 text-xs text-muted">{g.code}</span>}
        </div>
      ),
      sortValue: (g) => g.name,
    },
    {
      key: 'terms',
      header: 'Terms',
      cell: (g) => (
        <span className="text-ink-2">
          {g.defaultTermsDays === 0 ? 'Cash on delivery' : `${g.defaultTermsDays} days`}
        </span>
      ),
      sortValue: (g) => g.defaultTermsDays,
    },
    {
      key: 'limit',
      header: 'Credit limit',
      numeric: true,
      /* The caps ride under the limit rather than taking two more columns:
         they are the same question at a different timescale, and a group with
         none — the common case — shows nothing extra. */
      cell: (g) => (
        <div>
          {g.defaultCreditLimit > 0 ? (
            formatMoney(g.defaultCreditLimit)
          ) : (
            <span className="text-muted">No credit</span>
          )}
          {(g.defaultDailyLimit > 0 || g.defaultMonthlyLimit > 0) && (
            <div className="text-xs text-muted">
              {[
                g.defaultDailyLimit > 0 ? `${formatMoney(g.defaultDailyLimit)}/day` : null,
                g.defaultMonthlyLimit > 0 ? `${formatMoney(g.defaultMonthlyLimit)}/month` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}
        </div>
      ),
      sortValue: (g) => g.defaultCreditLimit,
    },
    {
      key: 'structure',
      header: 'Price structure',
      cell: (g) => {
        const name = structureName(g.priceStructureId)
        return name ? (
          <Badge tone="brand">{name}</Badge>
        ) : (
          <span className="text-muted">Site default</span>
        )
      },
      sortValue: (g) => structureName(g.priceStructureId) ?? '',
    },
    {
      key: 'discount',
      header: 'Discount',
      numeric: true,
      cell: (g) =>
        g.defaultDiscountPct ? (
          <Badge tone="brand">{g.defaultDiscountPct}%</Badge>
        ) : (
          <span className="text-muted">—</span>
        ),
      sortValue: (g) => g.defaultDiscountPct ?? -1,
    },
    {
      key: 'interest',
      header: 'Interest',
      cell: (g) =>
        g.defaultInterestEnabled ? (
          <Badge tone="warning">{g.defaultInterestRatePct}% a year</Badge>
        ) : (
          <span className="text-muted">—</span>
        ),
      sortValue: (g) => (g.defaultInterestEnabled ? g.defaultInterestRatePct : -1),
    },
    {
      key: 'customers',
      header: 'Accounts',
      numeric: true,
      cell: (g) => g.customerCount,
      sortValue: (g) => g.customerCount,
    },
    {
      key: 'active',
      header: 'Status',
      cell: (g) =>
        g.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
      sortValue: (g) => (g.isActive ? 1 : 0),
    },
  ]

  return (
    <>
      <Card>
        <CardHeader
          title="Groups"
          description="Terms, credit limit, spend limits, interest and statement cycle are copied onto a new account and can be changed on it afterwards — editing a group never restates accounts that already exist. Pricing is the exception: the price structure and standing discount are read live at the till, so changing either reprices every account in the group that has not set its own."
          action={
            <Button variant="primary" size="sm" onClick={openNew}>
              <Icons.Plus size={15} />
              Add a group
            </Button>
          }
        />
        <DataTable
          columns={columns}
          rows={groups}
          getRowKey={(g) => g.id}
          onRowClick={openEdit}
          actions={(g) => (
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => setRemoving(g)}
              aria-label={`Remove ${g.name}`}
            >
              <Icons.Trash size={15} />
            </Button>
          )}
          empty={{
            title: 'No groups yet',
            hint: 'A group holds the terms a new account starts on and the prices it buys at — wholesale, retail, staff. Accounts work without one, so add these only where a set of customers genuinely trades on different terms.',
            icon: <Icons.Users size={22} />,
          }}
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'New group'}
        size="md"
      /* A long form: the default 60vh cap made it read through a letterbox with
           empty desktop above and below. Still a MAX, so a short one stays short. */
        bodyGrows
        /* The primary action lives in the footer: this dialog is taller than
           the modal body's 60vh, so a button placed after the fields would sit
           below the scroll line on a laptop. */
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending || !draft.name.trim()}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <CardBody className="grid gap-4 px-0 py-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="What the picker on a customer shows.">
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={120}
                placeholder="Wholesale"
              />
            </Field>
            <Field label="Code" hint="Optional. Short, for reports and imports.">
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
                maxLength={32}
                placeholder="WHL"
              />
            </Field>
          </div>

          {/* The live half, called out as such — everything below it is a
              starting point, these two are not. Structure and discount sit
              together because they are one question: what this group pays. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Price structure"
              hint="Read live at the till: changing this reprices every account in the group straight away."
            >
              <Select
                value={draft.priceStructureId === null ? '' : String(draft.priceStructureId)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    priceStructureId: e.target.value ? Number(e.target.value) : null,
                  })
                }
              >
                <option value="">Site default</option>
                {structures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.isDefault ? ' (site default)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Standing discount (%)"
              hint="Also live. Applies to every account in the group that has not set its own — capped per product at its own ceiling. Blank for none."
            >
              <NumberInput
                step="0.1"
                value={draft.defaultDiscountPct}
                onChange={(e) => setDraft({ ...draft, defaultDiscountPct: e.target.value })}
              />
            </Field>
          </div>

          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-medium text-ink">Defaults for a new account</h3>
            <p className="mt-1 text-sm text-muted">
              Copied onto an account when it is created, and editable on the account afterwards.
              Changing these never restates an account that already exists.
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Payment terms (days)" hint="Zero means cash on delivery.">
                <NumberInput
                  value={draft.defaultTermsDays}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultTermsDays: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Field label="Credit limit" hint="Zero means no credit granted — not unlimited.">
                <CurrencyInput
                  value={draft.defaultCreditLimit}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultCreditLimit: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </div>

            {/* Note the inverted zero: on the credit limit above, zero grants
                nothing; on these two it restricts nothing. Both hints say so
                rather than relying on the reader to notice. */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Daily limit" hint="Zero means no daily limit.">
                <CurrencyInput
                  value={draft.defaultDailyLimit}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultDailyLimit: Number(e.target.value) || 0 })
                  }
                />
              </Field>
              <Field label="Monthly limit" hint="Zero means no monthly limit.">
                <CurrencyInput
                  value={draft.defaultMonthlyLimit}
                  onChange={(e) =>
                    setDraft({ ...draft, defaultMonthlyLimit: Number(e.target.value) || 0 })
                  }
                />
              </Field>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Statement cycle" hint="How often an account in this group is statemented.">
                <Select
                  value={draft.defaultStatementCycle}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      defaultStatementCycle: e.target.value as StatementCycle,
                    })
                  }
                >
                  {STATEMENT_CYCLES.map((cycle) => (
                    <option key={cycle} value={cycle}>
                      {CYCLE_LABELS[cycle]}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.defaultStatementCycle === 'monthly' && (
                <Field
                  label="Cut on day"
                  hint="Zero for calendar months. The 31st becomes the last day in shorter months."
                >
                  <NumberInput
                    value={draft.defaultStatementAnchorDay}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultStatementAnchorDay: Number(e.target.value) || 0,
                      })
                    }
                  />
                </Field>
              )}
            </div>
          </div>

          {/* Interest is a legal decision, not merely a numeric default — the
              same NCA warning the customer form carries, for the same reason. */}
          <div className="border-t border-border pt-4">
            <Switch
              checked={draft.defaultInterestEnabled}
              onChange={(next) => setDraft({ ...draft, defaultInterestEnabled: next })}
              label="Charge interest on overdue amounts by default"
              hint="Only switch this on where these customers agree to it in writing — the National Credit Act requires that. It is still a default: each account can turn it off."
            />

            {draft.defaultInterestEnabled && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field label="Interest rate (% a year)" hint="Annual nominal rate.">
                  <NumberInput
                    step="0.01"
                    value={draft.defaultInterestRatePct}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultInterestRatePct: Number(e.target.value) || 0,
                      })
                    }
                  />
                </Field>
                <Field label="Grace period (days)" hint="Days past due before interest accrues.">
                  <NumberInput
                    value={draft.defaultInterestGraceDays}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        defaultInterestGraceDays: Number(e.target.value) || 0,
                      })
                    }
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="border-t border-border pt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Order" hint="Where it sits in the list. Lower comes first.">
              <NumberInput
                value={draft.sortOrder}
                onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>

          <Switch
            checked={draft.isActive}
            onChange={(next) => setDraft({ ...draft, isActive: next })}
            label="Available to choose"
            hint="An inactive group stays on the accounts already in it, but cannot be picked for a new one."
          />
        </CardBody>
      </Modal>

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={removing ? `Delete ${removing.name}?` : 'Delete group?'}
        confirmLabel="Delete it"
        tone="danger"
        busy={pending}
        message={
          removing && removing.customerCount > 0
            ? `${removing.customerCount} account${
                removing.customerCount === 1 ? ' is' : 's are'
              } still in this group, so it cannot be deleted — that would unassign ${
                removing.customerCount === 1 ? 'it' : 'them'
              } silently. Reassign ${
                removing.customerCount === 1 ? 'it' : 'them'
              } first, or switch the group off instead so it stays on the accounts that have it.`
            : 'No accounts are in this group, so it is removed outright.'
        }
      />
    </>
  )
}
