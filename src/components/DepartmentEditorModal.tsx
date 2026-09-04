'use client'

import { useState } from 'react'
import { Button, Field, Icons, Input, Modal, SwatchPicker } from '@/components/ui'
import type { Department } from '@/lib/site/departments'

/** What the editor modal is currently doing. */
export type DepartmentEditorTarget =
  | { mode: 'create'; parentId: number | null; parentName?: string }
  | { mode: 'edit'; department: Department }

/**
 * The little name-and-colour dialog for making or renaming a department.
 *
 * Shared rather than local to the departments list, because the SAME dialog is
 * what the product form's "<Create new>" option opens. A person filing a
 * product should not have to leave a half-filled form, cross to another
 * screen, and find their way back just to add the department they need — and a
 * second copy of this dialog would be the kind that drifts: one gains a field,
 * the other does not, and the two screens quietly disagree about what a
 * department is.
 *
 * Code, sort order and re-parenting stay on the full record at
 * /departments/[id]. This covers the two fields somebody actually has in mind
 * at the moment they realise a department is missing.
 */
export default function DepartmentEditorModal({
  target,
  busy,
  onClose,
  onSave,
}: {
  target: DepartmentEditorTarget | null
  busy: boolean
  onClose: () => void
  onSave: (values: { name: string; color: string | null }) => void
}) {
  // Held in the parent of the <dialog>'s keyed body so a value survives the
  // remount, but re-seeded whenever the target changes.
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [seenTarget, setSeenTarget] = useState<DepartmentEditorTarget | null>(null)

  if (seenTarget !== target) {
    setSeenTarget(target)
    setName(target?.mode === 'edit' ? target.department.name : '')
    setColor(target?.mode === 'edit' ? target.department.color : null)
  }

  const title =
    target?.mode === 'edit'
      ? `Rename ${target.department.name}`
      : target?.parentName
        ? `New sub-department under ${target.parentName}`
        : 'New top-level department'

  const trimmed = name.trim()

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={title}
      description={
        target?.mode === 'edit'
          ? 'Code, sort order and re-parenting live on the full record.'
          : 'You can set a code and sort order on the full record afterwards.'
      }
      size="sm"
      /* Holds half-typed work — a stray backdrop click must not discard it. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || trimmed.length === 0}
            onClick={() => onSave({ name: trimmed, color })}
          >
            <Icons.Save size={15} />
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && trimmed) onSave({ name: trimmed, color })
            }}
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Colour</span>
          <SwatchPicker value={color} onChange={setColor} size="sm" />
        </div>
      </div>
    </Modal>
  )
}
