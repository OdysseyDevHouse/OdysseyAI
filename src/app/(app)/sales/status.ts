import type { SalesDocStatus } from '@/lib/site/salesDocuments'
import type { BadgeTone } from '@/components/ui'

/*
 * One spelling of each sales-document status, shared by the list and the
 * detail screen so neither ever prints the raw enum.
 *
 * There is no "void" status, deliberately.
 *
 * On a till, staff already know "void" as removing a line or clearing the
 * basket — things that happen BEFORE a sale posts, where nothing is recorded
 * and nothing remains. A posted sale being undone is the opposite: it keeps
 * its number, its lines and a stated reason forever.
 *
 * Same word, two meanings, and the one people learn first is the wrong one
 * here. So a posted sale is CANCELLED, and "void" is left to mean what the
 * counter already thinks it means. Migration 022 merged the stored values.
 */
export const STATUS_LABELS: Record<SalesDocStatus, string> = {
  draft: 'Draft',
  saved: 'Saved',
  issued: 'Issued',
  finalised: 'Finalised',
  cancelled: 'Cancelled',
}

export const STATUS_TONE: Record<SalesDocStatus, BadgeTone> = {
  draft: 'neutral',
  saved: 'warning',
  issued: 'neutral',
  finalised: 'success',
  cancelled: 'danger',
}
