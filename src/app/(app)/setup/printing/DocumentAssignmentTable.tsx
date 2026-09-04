'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  DataTable,
  Drawer,
  Icons,
  SelectableCard,
  SettingGroup,
  Stepper,
  Tabs,
  TextLink,
  useToast,
  type Column,
} from '@/components/ui'
import {
  PAPER_LABELS,
  PRINT_DOC_GROUPS,
  PRINT_DOC_GROUP_LABELS,
  getPrintDoc,
  mediumFitsPaper,
  printDocsByGroup,
  type PrintDocDef,
  type PrintDocGroup,
} from '@/lib/printing/documents'
import type { PrintMode } from '@/lib/printing/resolve'
import type { Printer } from '@/lib/site/printers'
import type { DocumentAssignment } from '@/lib/site/documentPrinters'
import { clearDocumentPrinterAction, setDocumentPrinterAction } from './deviceActions'

/**
 * What comes out where, on one machine.
 *
 * ── ONE CARD, TABBED ──────────────────────────────────────────────────────
 *
 * Six separate cards read as six unrelated screens. It is one question —
 * "where does each document print on this machine" — so it is one card, and
 * the groups are tabs across the top of it. The count of not-yet-answered
 * documents rides on each tab, so a shop can see at a glance which section it
 * has not finished without opening all six.
 *
 * ── CLICKING A ROW OPENS A DRAWER ─────────────────────────────────────────
 *
 * Sixteen selects on one page is a wall of controls, and a per-row control
 * fights `onRowClick`. The drawer also has room to say WHY a printer is not
 * offered — "Plugged into TILL08, not this machine" — which a disabled option
 * in a dropdown never can.
 */

/** What the "Prints to" cell says, in the shop's own words. */
function destination(a: DocumentAssignment, doc: PrintDocDef): string {
  if (doc.routedPerProduct) return 'Routed per product'
  if (a.unset) return 'Not set'
  if (a.inheritedFrom) {
    return `Same as ${getPrintDoc(a.inheritedFrom)?.label ?? a.inheritedFrom}`
  }
  if (a.mode === 'pdf') return 'Save as PDF'
  if (a.mode === 'browser') return 'Browser print dialog'
  if (a.mode === 'off') return 'Never'
  return a.printerName ?? 'A printer that is no longer here'
}

function StatusBadge({ a, doc }: { a: DocumentAssignment; doc: PrintDocDef }) {
  if (doc.routedPerProduct) return <Badge tone="neutral">Per product</Badge>
  if (a.unreachable) return <Badge tone="danger">Not on this machine</Badge>
  if (a.unset) return <Badge tone="warning">Not set</Badge>
  if (a.mode === 'off') return <Badge tone="neutral">Off</Badge>
  if (a.mode === 'pdf') return <Badge tone="neutral">PDF</Badge>
  if (a.mode === 'browser') return <Badge tone="neutral">Dialog</Badge>
  return <Badge tone="success">Ready</Badge>
}

type Row = { doc: PrintDocDef; assignment: DocumentAssignment }

const UNSET: Omit<DocumentAssignment, 'docKey'> = {
  mode: 'browser',
  printerId: null,
  printerName: null,
  copies: 1,
  unset: true,
  unreachable: false,
  unreachableBecause: null,
  inheritedFrom: null,
}

export default function DocumentAssignmentTable({
  deviceId,
  deviceLabel,
  assignments,
  printers,
  modules,
}: {
  deviceId: string
  deviceLabel: string
  assignments: DocumentAssignment[]
  printers: Printer[]
  modules: string[]
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [openDoc, setOpenDoc] = useState<PrintDocDef | null>(null)

  const byKey = useMemo(() => new Map(assignments.map((a) => [a.docKey, a])), [assignments])

  /** Only the groups this shop actually has documents in. */
  const groups = useMemo(
    () =>
      PRINT_DOC_GROUPS.map((group) => ({
        group,
        docs: printDocsByGroup(group, modules as never),
      })).filter((g) => g.docs.length > 0),
    [modules],
  )

  const [tab, setTab] = useState<PrintDocGroup>(groups[0]?.group ?? 'counter')
  const shown = groups.find((g) => g.group === tab) ?? groups[0]

  const [mode, setMode] = useState<PrintMode>('printer')
  const [printerId, setPrinterId] = useState<number | null>(null)
  const [copies, setCopies] = useState(1)
  const current = openDoc ? byKey.get(openDoc.key) : undefined

  function open(doc: PrintDocDef) {
    const a = byKey.get(doc.key)
    setOpenDoc(doc)
    setMode(a && !a.unset ? a.mode : 'printer')
    setPrinterId(a?.printerId ?? null)
    setCopies(a?.copies ?? 1)
  }

  function save() {
    if (!openDoc) return
    startTransition(async () => {
      const result = await setDocumentPrinterAction(deviceId, openDoc.key, {
        mode,
        printerId: mode === 'printer' ? printerId : null,
        copies,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setOpenDoc(null)
    })
  }

  function clear() {
    if (!openDoc) return
    startTransition(async () => {
      const result = await clearDocumentPrinterAction(deviceId, openDoc.key)
      if (result.ok) {
        toast.success(result.message)
        setOpenDoc(null)
      } else toast.error(result.error)
    })
  }

  const columns: readonly Column<Row>[] = [
    {
      key: 'document',
      header: 'Document',
      cell: (r) => (
        <div>
          <div className="text-ink">{r.doc.label}</div>
          {r.doc.hint && <div className="text-xs text-muted">{r.doc.hint}</div>}
        </div>
      ),
      sortValue: (r) => r.doc.label,
    },
    {
      key: 'paper',
      header: 'Paper',
      width: 'w-28',
      cell: (r) => (
        <Badge tone="neutral">
          {r.doc.medium === 'slip' ? 'Slip' : r.doc.medium === 'label' ? 'Labels' : 'A4'}
        </Badge>
      ),
      sortValue: (r) => r.doc.medium,
    },
    {
      key: 'destination',
      header: 'Prints to',
      cell: (r) =>
        r.doc.routedPerProduct ? (
          <span className="text-muted">
            Routed per product · <TextLink href="/products">set on each product</TextLink>
          </span>
        ) : (
          <div>
            <span className={r.assignment.unset ? 'text-muted' : 'text-ink-2'}>
              {destination(r.assignment, r.doc)}
            </span>
            {/* WHY, not just that. "Plugged into TILL08, not this machine" is a
                sentence somebody fixes in one click. */}
            {r.assignment.unreachableBecause && (
              <div className="text-xs text-danger">{r.assignment.unreachableBecause}</div>
            )}
          </div>
        ),
      sortValue: (r) => destination(r.assignment, r.doc),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-44',
      cell: (r) => <StatusBadge a={r.assignment} doc={r.doc} />,
      sortValue: (r) => (r.assignment.unreachable ? 0 : r.assignment.unset ? 1 : 2),
    },
  ]

  const rowsFor = (docs: PrintDocDef[]): Row[] =>
    docs.map((doc) => ({
      doc,
      assignment: byKey.get(doc.key) ?? { docKey: doc.key, ...UNSET },
    }))

  return (
    <>
      <SettingGroup
        title="What prints where"
        description={`On ${deviceLabel}. Click a document to choose its printer.`}
      >
        <div className="px-4 pt-3">
          <Tabs
            aria-label="Document groups"
            items={groups.map(({ group, docs }) => {
              /* The unanswered count, on the tab. It is what turns six sections
                 into one glance — a shop can see it has not finished Purchasing
                 without opening Purchasing. */
              const notSet = docs.filter(
                (d) => !d.routedPerProduct && (byKey.get(d.key)?.unset ?? true),
              ).length
              return {
                value: group,
                label: PRINT_DOC_GROUP_LABELS[group],
                count: notSet > 0 ? notSet : undefined,
              }
            })}
            value={tab}
            onChange={setTab}
          />
        </div>

        {shown && (
          <DataTable
            columns={columns}
            rows={rowsFor(shown.docs)}
            getRowKey={(r) => r.doc.key}
            onRowClick={(r) => (r.doc.routedPerProduct ? undefined : open(r.doc))}
          />
        )}
      </SettingGroup>

      <Drawer
        open={openDoc !== null}
        onClose={() => setOpenDoc(null)}
        title={openDoc?.label ?? ''}
        description={`Where ${deviceLabel} prints it.`}
        footer={
          <>
            <Button variant="ghost" disabled={pending || current?.unset !== false} onClick={clear}>
              Clear
            </Button>
            <Button variant="secondary" onClick={() => setOpenDoc(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending} onClick={save}>
              <Icons.Save size={15} />
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        {openDoc && (
          <div className="flex flex-col gap-3">
            {printers.map((printer) => {
              const fits = mediumFitsPaper(openDoc.medium, printer.paper)
              const reachable =
                !printer.unconfigured &&
                (printer.connection === 'network' || printer.deviceId === deviceId)

              const why = !fits
                ? `Loaded with ${PAPER_LABELS[printer.paper].toLowerCase()} — this document needs ${
                    openDoc.medium === 'a4'
                      ? 'A4'
                      : openDoc.medium === 'label'
                        ? 'label stock'
                        : 'a slip roll'
                  }.`
                : printer.unconfigured
                  ? 'Not finished — open it under Printers and pick a printer.'
                  : !reachable
                    ? `Plugged into ${printer.deviceLabel ?? 'another machine'}, not ${deviceLabel}.`
                    : printer.connection === 'network'
                      ? `On the network at ${printer.target}`
                      : `${printer.target} on this machine`

              return (
                <SelectableCard
                  key={printer.id}
                  name="destination"
                  value={String(printer.id)}
                  title={printer.name}
                  description={why}
                  badge={<Badge tone="neutral">{PAPER_LABELS[printer.paper]}</Badge>}
                  checked={mode === 'printer' && printerId === printer.id}
                  disabled={!fits || !reachable}
                  onChange={() => {
                    setMode('printer')
                    setPrinterId(printer.id)
                  }}
                />
              )
            })}

            <SelectableCard
              name="destination"
              value="pdf"
              title="Save as a PDF"
              description="Makes the document and opens it in the PDF viewer."
              checked={mode === 'pdf'}
              onChange={() => setMode('pdf')}
            />
            <SelectableCard
              name="destination"
              value="browser"
              title="Use the browser’s print dialog"
              description="Ask every time, and pick a printer from the operating system."
              checked={mode === 'browser'}
              onChange={() => setMode('browser')}
            />
            <SelectableCard
              name="destination"
              value="off"
              title="Never print this here"
              description={`Nothing on ${deviceLabel} will produce it.`}
              checked={mode === 'off'}
              onChange={() => setMode('off')}
            />

            {mode === 'printer' && (
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-sm text-ink-2">Copies</span>
                <Stepper value={copies} onChange={setCopies} min={1} max={10} label="Copies" />
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  )
}
