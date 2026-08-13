import type { LabelSource } from '@/lib/site/labels'

/**
 * The label routes' querystring, decoded — shared by the A4 sheet and the
 * talker so the two doors read one contract:
 *   ?source=grv&id=123 · ?source=schedule&id=45 · ?ids=1,2,3&qty2=3
 */
export function parseLabelSource(params: {
  source?: string
  id?: string
  ids?: string
  [key: string]: string | undefined
}): LabelSource | null {
  if (params.source === 'grv' && Number(params.id) > 0) {
    return { kind: 'grv', documentId: Number(params.id) }
  }
  if (params.source === 'schedule' && Number(params.id) > 0) {
    return { kind: 'schedule', scheduleId: Number(params.id) }
  }
  if (params.ids) {
    const ids = params.ids
      .split(',')
      .map((raw) => Number(raw))
      .filter((n) => Number.isFinite(n) && n > 0)
    if (ids.length === 0) return null
    const qty: Record<number, number> = {}
    for (const id of ids) {
      const q = Number(params[`qty${id}`])
      if (Number.isFinite(q) && q > 1) qty[id] = Math.trunc(q)
    }
    return { kind: 'products', ids, qty }
  }
  return null
}
