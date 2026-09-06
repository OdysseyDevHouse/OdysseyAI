'use client'

import { useTransition } from 'react'
import { Button, Icons } from '@/components/ui'

/**
 * The escape hatch from a layout guess.
 *
 * `isPhoneLayout()` decides the shell from client hints and a user-agent
 * string, which is right for nearly everyone and wrong for the folding phone,
 * the spoofed UA, and the person who would simply rather have the real tables.
 * This is how they say so.
 *
 * ── THE ACTION ARRIVES AS A PROP ────────────────────────────────────────────
 *
 * Not imported. A component that imports a server action drags `next/headers`
 * and the whole auth chain behind it, and can then never be rendered anywhere
 * that has no request — which is exactly what the Style Guide is. Taking the
 * call as a prop keeps the switch previewable beside the rest of the kit,
 * where a touch target this size actually gets looked at.
 *
 * ── WHY IT NAMES THE DESTINATION, NOT THE STATE ─────────────────────────────
 *
 * The label says where the tap GOES ("Desktop site"), not where you are. A
 * switch that reads "Phone layout" while showing the phone layout is a switch
 * half the people who tap it expected to do nothing.
 */
export function LayoutPreferenceSwitch({
  current,
  onChoose,
}: {
  current: 'phone' | 'desktop'
  /** `setLayoutPreference` from `(app)/layoutActions` — passed, not imported. */
  onChoose: (pref: 'phone' | 'desktop') => Promise<void>
}) {
  const [pending, startTransition] = useTransition()
  const target = current === 'phone' ? 'desktop' : 'phone'

  return (
    <Button
      variant="bare"
      size="touch"
      className="w-full justify-start gap-2"
      disabled={pending}
      onClick={() => startTransition(() => void onChoose(target))}
    >
      {target === 'desktop' ? <Icons.Terminal size={16} /> : <Icons.Smartphone size={16} />}
      <span>{target === 'desktop' ? 'Desktop site' : 'Phone layout'}</span>
    </Button>
  )
}
