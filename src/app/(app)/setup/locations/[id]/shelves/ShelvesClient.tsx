'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Menu,
  MenuItem,
  Modal,
  SettingRow,
  SortableList,
  Switch,
  Textarea,
  useToast,
} from '@/components/ui'
import type { StockShelf, StockBin } from '@/lib/site/stockBins'
import {
  saveShelfAction,
  deleteShelfAction,
  saveBinAction,
  deleteBinAction,
  reorderShelvesAction,
  reorderBinsAction,
} from './actions'

/**
 * Shelves and bins in one stock location.
 *
 * ── THE ORDER OF THIS LIST IS THE FEATURE ──────────────────────────────────
 *
 * Dragging a shelf up or down sets the order a count sheet is printed in, which
 * is the whole reason shelves are worth recording. That effect is invisible on
 * this screen — nothing here changes when a row moves — so the page subtitle and
 * the toast after a drag both say what was just decided, rather than leaving the
 * user to discover it on a sheet next month.
 *
 * Drag rather than a walk-order number field: the sequence is the thing being
 * expressed, and a column of 10, 20, 30 asks somebody to encode a list they can
 * already see. The kit component carries the keyboard sensor, so nothing is lost
 * to a mouse-only interaction.
 *
 * ── BINS ARE NESTED, NOT A SECOND LIST ─────────────────────────────────────
 *
 * A bin only means anything under its shelf — every site numbers bins 1, 2, 3 up
 * every rack, so a flat list of bins would be a column of ones and twos with no
 * way to tell them apart. SettingRow's `nested` says the same thing visually.
 */
export default function ShelvesClient({
  locationId,
  locationName,
  shelves,
}: {
  locationId: number
  locationName: string
  shelves: StockShelf[]
}) {
  const [editingShelf, setEditingShelf] = useState<StockShelf | null>(null)
  const [addingShelf, setAddingShelf] = useState(false)
  const [deletingShelf, setDeletingShelf] = useState<StockShelf | null>(null)

  /* The bin dialogs carry the shelf they belong to: a bin cannot be created
     without one, and the title has to name it or "Add bin" is ambiguous on a
     screen showing six racks. */
  const [binTarget, setBinTarget] = useState<{ shelf: StockShelf; bin: StockBin | null } | null>(
    null,
  )
  const [deletingBin, setDeletingBin] = useState<{ shelf: StockShelf; bin: StockBin } | null>(null)

  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  function run(work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    startTransition(async () => {
      const result = await work()
      if (result.ok) {
        toast.success(result.message)
        setAddingShelf(false)
        setEditingShelf(null)
        setDeletingShelf(null)
        setBinTarget(null)
        setDeletingBin(null)
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const binCount = shelves.reduce((sum, s) => sum + s.bins.length, 0)

  return (
    <>
      <Card>
        <CardHeader
          title="Shelves"
          description={
            shelves.length === 0
              ? 'Where in this room stock is kept.'
              : `${shelves.length} shelf${shelves.length === 1 ? '' : 'ves'}${
                  binCount > 0 ? `, ${binCount} bin${binCount === 1 ? '' : 's'}` : ''
                } — top to bottom is the order count sheets print in.`
          }
          action={
            <Button variant="primary" onClick={() => setAddingShelf(true)} disabled={pending}>
              <Icons.Plus size={15} />
              Add shelf
            </Button>
          }
        />

        {shelves.length === 0 ? (
          <EmptyState
            icon={<Icons.StackedBands size={22} />}
            title="No shelves yet"
            hint={`Add a shelf for each rack or bay in ${locationName}. Once there are shelves, products can be placed on them and stock take sheets print in the order you walk the room instead of alphabetically.`}
            action={
              // Secondary: the header's Add shelf stays the one primary.
              <Button variant="secondary" onClick={() => setAddingShelf(true)} disabled={pending}>
                <Icons.Plus size={15} />
                Add shelf
              </Button>
            }
          />
        ) : (
          <SortableList
            items={shelves}
            getId={(s) => s.id}
            onReorder={(next) =>
              run(() =>
                reorderShelvesAction(
                  locationId,
                  next.map((s) => s.id),
                ),
              )
            }
            disabled={pending}
          >
            {(shelf, handle) => (
              <div>
                <SettingRow
                  /* The grip is the row's leading edge — the thing you grab —
                     and sits OUTSIDE the tinted tile, which is sized for one
                     glyph. */
                  leading={handle}
                  icon={<Icons.StackedBands size={16} />}
                  label={`${shelf.code} — ${shelf.name}`}
                  description={describeShelf(shelf)}
                >
                  <div className="flex items-center gap-1.5">
                    {!shelf.isActive && <Badge tone="neutral">Off</Badge>}

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => setBinTarget({ shelf, bin: null })}
                    >
                      <Icons.Plus size={15} />
                      Bin
                    </Button>

                    <Menu label="More" variant="ghost">
                      <MenuItem onClick={() => setEditingShelf(shelf)}>
                        <Icons.Pencil size={15} />
                        Edit
                      </MenuItem>
                      <MenuItem
                        tone="danger"
                        disabled={pending}
                        onClick={() => setDeletingShelf(shelf)}
                      >
                        <Icons.Trash size={15} />
                        Delete
                      </MenuItem>
                    </Menu>
                  </div>
                </SettingRow>

                {shelf.bins.length > 0 && (
                  <SortableList
                    items={shelf.bins}
                    getId={(b) => b.id}
                    onReorder={(next) =>
                      run(() =>
                        reorderBinsAction(
                          locationId,
                          next.map((b) => b.id),
                        ),
                      )
                    }
                    disabled={pending}
                  >
                    {(bin, binHandle) => (
                      <SettingRow
                        nested
                        leading={binHandle}
                        icon={<Icons.Boxes size={16} />}
                        label={bin.name ? `${bin.code} — ${bin.name}` : bin.code}
                        description={describeBin(bin)}
                      >
                        <div className="flex items-center gap-1.5">
                          {!bin.isActive && <Badge tone="neutral">Off</Badge>}
                          <Menu label="More" variant="ghost">
                            <MenuItem onClick={() => setBinTarget({ shelf, bin })}>
                              <Icons.Pencil size={15} />
                              Edit
                            </MenuItem>
                            <MenuItem
                              tone="danger"
                              disabled={pending}
                              onClick={() => setDeletingBin({ shelf, bin })}
                            >
                              <Icons.Trash size={15} />
                              Delete
                            </MenuItem>
                          </Menu>
                        </div>
                      </SettingRow>
                    )}
                  </SortableList>
                )}
              </div>
            )}
          </SortableList>
        )}
      </Card>

      <ShelfModal
        shelf={addingShelf ? null : editingShelf}
        open={addingShelf || editingShelf !== null}
        pending={pending}
        onClose={() => {
          setAddingShelf(false)
          setEditingShelf(null)
        }}
        onSave={(input) => run(() => saveShelfAction(locationId, editingShelf?.id ?? null, input))}
      />

      <BinModal
        target={binTarget}
        pending={pending}
        onClose={() => setBinTarget(null)}
        onSave={(input) =>
          binTarget &&
          run(() => saveBinAction(locationId, binTarget.shelf.id, binTarget.bin?.id ?? null, input))
        }
      />

      <ConfirmModal
        open={deletingShelf !== null}
        onClose={() => setDeletingShelf(null)}
        onConfirm={() => deletingShelf && run(() => deleteShelfAction(locationId, deletingShelf.id))}
        title={`Delete ${deletingShelf?.code}?`}
        message={deleteShelfMessage(deletingShelf)}
        confirmLabel="Delete shelf"
        busy={pending}
      />

      <ConfirmModal
        open={deletingBin !== null}
        onClose={() => setDeletingBin(null)}
        onConfirm={() => deletingBin && run(() => deleteBinAction(locationId, deletingBin.bin.id))}
        title={`Delete bin ${deletingBin?.bin.code}?`}
        message={deleteBinMessage(deletingBin)}
        confirmLabel="Delete bin"
        busy={pending}
      />
    </>
  )
}

/*
 * The row descriptions.
 *
 * Both lead with what is IN the thing, because that is what somebody about to
 * rename or delete it needs to know, and neither says "0 products" — an empty
 * shelf is the ordinary state of a new one, and reporting it as a figure makes
 * every fresh row look like a problem.
 */
function describeShelf(shelf: StockShelf): string {
  const parts: string[] = []
  if (shelf.bins.length > 0) {
    parts.push(`${shelf.bins.length} bin${shelf.bins.length === 1 ? '' : 's'}`)
  }
  if (shelf.placementCount > 0) {
    parts.push(`${shelf.placementCount} product${shelf.placementCount === 1 ? '' : 's'}`)
  }
  if (shelf.note) parts.push(shelf.note)
  if (parts.length === 0) return 'No bins yet — products can be placed on the shelf itself.'
  return parts.join(' · ')
}

function describeBin(bin: StockBin): string {
  if (bin.placementCount === 0) return 'Empty'
  return `${bin.placementCount} product${bin.placementCount === 1 ? '' : 's'}`
}

function deleteShelfMessage(shelf: StockShelf | null): string {
  if (!shelf) return ''
  const bins = shelf.bins.length
  const placed = shelf.placementCount
  if (placed === 0 && bins === 0) {
    return 'Nothing is on this shelf, so nothing is lost.'
  }
  const what = [
    bins > 0 ? `${bins} bin${bins === 1 ? '' : 's'}` : null,
    placed > 0 ? `${placed} product${placed === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' and ')
  return `This shelf holds ${what}. Deleting it removes the bins and leaves those products with no recorded spot — no stock is moved and nothing is written off, they simply stop saying where they are kept.`
}

function deleteBinMessage(target: { shelf: StockShelf; bin: StockBin } | null): string {
  if (!target) return ''
  const { shelf, bin } = target
  if (bin.placementCount === 0) return 'Nothing is in this bin, so nothing is lost.'
  return `${bin.placementCount} product${
    bin.placementCount === 1 ? '' : 's'
  } are kept here. They stay on shelf ${shelf.code} — they just stop naming a bin. No stock is moved.`
}

/* ── Dialogs ────────────────────────────────────────────────────────────── */

/*
 * Both dialogs seed their fields the first time they open for a given record and
 * reset when they close — the same `seeded` pattern LocationsClient uses, so a
 * reopened form never shows the previous shelf's values. Deliberately not
 * defaultValue with separate state: an untouched field would submit empty and
 * silently blank a code somebody never meant to change.
 */

function ShelfModal({
  shelf,
  open,
  pending,
  onClose,
  onSave,
}: {
  shelf: StockShelf | null
  open: boolean
  pending: boolean
  onClose: () => void
  onSave: (input: { code: string; name: string; note: string | null; isActive: boolean }) => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [seeded, setSeeded] = useState<number | null>(null)

  if (open && seeded !== (shelf?.id ?? 0)) {
    setSeeded(shelf?.id ?? 0)
    setCode(shelf?.code ?? '')
    setName(shelf?.name ?? '')
    setNote(shelf?.note ?? '')
    setIsActive(shelf?.isActive ?? true)
  }
  if (!open && seeded !== null) setSeeded(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={shelf ? `Edit ${shelf.code}` : 'Add a shelf'}
      description="A rack, bay or run of shelving in this room."
      size="sm"
      /* Holds typed field values; a stray backdrop click must not discard them. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => onSave({ code, name, note: note.trim() || null, isActive })}
          >
            {pending ? 'Saving…' : shelf ? 'Save changes' : 'Add shelf'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Code" hint="Short, and what is painted on the rack — A03, FRONT, COLD2.">
          {/* Constrained: a full-width box for a 3-character code tells the user
              the wrong thing about how long it should be. */}
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={24}
            autoFocus
            className="w-40"
          />
        </Field>

        <Field label="Name" hint="What someone would call it out loud.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>

        <Field label="Note" hint="Optional — anything a picker should know.">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={190}
            rows={2}
          />
        </Field>

        <SettingRow
          icon={<Icons.Check size={16} />}
          label="In use"
          description="Switch off a bay being re-racked. What is already placed here stays put; it just stops being offered for new placements."
        >
          <Switch checked={isActive} onChange={setIsActive} ariaLabel="Shelf in use" />
        </SettingRow>
      </div>
    </Modal>
  )
}

function BinModal({
  target,
  pending,
  onClose,
  onSave,
}: {
  target: { shelf: StockShelf; bin: StockBin | null } | null
  pending: boolean
  onClose: () => void
  onSave: (input: { code: string; name: string | null; isActive: boolean }) => void
}) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [seeded, setSeeded] = useState<number | null>(null)

  const open = target !== null
  const bin = target?.bin ?? null

  if (open && seeded !== (bin?.id ?? 0)) {
    setSeeded(bin?.id ?? 0)
    setCode(bin?.code ?? '')
    setName(bin?.name ?? '')
    setIsActive(bin?.isActive ?? true)
  }
  if (!open && seeded !== null) setSeeded(null)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={bin ? `Edit bin ${bin.code}` : 'Add a bin'}
      description={target ? `A slot on ${target.shelf.code} — ${target.shelf.name}.` : undefined}
      size="sm"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => onSave({ code, name: name.trim() || null, isActive })}
          >
            {pending ? 'Saving…' : bin ? 'Save changes' : 'Add bin'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Code" hint="Usually just the slot number — 1, 2, 3 up the rack.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={24}
            autoFocus
            className="w-28"
          />
        </Field>

        <Field label="Name" hint="Optional — “middle”, “top left”.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>

        <SettingRow
          icon={<Icons.Check size={16} />}
          label="In use"
          description="Switch off a slot that is out of action. Anything already in it stays there."
        >
          <Switch checked={isActive} onChange={setIsActive} ariaLabel="Bin in use" />
        </SettingRow>
      </div>
    </Modal>
  )
}
