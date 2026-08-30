import 'server-only'
import { publicSiteName } from '@/lib/sites'
import { logoFileName } from '@/lib/site/documentLogo'

/**
 * The two things every portal page needs for its letterhead.
 *
 * One helper because five pages ask the identical pair of questions, and both
 * are TOLERANT — a shop with no logo, or a control-database blip, must still
 * get its statement rather than an error page. Written once so no page can
 * forget the `.catch`.
 */
export type Letterhead = { name: string | null; hasLogo: boolean }

export async function letterheadFor(siteId: number): Promise<Letterhead> {
  const [name, logo] = await Promise.all([
    publicSiteName(siteId).catch(() => null),
    // The setting holds the stored FILENAME; an empty string means no logo has
    // ever been uploaded. Only its presence matters here — the bytes are served
    // by the logo route, which re-reads and re-sniffs them.
    logoFileName(siteId).catch(() => ''),
  ])
  return { name: name ?? null, hasLogo: Boolean(logo) }
}
