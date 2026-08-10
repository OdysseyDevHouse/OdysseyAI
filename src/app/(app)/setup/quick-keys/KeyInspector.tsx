'use client'

import { useEffect, useState } from 'react'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  SwatchPicker,
  Switch,
} from '@/components/ui'
import { actionForSlug, type QuickKeyRow } from '@/lib/quickKeys'

/**
 * The selected key's settings.
 *
 * A panel rather than a dialog, because arranging a bar means touching ten keys in a
 * row: a modal that has to be dismissed between each one turns a two-minute job into a
 * five-minute one. It stays put and follows the selection.
 *
 * ── EVERY FIELD SAVES ON COMMIT, NOT ON KEYSTROKE ─────────────────────────
 *
 * The caption saves on blur and the switches save immediately. Saving the caption per
 * character would be one round trip per letter and a canvas that renumbers underneath
 * somebody who is still typing.
 */
export function KeyInspector({
  keyRow,
  label,
  busy,
  canDelete,
  onChange,
  onDelete,
}: {
  keyRow: QuickKeyRow | null
  label: string
  busy: boolean
  /** False for the supervisor group, which the server also refuses to remove. */
  canDelete: boolean
  onChange: (changes: {
    caption?: string
    colourToken?: string
    requireAuth?: boolean
    isHidden?: boolean
  }) => void
  onDelete: () => void
}) {
  const [caption, setCaption] = useState(keyRow?.caption ?? '')
  const [confirming, setConfirming] = useState(false)

  /* Re-seeded when the SELECTION changes, not on every render — otherwise a keystroke
     would be overwritten by the prop on the next parent render. Keyed on the id so
     switching keys loads the new caption and switching back does not keep the old one. */
  useEffect(() => {
    setCaption(keyRow?.caption ?? '')
    setConfirming(false)
  }, [keyRow?.id, keyRow?.caption])

  if (!keyRow) {
    return (
      <Card className="w-full lg:w-80">
        <EmptyState
          icon={<Icons.Sparkles size={22} />}
          title="Nothing selected"
          hint="Tap a key to rename it, recolour it, or ask for a supervisor PIN."
        />
      </Card>
    )
  }

  const action = keyRow.kind === 'action' ? actionForSlug(keyRow.actionSlug) : null

  return (
    <Card className="w-full lg:w-80">
      <CardHeader title={label} description={kindLabel(keyRow)} />

      <div className="flex flex-col gap-4 p-4">
        {/* What the action DOES, in the shop's words. A slug tells a manager nothing,
            and this is the screen where they decide whether they want it. */}
        {action && <p className="text-sm text-muted">{action.hint}</p>}

        <Field
          label="What the key says"
          hint={
            keyRow.kind === 'group'
              ? 'Renaming a group is how it is identified, so keep it distinct.'
              : 'Leave it empty and the key reads the name of what it points at.'
          }
        >
          <Input
            value={caption}
            maxLength={60}
            placeholder={label}
            disabled={busy}
            onChange={(e) => setCaption(e.target.value)}
            /* On blur, and only when it CHANGED — an unchanged blur would be a wasted
               round trip every time somebody tabbed through. */
            onBlur={() => {
              if (caption.trim() !== keyRow.caption) onChange({ caption })
            }}
          />
        </Field>

        <Field label="Colour">
          <SwatchPicker
            value={keyRow.colourToken}
            disabled={busy}
            /* Null means "no colour", which the model stores as the explicit
               `tile-none` token rather than an empty string — an empty string cannot be
               told apart from "never chosen", and the two render differently. */
            onChange={(token) => onChange({ colourToken: token ?? 'tile-none' })}
          />
        </Field>

        <Switch
          checked={keyRow.requireAuth}
          disabled={busy}
          label="Ask for a supervisor PIN"
          hint="Even when the cashier is allowed to do it. For the keys worth a second pair of eyes."
          onChange={(next) => onChange({ requireAuth: next })}
        />

        <Switch
          checked={keyRow.isHidden}
          disabled={busy}
          label="Hide from the till"
          hint="Keeps the key and its settings, out of the way. For a seasonal button."
          onChange={(next) => onChange({ isHidden: next })}
        />

        {canDelete ? (
          confirming ? (
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                className="flex-1 justify-center"
                disabled={busy}
                onClick={onDelete}
              >
                {/* Says what happens to the members, because a manager deleting a folder
                    is tidying the bar and would not expect to lose eight keys. */}
                {keyRow.kind === 'group' ? 'Delete — keys move to the bar' : 'Delete this key'}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <Button
              variant="danger-ghost"
              size="sm"
              className="self-start"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <Icons.Trash size={14} />
              Remove
            </Button>
          )
        ) : (
          <p className="text-xs text-muted">
            The supervisor group is part of the till and cannot be removed.
          </p>
        )}
      </div>
    </Card>
  )
}

function kindLabel(keyRow: QuickKeyRow): string {
  switch (keyRow.kind) {
    case 'group':
      return 'A folder of keys'
    case 'product':
      return 'Adds a product to the sale'
    case 'department':
      return 'Opens a department'
    case 'action':
      return 'Runs something'
  }
}
