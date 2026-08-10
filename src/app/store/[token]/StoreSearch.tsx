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

  /*
   * Where a search lands.
   *
   * Inside a department the answer is that department's own route, with the
   * term as the only query — `?department=` is a redirect now (see page.tsx),
   * and pushing a URL that immediately bounces makes the back button take two
   * presses to leave a search.
   */
  const base = department ? `/store/${token}/c/${department}` : `/store/${token}`

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const term_ = term.trim()
    router.push(`${base}${term_ ? `?q=${encodeURIComponent(term_)}` : ''}`)
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
            router.push(base)
          }}
        >
          Clear
        </Button>
      )}
    </form>
  )
}
