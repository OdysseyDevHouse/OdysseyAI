'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Input, Modal, Select, useToast } from '@/components/ui'
import type { Brand } from '@/lib/site/lookups'
import { createBrandInlineAction } from '@/app/(app)/setup/brands/actions'

/**
 * The Brand select on the product form, with a "<Create new>" option.
 *
 * ── WHY IT CAN CREATE ────────────────────────────────────────────────────
 *
 * Same reason the department picker can: the moment somebody discovers a brand
 * is missing is the moment they are filing a product, and sending them to
 * Setup → Brands then means abandoning a half-filled form. Until this existed
 * there was no way to add a brand from anywhere in the app at all — the product
 * importer even refuses to invent them and tells the user to "add it under
 * Setup", naming a screen that did not exist.
 *
 * The brand is created immediately rather than at product-save: it is a real
 * row either way, and a save that had to create brands as a side effect would
 * be one that can half-succeed. It is then selected, which is the only reason
 * this needs the new id back.
 *
 * ── CREATE ONLY, NOT RENAME ──────────────────────────────────────────────
 *
 * There is one brands row and every product points at it, so renaming from
 * inside a product form would rename the brand on every product that carries it
 * while looking like an edit to the one on screen. Renaming stays on
 * Setup → Brands, where the dialog can say how many products it is about to
 * change. The action guards on `products.edit` for the same reason: filing
 * products should not carry the right to restyle the whole catalogue.
 */

/* The option value that opens the create dialog. A string that is not a number,
   so it can never collide with a brand id. */
const CREATE = 'create'

export default function BrandPicker({
  name,
  brands,
  defaultValue,
  canCreate = true,
}: {
  name: string
  brands: Brand[]
  defaultValue: number | null
  /**
   * `products.edit`. The action enforces it too — this only hides the option,
   * so somebody who may not create one is not handed a dialog that will fail.
   */
  canCreate?: boolean
}) {
  const router = useRouter()
  const toast = useToast()

  /* Brands created here, appended to what the server sent. router.refresh()
     brings the real rows down, but it is not instant and a <select> cannot show
     an option that is not in its list yet. Holding them locally is what makes a
     new brand appear the moment it exists rather than a beat later. */
  const [added, setAdded] = useState<Brand[]>([])

  /* Once refresh() lands, the server is sending the same row this list is still
     holding a stand-in for, so the stand-in has to drop out — otherwise the
     brand renders twice under one id, and React is asked to key two options the
     same. The server row wins: it is the real one. */
  const all = useMemo(() => {
    const fromServer = new Set(brands.map((b) => b.id))
    return [...brands, ...added.filter((b) => !fromServer.has(b.id))].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
  }, [brands, added])

  /* The chosen id. Seeded from the saved product, then owned here — a
     controlled select is what lets the newly created brand be selected. */
  const [selected, setSelected] = useState<number | ''>(defaultValue ?? '')

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  function choose(value: string) {
    if (value === CREATE) {
      setDraftName('')
      setCreating(true)
      return
    }
    setSelected(value === '' ? '' : Number(value))
  }

  const trimmed = draftName.trim()

  async function create() {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const result = await createBrandInlineAction({ name: trimmed })
      if (!result.ok) {
        // Names the brand that already holds it when the name clashes, which is
        // the likely failure here — shown as-is rather than made generic.
        toast.error(result.error)
        return
      }

      /* A stand-in until refresh() brings the real row down. Only the fields
         this picker reads are known here; it is active because it was just
         created, which is true at this instant. */
      setAdded((current) => [...current, { id: result.id, name: result.name, isActive: true }])
      setSelected(result.id)
      setCreating(false)
      toast.success(`${result.name} created.`)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* No max-w: this is a grid cell placed by the department picker's
          `trailing` slot, and the column sets the width. */}
      <Field label="Brand">
        <Select value={selected} onChange={(e) => choose(e.target.value)}>
          <option value="">&lt;None&gt;</option>
          {all.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          {canCreate && <option value={CREATE}>&lt;Create new&gt;</option>}
        </Select>
      </Field>

      {/* The value the product form actually posts. The <select> above is
          controlled and unnamed, so a brand created here is submitted without
          the form needing to know this dialog happened. */}
      <input type="hidden" name={name} value={selected} />

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New brand"
        description="Who makes this product. You can rename it or stop offering it under Setup → Brands."
        size="sm"
        /* Holds half-typed work — a stray backdrop click must not discard it. */
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || trimmed.length === 0} onClick={create}>
              <Icons.Save size={15} />
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <Field
          label="Name"
          hint="One row per brand, shared by every product on it — so spell it the way it should read everywhere."
        >
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            maxLength={120}
            autoFocus
            placeholder="Coca-Cola"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // This dialog sits inside the product form. Without this the
                // browser's implicit submission would SAVE THE PRODUCT on
                // Enter instead of creating the brand.
                e.preventDefault()
                void create()
              }
            }}
          />
        </Field>
      </Modal>
    </>
  )
}
