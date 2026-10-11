#!/usr/bin/env bash
#
# Deploy lambda-outbound-proxy with the AWS CLI only.
#
# RESPONSE_STREAM is hard-coded as the ONLY invoke mode. The proxy streams
# every byte of the upstream response and never buffers, so a buffered Function
# URL would be a misconfiguration — it is not offered here.
#
# Usage:
#   ROLE_ARN=arn:aws:iam::<acct>:role/<lambda-exec-role> ./scripts/deploy.sh
#
set -euo pipefail

FUNCTION_NAME="${FUNCTION_NAME:-lambda-outbound-proxy}"
REGION="${AWS_REGION:-us-east-1}"
RUNTIME="nodejs24.x"
HANDLER="lambda-outbound-proxy.handler"
INVOKE_MODE="RESPONSE_STREAM"   # <-- only supported mode
ARCH="arm64"

if [[ -z "${ROLE_ARN:-}" ]]; then
  echo "ROLE_ARN env var is required (Lambda execution role ARN)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Building artifact (dist/lambda-outbound-proxy.mjs)"
npm run build >/dev/null

echo "==> Packaging"
# The artifact is a single self-contained ESM file; the AWS SDK is provided by
# the runtime (external). No node_modules are shipped.
ZIP="$(mktemp -d)/function.zip"
( cd dist && zip -q "$ZIP" lambda-outbound-proxy.mjs )

echo "==> Creating or updating function '$FUNCTION_NAME'"
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP" \
    --region "$REGION" >/dev/null
  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" --handler "$HANDLER" \
    --timeout 900 --memory-size 512 \
    --environment "Variables={PROXY_TARGET_SCHEME=https}" \
    --region "$REGION" >/dev/null
else
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" --handler "$HANDLER" \
    --role "$ROLE_ARN" \
    --architectures "$ARCH" \
    --timeout 900 --memory-size 512 \
    --environment "Variables={PROXY_TARGET_SCHEME=https}" \
    --zip-file "fileb://$ZIP" \
    --region "$REGION" >/dev/null
fi

aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"

echo "==> Configuring Function URL (InvokeMode=$INVOKE_MODE, AuthType=AWS_IAM)"
if aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type AWS_IAM \
    --invoke-mode "$INVOKE_MODE" \
    --region "$REGION" >/dev/null
else
  aws lambda create-function-url-config \
    --function-name "$FUNCTION_NAME" \
    --auth-type AWS_IAM \
    --invoke-mode "$INVOKE_MODE" \
    --region "$REGION" >/dev/null
fi

URL="$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$REGION" --query FunctionUrl --output text)"
echo "==> Deployed. Function URL: $URL"
echo "    Invoke mode: $INVOKE_MODE (streaming only)"
