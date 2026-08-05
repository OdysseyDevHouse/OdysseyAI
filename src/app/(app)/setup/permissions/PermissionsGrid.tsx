'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Card,
  CardHeader,
  Checkbox,
  Icons,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
} from '@/components/ui'
import type { Capability } from '@/lib/site/permissions'
import type { SiteRole } from '@/lib/sites'
import { setCapabilityAction } from './actions'

/**
 * The role × capability grid.
 *
 * Saves on each tick rather than behind a Save button: there is one boolean per
 * cell, the change is instantly reversible, and a form that batches five
 * checkboxes into one submit invites someone to walk away mid-edit believing
 * they had granted something.
 *
 * The owner column is shown but locked. Seeing that an owner has everything is
 * the point — it is what makes "who can put this back?" answerable.
 */

const ROLES: { id: SiteRole; label: string; hint: string }[] = [
  { id: 'owner', label: 'Owner', hint: 'Always everything' },
  { id: 'manager', label: 'Manager', hint: 'Runs the shop' },
  { id: 'staff', label: 'Staff', hint: 'On the till' },
]

export default function PermissionsGrid({
  matrix,
  capabilities,
  canEdit,
}: {
  matrix: Record<SiteRole, Record<string, boolean>>
  capabilities: { id: Capability; label: string; hint: string }[]
  canEdit: boolean
}) {
  // Optimistic, so a tick responds immediately rather than after a round trip.
  // Reverted on failure, with the reason shown.
  const [local, setLocal] = useState(matrix)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function toggle(role: SiteRole, capability: Capability, next: boolean) {
    const previous = local[role][capability]
    setLocal((current) => ({
      ...current,
      [role]: { ...current[role], [capability]: next },
    }))

    startTransition(async () => {
      const result = await setCapabilityAction(role, capability, next)
      if (!result.ok) {
        setLocal((current) => ({
          ...current,
          [role]: { ...current[role], [capability]: previous },
        }))
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader
        title="Who may do what"
        description="Changes take effect on the next screen a user opens — no sign-out needed."
      />
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr className={TABLE_HEAD_ROW}>
              <th className={TABLE_TH}>Permission</th>
              {ROLES.map((role) => (
                <th key={role.id} className={`${TABLE_TH} text-center`}>
                  <div>{role.label}</div>
                  <div className="text-xs font-normal text-muted">{role.hint}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {capabilities.map((capability) => (
              <tr key={capability.id} className={TABLE_ROW}>
                <td className={TABLE_TD}>
                  <div className="text-ink">{capability.label}</div>
                  <div className="text-xs text-muted">{capability.hint}</div>
                </td>
                {ROLES.map((role) => {
                  // An owner keeps everything, so the cell is shown ticked and
                  // locked rather than hidden — the guarantee is worth seeing.
                  const locked = role.id === 'owner' || !canEdit
                  return (
                    <td key={role.id} className={`${TABLE_TD} text-center`}>
                      <div className="flex justify-center">
                        {role.id === 'owner' ? (
                          <span title="An owner always has every permission.">
                            <Icons.Check size={16} className="text-success" />
                          </span>
                        ) : (
                          <Checkbox
                            checked={local[role.id][capability.id] ?? false}
                            disabled={locked || pending}
                            onChange={(e) => toggle(role.id, capability.id, e.target.checked)}
                            aria-label={`${capability.label} for ${role.label}`}
                          />
                        )}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
