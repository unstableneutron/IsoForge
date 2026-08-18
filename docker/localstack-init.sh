#!/bin/sh
set -eu

bucket="${CELLD_BUCKET:-isoforge-celld}"
case "$bucket" in
  ''|*/*)
    echo "CELLD_BUCKET must be a non-empty S3 bucket name without a prefix" >&2
    exit 64
    ;;
esac

# LocalStack's ready hook is retried by Compose's healthcheck until this
# deterministic idempotent operation is visible through the S3 API.
if awslocal s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  echo "S3 bucket already exists: $bucket"
else
  awslocal s3api create-bucket --bucket "$bucket" >/dev/null
  echo "Created S3 bucket: $bucket"
fi
