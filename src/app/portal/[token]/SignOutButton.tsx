'use client'

import { useTransition } from 'react'
import { Button, Icons } from '@/components/ui'
import { signOutAction } from './actions'

export default function SignOutButton({ token }: { token: string }) {
  const [pending, start] = useTransition()
  return (
    /* Secondary rather than ghost: it now sits in the letterhead row against
       open canvas rather than inside a bordered strip, and a ghost button with
       nothing around it reads as a stray line of text. */
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() => start(async () => void (await signOutAction(token)))}
    >
      <Icons.LogOut size={14} />
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
