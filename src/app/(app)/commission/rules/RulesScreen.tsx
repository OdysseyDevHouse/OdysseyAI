'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  DataTable,
  Badge,
  Modal,
  Field,
  Input,
  NumberInput,
  CurrencyInput,
  Select,
  Switch,
  Icons,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { CommissionRule, CommissionTier, CommissionBasis } from '@/lib/site/commission'
import { saveRuleAction, deleteRuleAction } from '../actions'

type Option = { id: number; name: string }

/**
 * The commission rules list.
 *
 * Ordered by priority, because that is the order the calculation reads them in
 * — a list sorted any other way would hide the single most important fact
 * about a rule, which is what it beats.
 */
export default function RulesScreen({
  rules,
  users,
  departments,
  brands,
  suppliers,
}: {
  rules: CommissionRule[]
  users: Option[]
  departments: Option[]
  brands: Option[]
  suppliers: Option[]
}) {
  const [editing, setEditing] = useState<CommissionRule | null>(null)
  const [adding, setAdding] = useState(false)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function remove(rule: CommissionRule) {
    startTransition(async () => {
      const result = await deleteRuleAction(rule.id)
      if (!result.ok) return toast.error(result.error)
      toast.success(result.message)
      router.refresh()
    })
  }

  /** What a rule applies to, in words. */
  function scopeOf(rule: CommissionRule): string {
    const parts: string[] = []
    if (rule.productCode) parts.push(`product ${rule.productCode}`)
    if (rule.brandName) parts.push(rule.brandName)
    if (rule.supplierName) parts.push(`from ${rule.supplierName}`)
    if (rule.departmentName) parts.push(rule.departmentName)
    if (rule.userName) parts.push(rule.userName)
    return parts.length ? parts.join(' · ') : 'Everything'
  }

  const columns: Column<CommissionRule>[] = [
    {
      key: 'priority',
      header: 'Priority',
      sortValue: (r) => r.priority,
      cell: (r) => <span className="numeric text-muted">{r.priority}</span>,
    },
    {
      key: 'name',
      header: 'Rule',
      sortValue: (r) => r.name,
      cell: (r) => (
        <div>
          <div className="font-medium text-ink">{r.name}</div>
          <div className="text-xs text-muted">{scopeOf(r)}</div>
        </div>
      ),
    },
    {
      key: 'basis',
      header: 'Pays on',
      sortValue: (r) => r.basis,
      cell: (r) =>
        r.isExclusion ? (
          <Badge tone="danger">Excluded</Badge>
        ) : r.basis === 'gross_profit' ? (
          <Badge tone="success">Profit</Badge>
        ) : (
          <Badge tone="warning">Turnover</Badge>
        ),
    },
    {
      key: 'rate',
      header: 'Rate',
      numeric: true,
      sortValue: (r) => (r.tiers.length ? r.tiers[0].ratePct : r.ratePct),
      cell: (r) =>
        r.isExclusion ? (
          <span className="text-muted">—</span>
        ) : r.tiers.length ? (
          <div className="text-right">
            <div className="numeric text-ink">
              {r.tiers[0].ratePct}%–{r.tiers[r.tiers.length - 1].ratePct}%
            </div>
            <div className="text-xs text-muted">{r.tiers.length} tiers</div>
          </div>
        ) : (
          <span className="numeric text-ink">{r.ratePct}%</span>
        ),
    },
    {
      key: 'threshold',
      header: 'Threshold',
      numeric: true,
      sortValue: (r) => r.threshold,
      cell: (r) =>
        r.threshold > 0 ? (
          <span className="numeric text-ink-2">{formatMoney(r.threshold)}</span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => (r.isActive ? 1 : 0),
      cell: (r) =>
        r.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="default">Off</Badge>,
    },
  ]

  return (
    <>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Icons.Plus size={16} />
          Add rule
        </Button>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={rules}
          getRowKey={(r) => r.id}
          actions={(r) => (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={`Edit ${r.name}`}
                onClick={() => setEditing(r)}
              >
                <Icons.Pencil size={15} />
              </Button>
              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                disabled={pending}
                aria-label={`Delete ${r.name}`}
                onClick={() => remove(r)}
              >
                <Icons.Trash size={15} />
              </Button>
            </div>
          )}
          empty={{
            title: 'No commission rules yet',
            hint: 'Add one to start paying commission. Nothing is earned until a rule matches.',
          }}
        />
      </Card>

      {(adding || editing) && (
        <RuleForm
          rule={editing}
          users={users}
          departments={departments}
          brands={brands}
          suppliers={suppliers}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

function RuleForm({
  rule,
  users,
  departments,
  brands,
  suppliers,
  onClose,
}: {
  rule: CommissionRule | null
  users: Option[]
  departments: Option[]
  brands: Option[]
  suppliers: Option[]
  onClose: () => void
}) {
  const [name, setName] = useState(rule?.name ?? '')
  const [priority, setPriority] = useState(String(rule?.priority ?? ''))
  const [basis, setBasis] = useState<CommissionBasis>(rule?.basis ?? 'gross_profit')
  const [departmentId, setDepartmentId] = useState(rule?.departmentId ? String(rule.departmentId) : '')
  const [brandId, setBrandId] = useState(rule?.brandId ? String(rule.brandId) : '')
  const [supplierId, setSupplierId] = useState(rule?.supplierId ? String(rule.supplierId) : '')
  const [userId, setUserId] = useState(rule?.userId ? String(rule.userId) : '')
  const [isExclusion, setIsExclusion] = useState(rule?.isExclusion ?? false)
  const [ratePct, setRatePct] = useState(String(rule?.ratePct ?? 0))
  const [threshold, setThreshold] = useState(rule?.threshold ?? 0)
  const [isActive, setIsActive] = useState(rule?.isActive ?? true)
  const [useTiers, setUseTiers] = useState((rule?.tiers.length ?? 0) > 0)
  const [tiers, setTiers] = useState<CommissionTier[]>(
    rule?.tiers.length ? rule.tiers : [{ fromAmount: 0, ratePct: 0 }],
  )
  const [error, setError] = useState<string | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function submit() {
    setError(null)
    startTransition(async () => {
      const result = await saveRuleAction(rule?.id ?? null, {
        name,
        priority: priority.trim() ? Number(priority) : null,
        basis,
        departmentId: departmentId ? Number(departmentId) : null,
        productId: rule?.productId ?? null,
        brandId: brandId ? Number(brandId) : null,
        supplierId: supplierId ? Number(supplierId) : null,
        userId: userId ? Number(userId) : null,
        isExclusion,
        ratePct: Number(ratePct) || 0,
        threshold,
        isActive,
        tiers: useTiers ? tiers : [],
      })

      if (!result.ok) {
        setError(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
      onClose()
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? `Edit ${rule.name}` : 'Add a commission rule'}
      description="One rule pays each line — the lowest priority number that matches wins."
      size="lg"
      closeOnBackdrop={false}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {error && (
          <div className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm">
            <Icons.StatusWarning size={16} className="mt-0.5 shrink-0 text-danger" />
            <span className="text-ink">{error}</span>
          </div>
        )}

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Furniture — floor staff"
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Pays on"
            hint="Profit makes a discount cost the salesperson. Turnover does not."
          >
            <Select value={basis} onChange={(e) => setBasis(e.target.value as CommissionBasis)}>
              <option value="gross_profit">Gross profit</option>
              <option value="turnover">Turnover</option>
            </Select>
          </Field>

          <Field
            label="Priority"
            hint="Lowest wins. Leave blank to set it from how specific the rule is."
          >
            <Input
              value={priority}
              onChange={(e) => setPriority(e.target.value.replace(/\D/g, ''))}
              inputMode="numeric"
              placeholder="Automatic"
            />
          </Field>
        </div>

        <div className="rounded-card border border-border p-4">
          <p className="mb-3 text-sm font-medium text-ink">What it applies to</p>
          <p className="mb-4 text-xs text-muted">
            Leave everything blank for every sale. Setting more than one narrows it — all of them
            must match.
          </p>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Department" hint="Covers its sub-departments too.">
              <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                <option value="">Any</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Brand">
              <Select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                <option value="">Any</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Supplier" hint="Matches if the product comes from them at all.">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Any</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Salesperson">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Anyone</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>

        <Switch
          checked={isExclusion}
          onChange={setIsExclusion}
          label="Earns nothing"
          hint="Makes this an exclusion — matching lines pay no commission and stop looking. Use it to carve a category out of a broader rule."
        />

        {!isExclusion && (
          <>
            <Switch
              checked={useTiers}
              onChange={setUseTiers}
              label="Use tiers"
              hint="Rate bands by the running total for the period. Each band applies only to its own slice — crossing a threshold does not re-rate what came before."
            />

            {useTiers ? (
              <div className="rounded-card border border-border p-4">
                <p className="mb-3 text-sm font-medium text-ink">Tiers</p>
                <div className="flex flex-col gap-3">
                  {tiers.map((tier, i) => (
                    <div key={i} className="flex items-end gap-3">
                      <Field label={i === 0 ? 'From' : ''} className="flex-1">
                        <CurrencyInput
                          value={tier.fromAmount}
                          disabled={i === 0}
                          onChange={(e) =>
                            setTiers((current) =>
                              current.map((t, j) =>
                                j === i ? { ...t, fromAmount: Number(e.target.value) || 0 } : t,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label={i === 0 ? 'Rate %' : ''} className="w-28">
                        <NumberInput
                          value={tier.ratePct}
                          onChange={(e) =>
                            setTiers((current) =>
                              current.map((t, j) =>
                                j === i ? { ...t, ratePct: Number(e.target.value) || 0 } : t,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        iconOnly
                        aria-label="Remove tier"
                        disabled={i === 0}
                        onClick={() => setTiers((current) => current.filter((_, j) => j !== i))}
                      >
                        <Icons.Trash size={15} />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() =>
                    setTiers((current) => [
                      ...current,
                      {
                        fromAmount: (current[current.length - 1]?.fromAmount ?? 0) + 10000,
                        ratePct: 0,
                      },
                    ])
                  }
                >
                  <Icons.Plus size={15} />
                  Add tier
                </Button>
                <p className="mt-3 text-xs text-muted">
                  The first band always starts at 0. With 0 at 5% and 10 000 at 7.5%, a 16 000
                  total pays 500 + 450 = 950 — not 1 200.
                </p>
              </div>
            ) : (
              <Field label="Rate %" hint="Of profit or turnover, whichever this rule pays on.">
                <NumberInput
                  value={ratePct}
                  onChange={(e) => setRatePct(e.target.value)}
                  className="max-w-[10rem]"
                />
              </Field>
            )}

            <Field
              label="Threshold"
              hint="Commission starts only once this person passes this much for the period. Leave at zero for none."
            >
              <CurrencyInput
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value) || 0)}
                className="max-w-[12rem]"
              />
            </Field>
          </>
        )}

        <Switch checked={isActive} onChange={setIsActive} label="Active" />
      </div>
    </Modal>
  )
}
