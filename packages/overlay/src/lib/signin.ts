/**
 * The one place that knows the sign-in page's URL contract (task 3.7).
 *
 * `reason` selects the copy; `next` is not used by the MVP page (there is no
 * email form to submit), but the gate and the session hook already put it in
 * the URL, and the post-MVP "send me a new link" form will read it back.
 */
export type SignInReason = 'expired' | 'signed-out' | 'invalid'

export function signInUrl(reason: SignInReason = 'expired', next?: string): string {
  const params = new URLSearchParams({ reason })
  if (next) params.set('next', next)
  return `/__c11n/auth/?${params.toString()}`
}

/** Navigate to the sign-in page, remembering where the user was. */
export function goToSignIn(reason: SignInReason = 'expired', next?: string): void {
  const from = next ?? location.pathname + location.search
  location.assign(signInUrl(reason, from))
}
