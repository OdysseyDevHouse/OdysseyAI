import type { BadgeTone } from '@/components/ui'

/**
 * One spelling of what a purchase document's status looks like — shared by the
 * list and the document screen so the two can never disagree about what
 * "finalised" reads as or which colour it wears.
 */
export const PURCHASE_STATUS_TONE: Record<string, BadgeTone> = {
  draft: 'neutral',
  issued: 'brand',
  finalised: 'success',
  void: 'danger',
  cancelled: 'neutral',
}

export const PURCHASE_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  finalised: 'Finalised',
  void: 'Void',
  cancelled: 'Cancelled',
}

export function purchaseStatusTone(status: string): BadgeTone {
  return PURCHASE_STATUS_TONE[status] ?? 'neutral'
}

/**
 * The label for a document, folding fulfilment in: an issued order that has
 * been partly received reads "Part received" — that is its working state.
 */
export function purchaseStatusLabel(status: string, fulfilmentStatus?: string | null): string {
  if (status === 'issued' && fulfilmentStatus === 'part_received') return 'Part received'
  return PURCHASE_STATUS_LABEL[status] ?? sentenceCase(status)
}

function sentenceCase(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
