'use client'

import { useEffect, useState, type ComponentProps } from 'react'
import { Callout } from './Callout'

/**
 * TransientCallout — a Callout that takes itself away.
 *
 * A save confirmation has one job: tell the user the click landed. Once it has
 * done that it is just a green bar pushing the screen down, and it survives
 * every later interaction on the page because it is painted from a `?saved=1`
 * in the URL rather than from anything the user is still doing.
 *
 * Errors and warnings are the opposite: they carry something the user has to
 * ACT on, and they must stay until the condition that raised them is actually
 * fixed. So this is deliberately not a prop on Callout — reach for it only for
 * a good-news notice, and leave `<Callout tone="danger">` alone.
 *
 * Matches the toast timings in Toast.tsx, so the two ways a success reaches the
 * user behave the same.
 */
export function TransientCallout({
  ms = 5000,
  ...callout
}: ComponentProps<typeof Callout> & {
  /** How long it stays. Defaults to the five seconds a success gets. */
  ms?: number
}) {
  const [shown, setShown] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setShown(false), ms)
    return () => clearTimeout(timer)
  }, [ms])

  /* Unmounted rather than hidden: these sit in the normal flow above a form, so
     a still-mounted invisible banner would leave a gap where the message was. */
  if (!shown) return null
  return <Callout {...callout} />
}
