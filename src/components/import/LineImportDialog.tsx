'use client'

import { useRef, useState } from 'react'
import {
  Button, Callout, DataTable, Field, FileInput, Icons, Modal, useToast, type Column,
} from '@/components/ui'
import { readLinesAction } from './lineImportActions'
import type { LineDraft, LineProblem } from '@/lib/import/documentLines'

/**
 * Bringing a file of lines into a document screen.
 *
 * Deliberately stops at handing the lines over. The screen that opened this
 * already knows how to cost a line, capture a serial and post the document; a
 * dialog that posted for it would be a second path to the same place, and the
 * two would drift.
 *
 * So this reads, resolves and reports — and what the user gets is their own
 * grid, filled in, ready to be checked and corrected before they press the
 * button they always press.
 */
export function LineImportDialog({
  open,
  onClose,
  onLines,
  noun = 'lines',
}: {
  open: boolean
  onClose: () => void
  /** Handed the resolved lines. The screen maps them into its own row shape. */
  onLines: (lines: LineDraft[]) => void
  noun?: string
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState<LineDraft[]>([])
  const [problems, setProblems] = useState<LineProblem[]>([])
  const [filename, setFilename] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function choose(file: File | null) {
    if (!file) return
    setBusy(true)
    try {
      const isWorkbook = /\.(xlsx|xls|ods)$/i.test(file.name)
      const result = await readLinesAction({
        filename: file.name,
        ...(isWorkbook
          ? { base64: toBase64(await file.arrayBuffer()) }
          : { text: await file.text() }),
      })

      if (!result.ok) {
        toast.error(result.error)
        // A file input keeps its selection, so re-choosing a corrected file of
        // the same name would fire no change event without this.
        if (fileRef.current) fileRef.current.value = ''
        return
      }

      setFilename(file.name)
      setLines(result.lines)
      setProblems(result.problems)
    } finally {
      setBusy(false)
    }
  }

  function add() {
    onLines(lines)
    toast.success(`${lines.length} ${lines.length === 1 ? 'line' : 'lines'} added`)
    reset()
    onClose()
  }

  function reset() {
    setLines([])
    setProblems([])
    setFilename('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const problemColumns: Column<LineProblem & { key: number }>[] = [
    { key: 'line', header: 'Row', numeric: true, cell: (r) => r.line, width: 'w-20' },
    { key: 'reference', header: 'Product', cell: (r) => r.reference },
    { key: 'reason', header: 'Why', cell: (r) => r.reason },
  ]

  return (
    <Modal
      open={open}
      onClose={() => { reset(); onClose() }}
      title={`Import ${noun}`}
      description="A .csv or .xlsx with a product code and a quantity. Nothing is posted — the lines land in the grid for you to check."
      size="lg"
      /* The problems table runs to fifty rows, and the whole point of the
         dialog is reading them before importing. */
      bodyGrows
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose() }}>Cancel</Button>
          <Button variant="primary" disabled={busy || lines.length === 0} onClick={add}>
            <Icons.Plus size={15} />
            Add {lines.length > 0 ? `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}` : noun}
          </Button>
        </>
      }
    >
      <Field
        label="File"
        hint={filename ? `${lines.length} matched in ${filename}` : 'Columns are matched by heading — Product Code, Quantity, Unit Cost, Location, Serial.'}
      >
        <FileInput
          ref={fileRef}
          accept=".csv,.xlsx,.xls,.tsv,.txt"
          disabled={busy}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
      </Field>

      {problems.length > 0 && (
        <div className="mt-4">
          <Callout
            tone="danger"
            title={`${problems.length} row${problems.length === 1 ? '' : 's'} will not be added`}
          >
            The rest are still fine to add. Fix these in the file and import again, or key them in by hand.
          </Callout>
          <div className="mt-3 overflow-hidden rounded-card border border-border">
            <DataTable
              columns={problemColumns}
              rows={problems.slice(0, 50).map((p, key) => ({ ...p, key }))}
              getRowKey={(r) => r.key}
            />
          </div>
          {problems.length > 50 && (
            <p className="mt-2 text-sm text-muted">
              Showing the first 50 of {problems.length}.
            </p>
          )}
        </div>
      )}

      {lines.length > 0 && problems.length === 0 && (
        <Callout tone="success" title={`${lines.length} lines matched`} className="mt-4">
          Every row found its product. They will be added to the grid, where you can still change anything
          before posting.
        </Callout>
      )}
    </Modal>
  )
}

/** Bytes to base64 without blowing the stack on a large workbook. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
