import { requireCapability } from '@/lib/auth'
import StyleGuide from './StyleGuide'

/**
 * A server wrapper purely so the style guide can be permission-checked.
 *
 * The guide itself is `'use client'` — every demo on it is stateful — and a
 * client component cannot await a session. Before this file existed it was the
 * one screen in the app with no auth call of its own, relying entirely on the
 * layout's session check, which proves you are signed in and nothing more.
 */

export const dynamic = 'force-dynamic'

export default async function StyleGuidePage() {
  await requireCapability('setup.view')
  return <StyleGuide />
}
