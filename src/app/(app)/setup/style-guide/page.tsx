import { notFound } from 'next/navigation'
import { isDevBuild, requireCapability } from '@/lib/auth'
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
  /* Developer machines only. The guide is the design system's own reference —
     it means nothing to a shop, and it is not something to leave on a deployed
     build. notFound() rather than a redirect: in production this route simply
     does not exist, which is the honest answer and the one that says nothing
     about what is behind it. See `isDevBuild`. */
  if (!isDevBuild()) notFound()
  await requireCapability('setup.view')
  return <StyleGuide />
}
