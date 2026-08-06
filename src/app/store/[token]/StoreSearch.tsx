'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button, Icons, Input } from '@/components/ui'

/**
 * Catalogue search.
 *
 * A plain form that navigates, rather than a live filter: the results come
 * from the server (the browser never holds the whole catalogue), and a shopper
 * on a phone in a queue should be able to type, submit, and have the back
 * button work afterwards.
 */
export default function StoreSearch({
  token,
  initial,
  department,
}: {
  token: string
  initial: string
  department?: string
}) {
  const router = useRouter()
  const [term, setTerm] = useState(initial)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const params = new URLSearchParams()
    if (term.trim()) params.set('q', term.trim())
    // Keep the department, so searching inside one stays inside it.
    if (department) params.set('department', department)
    const query = params.toString()
    router.push(`/store/${token}${query ? `?${query}` : ''}`)
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search for something"
        icon={<Icons.Search size={16} />}
        aria-label="Search the shop"
      />
      <Button variant="secondary" type="submit">
        Search
      </Button>
      {initial && (
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setTerm('')
            router.push(`/store/${token}${department ? `?department=${department}` : ''}`)
          }}
        >
          Clear
        </Button>
      )}
    </form>
  )
}
