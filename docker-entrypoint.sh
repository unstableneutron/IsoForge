#!/bin/sh
set -eu

if [ "${1:-}" != "deploy" ]; then
  echo "usage: docker-entrypoint.sh deploy" >&2
  exit 64
fi

: "${CELLD_BUCKET:?CELLD_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${AWS_REGION:?AWS_REGION is required}"

worker_project=/workspace/packages/isoforge-worker
static_assets=/workspace/packages/isoforge-worker/public

if [ ! -f "$worker_project/wrangler.jsonc" ]; then
  echo "missing $worker_project/wrangler.jsonc; build or check out the Worker first" >&2
  exit 66
fi

if [ ! -d "$static_assets" ]; then
  echo "missing $static_assets; run the FossFLOW app production build first" >&2
  exit 66
fi

echo "Deploying Worker and static assets from $worker_project"
exec celld deploy "$worker_project" \
  --bucket "s3://$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" \
  --region "$AWS_REGION"
