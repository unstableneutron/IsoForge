# syntax=docker/dockerfile:1.7

ARG CELLD_IMAGE=ghcr.io/denoland/celld:v0.2.1@sha256:7a4380721b6400073f2a26afe70a828410169f658d31b5ef61383e648ca0c530
ARG ESBUILD_VERSION=0.25.9

# Install the workspace dependencies once and reuse them in both build
# targets. This keeps a clean-checkout Compose startup from doing two network
# installs and keeps the Worker bundler on the lockfile-resolved dependency
# graph.
FROM node:24.19.0-bookworm-slim AS node-dependencies
WORKDIR /workspace
COPY package*.json ./
COPY tsconfig.base.json ./
COPY packages/fossflow-lib/package*.json ./packages/fossflow-lib/
COPY packages/fossflow-app/package*.json ./packages/fossflow-app/
COPY packages/isoforge-worker/package*.json ./packages/isoforge-worker/
RUN npm ci --no-fund --no-audit

# Build the browser assets in a repeatable image. The output is copied to a
# Compose named volume by the one-shot `assets` service; no host build/
# directory is required for a clean checkout.
FROM node-dependencies AS fossflow-assets
COPY packages/fossflow-lib ./packages/fossflow-lib
COPY packages/fossflow-app ./packages/fossflow-app
RUN npm run build:lib && npm run build:app
RUN mkdir -p /out && cp -a packages/fossflow-app/build/. /out/

# Keep the deployment helper on the exact celld release used by the runtime.
FROM ${CELLD_IMAGE} AS celld-binary

# celld deploy intentionally delegates Worker bundling to esbuild. This image
# contains no HTTP server; it only runs the one-shot deploy command.
FROM node:24.19.0-bookworm-slim AS celld-deploy
ARG ESBUILD_VERSION
COPY --from=celld-binary /usr/local/bin/celld /usr/local/bin/celld
RUN npm install --global --no-fund --no-audit --allow-scripts=esbuild esbuild@${ESBUILD_VERSION}
COPY --from=node-dependencies /workspace/node_modules /workspace/node_modules
COPY --from=node-dependencies /workspace/packages/isoforge-worker/node_modules /workspace/packages/isoforge-worker/node_modules
COPY packages/isoforge-worker/ /workspace/packages/isoforge-worker/
COPY docker-entrypoint.sh /usr/local/bin/isoforge-entrypoint
RUN chmod 0755 /usr/local/bin/isoforge-entrypoint
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/isoforge-entrypoint"]
