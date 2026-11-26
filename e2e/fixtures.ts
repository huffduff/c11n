/**
 * Fixture helpers over PocketBase's REST API.
 *
 * The overlay itself uses `/__c11n/pb`, but fixtures talk to PocketBase
 * directly on its own port (from `.stack/creds.json`): seeding must not depend
 * on the proxy under test, and superuser calls are the only way to create
 * users once public signup is closed (Phase 2).
 */
import { request, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { destructiveRefusal } from './external-guard'

export interface Creds {
  email: string
  password: string
  pbUrl: string
  baseUrl: string
}

/**
 * Port of the go fixture's demo server. Keep in sync with `GO_PORT` in
 * scripts/stack.sh (the two cannot import from each other).
 */
export const GO_PORT = 15174

export type Role = 'owner' | 'team' | 'client' | 'agent'

export interface PbUser {
  id: string
  email: string
  name: string
  /** Set by the server: 'client' by default (pb_hooks/identity.pb.js). */
  role?: Role
}

export interface PbComment {
  id: string
  seq?: number
  project: string
  path: string
  selector: string
  anchorMeta: unknown
  body: string
  author: string
  resolved: boolean
  created: string
  updated: string
}

const repoRoot = path.resolve(__dirname, '..')
const credsPath = process.env.C11N_CREDS ?? path.join(repoRoot, '.stack', 'creds.json')
const stateDir = process.env.C11N_STACK_DIR ?? path.join(repoRoot, '.stack')

/**
 * EXTERNAL MODE (Phase 5 task 5.5): run this suite against a REAL deployment
 * (the closedcloud cluster) instead of a stack scripts/stack.sh started here.
 *
 * Set C11N_E2E_EXTERNAL=1 plus:
 *   C11N_E2E_BASE_URL   the proxy's origin (port-forward, see the docs)
 *   C11N_E2E_PB_URL     PocketBase's direct API origin (a second port-forward:
 *                       the superuser helpers bypass the proxy on purpose)
 *   C11N_E2E_SU_EMAIL / C11N_E2E_SU_PASSWORD  a superuser in that deployment
 *
 * There is no local stack, so everything that reads a local log or wipes
 * local state is skipped: the fixtures throw, and the specs that depend on
 * the bootstrap log or a native Caddy binary skip themselves.
 */
export const EXTERNAL = process.env.C11N_E2E_EXTERNAL === '1'

function needEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `C11N_E2E_EXTERNAL=1 needs ${name}. See scripts/cluster/e2e-against-ingress.md.`,
    )
  }
  return value.replace(/\/+$/, '')
}

/** Raw text of a stack service log (`.stack/<name>.log`), '' when missing. */
export function stackLog(name: 'pocketbase' | 'caddy' | 'demo'): string {
  if (EXTERNAL) {
    throw new Error(
      `stackLog(${name}) is local-stack only. In external mode read the pod log: ` +
        `kubectl logs deploy/c11n -c pocketbase`,
    )
  }
  try {
    return fs.readFileSync(path.join(stateDir, `${name}.log`), 'utf8')
  } catch {
    return ''
  }
}

export interface BootstrapInvite {
  email: string
  ttlHours: number
  link: string
  token: string
}

/**
 * The one-time owner invite that `pb_hooks/bootstrap.pb.js` prints on a fresh
 * stack (task 3.2). Read from the log rather than from the database on
 * purpose: the log line is the only copy of the raw token, so a spec that
 * regexes it also proves the operator can actually find it.
 */
export function bootstrapInviteLink(): BootstrapInvite {
  if (EXTERNAL) {
    throw new Error(
      'the bootstrap link lives in the cluster log, not here: ' +
        "kubectl logs deploy/c11n -c pocketbase | grep 'c11n bootstrap' (docs/runbook.md)",
    )
  }
  const match = stackLog('pocketbase').match(
    /c11n bootstrap: owner invite for (\S+) \(single use, expires in (\d+)h\): (\S+)/,
  )
  if (!match) throw new Error('no bootstrap invite line in .stack/pocketbase.log')
  const [, email, ttlHours, link] = match
  // Links carry the token in the FRAGMENT (ADR 0006, revised): '#t=<token>'.
  const token = link.includes('#t=') ? link.split('#t=')[1] : (new URL(link).searchParams.get('t') ?? '')
  return { email, ttlHours: Number(ttlHours), link, token }
}

export function readCreds(): Creds {
  if (EXTERNAL) {
    return {
      email: needEnv('C11N_E2E_SU_EMAIL'),
      password: needEnv('C11N_E2E_SU_PASSWORD'),
      pbUrl: needEnv('C11N_E2E_PB_URL'),
      baseUrl: needEnv('C11N_E2E_BASE_URL'),
    }
  }
  return JSON.parse(fs.readFileSync(credsPath, 'utf8')) as Creds
}

let superuserToken: string | null = null
let projectId: string | null = null
let api: APIRequestContext | null = null

async function ctx(): Promise<APIRequestContext> {
  if (!api) api = await request.newContext()
  return api
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext['post']>>): Promise<T> {
  const text = await res.text()
  if (!res.ok()) throw new Error(`${res.url()} -> ${res.status()} ${text}`)
  return JSON.parse(text) as T
}

/** Superuser token, cached for the process (one worker, one stack). */
export async function superuserTokenFor(): Promise<string> {
  if (superuserToken) return superuserToken
  const creds = readCreds()
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/_superusers/auth-with-password`, {
    data: { identity: creds.email, password: creds.password },
  })
  const body = await json<{ token: string }>(res)
  superuserToken = body.token
  return superuserToken
}

/** Id of the seeded `default` project (the only project v1 ships with). */
export async function defaultProjectId(): Promise<string> {
  if (projectId) return projectId
  const creds = readCreds()
  const res = await (await ctx()).get(
    `${creds.pbUrl}/api/collections/projects/records?perPage=1&filter=` +
      encodeURIComponent(`slug='default'`),
    { headers: { authorization: await superuserTokenFor() } },
  )
  const body = await json<{ items: Array<{ id: string }> }>(res)
  if (!body.items[0]) throw new Error('no `default` project — did the migrations run?')
  projectId = body.items[0].id
  return projectId
}

let userSeq = 0

/** Create a user as superuser (works with public signup closed). */
export async function createUser(
  email?: string,
  name = 'Test User',
  role: Role = 'client',
  password = 'password123456',
): Promise<PbUser> {
  const creds = readCreds()
  // Unique per call so parallel-ish suites never collide on the unique email.
  const unique = email ?? `e2e-${Date.now()}-${userSeq++}@c11n.test`
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/users/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: { email: unique, password, passwordConfirm: password, name, role },
  })
  return json<PbUser>(res)
}

/**
 * A bearer token for an API-level spec, minted through the superuser
 * impersonate endpoint. Password auth is gone (task 3.9) and the gate
 * overwrites any client Authorization on the proxy, so fixtures use
 * impersonation for "act as this user" and talk to PocketBase directly
 * (ADR 0006 mints agent tokens the same way).
 */
export async function userToken(email: string, durationSeconds = 3600): Promise<string> {
  const creds = readCreds()
  const user = await userByEmail(email)
  if (!user) throw new Error(`userToken: no user with email ${email}`)
  const res = await (await ctx()).post(
    `${creds.pbUrl}/api/collections/users/impersonate/${user.id}`,
    { headers: { authorization: await superuserTokenFor() }, data: { duration: durationSeconds } },
  )
  const body = await json<{ token: string }>(res)
  return body.token
}

/**
 * Create a user with a specific role, as superuser, and return it with a
 * bearer token (impersonation, so it works with password auth off).
 */
export async function createUserWithRole(
  role: Role,
  name = `${role} user`,
): Promise<PbUser & { token: string }> {
  const email = `e2e-${role}-${Date.now()}-${userSeq++}@c11n.test`
  const user = await createUser(email, name, role)
  return { ...user, token: await userToken(email) }
}

export interface InviteResult {
  status: number
  /** Present on success (task 3.3 always returns the link). */
  link?: string
  expiresAt?: string
  text: string
}

/**
 * POST /api/c11n/invite, straight to PocketBase on its own port. `token` null
 * means "call as superuser" (the only caller allowed to do anything at all,
 * per ADR 0008). Not through the proxy: since 3.8 the proxy overwrites any
 * client Authorization with the session cookie, so a bearer through it would
 * be signed as the cookie user (or 401 with no cookie at all).
 */
export async function inviteAs(
  request: APIRequestContext,
  token: string | null,
  email: string,
  role: string,
): Promise<InviteResult> {
  const headers: Record<string, string> = token ? { authorization: token } : { authorization: await superuserTokenFor() }
  const res = await request.post(`${readCreds().pbUrl}/api/c11n/invite`, { headers, data: { email, role } })
  const text = await res.text()
  let body: { link?: string; expiresAt?: string } = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    // error pages are HTML
  }
  return { status: res.status(), link: body.link, expiresAt: body.expiresAt, text }
}

export interface InviteRow {
  id: string
  email: string
  role: string
  user: string
  invitedBy: string
  tokenHash: string
  expiresAt: string
  usedAt: string
}

/** Invite rows for one email, newest first (superuser view). */
export async function invitesFor(email: string): Promise<InviteRow[]> {
  const creds = readCreds()
  const res = await (await ctx()).get(
    `${creds.pbUrl}/api/collections/invites/records?perPage=50&sort=-created&filter=` +
      encodeURIComponent(`email='${email}'`),
    { headers: { authorization: await superuserTokenFor() } },
  )
  const body = await json<{ items: InviteRow[] }>(res)
  return body.items
}

/** A user by email, or undefined (superuser view). */
export async function userByEmail(email: string): Promise<PbUser | undefined> {
  const creds = readCreds()
  const res = await (await ctx()).get(
    `${creds.pbUrl}/api/collections/users/records?filter=` + encodeURIComponent(`email='${email}'`),
    { headers: { authorization: await superuserTokenFor() } },
  )
  const body = await json<{ items: PbUser[] }>(res)
  return body.items[0]
}

async function allRecords(collection: string): Promise<Array<{ id: string }>> {
  const creds = readCreds()
  const headers = { authorization: await superuserTokenFor() }
  const out: Array<{ id: string }> = []
  for (let page = 1; page <= 50; page++) {
    const res = await (await ctx()).get(
      `${creds.pbUrl}/api/collections/${collection}/records?perPage=200&page=${page}&fields=id`,
      { headers },
    )
    const body = await json<{ items: Array<{ id: string }>; totalPages: number }>(res)
    out.push(...body.items)
    if (page >= body.totalPages) break
  }
  return out
}

/**
 * Delete every comment and reply. Comments cascade to their replies, but
 * replies are cleared first anyway so a half-deleted state can't survive.
 * The per-project seq counters go too: "reset" means the next comment gets
 * seq 1, which several specs assert on.
 */
export async function resetData(): Promise<void> {
  // Second gate, at the point of deletion: external mode may only wipe a
  // deployment the operator confirmed is disposable (e2e/external-guard.ts).
  // globalSetup checks this too; this is the one that runs next to the DELETE.
  const refusal = destructiveRefusal()
  if (refusal) throw new Error(`resetData: ${refusal}`)

  const creds = readCreds()
  const headers = { authorization: await superuserTokenFor() }
  for (const collection of ['replies', 'comments', 'comment_counters']) {
    for (const rec of await allRecords(collection)) {
      const res = await (await ctx()).delete(`${creds.pbUrl}/api/collections/${collection}/records/${rec.id}`, {
        headers,
      })
      if (!res.ok() && res.status() !== 404) {
        throw new Error(`resetData: delete ${collection}/${rec.id} -> ${res.status()} ${await res.text()}`)
      }
    }
  }
}

export interface SeedComment {
  author: string
  path?: string
  selector?: string
  body?: string
  anchorMeta?: unknown
  project?: string
}

/** Insert a comment directly (bypassing the overlay) for load-time specs. */
export async function seedComment(input: SeedComment): Promise<PbComment> {
  const creds = readCreds()
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/comments/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: {
      project: input.project ?? (await defaultProjectId()),
      path: input.path ?? '/',
      selector: input.selector ?? 'h1',
      body: input.body ?? 'seeded comment',
      author: input.author,
      ...(input.anchorMeta === undefined ? {} : { anchorMeta: input.anchorMeta }),
    },
  })
  return json<PbComment>(res)
}

/** Every comment in the project, oldest seq first. */
export async function listComments(): Promise<PbComment[]> {
  const creds = readCreds()
  const res = await (await ctx()).get(
    `${creds.pbUrl}/api/collections/comments/records?perPage=500&sort=seq`,
    { headers: { authorization: await superuserTokenFor() } },
  )
  const body = await json<{ items: PbComment[] }>(res)
  return body.items
}

export interface PbReply {
  id: string
  comment: string
  body: string
  author: string
  created: string
}

/** Replies of one comment, as stored (superuser view: no rule filtering). */
export async function listReplies(commentId: string): Promise<PbReply[]> {
  const creds = readCreds()
  const res = await (await ctx()).get(
    `${creds.pbUrl}/api/collections/replies/records?perPage=200&sort=created&filter=` +
      encodeURIComponent(`comment='${commentId}'`),
    { headers: { authorization: await superuserTokenFor() } },
  )
  const body = await json<{ items: PbReply[] }>(res)
  return body.items
}

/** Insert a reply directly (superuser), for API-level permission specs. */
export async function seedReply(commentId: string, author: string, body = 'seeded reply'): Promise<PbReply> {
  const creds = readCreds()
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/replies/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: { comment: commentId, author, body },
  })
  return json<PbReply>(res)
}

/** Create a project as superuser; `projects` is superuser-write (v1). */
export async function createProject(slug: string, name = slug): Promise<{ id: string; slug: string }> {
  const creds = readCreds()
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/projects/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: { name, slug },
  })
  return json<{ id: string; slug: string }>(res)
}

/** Delete a project as superuser (used by specs that create throwaways). */
export async function deleteProject(id: string): Promise<void> {
  const creds = readCreds()
  await (await ctx()).delete(`${creds.pbUrl}/api/collections/projects/records/${id}`, {
    headers: { authorization: await superuserTokenFor() },
  })
}

/** The token inside a fragment link (`.../__c11n/auth/#t=<token>`). */
export function linkToken(link: string): string {
  const hash = new URL(link).hash.replace(/^#/, '')
  return new URLSearchParams(hash).get('t') ?? ''
}

/** Mint a fresh (single-use) magic link for an existing or new user. */
export async function magicLinkFor(email: string, role: Role = 'client'): Promise<string> {
  const res = await inviteAs(await ctx(), null, email, role)
  if (res.status !== 200 || !res.link) {
    throw new Error(`magicLinkFor(${email}) -> ${res.status} ${res.text}`)
  }
  return res.link
}

/**
 * A `c11n_session=…` Cookie header: the state a browser is in after claiming a
 * magic link. API-level specs pass it to the proxy instead of a bearer, because
 * since 3.8 the proxy derives Authorization from this cookie and overwrites
 * anything the client sent.
 */
export async function sessionCookie(email: string, role: Role = 'client'): Promise<string> {
  const claimed = await claimInvite(await ctx(), await magicLinkFor(email, role))
  if (claimed.status !== 200 || !claimed.setCookie) {
    throw new Error(`sessionCookie(${email}) -> ${claimed.status} ${claimed.body}`)
  }
  return `c11n_session=${sessionToken(claimed.setCookie)}`
}

export interface SignedIn {
  user: PbUser
  link: string
}

/**
 * Sign a browser in the way a reviewer does since the fragment change: open the
 * link (the token stays in the fragment, so no server sees it), click
 * "Continue to review", and let the page POST the claim.
 *
 * `email` omitted creates a fresh user with `role`. The wait is the authed
 * toolbar: the overlay only renders it once `/api/c11n/me` answered from the
 * cookie, so a green wait also proves the cookie got through the proxy.
 */
export async function signInAs(page: Page, email?: string, role: Role = 'client'): Promise<SignedIn> {
  const user = email
    ? ((await userByEmail(email)) ?? (await createUser(email, `${role} user`, role)))
    : await createUser(undefined, `${role} user`, role)
  const link = await magicLinkFor(user.email, (user.role as Role) ?? role)
  await openMagicLinkInPage(page, link)
  return { user, link }
}

/**
 * Open a magic link in a browser and click through to the session. This is the
 * one place that knows the page's continue button; every spec that navigates a
 * browser to an invite link should come through here.
 *
 * `next` is added to the PAGE's query string (the token is in the fragment), so
 * the claim POST carries it and the page then navigates there.
 */
export async function openMagicLinkInPage(page: Page, link: string, next?: string): Promise<void> {
  const url = next === undefined ? link : withNextParam(link, next)
  await page.goto(url)
  const continueButton = page.locator('#signin-continue')
  await continueButton.waitFor({ state: 'visible' })
  await continueButton.click()
  // Wait for the claim's navigation to land AND finish loading: returning while
  // the document is still committing makes the next page.goto in a spec fight
  // with it ("navigation is interrupted by another navigation").
  await page.waitForURL((current) => !current.pathname.startsWith('/__c11n/auth/'))
  await page.waitForLoadState('load')
}

/** Put `next` before the fragment: `/auth/?next=…#t=…`. */
export function withNextParam(link: string, next: string): string {
  const hashAt = link.indexOf('#')
  const base = hashAt === -1 ? link : link.slice(0, hashAt)
  const hash = hashAt === -1 ? '' : link.slice(hashAt)
  return `${base}?next=${encodeURIComponent(next)}${hash}`
}

export interface ClaimResult {
  status: number
  /** The raw Set-Cookie header, when the claim minted a session. */
  setCookie?: string
  /** `{ redirect }` on success, `{ message }` on a refused claim. */
  json?: { redirect?: string; message?: string }
  body: string
}

/**
 * POST a magic link's token to the claim route, through the proxy (the public
 * path a browser uses), without a browser. `origin` is the CSRF-relevant
 * header: it defaults to the public origin, and a spec passes something else to
 * prove a cross-origin claim is refused.
 */
export async function claimInvite(
  request: APIRequestContext,
  link: string,
  options: { next?: string; origin?: string; contentType?: string } = {},
): Promise<ClaimResult> {
  const creds = readCreds()
  const token = linkToken(link)
  const res = await request.post(`${creds.baseUrl}/__c11n/auth/claim`, {
    headers: {
      'content-type': options.contentType ?? 'application/json',
      origin: options.origin ?? creds.baseUrl,
    },
    data: { t: token, ...(options.next === undefined ? {} : { next: options.next }) },
  })
  const body = await res.text()
  let parsed: ClaimResult['json']
  try {
    parsed = body ? (JSON.parse(body) as ClaimResult['json']) : undefined
  } catch {
    // error pages are HTML
  }
  return { status: res.status(), setCookie: res.headers()['set-cookie'], json: parsed, body }
}

export interface MagicOpen {
  status: number
  location?: string
  /** The raw Set-Cookie header, when the response set one. */
  setCookie?: string
  /** `X-C11n-Error` on a redirect to the sign-in page (task 3.7). */
  errorHeader?: string
  body: string
}

/**
 * GET a magic link WITHOUT following the redirect, for the legacy-path specs.
 * A GET must never claim: this is what an unfurler does.
 */
export async function openMagicLink(request: APIRequestContext, link: string): Promise<MagicOpen> {
  const res = await request.get(link, { maxRedirects: 0 })
  const headers = res.headers()
  return {
    status: res.status(),
    location: headers['location'] ?? headers['Location'],
    setCookie: headers['set-cookie'] ?? headers['Set-Cookie'],
    errorHeader: headers['x-c11n-error'],
    body: await res.text(),
  }
}

export interface ParsedCookie {
  name: string
  value: string
  /** Attributes exactly as sent, lowercased: ['path=/', 'httponly', ...]. */
  attributes: string[]
  raw: string
}

/** Parse one Set-Cookie header (the session cookie has no commas in values). */
export function parseSetCookie(header: string): ParsedCookie {
  const [pair, ...attrs] = header.split(';').map((part) => part.trim())
  const eq = pair.indexOf('=')
  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    attributes: attrs.map((a) => a.toLowerCase()),
    raw: header,
  }
}

/**
 * The PocketBase auth token inside a `c11n_session` cookie. Specs pass it as
 * `Authorization`, which is exactly what Caddy's `header_up Authorization
 * {http.request.cookie.c11n_session}` will do for /__c11n/pb/* (task 3.8).
 */
export function sessionToken(setCookie: string): string {
  const cookie = parseSetCookie(setCookie)
  if (cookie.name !== 'c11n_session') throw new Error(`not a c11n_session cookie: ${cookie.raw}`)
  return cookie.value
}

/** Invite rows for one email, plus a PATCH helper for the expiry spec. */
export async function patchInvite(id: string, data: Record<string, unknown>): Promise<void> {
  const creds = readCreds()
  const res = await (await ctx()).patch(`${creds.pbUrl}/api/collections/invites/records/${id}`, {
    headers: { authorization: await superuserTokenFor() },
    data,
  })
  if (!res.ok()) throw new Error(`patchInvite -> ${res.status()} ${await res.text()}`)
}

/**
 * A request context with its OWN cookie jar. The `request` fixture is shared by
 * every call in a spec file, and Playwright stores Set-Cookie responses in it —
 * so a spec that signs in and then asserts "anonymous gets 401" would carry the
 * session cookie and pass for the wrong reason.
 */
export async function isolatedRequest(): Promise<APIRequestContext> {
  const creds = readCreds()
  return request.newContext({ baseURL: creds.baseUrl })
}
