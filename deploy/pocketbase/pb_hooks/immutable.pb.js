// pb_hooks/immutable.pb.js
// Author, project and seq (comments) / author and comment (replies) are
// immutable after create (S2, ADR 0008).
//
// Why a hook and not the rule string: PocketBase API rules can only say
// "this request body must not contain field X". That is a blocklist, and it
// has two holes the assessment found: a field the rule forgets (`seq`) is
// writable by anyone, and the author branch of the rule has to allow every
// field so the author can edit their own body — including `author` and
// `project`. Comparing against the stored row closes both.
//
// `e.record.original()` returns the DB state before the request was applied
// (types.d.ts, 0.39.11), so a client that echoes unchanged fields back — a
// full-record PUT, or a PATCH built from a form — is still accepted. Only a
// real change is rejected.
//
// 400, not 403: an immutable field in the body is a malformed request, not a
// permission problem, and 400 is what the e2e permission specs assert.
//
// The two handlers are written out in full rather than sharing a helper:
// PocketBase's JSVM runs each .pb.js file in its own scope pool, and a
// top-level `function` is NOT visible from the handler when it runs later —
// calling one throws a ReferenceError, which PocketBase surfaces as a bare
// 400 on every update (this hook rejected valid edits until the logic was
// inlined).
//
// Phase 3 adds the role matrix on top; this hook stays as-is.
onRecordUpdateRequest((e) => {
  const original = e.record.original();
  const immutable = ["author", "project", "seq"];
  for (let i = 0; i < immutable.length; i++) {
    const field = immutable[i];
    // Relation fields normalise to a string id, seq to a number. Compare as
    // strings so an echoed 0/"0" or null/"" doesn't look like a change.
    const before = String(original.get(field) ?? "");
    const after = String(e.record.get(field) ?? "");
    if (before !== after) {
      throw new BadRequestError(field + " is immutable");
    }
  }
  // Request hooks must hand control back to PocketBase's default handler;
  // without e.next() the update is skipped and the API answers 200 with the
  // record unchanged (hit while building this hook: valid edits "succeeded"
  // and silently did nothing).
  e.next();
}, "comments");

onRecordUpdateRequest((e) => {
  const original = e.record.original();
  const immutable = ["author", "comment"];
  for (let i = 0; i < immutable.length; i++) {
    const field = immutable[i];
    const before = String(original.get(field) ?? "");
    const after = String(e.record.get(field) ?? "");
    if (before !== after) {
      throw new BadRequestError(field + " is immutable");
    }
  }
  e.next();
}, "replies");
