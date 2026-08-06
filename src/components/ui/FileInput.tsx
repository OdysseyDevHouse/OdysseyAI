import type { ComponentProps } from 'react'
import { CONTROL, CONTROL_INVALID } from './styles'

/**
 * A file picker wearing the same skin as every other control.
 *
 * The native element is kept rather than hidden behind a styled button. Only a
 * real <input type="file"> can open the picker from a user gesture, and only it
 * participates in a plain form submission — the two things a replacement would
 * have to rebuild, badly.
 *
 * What IS restyled is the button the browser draws inside it, via ::file-selector-button,
 * so the control reads as one of ours rather than as the operating system's.
 *
 * Height is left to the content rather than pinned to h-control: the browser
 * puts the button and the chosen filename on one line, and forcing 36px clips
 * the descenders on some platforms. The vertical padding lands it at the same
 * height in practice.
 */
export function FileInput({
  className = '',
  invalid = false,
  ...rest
}: Omit<ComponentProps<'input'>, 'type' | 'className'> & {
  className?: string
  /** Red edge, for a field the form has rejected. */
  invalid?: boolean
}) {
  return (
    <input
      type="file"
      className={[
        CONTROL,
        'cursor-pointer py-2 leading-normal',
        // The browser-drawn button, styled as a quiet secondary.
        'file:mr-3 file:cursor-pointer file:rounded-control file:border-0',
        'file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink',
        'hover:file:bg-border',
        invalid ? CONTROL_INVALID : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}
