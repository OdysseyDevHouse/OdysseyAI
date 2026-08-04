import LoginScreen from '@/components/LoginScreen'
import LoginForm from './login/LoginForm'

/**
 * The landing page and the real sign-in. Authenticates against cp2_users in the
 * control database; on success the session opens the user's default site.
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams

  return (
    <LoginScreen>
      <LoginForm next={next ?? ''} />
    </LoginScreen>
  )
}
