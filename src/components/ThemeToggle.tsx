'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from '@/components/ui/icons'

export const THEME_KEY = 'odyssey.theme'

type Theme = 'light' | 'dark'

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    // Private mode or blocked storage — fall back to the system preference.
    return null
  }
}

/**
 * Light/dark switch for the avatar menu.
 *
 * Writes `data-theme` on <html>, which globals.css uses to override the
 * prefers-color-scheme media query. Until someone makes a choice the attribute
 * is absent on purpose, so the app keeps following the OS — including when the
 * OS flips at sunset, which a hard-coded value would ignore.
 */
export default function ThemeToggle() {
  // Starts light and corrects on mount. Reading the real theme during render
  // would make the server and client markup disagree and break hydration.
  const [theme, setTheme] = useState<Theme>('light')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setTheme(storedTheme() ?? systemTheme())
    setReady(true)
  }, [])

  // While no explicit choice exists, track the OS if it changes mid-session.
  useEffect(() => {
    if (!ready || storedTheme() !== null) return

    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [ready])

  const choose = (next: Theme) => {
    setTheme(next)
    document.documentElement.dataset.theme = next
    try {
      window.localStorage.setItem(THEME_KEY, next)
    } catch {
      // The attribute is already set, so this session still looks right.
    }
  }

  const isDark = theme === 'dark'

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <span className="flex items-center gap-2.5 text-sm text-muted">
        {isDark ? <Moon size={15} /> : <Sun size={15} />}
        {isDark ? 'Dark mode' : 'Light mode'}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label="Dark mode"
        onClick={() => choose(isDark ? 'light' : 'dark')}
        className={`relative h-5 w-9 shrink-0 rounded-pill transition-colors ${
          isDark ? 'bg-brand' : 'bg-border-strong'
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-pill bg-white shadow-card transition-[left] ${
            isDark ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  )
}
