'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Select,
  SettingRow,
  Switch,
  useToast,
} from '@/components/ui'
import type { SequenceCheck } from '@/lib/site/sequences'
import { saveSequenceAction, saveSettingAction } from './actions'

type SequenceRow = {
  docType: string
  label: string
  prefix: string
  nextNumber: number
  padding: number
  resetPeriod: 'none' | 'yearly'
  preview: string
  check: SequenceCheck
}

export default function NumberingClient({
  sequences,
  settings,
}: {
  sequences: SequenceRow[]
  settings: Record<string, string>
}) {
  const [editing, setEditing] = useState<SequenceRow | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Document numbers"
          description="Issued at finalise, never before. A number is never reused, and a voided document keeps its own."
        />
        <div>
          {sequences.map((sequence) => (
            <SettingRow
              key={sequence.docType}
              icon={<Icons.Hash size={16} />}
              label={sequence.label}
              description={describeSequence(sequence)}
            >
              <div className="flex items-center gap-2">
                <span className="numeric text-sm text-ink">{sequence.preview}</span>
                {sequence.check.missing > 0 && (
                  <Badge tone="danger">{sequence.check.missing} missing</Badge>
                )}
                <Button variant="ghost" size="sm" onClick={() => setEditing(sequence)}>
                  <Icons.Pencil size={15} />
                  Edit
                </Button>
              </div>
            </SettingRow>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Posting rules"
          description="How money is rounded, and what may still be changed."
        />

        <SettingRow
          icon={<Icons.Coins size={16} />}
          label="Cash rounding"
          description="Rounds what the drawer takes, never the invoice — so the VAT declared stays exact."
        >
          <Select
            defaultValue={settings.sales_cash_rounding}
            onChange={(e) => run(() => saveSettingAction('sales_cash_rounding', e.target.value))}
            className="w-40"
          >
            <option value="0">No rounding</option>
            <option value="0.05">Nearest 5c</option>
            <option value="0.1">Nearest 10c</option>
          </Select>
        </SettingRow>

        <SettingRow
          icon={<Icons.Ban size={16} />}
          label="VAT period locked to"
          description="Nothing on or before this date may be voided, credited or backdated. Set it after each VAT return."
        >
          <Input
            type="date"
            defaultValue={settings.vat_period_locked_to}
            onChange={(e) => run(() => saveSettingAction('vat_period_locked_to', e.target.value))}
            className="w-44"
          />
        </SettingRow>

        <SettingRow
          icon={<Icons.Pencil size={16} />}
          label="Allow correcting a finalised invoice"
          description="Reverses the original and re-posts a corrected one. Leave off until that path has been proven."
        >
          <Switch
            checked={settings.sales_allow_finalised_edit === '1'}
            onChange={(next) =>
              run(() => saveSettingAction('sales_allow_finalised_edit', next ? '1' : '0'))
            }
            label="Allow correcting a finalised invoice"
          />
        </SettingRow>
      </Card>

      <SequenceModal
        sequence={editing}
        pending={pending}
        onClose={() => setEditing(null)}
        onSave={(input) => editing && run(() => saveSequenceAction(editing.docType, input))}
      />
    </>
  )
}

function describeSequence(sequence: SequenceRow): string {
  const parts = [`next ${sequence.preview}`]
  if (sequence.resetPeriod === 'yearly') parts.push('restarts each year')
  const { issued, live, voided } = sequence.check
  if (issued > 0) {
    parts.push(`${issued} issued`)
    if (voided > 0) parts.push(`${live} live, ${voided} voided`)
  }
  return parts.join(' · ')
}

function SequenceModal({
  sequence,
  pending,
  onClose,
  onSave,
}: {
  sequence: SequenceRow | null
  pending: boolean
  onClose: () => void
  onSave: (input: {
    prefix: string
    nextNumber: number
    padding: number
    resetPeriod: 'none' | 'yearly'
  }) => void
}) {
  const [prefix, setPrefix] = useState('')
  const [nextNumber, setNextNumber] = useState(1)
  const [padding, setPadding] = useState(6)
  const [resetPeriod, setResetPeriod] = useState<'none' | 'yearly'>('none')
  const [seeded, setSeeded] = useState<string | null>(null)

  if (sequence && seeded !== sequence.docType) {
    setSeeded(sequence.docType)
    setPrefix(sequence.prefix)
    setNextNumber(sequence.nextNumber)
    setPadding(sequence.padding)
    setResetPeriod(sequence.resetPeriod)
  }
  if (!sequence && seeded !== null) setSeeded(null)

  const preview =
    resetPeriod === 'yearly'
      ? `${prefix}-${new Date().getFullYear()}-${String(nextNumber).padStart(padding, '0')}`
      : `${prefix}${String(nextNumber).padStart(padding, '0')}`

  return (
    <Modal
      open={sequence !== null}
      onClose={onClose}
      title={`Numbering — ${sequence?.label ?? ''}`}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => onSave({ prefix, nextNumber, padding, resetPeriod })}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-card bg-surface-2 px-4 py-3">
          <p className="text-xs text-muted">The next document will be</p>
          <p className="numeric mt-0.5 text-lg font-semibold text-ink">{preview}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prefix" hint="Letters and hyphens only.">
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} maxLength={12} />
          </Field>
          <Field label="Digits" hint="How many, padded with zeroes.">
            <NumberInput
              value={padding}
              onChange={(e) => setPadding(Number(e.target.value) || 1)}
            />
          </Field>
        </div>

        <Field
          label="Next number"
          hint="Can only move forward — numbers below this have already been issued."
        >
          <NumberInput
            value={nextNumber}
            onChange={(e) => setNextNumber(Number(e.target.value) || 1)}
          />
        </Field>

        <Field
          label="Restart each year"
          hint="The year is added to the number so last year's 41 and this year's 41 stay distinct."
        >
          <Select
            value={resetPeriod}
            onChange={(e) => setResetPeriod(e.target.value as 'none' | 'yearly')}
          >
            <option value="none">Keep counting</option>
            <option value="yearly">Restart at 1 each year</option>
          </Select>
        </Field>

        {sequence && sequence.check.issued > 0 && (
          <p className="text-xs text-muted">
            {sequence.check.issued} issued so far ({sequence.check.live} live,{' '}
            {sequence.check.voided} voided).
            {sequence.check.missing > 0
              ? ` ${sequence.check.missing} number(s) cannot be accounted for — that should never happen.`
              : ' Every number is accounted for.'}
          </p>
        )}
      </div>
    </Modal>
  )
}
