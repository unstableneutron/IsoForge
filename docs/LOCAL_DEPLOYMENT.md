# IsoForge local deployment

IsoForge is a browser-first diagram editor backed by a Cloudflare Workers-shaped
application running in [celld](https://github.com/denoland/celld). The local
stack has no Node HTTP or WebSocket server:

```text
Browser :8787
    │ public listener only
    ▼
celld v0.2.1 ── deployed Worker ──┬─ DurableObject DiagramCatalog
    │                             └─ DurableObject DiagramCell (SQLite)
    ├── private 127.0.0.1:8788 operator/peer listener
    └── S3 API ── LocalStack v4.14.0 ── persistent localstack-data volume

assets (one-shot build/init)
    └── builds the browser bundle into a persistent Compose volume

celld deploy (one-shot init)
    ├── pins the Worker source and esbuild version in the deploy image
    └── uploads the Worker plus the built browser bundle before celld starts
```

The celld fleet bucket is the durable source of truth for deployments, Durable
Object state, leases, and peer-authentication metadata. The local `celld-state`
volume holds celld's local SQLite/replication working directory and asset cache.
LocalStack's `localstack-data` volume persists the S3 bucket across ordinary
`docker compose down` / `up` cycles. `docker compose down -v` intentionally
deletes both volumes and is a destructive reset.

## Attribution

IsoForge preserves the upstream FossFLOW project and attribution. The editor
and its compatible diagram model are derived from [Abrar74774/FossFLOW](https://github.com/Abrar74774/FossFLOW),
which in turn credits [stan-smith/FossFLOW](https://github.com/stan-smith/FossFLOW)
and the original [markmanx/isoflow](https://github.com/markmanx/isoflow) work.
The FossFLOW/isoflow names remain part of the compatibility and attribution
surface; this deployment layer does not remove or replace that history.

## Exact startup

Run these commands from the repository root. Compose builds the browser bundle
in the pinned Node build stage, builds the Worker deploy helper with pinned
`esbuild@0.25.9`, and runs both one-shot stages before serving.

```sh
cp .env.example .env
docker compose up --build -d --wait
```

The Worker input must contain `packages/isoforge-worker/wrangler.jsonc`. The
one-shot `assets` service builds the app into a named volume, and the one-shot
`deploy` service fails closed with an actionable error when the Worker input is
missing. No host `packages/fossflow-app/build/` directory or pre-installed host
dependencies are required for this Compose path.

The `--build` flag is intentional: the deploy image copies the Worker source
and its runtime dependencies into a pinned image, so a Worker source change is
not silently hidden by a stale container layer. Compose waits for LocalStack's
healthy S3 bucket, runs `celld deploy`, and only then starts celld. Re-running
the command is idempotent for unchanged content; celld computes a content
addressed deployment version and publishes the current pointer last.

celld nodes load a deployment at startup. On a clean checkout the dependency
chain starts celld after deploy automatically. When updating an already-running
checkout, restart celld after the deploy completes so it loads the new pointer:

```sh
docker compose up --build -d --wait
docker compose restart celld
```

Useful lifecycle commands:

```sh
docker compose ps
docker compose logs -f celld
docker compose down                 # keep persistent volumes
docker compose down -v              # reset LocalStack and celld state
docker compose -f compose.yml -f compose.dev.yml up --build -d --wait
```

## Public and private routes

Only `CELLD_PUBLIC_PORT` (8787 by default) is published to the host. The celld
internal listener is bound to `127.0.0.1:8788` inside the celld container and
has no Compose `ports` mapping. It is intentionally not a public API. celld's
public readiness route is reserved at `/__celld/health`; the deployed Worker
owns `/health` and all other public paths.

The Worker routes are:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Worker/runtime health JSON |
| `GET` | `/api/diagrams` | List persisted diagram summaries |
| `POST` | `/api/diagrams` | Create a diagram, optionally with a FossFLOW-compatible state |
| `GET` | `/api/diagrams/:id` | Read the canonical diagram record |
| `GET` | `/api/diagrams/:id/state` | Read state, schema version, and revision |
| `POST` | `/api/diagrams/:id/operations` | Atomically apply operations with `expectedRevision` and `idempotencyKey` |
| `GET` | `/api/diagrams/:id/export` | Download canonical diagram JSON |
| `GET` | `/ws/diagrams/:id` | WebSocket snapshot and subsequent authoritative changes |
| `POST` | `/mcp` | Current request-scoped MCP HTTP plus stateless 2025 compatibility |

The browser and MCP clients use relative URLs. A `409 REVISION_CONFLICT` means
the server is authoritative: fetch the current state and retry from that
revision. WebSocket clients receive a `diagram.snapshot` first, then monotonic
`diagram.patch` messages. A client may send `ping` and receives `pong`.

Quick checks after startup:

```sh
curl -fsS http://localhost:8787/__celld/health
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:8787/api/diagrams
```

The Compose healthcheck uses the native celld binary because the upstream celld
image deliberately contains only celld and CA certificates. It first unsets
`CELLD_ADDR` and `CELLD_INTERNAL_ADDR` so `diagnose` cannot try to bind the
serving listeners, then checks the explicitly configured bucket, endpoint, and
region in read-only mode. The first command above is the direct public
listener check.

## MCP at `/mcp`

The authoritative protocol is MCP `2026-07-28`. That revision is
request-scoped and removed the old initialization/session lifecycle. A minimal
modern discovery request uses the required standard headers and repeats the
protocol/client declaration in `_meta`:

```sh
curl -sS http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"local-check","version":"0.1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

IsoForge uses the official `@modelcontextprotocol/server@2.0.0`
`createMcpHandler` web-standard surface. Its documented stateless fallback is
deliberately enabled for deployed 2025-era clients that still begin with
`initialize`. Such clients use the same URL and the date they implement, for
example `2025-06-18`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "legacy-client", "version": "2025-era" }
  }
}
```

Each compatibility POST is served statelessly; IsoForge does not issue or
require an `Mcp-Session-Id`. Use normal `tools/list` and `tools/call` POSTs.
Available tools include
`create_diagram`, `list_diagrams`, `get_diagram`, `get_diagram_state`,
`apply_diagram_operations`, `search_icons`, and `export_diagram_json`.

### Optional bearer token

The public endpoint is unauthenticated by default for local development. To
enable the Worker token check without putting a credential in `.env.example`,
export a token in the invoking shell:

```sh
export MCP_BEARER_TOKEN="replace-with-a-long-random-local-token"
docker compose up --build -d --wait
curl -fsS http://localhost:8787/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"local-check","version":"0.1.0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The token is passed to the Worker as celld's `CELLD_VAR_MCP_BEARER_TOKEN`
override. It protects `/mcp`; it is not a replacement for TLS, a reverse
proxy, or production identity management. Do not commit the token or expose
the private celld listener.

## Security assumptions

This Compose file is a local development boundary:

- LocalStack credentials default to the literal non-secret values `localstack`
  / `localstack`. Replace them, and use a real least-privilege S3 identity,
  before adapting the topology to a shared environment.
- celld does not terminate TLS and does not authenticate public Worker users.
  Put TLS, authentication, rate limiting, and origin policy in a trusted
  ingress for anything beyond localhost.
- The internal operator API is unauthenticated. It is loopback-bound inside
  the celld container and no internal port is published; do not change that
  without putting the listener on a private encrypted network.
- `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` are passed to the Worker for MCP
  host/origin validation. Both values are comma-separated hostnames (for
  example `localhost,127.0.0.1,[::1]`), not `http://` URL strings. Set them
  explicitly when the browser is served from a different origin.
- The S3 bucket contains deployments, Durable Object state, leases, and the
  fleet peer-authentication secret. Treat access to it as celld administrator
  access.

## Validation

Static Compose validation does not require the Worker build or a running
Docker daemon:

```sh
docker compose config --quiet
docker compose -f compose.yml -f compose.dev.yml config --quiet
```

Runtime validation, after the exact startup above, is:

```sh
docker compose ps
docker compose logs --no-log-prefix deploy
curl -fsS http://localhost:8787/__celld/health
curl -fsS http://localhost:8787/health
curl -fsS http://localhost:8787/api/diagrams
docker compose exec localstack awslocal s3api head-bucket \
  --bucket "${CELLD_BUCKET:-isoforge-celld}"
```

The expected Compose state is `localstack` and `celld` healthy, `deploy`
exited with status 0, and only host port 8787 published by the stack. If
`docker compose config --quiet` fails, fix that configuration error first;
if source/build inputs are unavailable, report the exact missing path rather
than claiming a runtime deployment was validated.
