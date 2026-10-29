# Architecture decision records

An ADR records one significant decision: its context, the decision itself, its consequences
and the alternatives we rejected. To change an accepted decision, write a new ADR that
supersedes it; don't rewrite the old one. Small dated decisions go in
[000-notes.md](000-notes.md).

| ADR | Decision | Status |
| --- | --- | --- |
| [000](000-notes.md) | Decision notes: toolchain baseline, lint/format, type-check scripts | Living document |
| [001](001-record-storage.md) | Record storage: one physical Postgres table per user table, junction tables for links | Accepted (2026-10-25) |
| [002](002-tenancy.md) | Tenancy: workspace = tenant, `workspace_id` everywhere, RLS on shared tables, separate system-admin flag | Accepted |
| [003](003-realtime.md) | Realtime: server-authoritative cell ops, per-cell LWW with versions, outbox → LISTEN/NOTIFY or Redis | Accepted |
| [004](004-jobs.md) | Jobs: pg-boss in a separate worker process from the same image | Accepted |
| [005](005-open-core.md) | Open core: an AGPL-3.0 core with plug-in interfaces; hosted-only paid code outside it, never imported by the core | Accepted (2026-10-25); layout superseded by 008 |
| [006](006-auth-provider.md) | Auth: Keycloak, or any OIDC provider, via OIDC; server-side sessions; no better-auth | Accepted (2026-10-25) |
| [007](007-grid-rendering.md) | Grid rendering: DOM row and column virtualization with TanStack Virtual, ARIA grid, windowed loading (Glide considered) | Accepted (2026-10-25) |
| [008](008-repository-split.md) | Repository split at the public launch: the AGPL core in a public repository with fresh history, the hosted edition in a private overlay repository pinned to a core commit | Accepted (2026-10-29) |

Template: a title `# ADR-NNN: <decision>`, then **Status**, **Issue** and **Related**, and the
sections Context, Decision, Consequences and Alternatives considered. Aim for one to three
pages.
