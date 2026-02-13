# CI/CD Pipeline Integration Guide

## Overview

Every API provisioned through BRAVE ships with a GitHub Actions workflow that integrates Postman test execution into the CI/CD pipeline. This document describes the workflow structure, configuration, and what happens at each stage.

## Pipeline Structure

```
Push to main
    |
    +-- [Job 1] Unit Tests + Lint (always)
    |       - pytest
    |       - flake8, black
    |
    +-- [Job 2] Validate OpenAPI Spec (always)
    |       - swagger-cli validate
    |
    +-- [Job 3] Deploy to Dev (after Jobs 1+2 pass, main only)
    |       - Package Lambda
    |       - Update function code
    |       - Output invoke URL
    |
    +-- [Job 4] Smoke Tests (after Job 3)
    |       - postman-cli login
    |       - Run smoke collection against deployed service
    |       - Upload JUnit results
    |
    +-- [Job 5] Contract Tests (after Job 3, parallel with Job 4)
            - postman-cli login
            - Run contract collection against deployed service
            - Upload JUnit results
```

## GitHub Actions Secrets Required

These are set at the repository level (or org level for `postman-cs`):

| Secret | Description |
|--------|-------------|
| `POSTMAN_API_KEY` | Postman API key for CLI authentication |
| `AWS_ACCESS_KEY_ID` | AWS credentials for Lambda deployment |
| `AWS_SECRET_ACCESS_KEY` | AWS credentials for Lambda deployment |

## GitHub Actions Variables Required

These are set at the repository or environment level:

| Variable | Description | Example |
|----------|-------------|---------|
| `FUNCTION_NAME` | Lambda function name | `order-management-api` |
| `API_GATEWAY_URL` | API Gateway invoke URL | `https://abc.execute-api.us-east-1.amazonaws.com` |
| `API_GATEWAY_ID` | API Gateway ID | `abc123xyz` |
| `POSTMAN_SMOKE_COLLECTION_UID` | Smoke test collection UID | `12345678-abcd-efgh-ijkl` |
| `POSTMAN_CONTRACT_COLLECTION_UID` | Contract test collection UID | `12345678-mnop-qrst-uvwx` |
| `POSTMAN_ENVIRONMENT_UID` | Dev environment UID | `12345678-yzab-cdef-ghij` |

These variables are pre-populated during provisioning (written to `.env.example` as a reference).

## Postman CLI Commands

The workflow uses the Postman CLI (not Newman) for collection runs:

```bash
# Login (once per job)
postman login --with-api-key $POSTMAN_API_KEY

# Run a collection
postman collection run <COLLECTION_UID> \
    --environment <ENVIRONMENT_UID> \
    --env-var "baseUrl=https://deployed-url.com" \
    --reporters cli,junit \
    --reporter-junit-export results.xml
```

The `--env-var` flag overrides the `baseUrl` in the environment with the actual deploy URL from the current pipeline run, ensuring tests always target the freshly deployed service.

## Test Types

### Smoke Tests

Fast validation that the deployed service is reachable and responding correctly.

**Per endpoint, validates:**
- HTTP status code matches expected (e.g., 200 for GET, 201 for POST)
- Response time under 2000ms (configurable via `RESPONSE_TIME_THRESHOLD` env variable)
- Response body is not empty (except for 204 No Content)

**Use case:** Run after every deployment to catch infrastructure issues (bad IAM, network config, missing env vars).

### Contract Tests

Comprehensive validation that the API response matches the OpenAPI specification.

**Per endpoint, validates:**
- Everything in smoke tests
- `Content-Type: application/json` header present
- All required fields exist in response body
- Enum fields contain valid values
- UUID fields match UUID format
- Date-time fields are valid ISO 8601

**Use case:** Run on PRs to catch specification drift. Ensures that code changes don't break the API contract.

## Extending the Pipeline

### Adding Security Scans

The workflow can be extended with additional jobs. LPL's existing Wiz and Arnica scans can run as parallel jobs:

```yaml
security-scan:
    name: Security Scan
    needs: unit-tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Existing Wiz/Arnica scan steps from LPL DevOps templates
```

### Adding SonarQube

SonarQube integration follows the same pattern as existing LPL repos:

```yaml
sonar-scan:
    name: SonarQube Analysis
    needs: unit-tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Existing SonarQube scan steps from LPL DevOps templates
```

### Promoting to QA

The current workflow deploys to dev. To promote to QA, add a deployment job with an environment gate:

```yaml
deploy-qa:
    name: Deploy to QA
    needs: [postman-smoke-tests, postman-contract-tests]
    if: success()
    runs-on: ubuntu-latest
    environment: qa  # Requires manual approval
    steps:
      # Same deploy steps targeting QA Lambda + APIGW
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `postman login` fails | Invalid or expired API key | Rotate key in Postman, update GitHub secret |
| Collection run returns 0 tests | Wrong collection UID | Verify UID in Postman, update GitHub variable |
| Tests pass locally, fail in CI | Environment mismatch | Check that `baseUrl` override is correct in workflow |
| Deploy succeeds, smoke tests fail | Lambda cold start timeout | Increase `RESPONSE_TIME_THRESHOLD` or add warmup |
| Contract tests fail after code change | Spec drift | Update `openapi.yaml` to match new response schema, re-generate collections |
