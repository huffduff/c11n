/// <reference path="../pb_data/types.d.ts" />

// S2 — simplify `comments.updateRule`.
//
// Before: two long branches, the non-author one blocklisting every field the
// author owns (`body`, `selector`, `anchorMeta`, `path`, `project`, `author`)
// so a reviewer could only toggle `resolved`. Two problems:
//   - `seq` was not in the blocklist, so ANY authenticated user could rewrite
//     a comment's sequence number;
//   - the author branch (`author = @request.auth.id`) allowed everything, so
//     an author could reassign the comment to another user or project.
//
// Immutability now lives in `pb_hooks/immutable.pb.js`, which compares the
// request against the stored row (author, project, seq → 400). The rule only
// has to answer "who may write at all":
//   - the author: anything (their body, plus resolve/reopen);
//   - any other authenticated user: only fields that aren't the author's
//     content, i.e. resolve/reopen. The field checks stay, because otherwise
//     a non-author could rewrite the body and only be stopped by the hook
//     (which doesn't cover `body`).
//
// ADR 0008 replaces this with the role matrix in Phase 3.
migrate((app) => {
  const comments = app.findCollectionByNameOrId("comments");
  comments.updateRule =
    '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false))';
  app.save(comments);
}, (app) => {
  const comments = app.findCollectionByNameOrId("comments");
  // Back to the pre-S2 rule (the holes included).
  comments.updateRule =
    '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false && @request.body.project:isset = false && @request.body.author:isset = false))';
  app.save(comments);
});
