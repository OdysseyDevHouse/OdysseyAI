import 'server-only'
import bcrypt from 'bcryptjs'

/**
 * bcrypt, because that is what cp2_users.password_hash already contains
 * ($2a$10$… , 60 chars) and those hashes were written by another application.
 * The format is fixed by the existing data, not chosen here.
 *
 * bcryptjs (pure JS) rather than the native `bcrypt` package: the same code
 * ships inside the Electron desktop build, and a native module would need
 * rebuilding for each Electron ABI.
 */

const ROUNDS = 10

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS)
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!plain || !stored) return false
  try {
    return await bcrypt.compare(plain, stored)
  } catch {
    // Malformed hash in the database — treat as a failed match rather than a
    // 500, so one bad row can't take the login page down.
    return false
  }
}

/** True for a value that looks like a bcrypt hash we can actually check. */
export function isBcryptHash(stored: string | null | undefined): boolean {
  return !!stored && /^\$2[aby]\$\d{2}\$.{53}$/.test(stored)
}
