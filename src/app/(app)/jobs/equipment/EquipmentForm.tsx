'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Select,
  TextLink,
  Textarea,
  useToast,
} from '@/components/ui'
import type { CustomerAsset, DuplicateWarning } from '@/lib/site/jobAssets'
import { saveAssetAction, customerAddressesAction } from '../actions'

type TypeOption = { id: number; name: string; identifierLabel: string }
type CustomerOption = { id: number; name: string }

/**
 * Recording a piece of equipment.
 *
 * ── THE IDENTIFIER LABEL CHANGES WITH THE KIND ─────────────────────────────
 *
 * A vehicle has a VIN, a machine has a serial, a meter has an asset tag. The PRD
 * asks for the asset field label to be customisable, and this is the field that
 * matters — a technician typing into a box marked the wrong thing hesitates, and
 * then types it into the notes instead.
 *
 * ── THE DUPLICATE WARNING ARRIVES AFTER THE SAVE ───────────────────────────
 *
 * Deliberately. The check WARNS rather than blocks, so the save succeeds and the
 * matches come back with it — the alternative is a modal interrupting somebody
 * mid-form to tell them about a unit they may well know about. Section 18.3 is
 * explicit that plenty of equipment has no legible serial, so a hard stop would
 * refuse real second units.
 */
export default function EquipmentForm({
  asset,
  types,
  customers,
  initialAddresses,
}: {
  asset: CustomerAsset | null
  types: TypeOption[]
  customers: CustomerOption[]
  /** The chosen customer's sites, preloaded so an edit renders its own without a round trip. */
  initialAddresses: { id: number; name: string }[]
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [typeId, setTypeId] = useState(asset?.assetTypeId === null || asset === null ? '' : String(asset.assetTypeId))
  const [customerId, setCustomerId] = useState(
    asset?.customerId === null || asset === null ? '' : String(asset.customerId),
  )
  const [addressId, setAddressId] = useState(
    asset?.serviceAddressId === null || asset === null ? '' : String(asset.serviceAddressId),
  )
  const [description, setDescription] = useState(asset?.description ?? '')
  const [make, setMake] = useState(asset?.make ?? '')
  const [model, setModel] = useState(asset?.model ?? '')
  const [serial, setSerial] = useState(asset?.serialText ?? '')
  const [installedOn, setInstalledOn] = useState(asset?.installedOn ?? '')
  const [purchasedOn, setPurchasedOn] = useState(asset?.purchasedOn ?? '')
  const [purchaseReference, setPurchaseReference] = useState(asset?.purchaseReference ?? '')
  const [warrantyUntil, setWarrantyUntil] = useState(asset?.warrantyUntil ?? '')
  const [nextServiceOn, setNextServiceOn] = useState(asset?.nextServiceOn ?? '')
  const [conditionNote, setConditionNote] = useState(asset?.conditionNote ?? '')
  const [note, setNote] = useState(asset?.note ?? '')

  const [duplicates, setDuplicates] = useState<DuplicateWarning[]>([])

  /*
   * Only the chosen customer's sites, fetched when the customer changes rather
   * than preloading every address in the business. An address belonging to
   * somebody else is the mistake a flat list makes easy, and the model refuses
   * that combination anyway.
   */
  const [theirAddresses, setTheirAddresses] = useState(initialAddresses)

  const chosenType = types.find((t) => String(t.id) === typeId)
  const identifierLabel = chosenType?.identifierLabel ?? 'Serial number'

  function chooseCustomer(next: string) {
    setCustomerId(next)
    // The site belonged to the old customer, so it cannot survive the change.
    setAddressId('')
    if (next === '') {
      setTheirAddresses([])
      return
    }
    start(async () => {
      const rows = await customerAddressesAction(Number(next))
      setTheirAddresses(rows.map((r) => ({ id: r.id, name: r.name })))
    })
  }

  function save() {
    start(async () => {
      const result = await saveAssetAction({
        id: asset?.id ?? null,
        assetTypeId: typeId === '' ? null : Number(typeId),
        customerId: customerId === '' ? null : Number(customerId),
        serviceAddressId: addressId === '' ? null : Number(addressId),
        description,
        make: make.trim() || null,
        model: model.trim() || null,
        serialText: serial.trim() || null,
        // Set only when we sold the unit, which this form does not do — see the
        // module header in jobAssets.ts. Editing preserves whatever is there.
        productId: asset?.productId ?? null,
        serialId: asset?.serialId ?? null,
        installedOn: installedOn || null,
        purchasedOn: purchasedOn || null,
        purchaseReference: purchaseReference.trim() || null,
        warrantyUntil: warrantyUntil || null,
        nextServiceOn: nextServiceOn || null,
        conditionNote: conditionNote.trim() || null,
        note: note.trim() || null,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      if (result.duplicates.length > 0) {
        // Surfaced rather than swallowed: somebody has to be able to decide it was
        // a mistake and go and merge them.
        setDuplicates(result.duplicates)
        toast.success(
          `Saved as ${result.documentNumber ?? `#${result.id}`}, but the serial matches equipment already on file.`,
        )
      } else {
        toast.success(asset ? 'Equipment saved.' : `Added as ${result.documentNumber ?? `#${result.id}`}.`)
      }
      router.push(`/jobs/equipment/${result.id}`)
    })
  }

  return (
    <>
      {duplicates.length > 0 && (
        <Callout tone="warning" title="That serial is already on file for this customer">
          {duplicates.map((d) => (
            <div key={d.id}>
              <TextLink href={`/jobs/equipment/${d.id}`}>
                {d.documentNumber ?? `#${d.id}`} — {d.description}
              </TextLink>
            </div>
          ))}
          <p className="mt-1">
            Saved anyway, because plenty of equipment carries no legible plate and two real units can
            read the same. Check whether this is a second unit or a duplicate record.
          </p>
        </Callout>
      )}

      <Card>
        <CardHeader
          title={asset ? 'Edit the equipment' : 'What is the equipment?'}
          description="Whose it is can be filled in later — a unit in the workshop nobody has claimed yet is a normal thing to record."
        />
        <CardBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-4">
              <Field label="Kind" hint="Decides the service interval and what the number is called.">
                <div className="w-52">
                  <Select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                    <option value="">Not specified</option>
                    {types.map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
              <div className="min-w-64 flex-1">
                <Field label="Description" hint="What it is, in the words a technician would use.">
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Rooftop split unit, reception"
                    maxLength={190}
                  />
                </Field>
              </div>
            </div>

            <div className="flex flex-wrap gap-4">
              <Field label="Make">
                <div className="w-44">
                  <Input value={make} onChange={(e) => setMake(e.target.value)} maxLength={120} />
                </div>
              </Field>
              <Field label="Model">
                <div className="w-44">
                  <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={120} />
                </div>
              </Field>
              {/* The label follows the kind. See the header. */}
              <Field label={identifierLabel} hint="As stamped on the plate. Spacing and capitals do not matter.">
                <div className="w-52">
                  <Input value={serial} onChange={(e) => setSerial(e.target.value)} maxLength={64} />
                </div>
              </Field>
            </div>

            <div className="flex flex-wrap gap-4">
              <Field label="Customer" hint="Blank for a unit nobody has claimed yet.">
                <div className="w-64">
                  <Select value={customerId} onChange={(e) => chooseCustomer(e.target.value)}>
                    <option value="">Not linked to a customer</option>
                    {customers.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
              <Field
                label="Which of their sites"
                hint={
                  customerId === ''
                    ? 'Choose a customer first.'
                    : theirAddresses.length === 0
                      ? 'This customer has no sites on file.'
                      : 'Where the unit actually is.'
                }
              >
                <div className="w-64">
                  <Select
                    value={addressId}
                    onChange={(e) => setAddressId(e.target.value)}
                    disabled={customerId === '' || theirAddresses.length === 0}
                  >
                    <option value="">Not specified</option>
                    {theirAddresses.map((a) => (
                      <option key={a.id} value={String(a.id)}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </Field>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Its history and its warranty"
          description="What decides who pays when it fails, and when it is next due."
        />
        <CardBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-4">
              <Field label="Purchased">
                <div className="w-40">
                  <Input
                    type="date"
                    value={purchasedOn}
                    onChange={(e) => setPurchasedOn(e.target.value)}
                  />
                </div>
              </Field>
              <Field label="Installed">
                <div className="w-40">
                  <Input
                    type="date"
                    value={installedOn}
                    onChange={(e) => setInstalledOn(e.target.value)}
                  />
                </div>
              </Field>
              <Field label="Their invoice" hint="Optional, for a warranty claim.">
                <div className="w-40">
                  <Input
                    value={purchaseReference}
                    onChange={(e) => setPurchaseReference(e.target.value)}
                    maxLength={60}
                  />
                </div>
              </Field>
            </div>

            <div className="flex flex-wrap gap-4">
              <Field
                label="Under warranty until"
                hint="The warranty on THIS unit, which can differ from the manufacturer term."
              >
                <div className="w-40">
                  <Input
                    type="date"
                    value={warrantyUntil}
                    onChange={(e) => setWarrantyUntil(e.target.value)}
                  />
                </div>
              </Field>
              <Field
                label="Next service due"
                hint={
                  chosenType
                    ? 'Set automatically from the kind when a job closes against it.'
                    : 'Leave blank for equipment serviced on demand.'
                }
              >
                <div className="w-40">
                  <Input
                    type="date"
                    value={nextServiceOn}
                    onChange={(e) => setNextServiceOn(e.target.value)}
                  />
                </div>
              </Field>
            </div>

            <Field label="Condition" hint="Optional — how it is holding up.">
              <Input
                value={conditionNote}
                onChange={(e) => setConditionNote(e.target.value)}
                maxLength={190}
              />
            </Field>

            <Field label="Notes" hint="Anything a technician arriving should know.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
            </Field>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => router.back()} disabled={pending}>
                Cancel
              </Button>
              <Button variant="primary" onClick={save} disabled={pending || !description.trim()}>
                {pending ? 'Saving…' : asset ? 'Save changes' : 'Add the equipment'}
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>
    </>
  )
}
