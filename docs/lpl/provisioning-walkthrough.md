# Provisioning Walkthrough

Step-by-step walkthrough of the BRAVE + Postman provisioning flow. Use this as a demo script or reference for understanding what happens when a developer provisions a new API.

## Step 1: Select Template

Developer navigates to the BRAVE portal and selects **Python 3.11 Flask Experience API (AWS EKS)**. This template now includes the "Postman Integrated" designation, indicating that Postman workspace provisioning is bundled.

Other templates (.NET, Angular, Kafka) will be extended with Postman integration in future phases.

## Step 2: Fill Provisioning Form

Developer completes the form:

| Field | Example Value | Notes |
|-------|--------------|-------|
| Project Name | `order-management-api` | Used for repo name, workspace name, Lambda function name |
| Email | `developer@lplfinancial.com` | Receives notification; granted Postman workspace access |
| Product Code | `WEALTH-001` | Tracking identifier |
| Spec URL | `https://app.swaggerhub.com/apis/...` | Optional; default Experience API spec used if blank |
| AWS Account | `123456789012` | Target dev account for deployment |
| API Gateway | Kong API Gateway | LPL standard |

The form also displays what Postman resources will be automatically provisioned.

## Step 3: Provisioning Executes

The orchestrator runs four phases:

### Phase 1: Postman

**What happens:**
- Team workspace `order-management-api` created in Postman
- `developer@lplfinancial.com` added as workspace editor
- OpenAPI spec uploaded to Spec Hub as "Experience API"
- "Experience API - Smoke Tests" collection generated (6 requests, one per endpoint)
- "Experience API - Contract Tests" collection generated (6 requests with schema validation)
- "Experience API - Dev" environment created with `baseUrl` variable

**What the developer sees in Postman:**
```
Workspace: order-management-api
    APIs:
        Experience API (OpenAPI 3.0.3)
    Collections:
        Experience API - Smoke Tests
            Operations/
                Health check
            Items/
                List items
                Create an item
                Get an item
                Update an item
                Delete an item
        Experience API - Contract Tests
            [same structure, more comprehensive tests]
    Environments:
        Experience API - Dev
            baseUrl = (pending deploy)
            RESPONSE_TIME_THRESHOLD = 2000
            itemId = (empty, for path params)
```

### Phase 2: GitHub

**What happens:**
- Private repo `postman-cs/order-management-api` created
- Boilerplate Flask API code pushed (app/, openapi.yaml, Dockerfile)
- GitHub Actions CI/CD workflow pushed (unit tests + Postman CLI integration)
- `.env.example` written with Postman workspace ID and collection UIDs
- Developer invited as collaborator with push access

**Repo structure:**
```
order-management-api/
    .github/workflows/ci.yml
    .env.example
    .gitignore
    app/
        __init__.py
        routes.py
        models.py
        wsgi.py
    openapi.yaml
    requirements.txt
    Dockerfile
```

### Phase 3: AWS

**What happens:**
- IAM Lambda execution role created
- Flask app packaged with WSGI-to-Lambda adapter
- Lambda function deployed (Python 3.11, 256MB)
- HTTP API Gateway created, pointing to Lambda
- Invoke URL captured (e.g., `https://abc123.execute-api.us-east-1.amazonaws.com`)

### Phase 4: Sync + Notify

**What happens:**
- Postman "Experience API - Dev" environment updated: `baseUrl` set to the AWS invoke URL
- Summary printed to console and written to `provisioning-result.json`
- Developer receives all resource links

## Step 4: Developer Starts Working

The developer now has:

1. **GitHub repo** with working code, CI/CD, and Postman integration
2. **Postman workspace** with spec, test collections, and configured environment
3. **Deployed API** accessible via the invoke URL
4. **CI/CD pipeline** that runs Postman tests on every push

**Immediate actions available:**
- Open Postman, navigate to workspace, run smoke tests against live API
- Clone repo, write business logic, push -- CI/CD validates automatically
- Run contract tests to confirm deployed API matches spec

## What Happens on Subsequent Code Pushes

When a developer pushes code to `main`:

1. GitHub Actions triggers
2. Unit tests + linting run
3. Lambda function redeployed with new code
4. Postman CLI runs smoke tests against deployed service
5. Postman CLI runs contract tests against deployed service
6. Results uploaded as JUnit artifacts
7. If tests fail, developer is notified via GitHub

No manual intervention required for test maintenance -- tests are generated from the OpenAPI spec and validate against it.
