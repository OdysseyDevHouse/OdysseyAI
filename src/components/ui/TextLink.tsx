import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

/**
 * TextLink — an inline brand-coloured link: a record reference inside a table
 * cell or a sentence. Wraps next/link so it soft-navigates; several screens
 * were hand-styling raw <a> tags (full page load) with `text-brand
 * hover:underline` retyped at each site.
 *
 * For anything that looks like a button, use <ButtonLink> instead.
 */
export function TextLink({
  href,
  children,
  className = '',
  ...rest
}: {
  href: ComponentProps<typeof Link>['href']
  children: ReactNode
  className?: string
} & Omit<ComponentProps<typeof Link>, 'href' | 'className'>) {
  return (
    <Link href={href} className={`font-medium text-brand hover:underline ${className}`} {...rest}>
      {children}
    </Link>
  )
}
