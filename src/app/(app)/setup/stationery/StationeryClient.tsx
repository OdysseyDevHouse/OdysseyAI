'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CodeArea,
  ConfirmModal,
  EmptyState,
  Field,
  Icons,
  Input,
  Select,
  useToast,
} from '@/components/ui'
import {
  saveTemplateAction,
  setActiveAction,
  resetToDefaultAction,
  previewTemplateAction,
  deleteTemplateAction,
  copyTemplateAction,
  uploadLogoAction,
  clearLogoAction,
  toMarkupAction,
  uploadPictureAction,
  deletePictureAction,
  saveReviewUrlAction,
  type PictureInfo,
} from './actions'
import SlipDesigner from './SlipDesigner'
import CopyDesignModal from './CopyDesignModal'
import { parseSlip, serialiseSlip } from '@/lib/stationery/slip'
import { parseSpec, serialiseSpec } from '@/lib/stationery/blocks'
import VisualDesigner from './visual/VisualDesigner'

/**
 * One empty slip spec, shared.
 *
 * A literal written inline is a NEW OBJECT on every render, so the designer's
 * preview effect — which depends on the spec — refired without end and called the
 * preview action hundreds of times. Any one of those failing left "The preview
 * could not be rendered" on screen, which is how it was reported.
 */
const EMPTY_SLIP = { version: 1 as const, blocks: [] }

type TokenInfo = { key: string; label: string; hint: string; section: string | null }
type DocInfo = {
  key: string
  label: string
  medium: 'a4' | 'slip'
  defaultBody: string
  /** The same document as a block spec, for the visual editor. */
  defaultSpec?: string
  tokens: TokenInfo[]
  sections: { key: string; label: string }[]
}
type TemplateInfo = {
  id: number
  docType: string
  name: string
  body: string
  draftBody: string | null
  isActive: boolean
  format: 'html' | 'slip' | 'blocks'
}

/**
 * The stationery designer.
 *
 * ── THE PREVIEW IS THE BUILD SURFACE ──────────────────────────────────────
 *
 * Laid out the way the report builder is: the thing being made sits front and
 * centre and the controls sit beside it, because the question a designer is
 * actually asking is "what does the paper look like" and everything else is in
 * service of that. The markup pane is a tool, not the subject.
 *
 * The preview is rendered by the SERVER, through the same sanitiser, validator
 * and renderer the print route uses, against this shop's own most recent order.
 * A browser-side preview would be a second implementation of the renderer whose
 * only job is to agree with the first — and it would disagree eventually, at
 * the moment someone trusted it.
 *
 * ── UNSAVED WORK IS VISIBLE ───────────────────────────────────────────────
 *
 * `dirty` drives both the Save button and a warning strip, because the failure
 * this screen invites is editing for ten minutes and navigating away. What
 * PRINTS and what is being EDITED are also different things and are labelled
 * as such: a design only reaches paper when it is made active.
 */
export default function StationeryClient({
  siteName,
  logoFile,
  pictures: initialPictures,
  reviewUrl: initialReviewUrl,
  docs,
  templates: initialTemplates,
}: {
  siteName: string
  /** The stored disk name, or '' — used only to know whether one exists. */
  logoFile: string
  pictures: PictureInfo[]
  /** Where a scan-to-rate QR points. Empty means such a QR prints nothing. */
  reviewUrl: string
  docs: DocInfo[]
  templates: TemplateInfo[]
}) {
  const toast = useToast()
  const [pending, start] = useTransition()

  const [docType, setDocType] = useState(docs[0]?.key ?? '')
  const doc = useMemo(() => docs.find((d) => d.key === docType), [docs, docType])

  const [templates, setTemplates] = useState(initialTemplates)
  const forDoc = useMemo(
    () => templates.filter((t) => t.docType === docType),
    [templates, docType],
  )
  const active = forDoc.find((t) => t.isActive) ?? null

  const [editingId, setEditingId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [dirty, setDirty] = useState(false)
  /**
   * How the open design is written.
   *
   * `body` stays the single source of truth whichever editor is showing — the
   * visual one serialises its spec into it on every change — so saving,
   * dirty-checking and the draft flow need no second path. This only says how
   * to READ it.
   */
  const [format, setFormat] = useState<'html' | 'slip' | 'blocks'>('html')
  const [convertOpen, setConvertOpen] = useState(false)

  /**
   * Turn the open block design into markup.
   *
   * The result lands in the editor as UNSAVED work rather than being written,
   * so converting by accident costs nothing — close the screen and the stored
   * design is untouched. Converting and saving stay two decisions.
   */
  function convertToMarkup() {
    start(async () => {
      const res = await toMarkupAction({ docType, spec: body })
      setConvertOpen(false)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setBody(res.body)
      setFormat('html')
      setDirty(true)
      toast.success('Converted. Save to keep it — the block version is still in your list.')
    })
  }

  const [html, setHtml] = useState('')
  const [previewLabel, setPreviewLabel] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [previewing, setPreviewing] = useState(false)

  const editing = editingId === null ? null : forDoc.find((t) => t.id === editingId) ?? null

  /* Switching document type abandons the editor rather than carrying markup
     from one document into another, where its tokens would all be unknown. */
  useEffect(() => {
    setEditingId(null)
    setName('')
    setBody('')
    setDirty(false)
    setWarnings([])
    setHtml('')
  }, [docType])

  /**
   * Ask the server what this markup renders to.
   *
   * Debounced, and the answer is dropped if another request went out while it
   * was in flight — otherwise a slow render of an old draft lands after a fast
   * render of a new one and the preview shows the wrong document.
   */
  const seq = useRef(0)
  const runPreview = useCallback(
    (markup: string) => {
      if (!docType) return
      const mine = ++seq.current
      setPreviewing(true)
      previewTemplateAction({ docType, body: markup })
        .then((res) => {
          if (mine !== seq.current) return
          if (!res.ok) {
            setWarnings([res.error])
            setHtml('')
            return
          }
          setHtml(res.html)
          setPreviewLabel(res.label)
          setWarnings(res.warnings)
        })
        .catch(() => {
          if (mine === seq.current) setWarnings(['The preview could not be rendered.'])
        })
        .finally(() => {
          if (mine === seq.current) setPreviewing(false)
        })
    },
    [docType],
  )

  useEffect(() => {
    /*
     * A BLOCK design and a SLIP design each preview themselves, block by block,
     * on their own canvas. Asking the markup renderer for them as well would
     * render their JSON as a page, and would be a second request per keystroke
     * for a preview nobody is looking at.
     */
    if (format === 'blocks' || format === 'slip' || !body.trim()) {
      setHtml('')
      setWarnings([])
      return
    }
    const t = setTimeout(() => runPreview(body), 400)
    return () => clearTimeout(t)
  }, [body, format, runPreview])

  function openTemplate(t: TemplateInfo) {
    setEditingId(t.id)
    setName(t.name)
    setBody(t.draftBody ?? t.body)
    setFormat(t.format)
    setDirty(false)
  }

  /**
   * Start a design, either way in.
   *
   * The VISUAL default and the MARKUP default are the same document expressed
   * twice — the test suite compares what they render, word for word — so which
   * one a shop starts from is a question of how they want to work, not of what
   * they will get.
   */
  function startFromDefault(as: 'blocks' | 'html') {
    if (!doc) return
    setEditingId(null)
    setName(`${doc.label} — ${siteName}`)
    setBody(as === 'blocks' ? (doc.defaultSpec ?? '') : doc.defaultBody)
    setFormat(doc.medium === 'slip' ? 'slip' : as)
    setDirty(true)
  }

  function save(asDraft: boolean) {
    if (!doc) return
    start(async () => {
      const res = await saveTemplateAction({
        id: editingId ?? undefined,
        docType,
        name,
        body,
        format,
        asDraft,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setDirty(false)
      if (res.id) setEditingId(res.id)

      // Reflect the save locally rather than reloading: the server revalidated
      // the route, but this component owns the editor's state and a refetch
      // would throw away what is in the pane.
      setTemplates((prev) => {
        const id = res.id!
        const found = prev.find((t) => t.id === id)
        if (found) {
          return prev.map((t) =>
            t.id === id
              ? { ...t, name, ...(asDraft ? { draftBody: body } : { body, draftBody: null }) }
              : t,
          )
        }
        return [
          ...prev,
          { id, docType, name, body, format, draftBody: asDraft ? body : null, isActive: false },
        ]
      })
    })
  }

  function activate(id: number) {
    start(async () => {
      const res = await setActiveAction(id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setTemplates((prev) =>
        prev.map((t) =>
          t.docType === docType ? { ...t, isActive: t.id === id } : t,
        ),
      )
    })
  }

  function reset() {
    start(async () => {
      const res = await resetToDefaultAction(docType)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setTemplates((prev) =>
        prev.map((t) => (t.docType === docType ? { ...t, isActive: false } : t)),
      )
    })
  }

  /*
   * The design a copy dialog is open for, or null. The whole template rather
   * than its id: the dialog needs its name and its format to decide what to
   * offer, and looking those up again from the id would go stale the moment the
   * list refreshes underneath it.
   */
  const [copying, setCopying] = useState<TemplateInfo | null>(null)

  function copy(targetDocType: string, name: string) {
    if (!copying) return
    start(async () => {
      const res = await copyTemplateAction({ id: copying.id, targetDocType, name })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      /*
       * The message names what was dropped and what had to be added — see
       * describeCopy. Shown for longer than a plain "saved" because it is
       * information the shop has to act on, not a confirmation.
       */
      toast.success(res.message)
      setCopying(null)
      /*
       * Merged locally rather than refetched, for the same reason a save is:
       * this component owns the editor's state and a reload would throw away
       * whatever is open in the pane. The action hands back the whole row —
       * including the FILTERED body, which is not what was copied from — so
       * nothing here has to guess at what the server decided.
       */
      setTemplates((prev) => [
        ...prev,
        {
          id: res.id,
          docType: res.docType,
          name: res.name,
          body: res.body,
          format: res.format,
          draftBody: null,
          isActive: false,
        },
      ])
    })
  }

  function remove(id: number) {
    start(async () => {
      const res = await deleteTemplateAction(id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setTemplates((prev) => prev.filter((t) => t.id !== id))
      if (editingId === id) {
        setEditingId(null)
        setName('')
        setBody('')
        setDirty(false)
      }
    })
  }

  const blocking = warnings.filter((w) => /must show|must carry/i.test(w))

  /* The slip's body is a JSON block spec rather than markup, so the editor
     works on the parsed form and `body` stays the single source of truth. */
  const slipSpec = useMemo(
    () => (doc?.medium === 'slip' && body.trim() ? parseSlip(body) : null),
    [doc?.medium, body],
  )

  /* A block design is JSON in `body`, parsed for the canvas. Dropping what
     this build no longer knows happens here, once, rather than in the canvas. */
  const blockSpec = useMemo(
    () => (format === 'blocks' && body.trim() ? parseSpec(body, docType) : null),
    [format, body, docType],
  )

  /* The stored name doubles as a cache-buster: the URL is constant per site, so
     without it a replaced logo would keep showing the old picture. */
  const [logo, setLogo] = useState(logoFile)
  /*
   * The whole list comes back from every picture action rather than being
   * patched here — two tabs open on this screen would otherwise disagree about
   * what the shop has.
   */
  const [pictures, setPictures] = useState(initialPictures)
  const [reviewUrl, setReviewUrl] = useState(initialReviewUrl)

  function saveReviewUrl() {
    start(async () => {
      const res = await saveReviewUrlAction(reviewUrl)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
    })
  }
  const fileInput = useRef<HTMLInputElement>(null)

  const pictureInput = useRef<HTMLInputElement>(null)

  function uploadPicture(file: File) {
    const form = new FormData()
    form.set('picture', file)
    // The upload name is a poor label but a real one — a shop renames it by
    // uploading with a better filename, which is simpler than a rename field
    // nobody would use twice.
    form.set('label', file.name.replace(/.[^.]+$/, ''))
    start(async () => {
      const res = await uploadPictureAction(form)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setPictures(res.pictures)
      toast.success(res.message)
    })
  }

  function deletePicture(id: number) {
    start(async () => {
      const res = await deletePictureAction(id)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      setPictures(res.pictures)
      toast.success(res.message)
    })
  }

  function uploadLogo(file: File) {
    const form = new FormData()
    form.set('logo', file)
    start(async () => {
      const res = await uploadLogoAction(form)
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      // A new token, so the <img> and the preview both refetch.
      setLogo(`${Date.now()}`)
      if (body.trim()) runPreview(body)
    })
  }

  function removeLogo() {
    start(async () => {
      const res = await clearLogoAction()
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(res.message)
      setLogo('')
      if (body.trim()) runPreview(body)
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="Which document"
          description="Design one document at a time. Everything else keeps the standard layout."
          action={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={reset} disabled={pending || !active}>
                Use the standard layout
              </Button>
              <Button variant="secondary" onClick={() => startFromDefault(doc?.defaultSpec ? 'blocks' : 'html')} disabled={pending}>
                <Icons.Plus aria-hidden className="h-4 w-4" />
                Start a design
              </Button>
            </div>
          }
        />
        <CardBody>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <Field label="Document" className="sm:w-64">
              <Select value={docType} onChange={(e) => setDocType(e.target.value)}>
                {docs.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="text-sm text-muted">
              {active ? (
                <>
                  Printing <span className="font-medium text-ink">{active.name}</span>.
                </>
              ) : (
                <>Printing the standard layout.</>
              )}
            </p>
          </div>

          {/* What a design does and does not reach, said on the screen rather
              than discovered by a customer who redesigns their invoice and then
              emails one. The emailed PDF now follows a BLOCK design
              (lib/stationery/pdf.ts); a markup one it cannot draw, and
              statements are a different document entirely. */}
          {docType === 'invoice' && (
            <Callout tone={format === 'html' ? 'warning' : 'neutral'} className="mt-4">
              {format === 'html' ? (
                <>
                  A design written as <strong>HTML</strong> is used when an invoice is{' '}
                  <strong>printed</strong>. Emailed invoices keep the standard layout — a PDF
                  cannot draw arbitrary markup. Design it by <strong>dragging</strong> instead
                  and the emailed copy follows it too.
                </>
              ) : (
                <>
                  This design is used when an invoice is <strong>printed</strong> and when one
                  is <strong>emailed</strong>. Statements still use the standard layout — they
                  are a different document.
                </>
              )}
            </Callout>
          )}

          {forDoc.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1.5">
              {forDoc.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 rounded-control border border-border px-3 py-2"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-ink-2">{t.name}</span>
                    {t.isActive && <Badge tone="success">Printing</Badge>}
                    {t.draftBody && <Badge tone="warning">Unpublished draft</Badge>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => openTemplate(t)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCopying(t)} disabled={pending}>
                      Copy
                    </Button>
                    {!t.isActive && (
                      <Button size="sm" variant="ghost" onClick={() => activate(t.id)} disabled={pending}>
                        Use this
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      onClick={() => remove(t.id)}
                      disabled={pending}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your logo"
          description="Put it on any document by writing {site.logo} where it should go."
        />
        <CardBody>
          <div className="flex flex-wrap items-center gap-4">
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by an
              // authenticated route that streams bytes off disk; Next's optimiser
              // cannot fetch it, and a logo needs no responsive variants.
              <img
                src={`/api/document-logo?v=${encodeURIComponent(logo)}`}
                alt=""
                className="max-h-14 w-auto rounded-control border border-border bg-surface p-2"
              />
            ) : (
              <p className="text-sm text-muted">No logo yet — documents print the name only.</p>
            )}

            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadLogo(f)
                e.target.value = ''
              }}
            />
            <Button
              variant="secondary"
              onClick={() => fileInput.current?.click()}
              disabled={pending}
            >
              <Icons.Upload aria-hidden className="h-4 w-4" />
              {logo ? 'Replace' : 'Upload a logo'}
            </Button>
            {logo && (
              <Button variant="danger-ghost" onClick={removeLogo} disabled={pending}>
                Remove
              </Button>
            )}
          </div>
          <p className="mt-3 text-xs text-muted">
            PNG or JPEG reads everywhere; GIF and WebP print but are left off emailed
            invoices. Keep it under 500&nbsp;KB — an emailed PDF carries the file itself, so a
            larger logo is skipped there rather than attached to every invoice. In the
            designer, add a <span className="font-medium text-ink">Your logo</span> block to
            put it where you like and set how tall it prints.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your pictures"
          description="Anything else you print — equipment you fit, an accreditation, a promotion."
          action={
            <Badge tone="neutral">
              {pictures.length} {pictures.length === 1 ? 'picture' : 'pictures'}
            </Badge>
          }
        />
        <CardBody>
          {pictures.length === 0 ? (
            <p className="text-sm text-muted">
              No pictures yet. Upload one, then add a{' '}
              <span className="font-medium text-ink">A picture</span> block to a design.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {pictures.map((p) => (
                <li
                  key={p.id}
                  className="flex w-40 flex-col gap-2 rounded-control border border-border p-2"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by
                      an authenticated route that streams bytes off disk; Next's
                      optimiser cannot fetch it. */}
                  <img
                    src={`/api/stationery-images/${p.id}`}
                    alt=""
                    className="h-20 w-full rounded-control bg-surface-2 object-contain"
                  />
                  <span className="truncate text-xs text-ink-2" title={p.label}>
                    {p.label}
                  </span>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    onClick={() => deletePicture(p.id)}
                    disabled={pending}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <input
            ref={pictureInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) uploadPicture(f)
              e.target.value = ''
            }}
          />
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() => pictureInput.current?.click()}
              disabled={pending}
            >
              <Icons.Upload aria-hidden className="h-4 w-4" />
              Upload a picture
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted">
            Under 500&nbsp;KB each — an emailed document carries the picture itself, so a
            large one is attached to everything you send. Pictures print on pages, not on
            till slips: a thermal printer has no useful way to draw one. Deleting a picture
            leaves any design using it printing without it.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Your review link"
          description="Where a “scan to rate us” QR code sends people."
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Web address"
              hint="Your Google, Facebook or own review page. Must start with https."
              className="min-w-[22rem] flex-1"
            >
              <Input
                value={reviewUrl}
                placeholder="https://g.page/r/your-review-link"
                onChange={(e) => setReviewUrl(e.target.value)}
              />
            </Field>
            <Button variant="secondary" onClick={saveReviewUrl} disabled={pending}>
              Save
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted">
            Typed once here rather than into each design — a shop putting the same square on
            its invoice and its till slip changes the address in one place when it moves.
            Leave it empty and a QR pointing at it simply prints nothing.
          </p>
        </CardBody>
      </Card>

      {body.trim() === '' ? (
        <Card>
          <CardBody>
            <EmptyState
              icon={<Icons.FileText aria-hidden className="h-6 w-6" />}
              title="No design open"
              hint={
                forDoc.length > 0
                  ? 'Open one of your designs above, or start a new one from the standard layout.'
                  : 'Start a design and you will get the standard layout to change, so nothing looks wrong while you work.'
              }
              action={
                <Button variant="primary" onClick={() => startFromDefault(doc?.defaultSpec ? 'blocks' : 'html')}>
                  Start a design
                </Button>
              }
            />
          </CardBody>
        </Card>
      ) : (
        /*
         * Three editors, three shapes, one row.
         *
         * The VISUAL designer carries its own palette and its own page, so it
         * takes the whole width.
         *
         * The MARKUP editor is a text pane beside a preview: the preview is the
         * subject and the pane serves it, so the preview gets the room.
         *
         * The SLIP editor is neither. Its preview is 80mm of paper — a few
         * hundred pixels — and its controls are a list of seventeen blocks that
         * runs past the fold. Giving the preview the wide column left a slip
         * floating in a metre of empty space while the controls were squeezed
         * three-to-a-row in a narrow rail. So it is reversed: the editor takes
         * the width it needs and the slip sits beside it, sticky, at the size it
         * will actually print.
         */
        <div
          className={`grid gap-5 ${
            /*
             * The VISUAL and SLIP designers each carry their own inspector AND
             * their own preview, because what is being arranged and what it will
             * look like are the same picture. They take the whole row.
             *
             * The MARKUP editor is a text pane beside a preview — markup is not
             * a picture of anything — so it keeps the split.
             */
            format === 'blocks' || doc?.medium === 'slip'
              ? ''
              : 'xl:grid-cols-[minmax(0,1fr)_26rem]'
          }`}
        >
          {/* The VISUAL designer owns the whole left column: it carries its own
              palette and its own preview, because what is being arranged and
              what it will look like are the same picture. The markup editor
              splits them, because markup is not a picture of anything. */}
          {doc?.medium === 'slip' && format === 'slip' ? (
            <SlipDesigner
              spec={slipSpec ?? EMPTY_SLIP}
              onChange={(next) => {
                setBody(serialiseSlip(next))
                setDirty(true)
              }}
            />
          ) : format === 'blocks' ? (
            <VisualDesigner
              pictures={pictures}
              docType={docType}
              spec={blockSpec ?? { version: 1, blocks: [] }}
              tokens={doc?.tokens.map((t) => ({ key: t.key, label: t.label, section: t.section })) ?? []}
              onChange={(next) => {
                setBody(serialiseSpec(next))
                setDirty(true)
              }}
            />
          ) : (
          <Card>
            <CardHeader
              title="What the paper will look like"
              description={previewLabel || 'Rendered with your own data.'}
              action={previewing ? <Badge tone="brand">Rendering…</Badge> : undefined}
            />
            <CardBody>
              {blocking.length > 0 && (
                <Callout tone="danger" className="mb-4">
                  <p className="font-medium">This design cannot be saved yet.</p>
                  <ul className="mt-1 list-disc pl-5">
                    {blocking.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Callout>
              )}
              {warnings.length > blocking.length && (
                <Callout tone="warning" className="mb-4">
                  <ul className="list-disc pl-5">
                    {warnings
                      .filter((w) => !blocking.includes(w))
                      .map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                  </ul>
                </Callout>
              )}
              <div className="overflow-x-auto rounded-card border border-border bg-surface">
                {/* Server-rendered from the sanitised template, with every value
                    escaped by the renderer. See lib/stationery/sanitise.ts. */}
                <div dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            </CardBody>
          </Card>
          )}

          {/* The tools. Sticky on a wide screen: a purchase order runs longer
              than the viewport, and scrolling to check the bottom of the paper
              should not take the markup pane away with it. */}
          <div className="flex flex-col gap-5 xl:sticky xl:top-4 xl:self-start">
            <Card>
              <CardHeader title={editing ? 'Editing' : 'New design'} />
              <CardBody className="flex flex-col gap-4">
                <Field label="Name" hint="Only you see this — it names the design, not the document.">
                  <Input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setDirty(true)
                    }}
                    placeholder="Our letterhead"
                  />
                </Field>

                {/* A slip has no markup to edit — see lib/stationery/slip.ts
                    for why its design is a block list instead. A `blocks`
                    document has no markup pane here either: it is edited on the
                    canvas above, which needs the width. */}
                {format === 'blocks' ? (
                  <p className="text-sm text-muted">
                    Arrange this document by dragging the blocks on the page.
                  </p>
                ) : doc?.medium === 'slip' ? (
                  <p className="text-sm text-muted">
                    Arrange this slip by clicking and dragging its lines above.
                  </p>
                ) : (
                  <Field
                    label="Layout"
                    hint="HTML and CSS. Put a value on the page by writing its token in braces."
                  >
                    <CodeArea
                      rows={22}
                      value={body}
                      onChange={(e) => {
                        setBody(e.target.value)
                        setDirty(true)
                      }}
                    />
                  </Field>
                )}

                {dirty && (
                  <p className="text-xs text-warning-ink">
                    Unsaved changes. Nothing on paper has changed yet.
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    onClick={() => save(false)}
                    disabled={pending || blocking.length > 0 || !name.trim()}
                  >
                    Save
                  </Button>
                  {editing && (
                    <Button
                      variant="secondary"
                      onClick={() => save(true)}
                      disabled={pending || blocking.length > 0 || !name.trim()}
                    >
                      Save as draft
                    </Button>
                  )}
                  {editing && !editing.isActive && (
                    <Button variant="ghost" onClick={() => activate(editing.id)} disabled={pending || dirty}>
                      Use this when printing
                    </Button>
                  )}
                  {/* The escape hatch out of the visual editor, for a change
                      the blocks cannot express. One-way — see the dialog. */}
                  {format === 'blocks' && (
                    <Button
                      variant="ghost"
                      onClick={() => setConvertOpen(true)}
                      disabled={pending || !body.trim()}
                    >
                      Edit as HTML
                    </Button>
                  )}
                </div>
              </CardBody>
            </Card>

            {/* Tokens are a markup idea. A slip is composed of blocks that
                carry their own content, so there is nothing to list — and an
                empty "what you can put on the page" card reads as a feature
                that is broken rather than one that does not apply. */}
            {/* Not for the visual editor either: a token list is a reference
                for someone TYPING one. On the canvas, fields are picked from
                the block being edited, so a column of forty token names is a
                second way to do something that already has a first. */}
            {doc && doc.medium !== 'slip' && format !== 'blocks' && (
              <Card>
                <CardHeader
                  title="What you can put on the page"
                  description="Click to copy. Only fields you are allowed to see are listed."
                />
                {/* Scrolls inside itself. Forty-odd tokens is a legitimate list
                    for a document this size, but letting it set the page height
                    pushes the editor and the Save button off the bottom — which
                    is the one thing on this screen that must always be reachable. */}
                <CardBody className="max-h-[28rem] overflow-y-auto">
                  <TokenList doc={doc} onCopy={(k) => navigator.clipboard?.writeText(k)} />
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Said before it happens, because it cannot be undone: recovering blocks
          from markup would need the parser this design exists to avoid. */}
      <CopyDesignModal
        open={copying !== null}
        sourceName={copying?.name ?? ''}
        sourceDocType={copying?.docType ?? ''}
        sourceFormat={copying?.format ?? 'blocks'}
        docs={docs}
        busy={pending}
        onClose={() => setCopying(null)}
        onCopy={copy}
      />

      <ConfirmModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        onConfirm={convertToMarkup}
        busy={pending}
        tone="primary"
        title="Edit this design as HTML?"
        confirmLabel="Convert to HTML"
        message={
          <>
            <p>
              You will get the same document as markup, and full control over it. The
              drag-and-drop editor cannot open it afterwards — there is no reliable way to
              turn markup back into blocks.
            </p>
            <p className="mt-2 text-muted">
              Your block version stays in the list, so you can go back to it by making it the
              one that prints.
            </p>
          </>
        }
      />
    </div>
  )
}

/**
 * The token reference.
 *
 * Grouped by where a token is legal, because "inside the line loop" versus
 * "anywhere" is the one distinction that produces a broken template, and a flat
 * alphabetical list hides it.
 */
function TokenList({ doc, onCopy }: { doc: DocInfo; onCopy: (key: string) => void }) {
  const groups = [
    { key: null as string | null, label: 'Anywhere on the document' },
    ...doc.sections.map((s) => ({ key: s.key as string | null, label: `Inside {#each ${s.key}}` })),
  ]

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => {
        const items = doc.tokens.filter((t) => t.section === g.key)
        if (items.length === 0) return null
        return (
          <div key={g.label}>
            <p className="mb-1.5 text-xs font-medium tracking-wide text-muted">
              {g.label.toUpperCase()}
            </p>
            <ul className="flex flex-col gap-0.5">
              {items.map((t) => (
                <li
                  key={t.key}
                  title={t.hint || t.label}
                  className="flex items-center justify-between gap-2 rounded-control px-2 py-1 hover:bg-surface-2"
                >
                  <code className="min-w-0 truncate font-mono text-xs text-ink-2">
                    {`{${t.key}}`}
                  </code>
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xs text-muted">{t.label}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      aria-label={`Copy ${t.key}`}
                      onClick={() => onCopy(`{${t.key}}`)}
                    >
                      <Icons.Copy aria-hidden className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
