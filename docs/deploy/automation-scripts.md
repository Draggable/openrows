# Run-script automation steps

The "Run a script" action runs a creator's JavaScript in a sandbox. It is **off by default**
(`AUTOMATION_SCRIPTS=off`). Self-hosted servers can turn it on for every workspace; on the hosted
service it is a paid-plan feature, gated server-side through `ScriptSandbox.limitsFor` (the plan
hook arrives with billing; until then app.openrows.io leaves it off).

## How a script runs

`packages/server/src/automations/script/`:

- **Executor** (`types.ts`, `ScriptExecutor`): `local-container` today (`local-container.ts`). A
  remote executor (for example a runner on another machine over a private network with mutual
  auth) can implement
  the same interface later; the protocol below already works over any byte stream.
- **One throwaway container per script**: `docker run --rm` with `--network none`, `--read-only`
  and an 8 MB `noexec` tmpfs at `/tmp`, user `65534` (nobody), `--cap-drop ALL`,
  `no-new-privileges`, Docker's default seccomp profile, `--ipc none`, memory and swap
  `AUTOMATION_SCRIPT_MEMORY_MB` (V8's heap at 60 % of it), 1 CPU, 32 processes, RLIMIT_CPU
  `AUTOMATION_SCRIPT_CPU_SECONDS`, 64 open files, no core dumps, `--log-driver none`,
  `--pull never`. No `-e`, mounts or devices: the container gets the image's own environment and
  nothing of the server's. `AUTOMATION_SCRIPT_RUNTIME=runsc` adds gVisor if the host has it.
- **No token, no network.** The script's `base` client and `fetch` are JSON-line calls over the
  container's stdio (`runner.ts` inside, `supervise.ts` outside). The server answers them
  (`bridge.ts`) in the run's transaction, in a savepoint per call, as the person the automation
  runs as with their live role: tables of the automation's base only, the RecordService's table
  and field edit permissions on every write, `fetch` through the SSRF-safe client
  (`OUTBOUND_HTTP_*`, 20 requests, 1 MB, 10 s each). Scripts never see a credential.
- **Limits the supervisor enforces**: the wall clock (`AUTOMATION_SCRIPT_TIMEOUT_SECONDS`, the
  container is removed with `docker rm --force`), 8 MB printed, 500 calls, a 64 KB output,
  200 log lines (32 KB). `AUTOMATION_SCRIPT_CONCURRENCY` containers per process at once.
- Inside, the script runs in a `vm` context with only `input`, `output`, `base`, `fetch` and
  `console`, and node runs with `--disallow-code-generation-from-strings`. That context is not
  the boundary; the container is. The escape suite
  (`packages/server/test/integration/automation-scripts.test.ts`) runs a probe with full Node
  inside the container to prove it holds.

## Turning it on

1. The processes that run automations (the worker, and the api for the builder's test runs and
   retries) need the `docker` CLI and a Docker daemon (`AUTOMATION_SCRIPT_DOCKER`, `DOCKER_HOST`).
2. `docker pull` the image named by `AUTOMATION_SCRIPT_IMAGE` (default: the Node 22 image of
   `docker/Dockerfile`, pinned by digest). Runs never pull; a missing image fails the step with
   a message saying so.
3. Set `AUTOMATION_SCRIPTS=local-container` on both processes and restart them.

**Caution:** whatever can reach the Docker daemon is root on that host. The OpenRows image does
not ship the docker CLI, and the Compose files don't mount the Docker socket, on purpose. Before
enabling scripts in containers, decide how the worker reaches a daemon: a
dedicated, otherwise empty Docker host or VM (a remote `DOCKER_HOST` over TLS), or a rootless
daemon, rather than the host's `/var/run/docker.sock`. Running scripts on a separate machine
(the `remote` executor idea) keeps a sandbox escape off the app's host entirely.
