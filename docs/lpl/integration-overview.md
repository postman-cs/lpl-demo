# Postman Integration with BRAVE Platform - Overview

## Executive Summary

This document outlines the Postman integration points within LPL Financial's BRAVE Internal Developer Platform. The integration automates Postman workspace provisioning, API specification management, test collection generation, and CI/CD pipeline integration as part of the BRAVE golden path -- giving developers a fully configured API lifecycle from template selection to production readiness.

## What Changes for Developers

**Before:** Developers select a BRAVE template, receive a GitHub repo with boilerplate code and CI/CD, and manually set up Postman workspaces, import specs, create collections, and configure environments. Credentials are often hardcoded. Workspace ownership is lost when team members leave.

**After:** When a developer selects a BRAVE template, they receive everything above plus:

- A pre-configured Postman team workspace with access automatically granted
- The API specification uploaded to Postman Spec Hub (replacing SwaggerHub for this flow)
- Auto-generated smoke test collection (endpoint reachability + response time validation)
- Auto-generated contract test collection (schema validation, field types, enums, formats)
- A dev environment pre-populated with the deployed API's base URL and variables
- CI/CD pipeline steps that run Postman tests on every push and PR

No manual setup required. No credentials exposed.

## Integration Points in the BRAVE Golden Path

```
  IDP (PROD)
      |
      v
  Template Selection (e.g., Python 3.11 Flask Experience API)
      |
      v
  Fill Form (project name, email, AWS account, spec URL)
      |
      v
  BRAVE Orchestrator
      |
      +--[1] Create Postman workspace + grant access
      |
      +--[2] Upload spec to Postman Spec Hub
      |
      +--[3] Generate smoke + contract test collections
      |
      +--[4] Create Postman environment (dev)
      |
      +--[5] Create GitHub repo with boilerplate + CI/CD
      |       (CI/CD includes Postman CLI test steps)
      |
      +--[6] Deploy to AWS (Lambda + API Gateway)
      |
      +--[7] Update Postman environment with deploy URL
      |
      +--[8] Notify developer with all resource links
      |
      v
  Developer receives email:
      - GitHub repo URL
      - Postman workspace URL
      - AWS invoke URL
      - Test collection UIDs
```

### Point 1: Workspace Creation

A team workspace is created in Postman, scoped to the project. The requester is automatically added as an editor. This replaces the current pattern where developers create personal workspaces or share through ad-hoc groups.

**API governance benefit:** All workspaces follow a naming standard and are associated with a BRAVE provisioning record.

### Point 2: Spec Hub Upload

The OpenAPI specification is uploaded directly to Postman's Spec Hub (API Definitions). This creates a versioned, governed record of the API design.

**Potential SwaggerHub replacement:** Spec Hub provides the same design-first validation capability that SwaggerHub offers today, with the advantage of being natively integrated with Postman collections, tests, and environments.

### Points 3-4: Test Collections + Environment

Two collections are auto-generated from the OpenAPI spec:

**Smoke Tests** (fast, run on every deployment):
- Each endpoint returns an expected status code
- Response time is under threshold (default 2 seconds)
- Response body is not empty

**Contract Tests** (comprehensive, run on every PR):
- Everything in smoke tests
- Response Content-Type is application/json
- All required fields are present
- Enum values are valid
- UUID and date-time fields match expected formats

The environment is pre-populated with the `baseUrl` variable, path parameter placeholders, and a configurable `RESPONSE_TIME_THRESHOLD`.

### Point 5: CI/CD Integration

The GitHub Actions workflow shipped with every repo includes:

| Job | Trigger | What It Does |
|-----|---------|--------------|
| Unit Tests | Every push/PR | Python pytest + linting |
| Spec Validation | Every push/PR | Validates OpenAPI spec with swagger-cli |
| Deploy to Dev | Push to main | Packages and deploys Lambda function |
| Smoke Tests | After deploy | Runs Postman smoke collection via Postman CLI |
| Contract Tests | After deploy | Runs Postman contract collection via Postman CLI |

Test results are uploaded as JUnit artifacts and can be commented on PRs.

### Points 6-7: AWS Deploy + Environment Sync

After the API is deployed to AWS Lambda + API Gateway, the Postman dev environment is automatically updated with the live invoke URL. Developers can immediately run tests against the deployed service from Postman without configuring anything.

## What Leadership Gets

- **Standardization:** Every API provisioned through BRAVE follows the same Postman workspace structure, naming conventions, and test patterns
- **Visibility:** Test results from every CI/CD run are tracked in Postman, providing an aggregate view of API quality across all teams
- **Compliance:** Contract tests validate that deployed APIs match their spec -- drift is caught automatically
- **Onboarding:** New developers receive a fully configured environment and only need to learn the standardized workflow
- **Secret Management:** Pre-request scripts reference AWS Secrets Manager, never hardcoded credentials

## Next Steps

1. **POV demo:** Walk through the provisioning flow end-to-end with a sample API
2. **DevOps alignment:** Review CI/CD workflow integration with existing GitHub Actions patterns
3. **Template expansion:** Extend to .NET, Angular, and Kafka templates
4. **Training pivot:** Enablement focused on the BRAVE-integrated workflow rather than generic Postman basics
