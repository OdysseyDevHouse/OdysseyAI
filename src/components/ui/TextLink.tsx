import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

/**
 * The one look both of these wear.
 *
 * Shared so the anchor and the button below cannot drift apart: a reference
 * that navigates and a reference that opens a dialog must be indistinguishable
 * to a reader, because the difference is an implementation detail of what sits
 * behind the number.
 */
const TEXT_LINK = 'font-medium text-brand hover:underline'

/**
 * TextLink — an inline brand-coloured link: a record reference inside a table
 * cell or a sentence. Wraps next/link so it soft-navigates; several screens
 * were hand-styling raw <a> tags (full page load) with `text-brand
 * hover:underline` retyped at each site.
 *
 * For anything that looks like a button, use <ButtonLink> instead. For a
 * reference that OPENS something in place rather than navigating, use
 * <TextLinkButton> below.
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
    <Link href={href} className={`${TEXT_LINK} ${className}`} {...rest}>
      {children}
    </Link>
  )
}

/**
 * TextLinkButton — a record reference that OPENS something where it stands.
 *
 * Looks exactly like <TextLink>, and is a <button> rather than an <a> because
 * it goes nowhere: it opens a dialog over the screen the reader is on. An
 * anchor without an href is not focusable or operable by keyboard, and one with
 * href="#" tells a screen reader it navigates when it does not — so the
 * distinction here is about what the control IS, not how it looks.
 *
 * Built for the report grid, where a document number opens the sale behind it
 * without costing the reader their filters, their sort and their place in two
 * thousand rows.
 */
export function TextLinkButton({
  onClick,
  children,
  className = '',
  ...rest
}: {
  onClick: () => void
  children: ReactNode
  className?: string
} & Omit<ComponentProps<'button'>, 'onClick' | 'className' | 'children' | 'type'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      /* `text-left` because a button centres its text by default and this one
         sits in a table cell alongside plain-text values that do not. */
      className={`${TEXT_LINK} rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-brand ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
