# ADR-008: Repository split at the public launch

- **Status:** Accepted (2026-10-29); takes effect at the v1.0.0 launch
- **Related:** [ADR-005](005-open-core.md) (open core), [ADR-004](004-jobs.md) (one image)

## Context

Until the launch, the AGPL core and the hosted edition's commercial code (`ee/`: billing, the
cloud composition root, enterprise single sign-on, SCIM, audit logs, the admin console, the
marketing site, the Zapier and Make apps) shared one private repository, together with the
production deploy and its runbooks. ADR-005 kept them apart inside it: the core never imports the
hosted code, builds and passes its tests without it, and ships an image without it.

Making that repository public would publish the hosted offering and the whole development
history (every past commit still holds `ee/`), and its issues reference internal work.

## Decision

1. **A fresh public repository for the core.** `Draggable/openrows` is recreated from a clean
   snapshot of the core: one initial commit, no history, no old issues. The development
   repository is renamed and kept private as an archive. Everything in the public repository is
   AGPL-3.0-only; the name and logo are trademarks (TRADEMARKS.md).
2. **The hosted edition is a private overlay.** A private repository holds the hosted-only code
   at the paths it has in the combined tree (`ee/`, the production Compose files, deploy and ops
   scripts, internal runbooks). It pins one core commit; its CI checks out the core at that
   commit, lays the overlay over it, installs one lockfile for the combined workspaces, and
   tests and builds the hosted image from that tree. The overlay may replace a few core files
   (the Dockerfile with its hosted targets, the test and lint configs); each records the core
   version it was merged with, and the build refuses a core whose file changed since.
3. **The core keeps its plug-in interfaces.** Hosted features keep plugging into
   `packages/server/src/edition/` (ADR-005 §4); the core neither imports nor names the hosted
   repository. The public repository builds, tests and publishes the open-source image on its
   own, on GitHub-hosted runners.
4. **Production deploys from the private repository**, after its CI passed for a core pin and
   an overlay commit. A core change reaches production by moving the pin, which an automated
   job does for every green commit on the core's `main`.

## Consequences

- Contributors see only the core; the hosted edition's code and operations stay private.
- A core change can't break production by itself: it reaches it through the pin, after the
  hosted CI passed on the combined tree.
- Changes that span both (a new edition interface and its hosted implementation) land in the
  core first, then in the overlay with the bumped pin.
- Overridden core files need a manual merge when the core changes them.

## Alternatives considered

- **Rewrite the existing repository's history** (`git filter-repo` to drop `ee/` and the ops
  files) and make it public. Every old commit, message and issue would have to be audited, and
  one miss publishes hosted code. Rejected for the fresh snapshot.
- **A git submodule of the core inside the private repository.** Moves the core to `core/`, so
  every relative path in the hosted code, the Dockerfile and the tests changes. The overlay keeps
  the paths both sides already use.
- **Build the hosted edition on the published npm packages.** The server isn't published to npm,
  and publishing it only for this would add a release step to every deploy.
