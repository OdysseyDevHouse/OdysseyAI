'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Modal,
  Select,
  TextLink,
  useToast,
} from '@/components/ui'
import { setJobAssetAction, customerAssetsAction } from '../actions'

/**
 * Which piece of equipment this job is about.
 *
 * ── ONE ASSET, NOT MANY ────────────────────────────────────────────────────
 *
 * A job is a visit to fix a thing. Servicing eight units at one site is eight jobs
 * or one job with eight lines, and both are already expressible; a join table would
 * make every cost, check and warranty question need to say WHICH asset it belonged
 * to. Starting with one keeps every figure unambiguous, and a join table can be
 * added later without moving what is already recorded.
 *
 * ── THE PICKER IS SCOPED TO THE CUSTOMER ───────────────────────────────────
 *
 * Two customers own the same model and the list is alphabetical, so an unscoped
 * picker is how a warranty claim lands against the wrong account. The action
 * refuses a mismatch as well — a filtered list is a convenience, not a boundary.
 */
export default function JobAssetCard({
  jobId,
  customerId,
  asset,
  canEdit,
  jobClosed,
}: {
  jobId: number
  customerId: number | null
  asset: {
    id: number
    description: string
    documentNumber: string | null
    serialText: string | null
    identifierLabel: string
    warrantyUntil: string | null
    nextServiceOn: string | null
    jobCount: number
  } | null
  canEdit: boolean
  jobClosed: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [picking, setPicking] = useState(false)
  const [options, setOptions] = useState<{ id: number; label: string }[]>([])
  const [chosen, setChosen] = useState(asset === null ? '' : String(asset.id))

  const today = new Date().toISOString().slice(0, 10)
  const warrantyLive = asset?.warrantyUntil !== null && asset?.warrantyUntil !== undefined && asset.warrantyUntil >= today

  function open() {
    setPicking(true)
    setChosen(asset === null ? '' : String(asset.id))
    start(async () => {
      // Fetched on open rather than with the page: most visits to a job card never
      // touch this, and a customer with 200 units should not cost every render.
      setOptions(await customerAssetsAction(customerId))
    })
  }

  function save() {
    start(async () => {
      const result = await setJobAssetAction(jobId, chosen === '' ? null : Number(chosen))
      if (result.ok) {
        toast.success(chosen === '' ? 'Equipment cleared.' : 'Equipment set.')
        setPicking(false)
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
          title="What it is about"
          description={
            asset === null
              ? 'No equipment named. Naming it builds the unit a service history for free.'
              : 'The unit this visit is for. Its history is on the equipment record.'
          }
          action={
            canEdit && !jobClosed ? (
              <Button variant="secondary" onClick={open} disabled={pending}>
                <Icons.Wrench size={15} />
                {asset === null ? 'Name the equipment' : 'Change'}
              </Button>
            ) : undefined
          }
        />
        {asset !== null && (
          <CardBody>
            <div className="flex flex-col gap-1 text-sm">
              <TextLink href={`/jobs/equipment/${asset.id}`}>
                {asset.description}
                {asset.documentNumber ? ` · ${asset.documentNumber}` : ''}
              </TextLink>
              {asset.serialText && (
                <span className="text-muted">
                  {asset.identifierLabel}: {asset.serialText}
                </span>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {/* Warranty first: it decides who pays, which is the question a
                    technician standing in front of a broken unit has. */}
                {asset.warrantyUntil === null ? (
                  <span className="text-xs text-muted">No warranty recorded</span>
                ) : warrantyLive ? (
                  <Badge tone="success">Under warranty until {asset.warrantyUntil}</Badge>
                ) : (
                  <Badge tone="neutral">Warranty expired {asset.warrantyUntil}</Badge>
                )}
                {asset.jobCount > 1 && (
                  <TextLink href={`/jobs/equipment/${asset.id}`}>
                    {asset.jobCount - 1} previous visit{asset.jobCount === 2 ? '' : 's'}
                  </TextLink>
                )}
              </div>
            </div>
          </CardBody>
        )}
      </Card>

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="Which piece of equipment?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPicking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {customerId === null ? (
            <p className="text-sm text-muted">
              This job has no customer, so only unclaimed equipment can be named — a unit in the
              workshop, for instance.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Only this customer&apos;s equipment, plus anything not yet claimed.
            </p>
          )}

          <Field label="Equipment">
            <Select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Nothing named</option>
              {options.map((o) => (
                <option key={o.id} value={String(o.id)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          {options.length === 0 && !pending && (
            <p className="text-sm text-muted">
              Nothing on file yet.{' '}
              <TextLink href="/jobs/equipment/new">Add the equipment</TextLink> and come back.
            </p>
          )}
        </div>
      </Modal>
    </>
  )
}
