/**
 * Who is allowed to run the DESTRUCTIVE half of the e2e suite?
 *
 * The suite is written for a stack it can throw away: `resetData()` deletes
 * every comment and reply (and the seq counters), and several specs assert on
 * global row sets. Against a real client's review site that is data loss, so in
 * EXTERNAL mode (C11N_E2E_EXTERNAL=1, a deployment somebody else owns) it is
 * refused unless the operator says, twice, that this is not production:
 *
 *   1. C11N_E2E_ALLOW_DESTRUCTIVE=1
 *      an explicit "yes, run the wipes".
 *   2. both origins are disposable by NAME:
 *        - a loopback host (127.0.0.1, localhost, ::1), i.e. a port-forward to a
 *          test cluster, or
 *        - a host ending in `.closedcloud.test`, the test cluster's reserved
 *          suffix,
 *      OR C11N_E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1 for anything else (a test
 *      cluster behind a real DNS name). That is the third key on purpose: a
 *      hostname that does not look disposable needs a human decision, not a
 *      regex.
 *
 * The local (non-external) stack is unaffected: it is created and wiped by
 * scripts/stack.sh on this machine.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isDisposable(host: string | null): boolean {
  if (host === null) return false
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.closedcloud.test')
}

/**
 * The reason destructive specs may NOT run, or null when they may.
 *
 * Returns a sentence with the fix in it, because it is thrown from globalSetup
 * and from resetData(): the message is the whole documentation the operator
 * gets at that moment.
 */
export function destructiveRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.C11N_E2E_EXTERNAL !== '1') return null

  if (env.C11N_E2E_ALLOW_DESTRUCTIVE !== '1') {
    return (
      'external mode is destructive: the suite deletes every comment and reply ' +
      '(resetData) and creates users in the deployment it points at. ' +
      'Set C11N_E2E_ALLOW_DESTRUCTIVE=1 to confirm you mean it, and only ever ' +
      'against a disposable cluster (see scripts/cluster/e2e-against-ingress.md).'
    )
  }

  const base = hostOf(env.C11N_E2E_BASE_URL)
  const pb = hostOf(env.C11N_E2E_PB_URL)
  if (isDisposable(base) && isDisposable(pb)) return null

  if (env.C11N_E2E_I_KNOW_THIS_IS_NOT_PRODUCTION === '1') return null

  return (
    `refusing to run the destructive suite against ${env.C11N_E2E_BASE_URL ?? '<unset>'} / ` +
    `${env.C11N_E2E_PB_URL ?? '<unset>'}: only loopback hosts or *.closedcloud.test are ` +
    'treated as disposable. If this really is a throwaway test deployment, set ' +
    'C11N_E2E_I_KNOW_THIS_IS_NOT_PRODUCTION=1 as well.'
  )
}
