'use client'

import { useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  useToast,
} from '@/components/ui'
import type { VisitType } from '@/lib/site/visitTypes'
import {
  createVisitTypeAction,
  deleteVisitTypeAction,
  updateVisitTypeAction,
} from './actions'

/**
 * How a table is being served, as the shop's own words.
 *
 * ── WHY THIS SITS ON THE TABLES SCREEN ────────────────────────────────────
 *
 * It is the same decision as the floor: a manager setting up table service decides what
 * the tables are AND how service is filed, in one sitting. A separate Setup entry would
 * be a screen nobody finds until a waiter asks why the till only says "Sit down".
 *
 * ── THE DEFAULT IS THE LOAD-BEARING PART ──────────────────────────────────
 *
 * Most tables carry no type — nothing back-filled the column and nobody labels a table
 * they are about to seat. Those are filed under whichever type is marked default, so the
 * gate's first segment holds them rather than a fourth "untyped" one appearing. Which is
 * why exactly one row is starred and why the star cannot simply be turned off: it is
 * moved to another type instead.
 */
export default function VisitTypesCard({ types: initial }: { types: VisitType[] }) {
  const [types, setTypes] = useState(initial)
  const [pending, startAction] = useTransition()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const toast = useToast()

  const apply = (result: Awaited<ReturnType<typeof createVisitTypeAction>>) => {
    if (!result.ok) {
      toast.error(result.error)
      return false
    }
    setTypes(result.types)
    return true
  }

  return (
    <Card>
      <CardHeader
        title="Visit types"
        description="How a table is being served. The till filters the floor by these, and a table with none set counts as the default."
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => {
              setAdding(true)
              setEditing(null)
            }}
          >
            <Icons.Plus size={14} />
            Add a type
          </Button>
        }
      />

      {adding && (
        <div className="border-b border-border bg-surface-2 p-4">
          <TypeForm
            busy={pending}
            onCancel={() => setAdding(false)}
            onSave={(name) =>
              startAction(async () => {
                if (apply(await createVisitTypeAction({ name }))) {
                  toast.success('Visit type added.')
                  setAdding(false)
                }
              })
            }
          />
        </div>
      )}

      {types.length === 0 ? (
        <EmptyState
          icon={<Icons.Tag size={24} />}
          title="No visit types yet"
          hint="Add “Sit down”, “Takeaway” or whatever this shop calls it. The till shows one filter per type."
        />
      ) : (
        <ul>
          {types.map((t) => (
            <li key={t.id} className="border-b border-border last:border-b-0">
              {editing === t.id ? (
                <div className="bg-surface-2 p-4">
                  <TypeForm
                    type={t}
                    busy={pending}
                    onCancel={() => setEditing(null)}
                    onSave={(name) =>
                      startAction(async () => {
                        if (apply(await updateVisitTypeAction(t.id, { name }))) {
                          toast.success('Saved.')
                          setEditing(null)
                        }
                      })
                    }
                  />
                </div>
              ) : (
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={`truncate text-sm ${
                        t.isActive ? 'font-medium text-ink' : 'text-muted line-through'
                      }`}
                    >
                      {t.name}
                    </span>
                    {t.isDefault && <Badge tone="brand">Default</Badge>}
                    {!t.isActive && <Badge tone="neutral">Hidden</Badge>}
                  </span>

                  {/* Making a type the default is one tap, and the current default has
                      no button at all — "un-default" is not a thing a floor can be in,
                      so the only move offered is to hand it to another type. */}
                  {t.isActive && !t.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startAction(async () => {
                          if (apply(await updateVisitTypeAction(t.id, { isDefault: true }))) {
                            toast.success(`Unlabelled tables now count as “${t.name}”.`)
                          }
                        })
                      }
                    >
                      Make default
                    </Button>
                  )}

                  {!t.isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        startAction(async () => {
                          if (apply(await updateVisitTypeAction(t.id, { isActive: true }))) {
                            toast.success('Back in use.')
                          }
                        })
                      }
                    >
                      Bring back
                    </Button>
                  )}

                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Rename ${t.name}`}
                    disabled={pending}
                    onClick={() => {
                      setEditing(t.id)
                      setAdding(false)
                    }}
                  >
                    <Icons.Pencil size={14} />
                  </Button>

                  {t.isActive && (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Remove ${t.name}`}
                      disabled={pending}
                      onClick={() =>
                        startAction(async () => {
                          const result = await deleteVisitTypeAction(t.id)
                          if (apply(result)) {
                            /* Says which of the two things happened. A type still named
                               by a table is hidden rather than deleted, and a manager
                               who is not told that will come back wondering why it is
                               still on the screen. */
                            toast.success(
                              result.ok && result.outcome === 'hidden'
                                ? 'Tables still use that type, so it is hidden instead.'
                                : 'Visit type removed.',
                            )
                          }
                        })
                      }
                    >
                      <Icons.Trash size={14} />
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function TypeForm({
  type,
  busy,
  onCancel,
  onSave,
}: {
  type?: VisitType
  busy: boolean
  onCancel: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(type?.name ?? '')

  return (
    <div className="flex flex-col gap-3">
      <Field label="Name" hint="What the staff call it — “Sit down”, “Drive-thru”, “Room service”.">
        <Input
          value={name}
          maxLength={40}
          autoFocus
          disabled={busy}
          className="max-w-xs"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !name.trim()}
          onClick={() => onSave(name)}
        >
          {type ? 'Save' : 'Add it'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
