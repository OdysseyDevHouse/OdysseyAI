'use client'

import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'
import { buttonClass, type ButtonSize, type ButtonVariant } from './styles'

export type { ButtonSize, ButtonVariant }

type ButtonProps = Omit<ComponentProps<'button'>, 'className'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Square button holding a single icon — pass an aria-label with it. */
  iconOnly?: boolean
  className?: string
  children?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'md',
  iconOnly = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`${buttonClass({ variant, size, iconOnly })} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

type ButtonLinkProps = Omit<ComponentProps<typeof Link>, 'className'> & {
  variant?: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
  className?: string
}

/** A link that reads as a button — use for navigation, never for submits. */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  iconOnly = false,
  className = '',
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link className={`${buttonClass({ variant, size, iconOnly })} ${className}`} {...rest}>
      {children}
    </Link>
  )
}
