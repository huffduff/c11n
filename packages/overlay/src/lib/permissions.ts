import type { Role } from './types'

/**
 * The ADR 0008 matrix, as far as the overlay uses it.
 *
 * These are UI guards only: the PocketBase rules enforce the same cells
 * (deploy/pocketbase/pb_migrations/1766000100_role_matrix.js), so hiding a
 * button is a courtesy, never the access control. An unknown role is treated
 * as no role — the overlay must not assume a capability from a missing field.
 */

/** Top-level comments: owner, team and client; the agent only replies. */
export function canComment(role: Role | undefined): boolean {
  return role !== undefined && role !== 'agent'
}

/** Resolve/reopen: owner and team any thread, a client only its own, never the agent. */
export function canResolve(role: Role | undefined, isAuthor: boolean): boolean {
  if (role === 'owner' || role === 'team') return true
  if (role === 'client') return isAuthor
  return false
}

/** Delete a comment: the owner may delete anyone's; everyone else their own. */
export function canDelete(role: Role | undefined, isAuthor: boolean): boolean {
  if (role === undefined) return false
  return role === 'owner' || isAuthor
}
