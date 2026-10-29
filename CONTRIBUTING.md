# Contributing to OpenRows

Thanks for your interest. Bug reports, feature requests, docs fixes and code are all welcome.

- **Bugs and ideas:** open an issue with the bug or feature template. Search first; add what you
  know to an existing issue rather than opening a duplicate.
- **Code:** for a small fix, send a pull request. For anything larger (a new feature, a new
  dependency, a change of behavior or of the database schema), open an issue first so we can agree
  on the change before you spend time on it.
- **Security issues:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Setup

You need Node 22 (22.12 or later; `nvm use` reads `.nvmrc`), npm (no pnpm, yarn or Bun) and, for
the dev stack and the integration tests, Docker with Compose v2.

```sh
git clone https://github.com/Draggable/openrows.git
cd openrows
npm ci                                # also installs the lefthook git hooks
npm run build
docker/compose.sh dev up -d --wait    # Postgres, Keycloak, Mailpit, S3 and the app on :8180
```

Sign in at http://localhost:8180 with `dev@openrows.test` / `openrows-dev-password`. For the
hot-reloading dev servers, start only the services
(`docker/compose.sh dev up -d --wait postgres keycloak mailpit s3`), apply the migrations with
`npm run db:migrate`, export the `OIDC_*` values from [.env.example](.env.example) and run
`npm run dev` (client on http://localhost:5173). See [docker/README.md](docker/README.md).

## The codebase

| Path | What it holds |
| --- | --- |
| `packages/shared` | Zod schemas, the API contracts, the field-type registry, the formula engine, the authorization table; built to `dist/`, so rebuild it after changing it |
| `packages/server` | The Hono API, the background worker, Drizzle schema and migrations, integration tests in `test/integration/` |
| `packages/client` | The React web app |
| `packages/sdk`, `mcp-server`, `n8n-nodes-openrows`, `blocks` | The npm packages: the SDK, the MCP server, the n8n nodes, the extensions SDK |
| `e2e/` | Playwright tests |
| `docker/`, `deploy/helm/` | The image, the Compose stacks and the Helm chart |
| `docs/` | The user guide, API docs and [architecture decision records](docs/adr/README.md) |

Read the ADRs before changing how records are stored, how tenants are isolated, realtime or jobs.

## Before you push

```sh
npm run lint          # Biome, plus the brand-name check; npm run lint:fix
npm run typecheck
npm run build
npm test              # unit tests (the Compose config tests need the Docker CLI)
npm run db:check      # migrations match packages/server/src/db/schema.ts
npm run test:integration   # server or database changes (needs a Docker daemon)
```

Rules reviewers check:

- Write tests first where practical. Tests sit next to the code (`foo.ts` → `foo.test.ts`);
  integration tests use a real Postgres, never a mocked database.
- Every route is registered through the server's `RouteRegistry` with an access rule, and gets a
  case in the cross-tenant matrix (`packages/server/test/integration/authz-matrix.test.ts`).
- Every record write goes through the RecordService (`packages/server/src/records/service.ts`).
- Schema changes go through Drizzle migrations (`npm run db:generate`), never `drizzle-kit push`.
  New tenant tables need row-level security and an isolation test.
- Field-type specifics live in the registry in `packages/shared/src/fields/`, not in
  `switch (field.type)` statements elsewhere.
- The client calls the API only through `api` in `packages/client/src/api/client.ts`.
- User-facing text says "OpenRows" (capital O and R); `npm run lint:brand` checks it.
- Keep the docs truthful: update the guide, the API docs or a README in the same pull request.

## Pull requests and commits

Branch from `main` and open the pull request against `main`. Keep it to one change, with tests,
and describe what changed and how you tested it. CI runs on GitHub Actions: lint, type checks,
the build, unit, integration and end-to-end tests, the Docker image and the Helm chart must pass.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), checked by
commitlint in the commit-msg hook: `feat(grid): ...`, `fix: ...`, `docs: ...`, `chore: ...`,
`ci: ...`, `build: ...`, `test: ...`, `refactor: ...`. Reference the issue with `Fixes #N`.

## License of contributions

Everything in this repository is licensed under the [GNU AGPL-3.0-only](LICENSE). By contributing
you agree that your contribution is licensed under the AGPL-3.0-only. No CLA or DCO sign-off is
required. The project's name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md), not by the
license.
