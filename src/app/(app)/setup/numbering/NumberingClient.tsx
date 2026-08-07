'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
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
import type { SettingKey } from '@/lib/site/settings'
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

/**
 * A customer, supplier or product code. No `check` and no `resetPeriod` — the
 * first has no document table to verify against, and a code that restarted
 * each year would collide with itself.
 */
type CodeRow = {
  docType: string
  label: string
  setting: SettingKey
  enabled: boolean
  prefix: string
  nextNumber: number
  padding: number
  preview: string
}

export default function NumberingClient({
  sequences,
  codes,
  settings,
}: {
  sequences: SequenceRow[]
  codes: CodeRow[]
  settings: Record<string, string>
}) {
  const [editing, setEditing] = useState<SequenceRow | null>(null)
  const [editingCode, setEditingCode] = useState<CodeRow | null>(null)
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setEditing(null)
        setEditingCode(null)
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
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Edit ${sequence.label} numbering`}
                  onClick={() => setEditing(sequence)}
                >
                  <Icons.Pencil size={15} />
                </Button>
              </div>
            </SettingRow>
          ))}
        </div>
      </Card>

      {codes.length > 0 && (
        <Card>
          <CardHeader
            title="Customer, supplier & product codes"
            description="Fills the code in for you when adding one. Staff can still type their own — a code that is already taken is skipped, never reused."
          />
          <div>
            {codes.map((code) => (
              <SettingRow
                key={code.docType}
                icon={<Icons.Hash size={16} />}
                label={code.label}
                description={
                  code.enabled
                    ? `Next ${code.preview} · suggested on the new form, and still editable`
                    : 'Typed by hand'
                }
              >
                <div className="flex items-center gap-2">
                  {/* The pattern is only worth showing while it is in use —
                      beside an off switch it reads as a promise the form does
                      not keep. */}
                  {code.enabled && <span className="numeric text-sm text-ink">{code.preview}</span>}
                  <Switch
                    checked={code.enabled}
                    onChange={(next) =>
                      run(() => saveSettingAction(code.setting, next ? '1' : '0'))
                    }
                    ariaLabel={`Auto-number ${code.label}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Edit ${code.label}`}
                    onClick={() => setEditingCode(code)}
                  >
                    <Icons.Pencil size={15} />
                  </Button>
                </div>
              </SettingRow>
            ))}
          </div>
        </Card>
      )}

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
          {/* Sized by a wrapper, not by restyling the control itself. */}
          <div className="w-40">
            <Select
              defaultValue={settings.sales_cash_rounding}
              onChange={(e) => run(() => saveSettingAction('sales_cash_rounding', e.target.value))}
            >
              <option value="0">No rounding</option>
              <option value="0.05">Nearest 5c</option>
              <option value="0.1">Nearest 10c</option>
            </Select>
          </div>
        </SettingRow>

        <SettingRow
          icon={<Icons.Ban size={16} />}
          label="VAT period locked to"
          description="Nothing on or before this date may be voided, credited or backdated. Set it after each VAT return."
        >
          <div className="w-44">
            {/* Saved on blur, not change — a typed date fires a change event per
                keystroke, which would post a server action for every digit. */}
            <Input
              type="date"
              defaultValue={settings.vat_period_locked_to}
              onBlur={(e) => {
                if (e.target.value !== (settings.vat_period_locked_to ?? '')) {
                  run(() => saveSettingAction('vat_period_locked_to', e.target.value))
                }
              }}
            />
          </div>
        </SettingRow>

        <SettingRow
          icon={<Icons.Pencil size={16} />}
          label="Allow correcting a finalised invoice"
          description="Reverses the original and re-posts a corrected one. Leave off until that path has been proven."
        >
          {/* ariaLabel, not label — the SettingRow already shows the name, and
              a second visible copy beside the switch would say it twice. */}
          <Switch
            checked={settings.sales_allow_finalised_edit === '1'}
            onChange={(next) =>
              run(() => saveSettingAction('sales_allow_finalised_edit', next ? '1' : '0'))
            }
            ariaLabel="Allow correcting a finalised invoice"
          />
        </SettingRow>
      </Card>

      <SequenceModal
        sequence={editing}
        pending={pending}
        onClose={() => setEditing(null)}
        onSave={(input) => editing && run(() => saveSequenceAction(editing.docType, input))}
      />

      <CodeModal
        code={editingCode}
        pending={pending}
        onClose={() => setEditingCode(null)}
        onSave={(input) =>
          editingCode &&
          run(() =>
            saveSequenceAction(editingCode.docType, { ...input, resetPeriod: 'none' }),
          )
        }
      />
    </>
  )
}

/**
 * Prefix, digits and next number for a master-data code.
 *
 * A cut-down SequenceModal rather than a shared one: there is no yearly reset
 * (a code that restarted each year would collide with itself) and no issued
 * count to report, and threading two "hide this field" flags through the
 * document modal would make the thing that actually matters — the document
 * numbering — harder to read.
 */
function CodeModal({
  code,
  pending,
  onClose,
  onSave,
}: {
  code: CodeRow | null
  pending: boolean
  onClose: () => void
  onSave: (input: { prefix: string; nextNumber: number; padding: number }) => void
}) {
  const [prefix, setPrefix] = useState('')
  const [nextNumber, setNextNumber] = useState(1)
  const [padding, setPadding] = useState(5)
  const [seeded, setSeeded] = useState<string | null>(null)

  if (code && seeded !== code.docType) {
    setSeeded(code.docType)
    setPrefix(code.prefix)
    setNextNumber(code.nextNumber)
    setPadding(code.padding)
  }
  if (!code && seeded !== null) setSeeded(null)

  const preview = `${prefix}${String(nextNumber).padStart(Math.max(padding, 1), '0')}`

  return (
    <Modal
      open={code !== null}
      onClose={onClose}
      title={code?.label ?? ''}
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
            onClick={() => onSave({ prefix, nextNumber, padding })}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Callout tone="neutral" icon={null}>
          <p className="text-xs text-muted">The next one will be</p>
          <p className="numeric mt-0.5 text-lg font-semibold text-ink">{preview}</p>
        </Callout>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prefix" hint="Letters and hyphens only.">
            <Input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              maxLength={12}
            />
          </Field>
          <Field label="Digits" hint="How many, padded with zeroes.">
            <NumberInput value={padding} onChange={(e) => setPadding(Number(e.target.value) || 1)} />
          </Field>
        </div>

        <Field
          label="Next number"
          hint="Can only move forward. Raise it to start above codes you already type by hand."
        >
          <NumberInput
            value={nextNumber}
            onChange={(e) => setNextNumber(Number(e.target.value) || 1)}
          />
        </Field>
      </div>
    </Modal>
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
        <Callout tone="neutral" icon={null}>
          <p className="text-xs text-muted">The next document will be</p>
          <p className="numeric mt-0.5 text-lg font-semibold text-ink">{preview}</p>
        </Callout>

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
