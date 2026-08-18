<div align="center">

# IsoForge
### Synchronized, MCP-enabled isometric diagramming

</div>

IsoForge keeps the FossFLOW editor experience and FossFLOW-compatible diagram
model while adding an authoritative celld-backed synchronization and MCP
deployment surface. The local runtime is a single Compose stack: LocalStack
provides persistent S3-compatible storage, celld runs the Worker and Durable
Objects, and the browser connects directly to celld's public listener.

## Upstream attribution

IsoForge is a continuation and integration of the upstream
[Abrar74774/FossFLOW](https://github.com/Abrar74774/FossFLOW) project. FossFLOW
credits [stan-smith/FossFLOW](https://github.com/stan-smith/FossFLOW), which in
turn derives from [markmanx/isoflow](https://github.com/markmanx/isoflow).
Those upstream names, licenses, and attribution remain part of this project;
the synchronized deployment layer does not replace that history.

## Local deployment

Prerequisite: Docker with Compose v2. Compose builds the library/app assets and
the Worker deploy helper in pinned build stages, then starts the complete
stack:

```sh
cp .env.example .env
docker compose up --build -d --wait
```

Open <http://localhost:8787>. Compose pins `ghcr.io/denoland/celld:v0.2.1`,
`localstack/localstack:4.14.0`, and the deploy helper's esbuild version. It
creates the S3 bucket idempotently, builds the browser assets into a named
volume, deploys the Worker plus those assets, and starts celld only after
deployment succeeds.
Only port 8787 is published; the internal celld listener stays private.

See [docs/LOCAL_DEPLOYMENT.md](docs/LOCAL_DEPLOYMENT.md) for the architecture,
MCP initialization compatibility, API/WebSocket routes, bearer-token option,
persistence, security assumptions, and validation commands.

## Development

```sh
npm run dev       # FossFLOW app development server
npm test
npm run lint
```

The Compose development override enables verbose celld logs while preserving
the same dependency order and private internal listener:

```sh
docker compose -f compose.yml -f compose.dev.yml up --build -d --wait
```

MIT licensed. See the existing language-specific documentation under `docs/`
and the upstream FossFLOW materials for the broader editor and library
history.
