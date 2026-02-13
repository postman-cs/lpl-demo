#!/usr/bin/env bash
# Validate all credentials for the BRAVE-Postman demo
# Run from project root: bash scripts/validate-credentials.sh
set -euo pipefail

# Load .env
if [ -f orchestrator/.env ]; then
    set -a
    source orchestrator/.env
    set +a
else
    echo "ERROR: orchestrator/.env not found"
    exit 1
fi

PASS=0
FAIL=0

check() {
    local name="$1"
    shift
    if "$@" > /dev/null 2>&1; then
        echo "  PASS  $name"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $name"
        FAIL=$((FAIL + 1))
    fi
}

echo "== Credential Validation =="
echo ""

# Postman API
echo "Postman:"
check "API key valid" curl -sf -H "X-Api-Key: $POSTMAN_API_KEY" https://api.getpostman.com/me

# GitHub
echo "GitHub:"
check "PAT valid" curl -sf -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/user
check "Org access" curl -sf -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/orgs/${GITHUB_ORG:-postman-cs}"

# AWS
echo "AWS:"
check "Credentials valid" aws sts get-caller-identity
check "Lambda access" aws lambda list-functions --max-items 1 --region "${AWS_REGION:-us-east-1}"
check "Secrets Manager" aws secretsmanager get-secret-value --secret-id api-credentials-dev --region "${AWS_REGION:-us-east-1}"

echo ""
echo "== Results: $PASS passed, $FAIL failed =="

if [ $FAIL -gt 0 ]; then
    echo "Fix failed credentials before running the demo."
    exit 1
fi
echo "All credentials valid."
