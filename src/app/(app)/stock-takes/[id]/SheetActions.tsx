'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Field, Icons, Modal, Textarea, Callout, useToast } from '@/components/ui'
import type { StockTakeStatus } from '@/lib/site/stockTakes'
import {
  freezeStockTakeAction,
  postStockTakeAction,
  cancelStockTakeAction,
  deleteStockTakeAction,
  recountStockTakeAction,
} from '../actions'

/**
 * What can be done to a sheet, given where it is in its life.
 *
 * One primary action at a time, and it is always the obvious next step: freeze
 * a draft, post a count, and nothing at all once it is posted except the
 * reversal. Rendering every button always and disabling most of them would make
 * the screen ask the user to work out which one applies.
 */
export default function SheetActions({
  id,
  status,
  number,
  counted,
  lineCount,
  varianceCount,
}: {
  id: number
  status: StockTakeStatus
  number: string | null
  counted: number
  lineCount: number
  varianceCount: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [confirmPost, setConfirmPost] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [reason, setReason] = useState('')
  const [postError, setPostError] = useState<string | null>(null)

  function freeze() {
    start(async () => {
      const result = await freezeStockTakeAction(id)
      if (!('ok' in result) || !result.ok) {
        toast.error('error' in result ? result.error : 'The sheet could not be frozen.')
        return
      }
      toast.success('Frozen. Count against these figures.')
      router.refresh()
    })
  }

  function recount() {
    start(async () => {
      const result = await recountStockTakeAction(id)
      if (!('ok' in result) || !result.ok) {
        toast.error('error' in result ? result.error : 'The re-count sheet could not be built.')
        return
      }
      toast.success(`Re-count sheet ready — ${result.lineCount} line${result.lineCount === 1 ? '' : 's'} to check.`)
      router.push(`/stock-takes/${result.id}`)
    })
  }

  function post() {
    setPostError(null)
    start(async () => {
      const result = await postStockTakeAction(id)
      if (!('ok' in result) || !result.ok) {
        // Shown IN the modal rather than as a toast: the refusals here are
        // things the user must act on elsewhere first (a locked period, unposted
        // offline sales), and a toast that vanishes takes the instruction with it.
        setPostError('error' in result ? result.error : 'The sheet could not be posted.')
        return
      }
      toast.success(
        result.movements === 0
          ? 'Posted. Every line matched — nothing moved.'
          : `Posted as ${result.documentNumber}. ${result.movements} line${result.movements === 1 ? '' : 's'} adjusted.`,
      )
      setConfirmPost(false)
      router.refresh()
    })
  }

  /**
   * Discard or reverse, depending on what the sheet has already done.
   *
   * A draft is DELETED — it never moved stock and never took a number, so
   * keeping it as a cancelled row would leave the list full of sheets that
   * record nothing having happened. Once counting has started, or once it has
   * posted, the sheet is kept and cancelled instead: there is a count in it
   * worth explaining, and possibly movements to reverse.
   */
  function cancel() {
    start(async () => {
      const result =
        status === 'draft'
          ? await deleteStockTakeAction(id)
          : await cancelStockTakeAction(id, reason)

      if (!('ok' in result) || !result.ok) {
        toast.error('error' in result ? result.error : 'The sheet could not be discarded.')
        return
      }

      if (status === 'draft') {
        toast.success('Sheet discarded.')
        router.push('/stock-takes')
        return
      }

      toast.success(status === 'posted' ? 'Reversed — the stock went back.' : 'Sheet cancelled.')
      setConfirmCancel(false)
      router.refresh()
    })
  }

  const uncounted = lineCount - counted

  return (
    <>
      {status === 'draft' && (
        <>
          <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={pending}>
            Discard
          </Button>
          <Button variant="primary" onClick={freeze} disabled={pending}>
            <Icons.Lock size={15} />
            {pending ? 'Freezing…' : 'Freeze and start counting'}
          </Button>
        </>
      )}

      {status === 'counting' && (
        <>
          <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setConfirmPost(true)} disabled={pending || counted === 0}>
            <Icons.Check size={15} />
            Post the count
          </Button>
        </>
      )}

      {status === 'posted' && (
        <>
          <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={pending}>
            <Icons.Reverse size={15} />
            Reverse
          </Button>
          {/* The primary action on a posted sheet is checking the figures you
              did not believe — not undoing the count. Only offered when there
              is something to check. */}
          {varianceCount > 0 && (
            <Button variant="primary" onClick={recount} disabled={pending}>
              <Icons.ClipboardList size={15} />
              {pending ? 'Building…' : `Re-count ${varianceCount} line${varianceCount === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      )}

      <Modal
        open={confirmPost}
        onClose={() => setConfirmPost(false)}
        title="Post this count?"
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmPost(false)} disabled={pending}>
              Not yet
            </Button>
            <Button variant="primary" onClick={post} disabled={pending}>
              {pending ? 'Posting…' : 'Post the count'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {varianceCount === 0
              ? 'Every counted line matches what the books say, so this will write no movements at all.'
              : `${varianceCount} line${varianceCount === 1 ? '' : 's'} differ from the books and will be adjusted. Lines that matched write nothing.`}
          </p>

          {uncounted > 0 && (
            <Callout tone="warning" title={`${uncounted} line${uncounted === 1 ? '' : 's'} not counted`}>
              Uncounted lines are left alone — they are not treated as zero. You can post now and
              count the rest on another sheet.
            </Callout>
          )}

          <p className="text-sm text-muted">
            The difference is measured against the pile at this moment, not against what the sheet
            was built with — so anything sold while you counted is accounted for.
          </p>

          {postError && (
            <Callout tone="danger" title="Cannot post yet">
              {postError}
            </Callout>
          )}
        </div>
      </Modal>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title={status === 'posted' ? `Reverse ${number ?? 'this count'}?` : 'Discard this sheet?'}
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)} disabled={pending}>
              Keep it
            </Button>
            {/* A draft needs no reason — there is nothing to explain, because
                nothing happened. Anything further along does. */}
            <Button
              variant="danger"
              onClick={cancel}
              disabled={pending || (status !== 'draft' && !reason.trim())}
            >
              {pending ? 'Working…' : status === 'posted' ? 'Reverse the count' : 'Discard'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            {status === 'posted'
              ? 'Every adjustment this sheet wrote is reversed by an opposite movement. The originals stay — the stock genuinely moved, and erasing that would leave a pile whose history does not explain it.'
              : 'The sheet and its counts are deleted. No stock has moved, so nothing needs reversing.'}
          </p>
          {status !== 'draft' && (
            <Field label="Reason" hint="Stored on the sheet, so the reversal is explainable later.">
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={190}
                rows={2}
                placeholder={status === 'posted' ? 'Recount ordered' : 'Started by mistake'}
              />
            </Field>
          )}
        </div>
      </Modal>
    </>
  )
}
