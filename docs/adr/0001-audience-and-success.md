# ADR 0001: Audience and definition of success

**Status:** Accepted 2026-11-25 (Tom)

## Context

The 2026-08-19 reboot defined *what* to build but not *who for* or *when it
counts as done*. As a result the work stopped at "the unit tests pass", even
though the product didn't work (see `docs/assessment/2026-11-25-state-of-the-repo.md`).

## Decision

- **Users:** our own team plus the client's team members, who review a
  project we are building for them. An AI agent may take part as a
  reviewer or responder; that role is not defined yet (see ADR 0008 and
  the open questions in the plan).
- **Success:** dogfooding c11n on **one specific client project, with that
  client's team**. Generality comes later.

## Consequences

- Proxy hardening only has to cover **the dogfood site's** stack (its host,
  auth and origin quirks). It does not have to cover the web at large.
  Supporting arbitrary third-party sites is out of scope until after the
  dogfood run.
- Client users are external people with real identities, so identity and
  access are first-class and v1 work (ADR 0006).
- Single-tenant is fine (ADR 0005).
- The plan's exit criteria are measured on the dogfood run, not on demo
  fixtures.
