import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  createProject,
  createUser,
  deleteProject,
  listComments,
  readCreds,
  resetData,
  seedComment,
  seedReply,
  superuserTokenFor,
  userToken,
} from '../fixtures'

/**
 * S2 — author / project / seq must be immutable after create.
 *
 * Before this task the `comments.updateRule` only blocklisted fields for
 * *non*-authors, so:
 *   - a non-author could PATCH `seq` (the rule never mentioned it),
 *   - the author could reassign `author` or move the comment to another
 *     project (the rule's author branch allows anything).
 *
 * Immutability now lives in `pb_hooks/immutable.pb.js`
 * (`onRecordUpdateRequest` → 400), and the rule is the plain
 * "author may edit; anyone authenticated may resolve" shape. See ADR 0008.
 */
const PASSWORD = 'password123456'
const PB = '/__c11n/pb'

async function patch(
  request: APIRequestContext,
  url: string,
  data: Record<string, unknown>,
  token?: string,
): Promise<Awaited<ReturnType<APIRequestContext['patch']>>> {
  return request.patch(url, {
    data,
    ...(token ? { headers: { authorization: token } } : {}),
  })
}

test.beforeEach(async () => {
  await resetData()
})

test.describe('S2 — immutable fields on comments', () => {
  test('bob (non-author) cannot set seq', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')
    const comment = await seedComment({ author: alice.id, body: 'alice thread' })
    const bobToken = await userToken(bob.email)

    const res = await patch(request, `${PB}/api/collections/comments/records/${comment.id}`, { seq: 99 }, bobToken)
    expect(res.status(), await res.text()).toBe(400)

    const stored = (await listComments()).find((c) => c.id === comment.id)
    expect(stored?.seq).toBe(comment.seq)
  })

  test('alice (author) cannot reassign author', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')
    const comment = await seedComment({ author: alice.id, body: 'alice thread' })
    const aliceToken = await userToken(alice.email)

    const res = await patch(
      request,
      `${PB}/api/collections/comments/records/${comment.id}`,
      { author: bob.id },
      aliceToken,
    )
    expect(res.status(), await res.text()).toBe(400)
    expect((await listComments()).find((c) => c.id === comment.id)?.author).toBe(alice.id)
  })

  test('alice (author) cannot move the comment to another project', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const comment = await seedComment({ author: alice.id, body: 'alice thread' })
    const aliceToken = await userToken(alice.email)

    const other = (await createProject(`move-target-${Date.now()}`)).id
    try {
      const res = await patch(
        request,
        `${PB}/api/collections/comments/records/${comment.id}`,
        { project: other },
        aliceToken,
      )
      expect(res.status(), await res.text()).toBe(400)
      expect((await listComments()).find((c) => c.id === comment.id)?.project).toBe(comment.project)
    } finally {
      await deleteProject(other)
    }
  })

  test('alice can still edit her own body', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const comment = await seedComment({ author: alice.id, body: 'before' })
    const aliceToken = await userToken(alice.email)

    const res = await patch(
      request,
      `${PB}/api/collections/comments/records/${comment.id}`,
      { body: 'after' },
      aliceToken,
    )
    expect(res.status(), await res.text()).toBe(200)
    expect((await listComments()).find((c) => c.id === comment.id)?.body).toBe('after')
  })

  test('a resent unchanged seq is accepted (full-record PUTs stay legal)', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const comment = await seedComment({ author: alice.id, body: 'unchanged seq' })
    const aliceToken = await userToken(alice.email)

    // The overlay sends only changed fields, but a form/script may echo the
    // whole record back; that must not be rejected as "changed".
    const res = await patch(
      request,
      `${PB}/api/collections/comments/records/${comment.id}`,
      { seq: comment.seq, author: alice.id, body: 'edited with echo' },
      aliceToken,
    )
    expect(res.status(), await res.text()).toBe(200)
    expect((await listComments()).find((c) => c.id === comment.id)?.body).toBe('edited with echo')
  })
})

test.describe('comments — rule still separates authors from resolvers', () => {
  test('bob (non-author) cannot edit the body', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')
    const comment = await seedComment({ author: alice.id, body: 'do not touch' })
    const bobToken = await userToken(bob.email)

    const res = await patch(request, `${PB}/api/collections/comments/records/${comment.id}`, { body: 'hacked' }, bobToken)
    expect([403, 404]).toContain(res.status())
    expect((await listComments()).find((c) => c.id === comment.id)?.body).toBe('do not touch')
  })

  test('bob (non-author) can toggle resolved (allowed until Phase 3 roles)', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const bob = await createUser(undefined, 'Bob')
    const comment = await seedComment({ author: alice.id, body: 'resolve me' })
    const bobToken = await userToken(bob.email)

    const res = await patch(request, `${PB}/api/collections/comments/records/${comment.id}`, { resolved: true }, bobToken)
    expect(res.status(), await res.text()).toBe(200)
    expect((await listComments()).find((c) => c.id === comment.id)?.resolved).toBe(true)
  })
})

test.describe('S2 — immutable fields on replies', () => {
  test("a reply's comment cannot be changed", async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const first = await seedComment({ author: alice.id, body: 'first' })
    const second = await seedComment({ author: alice.id, body: 'second' })
    const reply = await seedReply(first.id, alice.id, 'reply body')
    const aliceToken = await userToken(alice.email)

    const res = await patch(
      request,
      `${PB}/api/collections/replies/records/${reply.id}`,
      { comment: second.id },
      aliceToken,
    )
    expect(res.status(), await res.text()).toBe(400)

    const creds = readCreds()
    const check = await request.get(`${creds.pbUrl}/api/collections/replies/records/${reply.id}`, {
      headers: { authorization: await superuserTokenFor() },
    })
    expect(((await check.json()) as { comment: string }).comment).toBe(first.id)
  })

  test('an author can still edit their reply body', async ({ request }) => {
    const alice = await createUser(undefined, 'Alice')
    const comment = await seedComment({ author: alice.id, body: 'thread' })
    const reply = await seedReply(comment.id, alice.id, 'before')
    const aliceToken = await userToken(alice.email)

    const res = await patch(
      request,
      `${PB}/api/collections/replies/records/${reply.id}`,
      { body: 'after' },
      aliceToken,
    )
    expect(res.status(), await res.text()).toBe(200)
  })
})

/** A second project, created as superuser (needed for the project-move spec). */
