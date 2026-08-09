'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { Button, Icons, Modal, useToast } from '@/components/ui'
import type { StorefrontImage } from '@/lib/site/storefrontImages'
import {
  deletePictureAction,
  listPicturesAction,
  uploadPictureAction,
} from '@/app/(app)/pictureActions'

/**
 * Choosing a picture — on a banner, a carousel slide, or a department.
 *
 * Lives in components/ rather than beside any one of those screens because it
 * is used by all three, over one shared library. It reads that library through
 * `pictureActions`, which guards on "may edit the things pictures go on"
 * rather than on the builder's `online.edit` — a department is edited under
 * `products.edit`, and the builder's own actions would have handed that user
 * an empty picker.
 *
 * ── A LIBRARY, NOT A FILE FIELD ──────────────────────────────────────────
 *
 * A plain upload control per section would mean uploading the same seasonal
 * photograph again for the second banner that uses it, and again after
 * deleting a section by mistake. The shop's pictures are a small library that
 * outlives any one section, so a picker over that library is the honest shape
 * — and it makes "use this one again" a click rather than a search of the
 * owner's own hard disk.
 *
 * ── WHY THE LIST IS FETCHED HERE ─────────────────────────────────────────
 *
 * The builder page could pass the whole library down, but the list changes
 * while the dialog is open — that is what uploading is — and a server-passed
 * prop only refreshes on a revalidate. Fetching on open means the grid is
 * right the moment it is drawn, and an upload lands in it without a round trip
 * through the page.
 */
export default function PicturePicker({
  value,
  current,
  onChange,
}: {
  /** The chosen image id, or null. */
  value: number | null
  /**
   * The chosen picture as the SERVER resolved it, so the button shows a
   * thumbnail before the dialog has ever been opened.
   */
  current: StorefrontImage | null
  onChange: (image: StorefrontImage | null) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <div className="flex items-center gap-3">
        {/* The thumbnail doubles as the "change it" button — a picture is the
            one thing nobody needs a label to recognise. */}
        <button
          data-kit-ok
          type="button"
          onClick={() => setOpen(true)}
          aria-label={value ? 'Change the picture' : 'Choose a picture'}
          className="relative h-16 w-28 shrink-0 overflow-hidden rounded-control border border-border bg-surface-2 transition hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/storefront-images/${value}`}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-muted">
              <Icons.Picture size={20} />
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-col gap-1">
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            {value ? 'Change picture' : 'Choose a picture'}
          </Button>
          {value && (
            <Button variant="danger-ghost" size="sm" onClick={() => onChange(null)}>
              Remove it
            </Button>
          )}
        </div>
      </div>

      <PickerDialog
        open={open}
        onClose={() => setOpen(false)}
        value={value}
        onPick={(image) => {
          onChange(image)
          setOpen(false)
        }}
      />
    </>
  )
}

function PickerDialog({
  open,
  onClose,
  value,
  onPick,
}: {
  open: boolean
  onClose: () => void
  value: number | null
  onPick: (image: StorefrontImage) => void
}) {
  const toast = useToast()
  const [images, setImages] = useState<StorefrontImage[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, startAction] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  // Loaded on OPEN rather than on mount: a page with six banner sections would
  // otherwise fetch the same library six times before anyone clicked anything.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const list = await listPicturesAction()
      // The dialog closed while this was in flight. Setting state now would
      // repopulate a grid nobody is looking at, and re-open it stale.
      if (cancelled) return
      setImages(list)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  function upload(file: File) {
    startAction(async () => {
      const form = new FormData()
      form.set('file', file)
      const result = await uploadPictureAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      // Straight into the grid AND straight onto the section: someone who has
      // just chosen a file from their own disk has already decided.
      setImages((prev) => [result.image, ...prev])
      onPick(result.image)
    })
  }

  function remove(image: StorefrontImage) {
    startAction(async () => {
      const result = await deletePictureAction(image.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setImages((prev) => prev.filter((i) => i.id !== image.id))
      toast.success('Picture deleted.')
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your pictures"
      description="Choose one for this banner, or upload a new one."
      size="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-surface-2 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Upload a picture</p>
            <p className="text-sm text-muted">
              A wide photograph works best — it is cropped to a strip across the page.
            </p>
          </div>
          {/* The native input is kept but hidden, and a kit Button opens it:
              only a real file input can open the picker from a user gesture,
              and this dialog wants the app's own button, not the browser's. */}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              // Cleared so choosing the SAME file twice still fires a change —
              // the browser suppresses it otherwise, and re-picking a file
              // after a failed upload is exactly when that matters.
              e.target.value = ''
              if (file) upload(file)
            }}
          />
          <Button variant="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icons.Upload size={15} />
            {busy ? 'Uploading…' : 'Choose a file'}
          </Button>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted">Loading your pictures…</p>
        ) : images.length === 0 ? (
          <div className="rounded-card border border-dashed border-border-strong px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink">No pictures yet</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
              Upload one above and it stays here, ready to use on any banner.
            </p>
          </div>
        ) : (
          <ul className="grid max-h-96 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {images.map((image) => (
              <li key={image.id} className="group relative">
                {/* Not a kit Button: a picture tile whose whole area is the
                    control, with its own selected outline. A Button variant
                    for it would be used nowhere else. */}
                <button
                  data-kit-ok
                  type="button"
                  onClick={() => onPick(image)}
                  aria-label={`Use ${image.filename}`}
                  aria-pressed={value === image.id}
                  className="block w-full overflow-hidden rounded-control border border-border bg-surface-2 transition hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  style={
                    value === image.id
                      ? { outline: '2px solid var(--color-brand)', outlineOffset: 2 }
                      : undefined
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/storefront-images/${image.id}`}
                    alt={image.altText || image.filename}
                    className="h-24 w-full object-cover"
                  />
                </button>

                <div className="absolute right-1 top-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Delete ${image.filename}`}
                    disabled={busy}
                    onClick={() => remove(image)}
                  >
                    <Icons.Trash size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-sm text-muted">
          Deleting a picture leaves any banner using it empty — the section stays, so you can
          choose another.
        </p>
      </div>
    </Modal>
  )
}
