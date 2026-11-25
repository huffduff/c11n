/// <reference path="../pb_data/types.d.ts" />

// Phase 3, task 3.10 — the ADR 0008 role matrix, in PocketBase API rules.
//
// Every rule here answers "may this caller touch this collection at all"; the
// per-field guarantees (author/project/seq immutable) stay in
// pb_hooks/immutable.pb.js, and these rules keep their own field blocklist so
// the deployment that ships migrations but forgets pb_hooks is not wide open
// (scripts/check-rule-floor.mjs boots exactly that deployment on purpose).
//
// The table, as implemented (triage/ticket columns are Phase 7.1 — their
// fields do not exist yet):
//
//   view site + comments   owner team client agent (agent: API only, the
//                          session route 403s an HTML document for it)
//   comment (top-level)    owner team client          (agent denied)
//   reply                  owner team client agent
//   edit/delete own        owner team client agent    (author check + hook)
//   resolve/reopen         owner team any; client own threads only; agent never
//   delete any comment     owner only                 (replies cascade)
//
// Why `@request.auth.role != ""` on list/view rather than project scoping:
// ADR 0005 gives each reviewed site its own deployment, so the accounts that
// exist are that project's stakeholders. The gap S3 named was that ANY
// authenticated — or role-less — token could read every comment. Requiring a
// role closes it without inventing project membership that the deployment
// model does not need (ADR 0008, S3 closure).
//
// Agent and `resolved`: the author branch would otherwise let an agent author
// toggle `resolved` on its own comment (a superuser can seed one). The matrix
// says the agent never resolves, so the author branch excludes that field when
// `role = "agent"`; an agent author can still edit its body.
migrate((app) => {
  const comments = app.findCollectionByNameOrId("comments");
  comments.listRule = '@request.auth.id != "" && @request.auth.role != ""';
  comments.viewRule = '@request.auth.id != "" && @request.auth.role != ""';
  comments.createRule =
    '@request.auth.id != "" && @request.auth.role != "" && @request.auth.role != "agent" && author = @request.auth.id';
  comments.updateRule =
    '@request.auth.id != "" && @request.auth.role != "" && (' +
    "(author = @request.auth.id && (@request.auth.role != \"agent\" || @request.body.resolved:isset = false))" +
    ' || ((@request.auth.role = "owner" || @request.auth.role = "team")' +
    " && @request.body.body:isset = false" +
    " && @request.body.selector:isset = false" +
    " && @request.body.anchorMeta:isset = false" +
    " && @request.body.path:isset = false" +
    " && @request.body.author:isset = false" +
    " && @request.body.project:isset = false" +
    " && @request.body.seq:isset = false" +
    "))";
  comments.deleteRule = '@request.auth.id != "" && (author = @request.auth.id || @request.auth.role = "owner")';
  app.save(comments);

  const replies = app.findCollectionByNameOrId("replies");
  // Same read gate as comments: a role-less token reads nothing. The agent may
  // read and reply; it may still only edit or delete its own replies.
  replies.listRule = '@request.auth.id != "" && @request.auth.role != ""';
  replies.viewRule = '@request.auth.id != "" && @request.auth.role != ""';
  replies.createRule = '@request.auth.id != "" && @request.auth.role != "" && author = @request.auth.id';
  replies.updateRule = '@request.auth.id != "" && author = @request.auth.id';
  replies.deleteRule = '@request.auth.id != "" && author = @request.auth.id';
  app.save(replies);
}, (app) => {
  // Back to the pre-3.10 shape: any authenticated user reads and, as a
  // non-author, may toggle `resolved`; the author/project/seq floor stays.
  const comments = app.findCollectionByNameOrId("comments");
  comments.listRule = '@request.auth.id != ""';
  comments.viewRule = '@request.auth.id != ""';
  comments.createRule = '@request.auth.id != "" && author = @request.auth.id';
  comments.updateRule =
    '@request.auth.id != "" && (author = @request.auth.id || (@request.body.body:isset = false && @request.body.selector:isset = false && @request.body.anchorMeta:isset = false && @request.body.path:isset = false && @request.body.author:isset = false && @request.body.project:isset = false && @request.body.seq:isset = false))';
  comments.deleteRule = 'author = @request.auth.id';
  app.save(comments);

  const replies = app.findCollectionByNameOrId("replies");
  replies.listRule = '@request.auth.id != ""';
  replies.viewRule = '@request.auth.id != ""';
  replies.createRule = '@request.auth.id != "" && author = @request.auth.id';
  replies.updateRule = 'author = @request.auth.id';
  replies.deleteRule = 'author = @request.auth.id';
  app.save(replies);
});
