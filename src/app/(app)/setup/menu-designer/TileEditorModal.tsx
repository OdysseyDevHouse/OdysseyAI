'use client'

import { useState } from 'react'
import { Button, Field, Icons, Input, Modal, SwatchPicker, Switch, TextLink } from '@/components/ui'
import type { Department, MenuProduct } from './types'

export type EditorTarget = { kind: 'product'; id: number } | { kind: 'department'; id: number }

/**
 * The quick-edit dialog for one tile.
 *
 * ── EVERYTHING APPLIES IMMEDIATELY ─────────────────────────────────────────
 *
 * No Save button: the colour and the visibility switch commit on click, and the
 * name commits on blur or Enter. That is deliberate and unlike the full product
 * and department forms — the canvas is right there behind the dialog, and the
 * point of this screen is seeing the menu change as you arrange it. A Save
 * button would put a step between a colour and the tile it recolours.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * Price, barcode, stock, VAT, the till icon, department pictures. Each has a
 * proper home on the full record, and a dialog that grew them would become a
 * second product form that could disagree with the first. This edits how a tile
 * LOOKS and whether the till shows it — nothing else — and links to the record
 * for the rest.
 */
export function TileEditorModal({
  product,
  department,
  canEdit,
  onClose,
  onRename,
  onRecolor,
  onToggleVisible,
}: {
  /** At most one is set; the parent resolves them live from the menu. */
  product: MenuProduct | null
  department: Department | null
  canEdit: boolean
  onClose: () => void
  onRename: (name: string) => void
  onRecolor: (token: string | null) => void
  onToggleVisible: (on: boolean) => void
}) {
  const open = product !== null || department !== null
  const name = product?.description ?? department?.name ?? ''
  const color = product?.imageColor ?? department?.color ?? null
  const visible = product ? product.visibleInPos : (department?.isActive ?? true)

  const [draft, setDraft] = useState(name)
  const [seenKey, setSeenKey] = useState<string | null>(null)

  // Re-seeded whenever the dialog changes target, so opening a second tile does
  // not show the first one's half-typed name.
  const key = product ? `p-${product.id}` : department ? `d-${department.id}` : null
  if (seenKey !== key) {
    setSeenKey(key)
    setDraft(name)
  }

  function commitName() {
    const next = draft.trim()
    if (!next || next === name) {
      setDraft(name)
      return
    }
    onRename(next)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={product ? 'Edit product tile' : 'Edit department tile'}
      description="Changes apply straight away."
      size="sm"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          hint={
            product
              ? `Code ${product.code}${product.barcode ? ` · ${product.barcode}` : ''}`
              : undefined
          }
        >
          <Input
            value={draft}
            maxLength={product ? 200 : 120}
            disabled={!canEdit}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </Field>

        <div>
          <span className="block text-sm font-medium text-ink-2">Colour</span>
          <p className="mb-1.5 text-xs text-muted">
            The tile’s colour on the till{product ? ', behind its icon' : ''}.
          </p>
          <SwatchPicker value={color} onChange={onRecolor} size="sm" disabled={!canEdit} />
        </div>

        <Switch
          checked={visible}
          disabled={!canEdit}
          onChange={onToggleVisible}
          label="Show on the till"
          hint={
            product
              ? 'Hidden products stay sellable by scan and by search — they just leave the browse grid.'
              : 'A hidden department, and everything inside it, leaves the till’s browse grid.'
          }
        />

        {/* Everything this dialog deliberately does not edit lives one click away. */}
        <p className="text-xs text-muted">
          {product ? (
            <>
              Price, stock and the till icon live on the{' '}
              <TextLink href={`/products/${product.id}`}>full product record</TextLink>.
            </>
          ) : department ? (
            <>
              Code, pictures and the rest live on the{' '}
              <TextLink href={`/departments/${department.id}`}>full department record</TextLink>.
            </>
          ) : null}
        </p>
      </div>
    </Modal>
  )
}
