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
  uploadLogoAction,
  clearLogoAction,
} from './actions'
import SlipBlockEditor from './SlipBlockEditor'
import { parseSlip, serialiseSlip } from '@/lib/stationery/slip'

type TokenInfo = { key: string; label: string; hint: string; section: string | null }
type DocInfo = {
  key: string
  label: string
  medium: 'a4' | 'slip'
  defaultBody: string
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
  docs,
  templates: initialTemplates,
}: {
  siteName: string
  /** The stored disk name, or '' — used only to know whether one exists. */
  logoFile: string
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
    if (!body.trim()) {
      setHtml('')
      setWarnings([])
      return
    }
    const t = setTimeout(() => runPreview(body), 400)
    return () => clearTimeout(t)
  }, [body, runPreview])

  function openTemplate(t: TemplateInfo) {
    setEditingId(t.id)
    setName(t.name)
    setBody(t.draftBody ?? t.body)
    setDirty(false)
  }

  function startFromDefault() {
    if (!doc) return
    setEditingId(null)
    setName(`${doc.label} — ${siteName}`)
    setBody(doc.defaultBody)
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
          { id, docType, name, body, draftBody: asDraft ? body : null, isActive: false },
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

  /* The stored name doubles as a cache-buster: the URL is constant per site, so
     without it a replaced logo would keep showing the old picture. */
  const [logo, setLogo] = useState(logoFile)
  const fileInput = useRef<HTMLInputElement>(null)

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
              <Button variant="secondary" onClick={startFromDefault} disabled={pending}>
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

          {/* Said plainly, on the screen, rather than discovered by a customer
              who redesigns their invoice and then emails one. An emailed
              invoice renders through lib/invoices/pdf.ts, which is drawn by
              hand and reads no template. */}
          {docType === 'invoice' && (
            <Callout tone="warning" className="mt-4">
              This design is used when an invoice is <strong>printed</strong>. Invoices{' '}
              <strong>emailed</strong> to a customer, and statements, still use the standard
              layout — they are built a different way and cannot follow a design yet.
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
            PNG, JPEG, GIF or WebP. It is printed at about 56px tall, so a wide image reads
            better than a tall one.
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
                <Button variant="primary" onClick={startFromDefault}>
                  Start a design
                </Button>
              }
            />
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
          {/* The paper. Deliberately first and widest — it is the subject. */}
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
                    for why its design is a block list instead. */}
                {doc?.medium === 'slip' ? (
                  <SlipBlockEditor
                    spec={slipSpec ?? { version: 1, blocks: [] }}
                    onChange={(next) => {
                      setBody(serialiseSlip(next))
                      setDirty(true)
                    }}
                  />
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
                </div>
              </CardBody>
            </Card>

            {/* Tokens are a markup idea. A slip is composed of blocks that
                carry their own content, so there is nothing to list — and an
                empty "what you can put on the page" card reads as a feature
                that is broken rather than one that does not apply. */}
            {doc && doc.medium !== 'slip' && (
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
