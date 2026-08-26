'use client'

import { useRef, useState, useTransition } from 'react'
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  FileInput,
  Field,
  useToast,
} from '@/components/ui'
import { uploadSignInBackdropAction, clearSignInBackdropAction } from './actions'

/**
 * The picture behind the till's sign-in screen.
 *
 * ── WHY IT LIVES HERE AND NOT UNDER STATIONERY ───────────────────────────
 *
 * The shop's document logo is on that screen, and the obvious instinct is to
 * put its companion beside it. But Stationery is about what PRINTS — a logo
 * there is chosen for how it looks small and dark on white paper. This is
 * chosen for how it looks across a room behind a PIN pad. Somebody picking one
 * is not thinking about the other, and the till screens are already this
 * screen's subject.
 *
 * ── WHY THERE IS NO PREVIEW OF THE WHOLE SCREEN HERE ─────────────────────
 *
 * There is a real one, at /setup/style-guide, rendered from the same component
 * the till uses. A second mock-up drawn here would be a picture of a screen
 * rather than the screen, and the moment it drifted it would be worse than
 * nothing — a manager would trust it and be wrong. What this panel shows is the
 * ASSET: the picture as uploaded, cropped the way the till crops it.
 */
export default function SignInArtPanel({ backdropUrl }: { backdropUrl: string }) {
  const toast = useToast()
  const [pending, start] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  /*
   * The URL to draw, held in state rather than read from the prop on every
   * render. `revalidatePath` re-renders the server page and hands back a fresh
   * prop, but not before the action resolves — so without this the old picture
   * stays on screen through the round trip and an upload reads as having done
   * nothing.
   */
  const [shown, setShown] = useState(backdropUrl)

  function upload(file: File) {
    const form = new FormData()
    form.set('backdrop', file)
    start(async () => {
      const result = await uploadSignInBackdropAction(form)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      /* Cache-busted on the CLOCK here, unlike the server's stored-name buster.
         This component does not know the new file's name — only that the bytes
         behind a constant URL have changed — and without a fresh query string
         the browser would go on showing the picture it already has. */
      setShown(`/api/pos/signin-art?v=${Date.now()}`)
      if (inputRef.current) inputRef.current.value = ''
    })
  }

  function remove() {
    start(async () => {
      const result = await clearSignInBackdropAction()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setShown('')
      if (inputRef.current) inputRef.current.value = ''
    })
  }

  return (
    <Card>
      <CardHeader
        title="Till sign-in screen"
        description="The picture customers see beside the PIN pad, while nobody is signed in."
      />
      <CardBody>
        <div className="flex flex-wrap items-start gap-5">
          {/* The asset, cropped the way the till crops it — `object-cover` on a
              tall frame, because that is what the panel does with it. A shop
              that uploads a wide landscape shot should be able to see here that
              its edges are lost, rather than discovering it at a counter. */}
          <div className="h-40 w-32 shrink-0 overflow-hidden rounded-card border border-border bg-surface-2">
            {shown ? (
              <img src={shown} alt="" className="h-full w-full object-cover" />
            ) : (
              /* What the till ACTUALLY shows with no picture — the same brand
                 gradient, not a grey "no image" box. The point is that having
                 uploaded nothing is a finished state, and a panel implying
                 otherwise would push shops into uploading something. */
              <div className="h-full w-full bg-gradient-to-br from-brand to-brand-ink" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <Field
              label="Replace the picture"
              hint="A tall photograph works best — the panel is a portrait shape beside the PIN pad. PNG, JPEG, GIF or WebP."
            >
              <FileInput
                ref={inputRef}
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={pending}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) upload(file)
                }}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3 pt-3">
              {/* Only offered when there is something to remove. A disabled
                  button here would be a control whose entire job is to say
                  "nothing to do", which the empty frame already says. */}
              {shown && (
                <Button variant="danger-ghost" onClick={remove} disabled={pending}>
                  Remove picture
                </Button>
              )}
              <p className="text-sm text-muted">
                Your logo appears over this picture, from Setup → Stationery. Any specials
                you are running today appear beneath it automatically.
              </p>
            </div>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
