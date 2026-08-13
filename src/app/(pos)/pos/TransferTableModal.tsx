'use client'

import { Button, EmptyState, Icons, Modal } from '@/components/ui'
import type { PosTable } from '@/lib/site/posTables'

/**
 * Where is the party moving to?
 *
 * Only FREE, active tables are offered. Merging onto an occupied table is not a
 * transfer — it is two parties' food on one bill with no way to tell them apart
 * afterwards — so the occupied tables are simply not on this screen, the same
 * way the split screen refuses them. The server re-checks under lock; this list
 * is a courtesy, not the guard.
 */
export default function TransferTableModal({
  open,
  fromTable,
  tables,
  busy,
  onPick,
  onClose,
}: {
  open: boolean
  fromTable: PosTable | null
  tables: readonly PosTable[]
  busy: boolean
  onPick: (toTableId: number) => void
  onClose: () => void
}) {
  const free = tables.filter(
    (t) => t.state === 'free' && t.id !== fromTable?.id,
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={fromTable ? `Move ${fromTable.code} to…` : 'Move table'}
      footer={
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      }
    >
      {free.length === 0 ? (
        <EmptyState
          icon={<Icons.LayoutGrid size={22} />}
          title="No free table to move to"
          hint="Every table has a bill. Settle or split one first."
        />
      ) : (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {free.map((t) => (
            <Button
              key={t.id}
              variant="secondary"
              size="touch"
              disabled={busy}
              onClick={() => onPick(t.id)}
            >
              {t.code}
            </Button>
          ))}
        </div>
      )}
    </Modal>
  )
}
