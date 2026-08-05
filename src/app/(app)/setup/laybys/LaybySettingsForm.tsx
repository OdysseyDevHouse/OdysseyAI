'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  NumberInput,
  Textarea,
  useToast,
} from '@/components/ui'
import { PENALTY_GRACE_BUSINESS_DAYS } from '@/lib/laybyRules'
import { saveLaybySettingsAction } from './actions'

/**
 * The store's lay-by policy.
 *
 * The terms box is not decoration. Under section 62 a cancellation fee is only
 * chargeable if it was disclosed to the customer BEFORE they signed — so
 * `cancelLayby` refuses to charge one while this box is empty, however the
 * percentage is set. The warning below says that out loud, because a store
 * that sets 1% and leaves the terms blank would otherwise wonder why nothing
 * is ever charged.
 */
export default function LaybySettingsForm({
  feePct,
  defaultDays,
  termsText,
  maxPct,
  canEdit,
}: {
  feePct: string
  defaultDays: string
  termsText: string
  /** The store policy ceiling. Not a statutory figure — see laybyRules.ts. */
  maxPct: number
  canEdit: boolean
}) {
  const [fee, setFee] = useState(feePct)
  const [days, setDays] = useState(defaultDays)
  const [terms, setTerms] = useState(termsText)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  const wantsFee = Number(fee) > 0
  const disclosed = terms.trim().length > 0
  const unenforceable = wantsFee && !disclosed

  function save() {
    startTransition(async () => {
      const result = await saveLaybySettingsAction({
        feePct: fee,
        defaultDays: days,
        termsText: terms,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
    })
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Terms"
          description="Applied to every new lay-by, and printed on the customer's copy."
          action={
            canEdit ? (
              <Button variant="primary" onClick={save} disabled={pending}>
                <Icons.Save size={15} />
                {pending ? 'Saving…' : 'Save terms'}
              </Button>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Cancellation fee (%)"
              hint={`Of the full price. This store caps it at ${maxPct}%, and zero is a perfectly normal choice.`}
            >
              <NumberInput
                value={Number(fee)}
                min={0}
                max={maxPct}
                step={0.1}
                disabled={!canEdit || pending}
                onChange={(e) => setFee(e.target.value)}
              />
            </Field>
            <Field
              label="Default period (days)"
              hint="How long a new lay-by runs before it is due. Changeable per lay-by."
            >
              <NumberInput
                value={Number(days)}
                min={1}
                max={730}
                disabled={!canEdit || pending}
                onChange={(e) => setDays(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Lay-by terms"
            hint="Printed on the customer's copy. A cancellation fee is only chargeable if it appears here."
          >
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={8}
              disabled={!canEdit || pending}
              placeholder={`e.g. Goods are held until paid in full.\nA ${maxPct}% cancellation fee applies if the lay-by is cancelled more than ${PENALTY_GRACE_BUSINESS_DAYS} business days after the due date.\nNo fee applies in the event of death or hospitalisation.`}
            />
          </Field>
        </CardBody>
      </Card>

      {unenforceable && (
        <Card>
          <div className="flex items-start gap-3 px-6 py-4">
            <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-medium text-ink">
                This fee cannot be charged while the terms are blank.
              </p>
              <p className="text-muted">
                A cancellation fee is only enforceable if the customer was told about it before
                they signed. Write it into the terms above and it will apply; leave them empty and
                every cancellation refunds in full.
              </p>
            </div>
          </div>
        </Card>
      )}
    </>
  )
}
