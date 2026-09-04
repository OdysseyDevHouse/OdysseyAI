'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  DataTable,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  useToast,
  type Column,
} from '@/components/ui'
import { parseWithRules } from '@/lib/barcodes'
import { saveScaleRuleAction, deleteScaleRuleAction } from './actions'
import type { ScaleRule } from '@/lib/site/scaleBarcodes'

/**
 * The scale barcode shapes this shop can read.
 *
 * ── WHY A LIST AND NOT THREE SETTINGS ─────────────────────────────────────
 *
 * A shop floor is not one scale. A grocer runs several, replaces one, or takes
 * deliveries pre-labelled by a supplier whose machine prints a different prefix
 * and a different PLU length. With a single stored shape the shop had to pick
 * which of its scales worked, and everything off the other one scanned as an
 * unknown barcode — no price, and nothing on screen saying why.
 *
 * The columns are the ones the people using this already know from the system
 * they came off: prefix, stock code, check digit, value length, decimals.
 */

const BLANK = {
  prefix: '',
  pluLength: 5,
  hasCheckDigit: true,
  valueLength: 0,
  decimals: 2,
  isActive: true,
}

type Draft = typeof BLANK & { id?: number }

export default function ScaleBarcodesClient({ rules }: { rules: ScaleRule[] }) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ScaleRule | null>(null)
  /* The tester's input. Empty is the resting state, and deliberately not
     pre-filled with an example: a box that already holds a working barcode
     invites reading the answer rather than scanning a real label. */
  const [probe, setProbe] = useState('')

  /* What the till would make of the typed barcode, using the SAME function the
     scanner uses rather than a re-implementation. A tester that agrees with a
     copy of the logic proves nothing about the copy the till runs. */
  const probeResult = useMemo(() => {
    const digits = probe.trim()
    if (!digits) return null
    return parseWithRules(
      digits,
      rules.filter((r) => r.isActive),
    )
  }, [probe, rules])

  function save() {
    if (!draft) return
    startTransition(async () => {
      const result = await saveScaleRuleAction(draft.id ?? null, {
        prefix: draft.prefix,
        pluLength: draft.pluLength,
        hasCheckDigit: draft.hasCheckDigit,
        valueLength: draft.valueLength,
        decimals: draft.decimals,
        isActive: draft.isActive,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setDraft(null)
      toast.success(result.message)
      router.refresh()
    })
  }

  function remove(rule: ScaleRule) {
    startTransition(async () => {
      const result = await deleteScaleRuleAction(rule.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setConfirmDelete(null)
      toast.success(result.message)
      router.refresh()
    })
  }

  const columns: Column<ScaleRule>[] = [
    {
      key: 'prefix',
      header: 'Prefix',
      cell: (r) => <span className="numeric">{r.prefix}</span>,
      sortValue: (r) => r.prefix,
    },
    {
      key: 'pluLength',
      header: 'Stock code',
      numeric: true,
      cell: (r) => <span className="numeric">{r.pluLength}</span>,
      sortValue: (r) => r.pluLength,
    },
    {
      key: 'hasCheckDigit',
      header: 'Check digit',
      cell: (r) => (
        <Badge tone={r.hasCheckDigit ? 'success' : 'neutral'}>
          {r.hasCheckDigit ? 'Yes' : 'No'}
        </Badge>
      ),
      sortValue: (r) => (r.hasCheckDigit ? 1 : 0),
    },
    {
      key: 'valueLength',
      header: 'Value length',
      numeric: true,
      /* 0 means "any length", which is what a rule carried over from the old
         single setting holds. Shown as a word rather than a nought, because a
         nought in a length column reads as a mistake. */
      cell: (r) => <span className="numeric">{r.valueLength || 'Any'}</span>,
      sortValue: (r) => r.valueLength,
    },
    {
      key: 'decimals',
      header: 'Decimals',
      numeric: true,
      cell: (r) => <span className="numeric">{r.decimals}</span>,
      sortValue: (r) => r.decimals,
    },
    {
      key: 'isActive',
      header: 'Status',
      cell: (r) =>
        r.isActive ? <Badge tone="success">In use</Badge> : <Badge tone="neutral">Paused</Badge>,
      sortValue: (r) => (r.isActive ? 1 : 0),
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Barcode shapes"
          description="How a scale label is read: which digits are the product, and which are the price or weight."
          action={
            <Button variant="primary" onClick={() => setDraft({ ...BLANK })}>
              <Icons.Plus size={15} />
              Add a shape
            </Button>
          }
        />
        <CardBody>
          {rules.length === 0 ? (
            <EmptyState
              icon={<Icons.Barcode size={22} />}
              title="No scale barcodes set up"
              hint="Add the shape your scale prints and the till will read the price or weight out of every label it produces."
              action={
                <Button variant="primary" onClick={() => setDraft({ ...BLANK })}>
                  Add a shape
                </Button>
              }
            />
          ) : (
            <DataTable
              columns={columns}
              rows={rules}
              getRowKey={(r) => String(r.id)}
              actions={(r) => (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit prefix ${r.prefix}`}
                    onClick={() => setDraft({ ...r })}
                  >
                    <Icons.Pencil size={15} />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete prefix ${r.prefix}`}
                    onClick={() => setConfirmDelete(r)}
                  >
                    <Icons.Trash size={15} />
                  </Button>
                </div>
              )}
            />
          )}
        </CardBody>
      </Card>

      {/* ── THE TESTER ────────────────────────────────────────────────────
          A wrong prefix or a wrong decimal count does not fail — it misprices
          every weighed item, quietly, and the first anyone knows is a cash-up
          that will not balance. So the screen lets somebody scan a real label
          and SEE what the till would charge, before it charges it. */}
      <Card>
        <CardHeader
          title="Try a barcode"
          description="Scan or type a label from your scale. This reads it exactly as the till would."
        />
        <CardBody className="flex flex-col gap-3">
          <Field label="Barcode" htmlFor="probe">
            <Input
              id="probe"
              className="max-w-[280px]"
              value={probe}
              placeholder="Scan a label"
              onChange={(e) => setProbe(e.target.value)}
            />
          </Field>

          {probe.trim() && !probeResult && (
            <p className="text-sm text-muted">
              No shape above reads this barcode. Check the prefix, or add a shape for it.
            </p>
          )}

          {probeResult && (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-card bg-surface-2 px-3 py-2.5 text-sm">
              <span className="text-muted">
                Matched prefix <span className="numeric text-ink">{probeResult.rule.prefix}</span>
              </span>
              <span className="text-muted">
                Stock code <span className="numeric text-ink">{probeResult.parsed.plu}</span>
              </span>
              <span className="text-muted">
                Value{' '}
                <span className="numeric text-ink">{probeResult.parsed.value.toFixed(2)}</span>
              </span>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? 'Edit barcode shape' : 'Add a barcode shape'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col gap-3">
            <Field
              label="Prefix"
              hint="The leading digit or two that marks a scale label."
              htmlFor="sb-prefix"
            >
              <Input
                id="sb-prefix"
                className="w-28"
                value={draft.prefix}
                onChange={(e) => setDraft({ ...draft, prefix: e.target.value })}
              />
            </Field>

            <Field
              label="Stock code length"
              hint="How many digits identify the product. Matched against its code, barcode or alias."
              htmlFor="sb-plu"
            >
              <NumberInput
                id="sb-plu"
                className="w-28"
                value={draft.pluLength}
                onChange={(e) => setDraft({ ...draft, pluLength: Number(e.target.value) })}
              />
            </Field>

            <Field
              label="Value length"
              hint="How many digits the whole barcode has. Leave at 0 to accept any length."
              htmlFor="sb-len"
            >
              <NumberInput
                id="sb-len"
                className="w-28"
                value={draft.valueLength}
                onChange={(e) => setDraft({ ...draft, valueLength: Number(e.target.value) })}
              />
            </Field>

            <Field
              label="Decimals"
              hint="2 when the embedded figure is in cents, 3 when it is in grams."
              htmlFor="sb-dec"
            >
              <Select
                id="sb-dec"
                className="w-32"
                value={String(draft.decimals)}
                onChange={(e) => setDraft({ ...draft, decimals: Number(e.target.value) })}
              >
                <option value="0">0</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </Select>
            </Field>

            {/* Checkbox carries a label and nothing else — a `hint` prop would
                spread onto the void input and 500 the route. Field is what
                holds an explanation. */}
            <Field hint="Tick when the barcode ends in a check digit, so it is not counted as part of the value.">
              <Checkbox
                checked={draft.hasCheckDigit}
                label="Last digit is a check digit"
                onChange={(e) => setDraft({ ...draft, hasCheckDigit: e.target.checked })}
              />
            </Field>

            <Field hint="Untick to keep the shape but stop the till reading it.">
              <Checkbox
                checked={draft.isActive}
                label="In use"
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
              />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Remove this barcode shape?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => confirmDelete && remove(confirmDelete)}
            >
              {pending ? 'Removing…' : 'Remove'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          Labels starting <span className="numeric">{confirmDelete?.prefix}</span> will stop
          scanning at the till until another shape covers them.
        </p>
      </Modal>
    </div>
  )
}
