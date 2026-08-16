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
import { IconPicker } from './IconPicker'

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
    icon?: string
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
      <Card>
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
    <Card>
      <CardHeader title={label} description={kindLabel(keyRow)} />

      <div className="flex flex-col gap-4 p-4">
        {/* What the action DOES, in the shop's words. A slug tells a manager nothing,
            and this is the screen where they decide whether they want it. */}
        {action && <p className="text-sm text-muted">{action.hint}</p>}

        {/*
          ── ONLY A GROUP CAN BE NAMED ───────────────────────────────────────

          A key is named by what it POINTS AT: an action key reads the action's own
          label, a product key its product's description, a department key the
          department. That is not a limitation, it is the feature — rename the product
          and the key follows, so a shop never maintains the same words twice.

          Letting a shop type over that produced a key called something other than what
          it does, which is a support call in waiting: "Refund" relabelled "Exchange"
          still posts a credit note, and the person who typed it is not the person on
          the till at 5pm. Removed deliberately.

          A GROUP is the exception, and has to be: it points at nothing, so its caption
          is the only thing that names it — and the signature `g:<caption>` is what
          distinguishes two folders on one bar. A group made by dropping one key onto
          another takes the target's name, which is a guess worth being able to correct.
        */}
        {keyRow.kind === 'group' ? (
          <Field
            label="What the group is called"
            hint="Its name is how it is identified, so keep it distinct from the other folders."
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
        ) : (
          <Field label="What the key says">
            {/* Shown, not editable. A manager still needs to see what the cashier will
                read — and where it comes from, so the way to change it (rename the
                product) is obvious rather than missing. */}
            <p className="rounded-control border border-border bg-surface-2 px-3 py-2 text-sm text-ink">
              {label}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              {keyRow.kind === 'product'
                ? 'Taken from the product’s description — rename the product to change it.'
                : keyRow.kind === 'department'
                  ? 'Taken from the department’s name — rename the department to change it.'
                  : 'The name of what this key does. It cannot be changed, so the till always says what the key actually does.'}
            </p>
          </Field>
        )}

        {/* Above the colour, because the icon is the thing a cashier actually aims at
            and the colour is how the key is grouped with its neighbours. */}
        <Field
          label="Icon"
          hint="Leave it unset and the key shows what its kind implies."
        >
          <IconPicker
            value={keyRow.icon}
            actionSlug={keyRow.actionSlug}
            disabled={busy}
            onChange={(icon) => onChange({ icon })}
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
