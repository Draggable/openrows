# ADR-005: Open-core boundary and licensing

- **Status:** Accepted (2026-10-25); the repository layout (§2, §5) is superseded by
  [ADR-008](008-repository-split.md) at the public launch
- **Related:** [LICENSE](../../LICENSE), [ADR-008](008-repository-split.md) (the repository split)

## Context

OpenRows is an open-source Airtable alternative and also a paid hosted service at
`app.openrows.io`. The open-source edition has to be a complete, genuinely useful product.
Competitors shouldn't be able to resell a closed fork as a hosted service. The code that only
the hosted business needs should stay out of the open-source edition.

## Decision

1. **The core is `AGPL-3.0-only`.** That covers everything outside `ee/`: server, worker,
   client, shared, SDK, MCP server, Docker files and docs. Every `package.json` says
   `"license": "AGPL-3.0-only"`. Anyone who runs a modified core as a network service must
   offer its source to their users.
2. **`ee/` is under the OpenRows Commercial License** (source-available; production use needs a
   paid hosted subscription or an agreement with Draggable; no redistribution). Code goes in
   `ee/` only if it is **hosted-only and paid**:
   - billing (Polar, seat-based), plans and entitlement limits, usage metering;
   - enterprise SSO (per-workspace SAML or OIDC via Keycloak identity brokering), SCIM
     provisioning, audit-log export and long retention;
   - the hosted ops console (system admin, ADR-002) and tenant routing or sharding tooling.
3. **Self-hosters get the full product.** That includes all field types, views, formulas,
   links, lookups and rollups, realtime, comments, sharing, forms, embeds, the API, webhooks,
   automations, import/export, revision history, table- and field-level permissions, and OIDC
   login against their own provider (ADR-006). There are no artificial record or row limits.
   The activity log and revision history are core; only the enterprise export and retention
   features are `ee/`.
4. **The core never imports `ee/`.** Dependencies point one way. The core defines plug-in
   interfaces with open-source defaults:
   - `BillingProvider` (none);
   - `Entitlements` (unlimited);
   - `UsageMeter` (no-op);
   - `AuditSink` (writes the core activity log);
   - `IdentityProviderAdmin` (none).

   The hosted entry point (`ee/server/main.ts`) imports the core's `createApp({ plugins })` and
   passes the `ee/` implementations. The core must build, start and pass every test with `ee/`
   deleted.
5. **Enforcement in CI (with and M5).**
   - A Biome `noRestrictedImports` rule bans `ee/` and `@openrows/ee*` paths in `packages/**`.
   - A boundary script fails if any file outside `ee/` resolves an import into `ee/`.
   - A CI job deletes `ee/` and runs `npm ci && npm run build && npm test`.

   Files in `ee/` start with `// SPDX-License-Identifier: LicenseRef-OpenRows-Commercial`.
   Core files may carry `// SPDX-License-Identifier: AGPL-3.0-only`.
6. **Contributions.** Core contributions come in under AGPL-3.0 (inbound = outbound), with a
   DCO sign-off. Before we accept the first substantial external contribution, the maintainers decide
   whether to require a CLA. A CLA would let Draggable dual-license the core later, and it
   removes any doubt about running AGPL contributions alongside the commercial `ee/` code in
   the hosted product. Nobody outside Draggable gets to contribute to `ee/`.

## Consequences

- Hosted features have to be designed as plug-ins against core interfaces. That keeps the core
  clean, and self-hosters get sensible defaults for free.
- When a feature is borderline (for example, field-level permissions), it goes in the core if
  self-hosters need it to run OpenRows for a team.
- `ee/LICENSE` is a draft and needs legal review before the first `ee/` code ships (M5).
- Because of AGPL, some companies won't use the core. That's an accepted trade-off. The hosted
  product and commercial agreements cover them.

## Implementation

The core side lives in `packages/server/src/edition/`: the interfaces (`types.ts`), their
open-source defaults (`oss.ts`), the hook registry (`hooks.ts`) and `resolveEdition`
(`index.ts`), with `EDITION=oss|cloud` in `config.ts`. The hosted implementations, and the notes
on how they were built, live in the hosted edition's private repository
([ADR-008](008-repository-split.md)).







## Alternatives considered

- **MIT or Apache-2.0 core.** Lets a competitor resell a closed hosted fork. Rejected.
- **BSL, SSPL or Elastic license for everything.** Not OSI open source, which hurts trust and
  distribution.
- **A separate private repository for hosted code.** It hides the code, but cross-repo changes
  and CI get harder. With `ee/` in the same repo, the boundary is visible and testable.





