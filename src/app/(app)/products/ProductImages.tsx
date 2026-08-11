'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Icons,
  Input,
  useToast,
} from '@/components/ui'
import { MAX_IMAGES_PER_PRODUCT, IMAGE_ACCEPT, IMAGE_EXTENSIONS_LABEL, type ProductImage } from '@/lib/productImageModel'
import {
  deleteImageAction,
  reorderImagesAction,
  setAltTextAction,
  setPrimaryImageAction,
  uploadImageAction,
} from './imageActions'

/**
 * A product's photographs.
 *
 * The FIRST image is what a shopper sees in a grid, so the order is a
 * merchandising decision rather than an accident of upload time — hence the
 * arrows. "Primary" is separate from position because the till button wants
 * one specific picture and that is not always the one you want leading the
 * gallery.
 *
 * Alt text saves on blur rather than behind a button: it is one field per
 * image, and a Save next to each would be more chrome than content.
 */
export default function ProductImages({
  productId,
  initial,
}: {
  productId: number
  initial: ProductImage[]
}) {
  const toast = useToast()
  const [busy, startAction] = useTransition()
  const [images, setImages] = useState(initial)
  const fileInput = useRef<HTMLInputElement>(null)

  const full = images.length >= MAX_IMAGES_PER_PRODUCT

  function upload(files: FileList | null) {
    if (!files || files.length === 0) return

    startAction(async () => {
      // One at a time: each upload validates and writes its own file, and a
      // partial failure should leave the successful ones in place rather than
      // rolling the whole batch back.
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.set('file', file)
        const result = await uploadImageAction(productId, form)
        if (!result.ok) {
          toast.error(`${file.name}: ${result.error}`)
          break
        }
        setImages(result.images)
      }
      if (fileInput.current) fileInput.current.value = ''
    })
  }

  function run(action: () => Promise<{ ok: true; images: ProductImage[] } | { ok: false; error: string }>) {
    startAction(async () => {
      const result = await action()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setImages(result.images)
    })
  }

  function move(imageId: number, direction: -1 | 1) {
    const index = images.findIndex((i) => i.id === imageId)
    const target = index + direction
    if (index === -1 || target < 0 || target >= images.length) return

    const next = [...images]
    ;[next[index], next[target]] = [next[target], next[index]]
    // Shown immediately, saved behind it: reordering is a drag-like gesture
    // and waiting for a round trip per tap makes it feel broken.
    setImages(next)
    startAction(async () => {
      const result = await reorderImagesAction(productId, next.map((i) => i.id))
      if (!result.ok) {
        toast.error(result.error)
        setImages(images)
      }
    })
  }

  return (
    <Card>
      <CardHeader
        tone="brand"
        title="Photographs"
        description={`Shown in your online store. The first one leads the gallery. ${IMAGE_EXTENSIONS_LABEL}.`}
        action={
          <>
            <input
              ref={fileInput}
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              hidden
              onChange={(e) => upload(e.target.files)}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || full}
              onClick={() => fileInput.current?.click()}
            >
              <Icons.Upload size={15} />
              {busy ? 'Uploading…' : 'Add images'}
            </Button>
          </>
        }
      />

      {images.length === 0 ? (
        <EmptyState
          icon={<Icons.FileImage size={22} />}
          title="No photographs yet"
          hint="A product with a picture sells better than one without. Add one to show it in your online store."
        />
      ) : (
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((image, index) => (
            <div
              key={image.id}
              className="flex flex-col gap-2 rounded-card border border-border p-3"
            >
              <div className="relative">
                <img
                  src={`/api/product-images/${image.id}?productId=${productId}`}
                  alt={image.altText || image.filename}
                  className="aspect-square w-full rounded-control bg-surface-2 object-contain"
                />
                {image.isPrimary && (
                  <span className="absolute left-2 top-2">
                    <Badge tone="brand">Main</Badge>
                  </span>
                )}
              </div>

              <Input
                defaultValue={image.altText}
                placeholder="Describe this picture"
                aria-label={`Description for ${image.filename}`}
                maxLength={190}
                /* On blur, not on every keystroke: this is one small field and
                   a write per character would be absurd. */
                onBlur={(e) => {
                  const value = e.target.value
                  if (value === image.altText) return
                  startAction(async () => {
                    const result = await setAltTextAction(productId, image.id, value)
                    if (!result.ok) toast.error(result.error)
                    else {
                      setImages((prev) =>
                        prev.map((i) => (i.id === image.id ? { ...i, altText: value } : i)),
                      )
                    }
                  })
                }}
              />

              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move earlier"
                  disabled={busy || index === 0}
                  onClick={() => move(image.id, -1)}
                >
                  <Icons.ChevronUp size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move later"
                  disabled={busy || index === images.length - 1}
                  onClick={() => move(image.id, 1)}
                >
                  <Icons.ChevronDown size={15} />
                </Button>

                {!image.isPrimary && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => run(() => setPrimaryImageAction(productId, image.id))}
                  >
                    Make main
                  </Button>
                )}

                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  className="ml-auto"
                  aria-label={`Remove ${image.filename}`}
                  disabled={busy}
                  onClick={() => run(() => deleteImageAction(productId, image.id))}
                >
                  <Icons.Trash size={15} />
                </Button>
              </div>
            </div>
          ))}
        </CardBody>
      )}

      {full && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted">
          This product has the maximum of {MAX_IMAGES_PER_PRODUCT} images. Remove one to add
          another.
        </p>
      )}
    </Card>
  )
}
