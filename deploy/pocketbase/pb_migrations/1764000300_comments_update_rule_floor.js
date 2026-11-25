/// <reference path="../pb_data/types.d.ts" />

// S2 follow-up — defence in depth for `comments.updateRule`.
//
// 1764000200 made the rule answer "who may write at all" and pushed
// immutability into pb_hooks/immutable.pb.js. That leaves the whole guarantee
// dependent on the hooks directory: a deploy that ships pb_migrations but
// forgets pb_hooks has a non-author branch that never mentions `author`,
// `project` or `seq` — three of the fields the hook exists to protect.
//
// This migration puts them back in the non-author branch, so the rule alone
// still blocks the obvious attack (a non-author PATCHing `{author: <someone
// else>}` gets a 404 from the rule, not a 400 from the hook).
//
// It is a FLOOR, not a complete blocklist. PocketBase's `field+` modifier on
// text/json fields passes `:isset` checks, and PocketBase silently ignores the
// modifier (verified against 0.39.11: 200, no write), so a body can carry
// `author+`/`project+`/`seq+` past these clauses. That is tolerable only
// because the hook compares against the stored row and rejects a real change;
// the modifier is ignored, so there is nothing to reject. Treat the hook as
// the primary guard, and this rule as the fallback for "hooks dir missing".
// scripts/check-rule-floor.mjs boots PocketBase with migrations and an EMPTY
// hooks dir to prove the fallback works.
//
// ADR 0008 replaces this with the role matrix in Phase 3 (task 3.10), which
// also makes list/view project-scoped.
migrate((app) => {
  const comments = app.findCollectionByNameOrId("comments");
  comments.updateRule =
    '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false && @request.body.author:isset = false && @request.body.project:isset = false && @request.body.seq:isset = false))';
  app.save(comments);
}, (app) => {
  const comments = app.findCollectionByNameOrId("comments");
  // Back to 1764000200: the non-author branch does not mention author,
  // project or seq (the hook still does).
  comments.updateRule =
    '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false))';
  app.save(comments);
});
