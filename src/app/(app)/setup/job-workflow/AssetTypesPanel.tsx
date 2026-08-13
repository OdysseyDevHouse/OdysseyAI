'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  Modal,
  NumberInput,
  Switch,
  useToast,
} from '@/components/ui'
import { TABLE, TABLE_HEAD_ROW, TABLE_NUMERIC, TABLE_TD, TABLE_TH } from '@/components/ui/styles'
import type { AssetType } from '@/lib/site/jobAssets'
import { saveAssetTypeAction, deleteAssetTypeAction } from '../../jobs/actions'

/**
 * Kinds of customer equipment.
 *
 * ── WHY THE IDENTIFIER LABEL IS CONFIGURABLE ───────────────────────────────
 *
 * A vehicle has a VIN, a machine has a serial, a meter has an asset tag. The PRD
 * asks for the asset field label to be customisable and this is the field that
 * matters: a technician typing into a box marked the wrong thing hesitates, and
 * then types it into the notes instead, where nothing can search it.
 *
 * ── WHY THE SERVICE INTERVAL LIVES HERE ────────────────────────────────────
 *
 * Because it is a property of the KIND of equipment, not of each unit. Setting it
 * once means closing a job rolls every unit of that kind forward by the right
 * amount; setting it per unit means somebody types 6 four hundred times and gets
 * one of them wrong.
 */
export default function AssetTypesPanel({ types }: { types: AssetType[] }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [editing, setEditing] = useState<AssetType | 'new' | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [months, setMonths] = useState(0)
  const [label, setLabel] = useState('Serial number')
  const [isActive, setIsActive] = useState(true)

  function open(type: AssetType | 'new') {
    setEditing(type)
    if (type === 'new') {
      setCode('')
      setName('')
      setMonths(0)
      setLabel('Serial number')
      setIsActive(true)
      return
    }
    setCode(type.code)
    setName(type.name)
    setMonths(type.serviceMonths ?? 0)
    setLabel(type.identifierLabel)
    setIsActive(type.isActive)
  }

  function save() {
    if (editing === null) return
    start(async () => {
      const result = await saveAssetTypeAction({
        id: editing === 'new' ? null : editing.id,
        code,
        name,
        serviceMonths: months > 0 ? months : null,
        identifierLabel: label,
        sortOrder: editing === 'new' ? types.length : editing.sortOrder,
        isActive,
      })
      if (result.ok) {
        toast.success(editing === 'new' ? 'Added.' : 'Saved.')
        setEditing(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  function remove(type: AssetType) {
    start(async () => {
      const result = await deleteAssetTypeAction(type.id)
      if (result.ok) {
        toast.success('Deleted.')
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
          title="Kinds of equipment"
          description="What sort of thing you look after for customers. Each kind decides its own service interval and what its identifying number is called."
          action={
            <Button variant="primary" onClick={() => open('new')} disabled={pending}>
              <Icons.Plus size={15} />
              Add a kind
            </Button>
          }
        />

        {types.length === 0 ? (
          <EmptyState
            icon={<Icons.Wrench size={22} />}
            title="No kinds of equipment yet"
            hint="Equipment can still be recorded without one — this is what lets a service interval roll forward on its own, and what renames the serial field for a trade that calls it something else."
            action={
              <Button variant="secondary" onClick={() => open('new')} disabled={pending}>
                <Icons.Plus size={15} />
                Add a kind
              </Button>
            }
          />
        ) : (
          <CardBody className="p-0">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Kind</th>
                  <th className={TABLE_TH}>Number is called</th>
                  <th className={TABLE_TH}>Serviced every</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>On file</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`} />
                </tr>
              </thead>
              <tbody>
                {types.map((t) => (
                  <tr key={t.id}>
                    <td className={TABLE_TD}>
                      <div className="flex flex-col">
                        <span className="text-ink">
                          {t.name}
                          {!t.isActive && (
                            <Badge tone="neutral" className="ml-2">
                              Off
                            </Badge>
                          )}
                        </span>
                        <span className="text-xs text-muted">{t.code}</span>
                      </div>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-ink-2">{t.identifierLabel}</span>
                    </td>
                    <td className={TABLE_TD}>
                      {t.serviceMonths === null ? (
                        // Not a gap: plenty of equipment is fixed when it breaks.
                        <span className="text-muted">on demand</span>
                      ) : (
                        <span className="text-ink-2">
                          {t.serviceMonths} month{t.serviceMonths === 1 ? '' : 's'}
                        </span>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <span className={t.assetCount > 0 ? 'text-ink-2' : 'text-muted'}>
                        {t.assetCount === 0 ? 'none' : t.assetCount}
                      </span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          iconOnly
                          aria-label={`Edit ${t.name}`}
                          onClick={() => open(t)}
                        >
                          <Icons.Pencil size={15} />
                        </Button>
                        {/* Only while nothing uses it — the action refuses
                            otherwise, and a button that only ever produces a
                            toast teaches people to ignore refusals. */}
                        {t.assetCount === 0 && (
                          <Button
                            variant="danger-ghost"
                            size="sm"
                            iconOnly
                            aria-label={`Delete ${t.name}`}
                            disabled={pending}
                            onClick={() => remove(t)}
                          >
                            <Icons.Trash size={15} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        )}
      </Card>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'A new kind of equipment' : `Edit ${editing?.name ?? ''}`}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={pending || !name.trim() || !code.trim() || !label.trim()}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <Field
              label="Code"
              hint={
                editing !== null && editing !== 'new'
                  ? 'Fixed once created, so a rename relabels every unit.'
                  : 'e.g. AIRCON'
              }
            >
              <div className="w-36">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={40}
                  disabled={editing !== null && editing !== 'new'}
                />
              </div>
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Split air conditioner"
                maxLength={120}
              />
            </Field>
          </div>

          <Field
            label="What the identifying number is called"
            hint="A vehicle has a VIN, a machine a serial, a meter an asset tag. This is what the field says when recording one."
          >
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Serial number"
              maxLength={40}
            />
          </Field>

          <Field
            label="Serviced every"
            hint="Months. Closing a job against a unit of this kind moves its next service on by this much. Zero for equipment fixed only when it breaks."
          >
            <div className="w-28">
              <NumberInput
                value={months}
                onChange={(e) => setMonths(Number(e.target.value) || 0)}
                min={0}
              />
            </div>
          </Field>

          <Switch
            checked={isActive}
            onChange={setIsActive}
            label="In use"
            hint="A retired kind stops appearing when recording equipment. Units already using it keep it."
          />
        </div>
      </Modal>
    </>
  )
}
