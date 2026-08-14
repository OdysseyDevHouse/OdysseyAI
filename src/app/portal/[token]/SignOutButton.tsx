'use client'

import { useTransition } from 'react'
import { Button } from '@/components/ui'
import { signOutAction } from './actions'

export default function SignOutButton({ token }: { token: string }) {
  const [pending, start] = useTransition()
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => start(async () => void (await signOutAction(token)))}
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
