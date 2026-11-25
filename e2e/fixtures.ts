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

export interface PbUser {
  id: string
  email: string
  name: string
  /** Set by the server: 'client' by default (pb_hooks/identity.pb.js). */
  role?: string
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

/** Raw text of a stack service log (`.stack/<name>.log`), '' when missing. */
export function stackLog(name: 'pocketbase' | 'caddy' | 'demo'): string {
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
  const match = stackLog('pocketbase').match(
    /c11n bootstrap: owner invite for (\S+) \(single use, expires in (\d+)h\): (\S+)/,
  )
  if (!match) throw new Error('no bootstrap invite line in .stack/pocketbase.log')
  const [, email, ttlHours, link] = match
  const token = new URL(link).searchParams.get('t') ?? ''
  return { email, ttlHours: Number(ttlHours), link, token }
}

export function readCreds(): Creds {
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
  password = 'password123456',
): Promise<PbUser> {
  const creds = readCreds()
  // Unique per call so parallel-ish suites never collide on the unique email.
  const unique = email ?? `e2e-${Date.now()}-${userSeq++}@c11n.test`
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/users/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: { email: unique, password, passwordConfirm: password, name },
  })
  return json<PbUser>(res)
}

/** Password-auth a user against PocketBase directly, for API-driven specs. */
export async function userToken(email: string, password = 'password123456'): Promise<string> {
  const creds = readCreds()
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/users/auth-with-password`, {
    data: { identity: email, password },
  })
  const body = await json<{ token: string }>(res)
  return body.token
}

/**
 * Create a user with a specific role, as superuser, and return it with a
 * bearer token. The token comes from password auth, which still works until
 * task 3.9 — the invite route accepts it exactly like the session cookie it
 * will later be derived from.
 */
export async function createUserWithRole(
  role: 'owner' | 'team' | 'client' | 'agent',
  name = `${role} user`,
): Promise<PbUser & { token: string }> {
  const creds = readCreds()
  const email = `e2e-${role}-${Date.now()}-${userSeq++}@c11n.test`
  const res = await (await ctx()).post(`${creds.pbUrl}/api/collections/users/records`, {
    headers: { authorization: await superuserTokenFor() },
    data: { email, password: 'password123456', passwordConfirm: 'password123456', name, role },
  })
  const user = await json<PbUser>(res)
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
 * POST /api/c11n/invite through the proxy. `token` null means "call as
 * superuser" (the only caller allowed to do anything at all, per ADR 0008).
 */
export async function inviteAs(
  request: APIRequestContext,
  token: string | null,
  email: string,
  role: string,
): Promise<InviteResult> {
  const headers: Record<string, string> = token ? { authorization: token } : { authorization: await superuserTokenFor() }
  const res = await request.post('/__c11n/pb/api/c11n/invite', { headers, data: { email, role } })
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

/**
 * Sign in through the overlay's own UI: chip → email/password → submit, then
 * wait for the authed toolbar. Deliberately drives the real form (not
 * localStorage injection) so the login path itself is covered.
 */
export async function loginAs(page: Page, email: string, password = 'password123456'): Promise<void> {
  await page.locator('.c11n-signin-chip').click()
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.locator('form button[type=submit]').click()
  await page.locator('.c11n-toolbar .c11n-mode-toggle').waitFor({ state: 'visible' })
}

/** Fresh page state per test: no persisted PocketBase auth in localStorage. */
export async function freshPage(page: Page, url = '/'): Promise<void> {
  await page.goto(url)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

export interface MagicOpen {
  status: number
  location?: string
  /** The raw Set-Cookie header, when the response set one. */
  setCookie?: string
  body: string
}

/**
 * GET a magic link WITHOUT following the redirect: the interesting parts of
 * the response are the status, the Location and the Set-Cookie header.
 */
export async function openMagicLink(request: APIRequestContext, link: string): Promise<MagicOpen> {
  const res = await request.get(link, { maxRedirects: 0 })
  const headers = res.headers()
  return {
    status: res.status(),
    location: headers['location'] ?? headers['Location'],
    setCookie: headers['set-cookie'] ?? headers['Set-Cookie'],
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
