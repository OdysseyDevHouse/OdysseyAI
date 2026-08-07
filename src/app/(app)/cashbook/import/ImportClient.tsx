'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Callout,
  Field,
  Select,
  Checkbox,
  Icons,
  FileInput,
  MiniStat,
  Skeleton,
  TableSkeleton,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { parseStatementAction, importStatementAction } from '../actions'

type Account = {
  id: number
  code: string
  name: string
  lastReconciledDate: string | null
}

type Parsed = Awaited<ReturnType<typeof parseStatementAction>>

/**
 * Parse, review, then import.
 *
 * The review step exists because of one specific, expensive mistake: a file
 * where 03/04 means 3 April is read as 4 March, silently, and every row lands
 * in the wrong month. Showing the detected format and the first rows makes that
 * visible in the two seconds before it becomes a problem.
 */
export function ImportClient({
  accounts,
  preselectedId,
}: {
  accounts: Account[]
  preselectedId?: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [accountId, setAccountId] = useState<number>(preselectedId ?? accounts[0]?.id ?? 0)
  const [filename, setFilename] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [autoMatch, setAutoMatch] = useState(true)
  const [reading, setReading] = useState(false)

  const account = accounts.find((a) => a.id === accountId)

  async function handleFile(file: File | null) {
    if (!file) {
      setParsed(null)
      setText(null)
      setFilename(null)
      return
    }
    setReading(true)
    try {
      const content = await file.text()
      setText(content)
      setFilename(file.name)
      const result = await parseStatementAction(content)
      setParsed(result)
      if (result.rows.length === 0) {
        toast.error('No transactions could be read from that file.')
      }
    } catch {
      toast.error('That file could not be read.')
    } finally {
      setReading(false)
    }
  }

  function doImport() {
    if (!text || !accountId) return
    startTransition(async () => {
      const result = await importStatementAction({
        bankAccountId: accountId,
        text,
        filename: filename ?? undefined,
        autoMatch,
      })
      if (result.ok) {
        toast.success(result.message)
        router.push(`/cashbook/${accountId}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  // A statement dated before the last sign-off is almost always the wrong file,
  // or one that will do nothing. Worth saying before the click, not after.
  const staleWarning =
    parsed?.periodTo && account?.lastReconciledDate && parsed.periodTo <= account.lastReconciledDate

  return (
    <>
      <Card>
        <CardHeader title="Choose the file" description="A CSV or OFX export from your bank." />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Import into">
              <Select
                value={String(accountId)}
                onChange={(e) => setAccountId(Number(e.target.value))}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.code})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Statement file" hint="Nothing is imported until you confirm below.">
              <FileInput
                accept=".csv,.ofx,.qfx,.txt"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      {/* The skeleton wears the review card's shape — summary strip, then rows —
          so the page does not collapse and then shove itself back down. */}
      {reading && (
        <Card aria-busy="true">
          <CardHeader title="Reading the file…" description="Detecting the format and first rows." />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          </CardBody>
          <TableSkeleton columns={4} rows={6} />
        </Card>
      )}

      {parsed && !reading && (
        <Card>
          <CardHeader
            title="What was understood"
            description="Check this before importing — especially the date format."
          />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MiniStat label="Format" value={parsed.detected.format.toUpperCase()} />
              <MiniStat
                label="Date format"
                value={parsed.detected.dateFormat ?? 'Not detected'}
                tone={parsed.detected.dateFormat ? 'default' : 'warning'}
              />
              <MiniStat
                label="Transactions"
                value={String(parsed.rows.length)}
                tone={parsed.rows.length === 0 ? 'danger' : 'default'}
              />
              <MiniStat
                label="Period"
                value={
                  parsed.periodFrom && parsed.periodTo
                    ? `${parsed.periodFrom} → ${parsed.periodTo}`
                    : 'Unknown'
                }
              />
            </div>

            {staleWarning && (
              <Callout tone="warning" title="This period has already been reconciled" className="mt-4">
                This statement ends on or before {account?.lastReconciledDate}. Most of these
                lines are probably already imported — that is safe, they will be skipped, but
                check this is the file you meant.
              </Callout>
            )}

            {parsed.problems.length > 0 && (
              <Callout
                tone="danger"
                title={`${parsed.problems.length} row${parsed.problems.length === 1 ? '' : 's'} could not be read and will be skipped`}
                className="mt-4"
              >
                <ul className="mt-1 space-y-0.5">
                  {parsed.problems.slice(0, 5).map((p) => (
                    <li key={p.lineNumber} className="text-xs">
                      Line {p.lineNumber}: {p.reason}
                    </li>
                  ))}
                </ul>
              </Callout>
            )}
          </CardBody>

          {parsed.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Description</th>
                    <th className={TABLE_TH}>Reference</th>
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 12).map((r, i) => (
                    <tr key={`${r.date}-${i}`} className={TABLE_ROW}>
                      <td className={TABLE_TD}>{r.date}</td>
                      <td className={TABLE_TD}>{r.description ?? '—'}</td>
                      <td className={TABLE_TD}>
                        <span className="text-muted">{r.reference ?? '—'}</span>
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 12 && (
                <p className="px-4 py-2 text-xs text-muted">
                  …and {parsed.rows.length - 12} more.
                </p>
              )}
            </div>
          )}

          <CardFooter>
            <div className="flex w-full items-center justify-between">
              <Checkbox
                checked={autoMatch}
                onChange={(e) => setAutoMatch(e.target.checked)}
                label="Match what is obvious after importing"
              />
              <Button disabled={pending || parsed.rows.length === 0} onClick={doImport}>
                <Icons.Upload size={15} />
                Import {parsed.rows.length} transaction
                {parsed.rows.length === 1 ? '' : 's'}
              </Button>
            </div>
          </CardFooter>
        </Card>
      )}
    </>
  )
}
