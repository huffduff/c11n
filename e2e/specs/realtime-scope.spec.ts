import { expect, test } from '@playwright/test'
import { EventSource } from 'eventsource'
import PocketBase from 'pocketbase'
import {
  createProject,
  createUser,
  defaultProjectId,
  deleteProject,
  readCreds,
  resetData,
  seedComment,
  seedReply,
} from '../fixtures'

// PocketBase's JS SDK opens the SSE stream with a global `EventSource`.
// Browsers have one; Node only exposes it behind --experimental-eventsource,
// so the spec supplies the spec-compliant polyfill.
if (typeof (globalThis as { EventSource?: unknown }).EventSource === 'undefined') {
  ;(globalThis as { EventSource?: unknown }).EventSource = EventSource
}

/**
 * S3 — reply realtime must be scoped to the project.
 *
 * `replies` has no `project` field; the project lives on the parent comment.
 * The overlay used to subscribe to every reply on the collection and filter on
 * the client, which leaks other projects' reply bodies to any authenticated
 * subscriber. The fix is a server-side realtime filter on the relation:
 *
 *     replies.subscribe('*', h, { filter: pb.filter('comment.project = {:projectId}', …) })
 *
 * This spec is at the SDK level (Node, not the overlay), because the overlay
 * hardcodes the `default` project slug and cannot render a second project. It
 * is also the experiment that decides whether relation filters work for
 * realtime on PocketBase 0.39.x at all.
 */
const PASSWORD = 'password123456'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

test.beforeEach(async () => {
  await resetData()
})

test('a reply in project Y does not reach a project-X subscriber', async () => {
  const creds = readCreds()
  const alice = await createUser(undefined, 'Alice')
  const bob = await createUser(undefined, 'Bob')

  const projectX = await defaultProjectId()
  const projectY = (await createProject(`scope-y-${Date.now()}`)).id

  const commentX = await seedComment({ author: bob.id, project: projectX, body: 'in X' })
  const commentY = await seedComment({ author: bob.id, project: projectY, body: 'in Y' })
  const commentY2 = await seedComment({ author: bob.id, project: projectY, body: 'in Y again' })

  const pb = new PocketBase(creds.pbUrl)
  await pb.collection('users').authWithPassword(alice.email, PASSWORD)

  const received: Array<{ id: string; body: string }> = []
  await pb.collection('replies').subscribe(
    '*',
    (e) => {
      if (e.action !== 'create') return
      received.push({ id: e.record.id as string, body: e.record.body as string })
    },
    { filter: pb.filter('comment.project = {:projectId}', { projectId: projectX }) },
  )

  try {
    // A reply in the OTHER project: must not arrive.
    const replyY = await seedReply(commentY.id, bob.id, 'secret of project Y')
    // A reply on a second Y comment as well, so one lucky non-match can't
    // explain the result.
    await seedReply(commentY2.id, bob.id, 'more of project Y')
    await sleep(1_500)
    expect(
      received,
      `realtime filter did not scope replies: got ${JSON.stringify(received)} (replyY ${replyY.id})`,
    ).toEqual([])

    // A reply in project X: must arrive.
    const replyX = await seedReply(commentX.id, bob.id, 'hello project X')
    for (let i = 0; i < 50 && received.length === 0; i++) await sleep(100)
    expect(received.map((r) => r.id)).toEqual([replyX.id])
    expect(received[0].body).toBe('hello project X')
  } finally {
    await pb.collection('replies').unsubscribe('*')
    pb.realtime.disconnect()
    await deleteProject(projectY)
  }
})
