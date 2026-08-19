import { createPocketBaseBackend } from './api'
import type { C11nBackend } from './api'

// The single shared backend instance. All data access in the overlay goes
// through this facade, never through createPocketBaseBackend directly.
let impl: C11nBackend = createPocketBaseBackend()

/**
 * Stable facade over the current backend implementation. Consumers import
 * `backend` once; tests can swap the implementation underneath it with
 * `setBackend` without touching module caches.
 */
export const backend: C11nBackend = {
  login: (email, password) => impl.login(email, password),
  logout: () => impl.logout(),
  me: () => impl.me(),
  // Arity-preserving: an omitted path must reach the impl as an omitted
  // argument (project-wide sidebar query), not an explicit undefined.
  listComments: (project, path) =>
    path === undefined ? impl.listComments(project) : impl.listComments(project, path),
  createComment: (input) => impl.createComment(input),
  setResolved: (id, resolved) => impl.setResolved(id, resolved),
  listReplies: (commentId) => impl.listReplies(commentId),
  createReply: (commentId, body) => impl.createReply(commentId, body),
  subscribe: (project, handlers) => impl.subscribe(project, handlers),
}

/** Test hook: replace the underlying backend implementation. */
export function setBackend(b: C11nBackend): void {
  impl = b
}
