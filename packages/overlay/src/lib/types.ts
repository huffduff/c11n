import type { AnchorMeta } from './anchor'

/** The signed-in user, as exposed to the UI. */
export interface Me {
  id: string
  email: string
  name: string
}

/** A comment record as stored in the backend, mapped for the UI. */
export interface CommentRec {
  id: string
  project: string
  path: string
  selector: string
  anchorMeta: AnchorMeta | null
  body: string
  author: string
  authorName?: string
  resolved: boolean
  created: string
  updated: string
}

/** A reply on a comment thread. */
export interface ReplyRec {
  id: string
  comment: string
  body: string
  author: string
  authorName?: string
  created: string
}

/** Payload for creating a comment; author is injected by the backend. */
export interface NewComment {
  project: string
  path: string
  selector: string
  anchorMeta: AnchorMeta | null
  body: string
}

/** Realtime event callbacks; each receives the already-mapped record. */
export interface RealtimeHandlers {
  onCommentCreate?: (comment: CommentRec) => void
  onCommentUpdate?: (comment: CommentRec) => void
  onCommentDelete?: (comment: CommentRec) => void
  onReplyCreate?: (reply: ReplyRec) => void
  onReplyUpdate?: (reply: ReplyRec) => void
  onReplyDelete?: (reply: ReplyRec) => void
}
