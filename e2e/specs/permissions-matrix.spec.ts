import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  createUser,
  createUserWithRole,
  inviteAs,
  readCreds,
  resetData,
  seedComment,
  seedReply,
  sessionCookie,
  superuserTokenFor,
  type PbComment,
  type PbReply,
  type Role,
} from '../fixtures'

/**
 * The ADR 0008 matrix, one test per cell, at the API level.
 *
 * Direct PocketBase (not the proxy) with an impersonated bearer: the proxy
 * overwrites `Authorization` with the session cookie (3.8), so a bearer sent
 * through it would be signed as the cookie user, or 401 without one.
 *
 * Scope: the cells whose collections/fields exist today. The triage
 * (`category`, `priority`, `triage`) and ticket (`ticketUrl`, `ticketKey`)
 * columns arrive with their fields in Phase 7.1; the agent credential path
 * lands in Phase 7 too. Everything else in the table is covered here:
 *
 *   View the site and comments   owner team client agent (API only)
 *   Comment (top-level)          owner team client          (agent denied)
 *   Reply                        owner team client agent
 *   Edit/delete own comment      owner team client agent
 *   Edit/delete own reply        owner team client agent
 *   Resolve/reopen               owner team any; client own; agent never
 *   Delete any comment           owner only
 *   Invite client                owner team  (client/agent denied)
 *   Invite team/owner            owner only
 *
 * Naming is `<role> · <action> · allowed|denied` so a failure names the cell.
 */

function pb() {
  return readCreds().pbUrl
}

/** One PocketBase REST call as `token` (a raw impersonated bearer). */
async function api(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  token: string | null,
  data?: Record<string, unknown>,
) {
  return request.fetch(`${pb()}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: token } : {}),
      ...(data ? { 'content-type': 'application/json' } : {}),
    },
    ...(data ? { data } : {}),
  })
}

/**
 * PocketBase's answers for a rule denial, by operation:
 *   400  create — "Failed to create record." (0.39.11 does not leak a 403)
 *   404  update/delete/view of a record the rule refuses to show
 *   403  route-level checks (the invite hook's own role gate)
 * Accepting all three keeps the assertion about the cell ("denied") rather
 * than about the envelope.
 */
function expectDenied(status: number, body: string) {
  expect([400, 403, 404], body).toContain(status)
}

const commentPath = (id: string) => `/api/collections/comments/records/${id}`
const replyPath = (id: string) => `/api/collections/replies/records/${id}`

// Reset between tests: the specs assert on global row sets and the suite runs
// one worker, so a leftover comment would change another test's list.
test.beforeEach(async () => {
  await resetData()
})

/** A client whose content the caller is acting on. */
async function victim() {
  return createUser(undefined, 'Victim', 'client')
}

/** Seed a comment authored by `author`, optionally already resolved. */
async function seed(
  request: APIRequestContext,
  author: string,
  body: string,
  resolved = false,
): Promise<PbComment> {
  const comment = await seedComment({ author, body })
  if (resolved) {
    const su = await superuserTokenFor()
    const res = await api(request, 'PATCH', commentPath(comment.id), su, { resolved: true })
    expect(res.status(), await res.text()).toBe(200)
  }
  return comment
}

// ---------------------------------------------------------------------------
// View the site and comments: owner, team, client (and agent, API only)
// ---------------------------------------------------------------------------

test.describe('view the site and comments', () => {
  for (const role of ['owner', 'team', 'client', 'agent'] as Role[]) {
    test(`${role} · view comments · allowed`, async ({ request }) => {
      const author = await victim()
      const seen = await seed(request, author.id, `${role} can read this`)
      const actor = await createUserWithRole(role)

      const list = await api(request, 'GET', '/api/collections/comments/records?perPage=50', actor.token)
      expect(list.status(), await list.text()).toBe(200)
      const items = ((await list.json()) as { items: PbComment[] }).items
      expect(items.map((c) => c.id)).toContain(seen.id)

      const view = await api(request, 'GET', commentPath(seen.id), actor.token)
      expect(view.status(), await view.text()).toBe(200)
    })
  }

  test('owner · browse the site · allowed', async ({ request }) => {
    const owner = await createUserWithRole('owner')
    const cookie = await sessionCookie(owner.email, 'owner')
    const res = await request.get('/', { headers: { cookie, accept: 'text/html' } })
    expect(res.status(), await res.text()).toBe(200)
  })

  // The agent is API-only (ADR 0008): it reads through the API, but the gate
  // refuses an HTML document so it cannot browse the reviewed site.
  test('agent · browse the site · denied', async ({ request }) => {
    const agent = await createUserWithRole('agent')
    const cookie = await sessionCookie(agent.email, 'agent')
    const res = await request.get('/', { headers: { cookie, accept: 'text/html' } })
    expect(res.status(), await res.text()).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Comment (top-level create): owner, team, client — not agent
// ---------------------------------------------------------------------------

test.describe('comment', () => {
  for (const role of ['owner', 'team', 'client'] as Role[]) {
    test(`${role} · comment · allowed`, async ({ request }) => {
      const actor = await createUserWithRole(role)
      // The project id comes from a seeded comment, so the spec does not
      // duplicate fixtures' project lookup.
      const anchor = await seedComment({ author: actor.id, body: 'project anchor' })
      const res = await api(request, 'POST', '/api/collections/comments/records', actor.token, {
        project: anchor.project,
        path: '/',
        selector: '#target',
        body: `${role} says hi`,
        author: actor.id,
      })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as PbComment).author).toBe(actor.id)
    })
  }

  test('agent · comment · denied', async ({ request }) => {
    const agent = await createUserWithRole('agent')
    const anchor = await seedComment({ author: agent.id, body: 'seed' })
    const res = await api(request, 'POST', '/api/collections/comments/records', agent.token, {
      project: anchor.project,
      path: '/',
      selector: '#target',
      body: 'agent top-level',
      author: agent.id,
    })
    expectDenied(res.status(), await res.text())
  })
})

// ---------------------------------------------------------------------------
// Reply: everyone, including the agent
// ---------------------------------------------------------------------------

test.describe('reply', () => {
  for (const role of ['owner', 'team', 'client', 'agent'] as Role[]) {
    test(`${role} · reply · allowed`, async ({ request }) => {
      const author = await victim()
      const thread = await seedComment({ author: author.id, body: 'a thread' })
      const actor = await createUserWithRole(role)
      const res = await api(request, 'POST', '/api/collections/replies/records', actor.token, {
        comment: thread.id,
        body: `${role} replies`,
        author: actor.id,
      })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as PbReply).comment).toBe(thread.id)
    })
  }
})

// ---------------------------------------------------------------------------
// Edit or delete OWN comment / reply: every role
// ---------------------------------------------------------------------------

test.describe('own content', () => {
  for (const role of ['owner', 'team', 'client', 'agent'] as Role[]) {
    test(`${role} · edit own comment · allowed`, async ({ request }) => {
      const actor = await createUserWithRole(role)
      const mine = await seedComment({ author: actor.id, body: 'before' })
      const res = await api(request, 'PATCH', commentPath(mine.id), actor.token, { body: 'after' })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as PbComment).body).toBe('after')
    })

    test(`${role} · delete own reply · allowed`, async ({ request }) => {
      const actor = await createUserWithRole(role)
      const mine = await seedComment({ author: actor.id, body: 'thread' })
      const reply = await seedReply(mine.id, actor.id, 'my reply')
      const res = await api(request, 'DELETE', replyPath(reply.id), actor.token)
      expect(res.status(), await res.text()).toBe(204)
    })
  }
})

// ---------------------------------------------------------------------------
// Resolve / reopen: owner and team any thread; client own threads; agent never
// ---------------------------------------------------------------------------

test.describe('resolve and reopen', () => {
  for (const role of ['owner', 'team'] as Role[]) {
    test(`${role} · resolve others' thread · allowed`, async ({ request }) => {
      const author = await victim()
      const thread = await seed(request, author.id, 'someone else thread')
      const actor = await createUserWithRole(role)
      const res = await api(request, 'PATCH', commentPath(thread.id), actor.token, { resolved: true })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as PbComment).resolved).toBe(true)
    })

    test(`${role} · reopen others' thread · allowed`, async ({ request }) => {
      const author = await victim()
      const thread = await seed(request, author.id, 'someone else resolved thread', true)
      const actor = await createUserWithRole(role)
      const res = await api(request, 'PATCH', commentPath(thread.id), actor.token, { resolved: false })
      expect(res.status(), await res.text()).toBe(200)
      expect(((await res.json()) as PbComment).resolved).toBe(false)
    })
  }

  test('client · resolve own thread · allowed', async ({ request }) => {
    const actor = await createUserWithRole('client')
    const mine = await seedComment({ author: actor.id, body: 'my thread' })
    const res = await api(request, 'PATCH', commentPath(mine.id), actor.token, { resolved: true })
    expect(res.status(), await res.text()).toBe(200)
    expect(((await res.json()) as PbComment).resolved).toBe(true)
  })

  test('client · reopen own thread · allowed', async ({ request }) => {
    const actor = await createUserWithRole('client')
    const mine = await seed(request, actor.id, 'my resolved thread', true)
    const res = await api(request, 'PATCH', commentPath(mine.id), actor.token, { resolved: false })
    expect(res.status(), await res.text()).toBe(200)
    expect(((await res.json()) as PbComment).resolved).toBe(false)
  })

  // The tightened cell: before 3.10 any authenticated non-author could toggle
  // `resolved`, so these two were 200.
  test("client · resolve others' thread · denied", async ({ request }) => {
    const author = await victim()
    const thread = await seed(request, author.id, 'not yours')
    const actor = await createUserWithRole('client')
    const res = await api(request, 'PATCH', commentPath(thread.id), actor.token, { resolved: true })
    expectDenied(res.status(), await res.text())
    const stored = await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())
    expect(((await stored.json()) as PbComment).resolved).toBe(false)
  })

  test("client · reopen others' thread · denied", async ({ request }) => {
    const author = await victim()
    const thread = await seed(request, author.id, 'not yours to reopen', true)
    const actor = await createUserWithRole('client')
    const res = await api(request, 'PATCH', commentPath(thread.id), actor.token, { resolved: false })
    expectDenied(res.status(), await res.text())
    const stored = await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())
    expect(((await stored.json()) as PbComment).resolved).toBe(true)
  })

  test('agent · resolve thread · denied', async ({ request }) => {
    const author = await victim()
    const thread = await seed(request, author.id, 'agent cannot resolve')
    const agent = await createUserWithRole('agent')
    const res = await api(request, 'PATCH', commentPath(thread.id), agent.token, { resolved: true })
    expectDenied(res.status(), await res.text())
    const stored = await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())
    expect(((await stored.json()) as PbComment).resolved).toBe(false)
  })

  test('agent · reopen thread · denied', async ({ request }) => {
    const author = await victim()
    const thread = await seed(request, author.id, 'agent cannot reopen', true)
    const agent = await createUserWithRole('agent')
    const res = await api(request, 'PATCH', commentPath(thread.id), agent.token, { resolved: false })
    expectDenied(res.status(), await res.text())
    const stored = await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())
    expect(((await stored.json()) as PbComment).resolved).toBe(true)
  })

  // Same cell, the shape only a superuser can seed: a comment the agent
  // authored. The author branch lets it edit its body, but `resolved` is
  // excluded for role=agent — an agent never closes a loop (ADR 0008).
  test('agent · resolve own authored comment · denied', async ({ request }) => {
    const agent = await createUserWithRole('agent')
    const mine = await seedComment({ author: agent.id, body: 'seeded for the agent' })
    const res = await api(request, 'PATCH', commentPath(mine.id), agent.token, { resolved: true })
    expectDenied(res.status(), await res.text())
    const edited = await api(request, 'PATCH', commentPath(mine.id), agent.token, { body: 'agent edit' })
    expect(edited.status(), await edited.text()).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Delete any comment: owner only (replies cascade)
// ---------------------------------------------------------------------------

test.describe('delete others content', () => {
  test("owner · delete others' comment · allowed", async ({ request }) => {
    const author = await victim()
    const thread = await seed(request, author.id, 'delete me')
    const reply = await seedReply(thread.id, author.id, 'cascade me')
    const owner = await createUserWithRole('owner')
    const res = await api(request, 'DELETE', commentPath(thread.id), owner.token)
    expect(res.status(), await res.text()).toBe(204)
    expect((await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())).status()).toBe(404)
    // Replies cascade with the parent comment.
    expect((await api(request, 'GET', replyPath(reply.id), await superuserTokenFor())).status()).toBe(404)
  })

  for (const role of ['team', 'client', 'agent'] as Role[]) {
    test(`${role} · delete others' comment · denied`, async ({ request }) => {
      const author = await victim()
      const thread = await seed(request, author.id, 'not yours to delete')
      const actor = await createUserWithRole(role)
      const res = await api(request, 'DELETE', commentPath(thread.id), actor.token)
      expectDenied(res.status(), await res.text())
      expect((await api(request, 'GET', commentPath(thread.id), await superuserTokenFor())).status()).toBe(200)
    })
  }
})

// ---------------------------------------------------------------------------
// Invite: owner any role (team/owner included); team clients only; client and
// agent cannot invite at all
// ---------------------------------------------------------------------------

test.describe('invite', () => {
  const invite = async (request: APIRequestContext, role: Role, targetRole: string, suffix: string) => {
    const actor = await createUserWithRole(role)
    return inviteAs(request, actor.token, `invited-${role}-${suffix}-${Date.now()}@c11n.test`, targetRole)
  }

  test('owner · invite team · allowed', async ({ request }) => {
    const res = await invite(request, 'owner', 'team', 'team')
    expect(res.status, res.text).toBe(200)
    expect(res.link).toContain('/__c11n/auth/#t=')
  })

  test('owner · invite client · allowed', async ({ request }) => {
    const res = await invite(request, 'owner', 'client', 'client')
    expect(res.status, res.text).toBe(200)
  })

  test('team · invite client · allowed', async ({ request }) => {
    const res = await invite(request, 'team', 'client', 'client')
    expect(res.status, res.text).toBe(200)
  })

  test('team · invite team · denied', async ({ request }) => {
    const res = await invite(request, 'team', 'team', 'team')
    expect(res.status, res.text).toBe(403)
  })

  test('client · invite client · denied', async ({ request }) => {
    const res = await invite(request, 'client', 'client', 'client')
    expect(res.status, res.text).toBe(403)
  })

  test('agent · invite client · denied', async ({ request }) => {
    const res = await invite(request, 'agent', 'client', 'client')
    expect(res.status, res.text).toBe(403)
  })
})
