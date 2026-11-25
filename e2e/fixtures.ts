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

export interface PbUser {
  id: string
  email: string
  name: string
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
