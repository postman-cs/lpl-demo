# LPL Ingestion Pipeline

![LPL BRAVE and Postman](LPL-BRAVEandPostman.png)

POV demonstrating Postman integration into LPL Financial's BRAVE Internal Developer Platform. Follows the prescriptive architecture: **one service = one workspace = one repo**.

When a developer selects a template in BRAVE, this pipeline provisions a complete API lifecycle:

- GitHub repo with boilerplate Flask API, OpenAPI spec, and CI/CD workflow
- Postman workspace with spec (Spec Hub), 3 collections (baseline, smoke, contract), 4 environments, and AWS secrets resolution
- AWS Lambda + API Gateway deployment
- Workspace-to-repo git sync (source control connection)
- GitHub Actions variables and secrets for Postman CLI + AWS deploy

**Live portal**: [lpl.pm-demo.dev](https://lpl.pm-demo.dev)

## Architecture

```
lpl.pm-demo.dev/*       -> Cloudflare Worker (src/index.ts)
  /                     -> static assets (docs/)
  /api/health           -> Worker direct response
  /api/provision        -> Worker SSE stream (dispatches GH Actions workflow)
  /api/teardown         -> Worker (GitHub/AWS/Postman API cleanup)
  /api/status           -> Worker (resource probe)
```

The portal UI lives in `docs/` (Cloudflare Worker static assets). Provisioning is orchestrated by the Worker: it creates a GitHub repo, pushes a `provision.yml` workflow, dispatches it via `workflow_dispatch`, then polls workflow steps and streams progress as SSE events. All heavy lifting (Postman API calls, AWS CLI, spec linting) runs in GitHub Actions.

## Directory Map

| Path | Purpose |
|------|---------|
| `docs/` | Portal static files served by Cloudflare Worker assets (HTML, CSS, JS, images) |
| `docs/lpl/` | Integration overview, provisioning walkthrough, CI/CD guide |
| `src/index.ts` | Cloudflare Worker: routes `/api/*` to handlers, serves static assets |
| `src/lib/provision.ts` | Provisioning orchestrator: dispatches GH Actions workflow, polls steps, streams SSE events |
| `src/lib/provision-workflow.ts` | Generates the `provision.yml` GitHub Actions workflow pushed to new repos; also generates `ci.yml` (base64-encoded) |
| `src/lib/teardown.ts` | Teardown handler: cleans up GitHub, AWS, and Postman resources |
| `src/lib/github.ts` | GitHub API helpers: repo creation, variables, secrets, collaborators |
| `src/lib/boilerplate.ts` | Fetches boilerplate Flask API files from GitHub raw URLs |
| `src/lib/sse.ts` | SSE stream utilities |
| `src/lib/teams.ts` | Postman team/workspace helpers |
| `wrangler.toml` | Cloudflare config: assets, routes |
| `server/boilerplate/` | Template Flask API pushed to new repos (Advisor Portfolio API, OpenAPI 3.0.3, 9 operations) |
| `scripts/` | teardown.py, validate-credentials.sh, setup-aws.sh, iam-policy.json |
| `tests/` | Vitest test suite (provision, workflow, github, teardown, boilerplate, SSE, worker) |

## Provisioning Sequence

1. **Pre-flight**: Check for and auto-clean orphan resources from prior runs
2. **Spec lint**: Validate OpenAPI spec via Postman CLI (`postman spec lint`) in GitHub Actions
3. **Postman workspace**: Create workspace (named `[domain]-[service]-service`)
4. **Access**: Invite requester as workspace editor
5. **Spec Hub upload**: `POST /specs?workspaceId={id}`
6. **Collection generation**: Resolve `$ref` pointers, generate 3 collections via Spec Hub, inject tests (`[Smoke]`/`[Contract]` prefixed), tag, prepend Request 0 secrets resolver
7. **Environments**: Create dev, QA, staging, prod with smart values, auth scheme detection, AWS credential vars
8. **Export**: Fetch full collection/environment JSON for git sync
9. **GitHub repo**: Push boilerplate + `.postman/config.json` + `postman/collections/` + `postman/environments/` + CI/CD workflow
10. **Git sync**: Connect workspace to repo via Bifrost filesystem API
11. **Governance group**: Assign workspace to domain-matching governance group via ruleset-service gateway
12. **CI/CD variables**: Inject Postman UIDs as GitHub Actions variables + `POSTMAN_ACCESS_TOKEN` as encrypted secret
13. **AWS deploy**: Lambda + API Gateway + IAM role
14. **AWS variables**: Inject `FUNCTION_NAME`, `API_GATEWAY_URL`, `API_GATEWAY_ID` into GitHub Actions
15. **Environment sync**: Merge invoke URL into dev environment (GET-merge-PUT preserves existing vars)
16. **Notify**: SSE complete event + mock email/SonarQube/Jira panels

## Self-Healing

The portal detects orphan resources on page load by probing GitHub, AWS, and Postman APIs. If resources from a prior run exist, a banner appears with a cleanup option. Provisioning also auto-cleans before starting, so the pipeline always runs clean regardless of prior state.

## Secrets Management

All generated collections include a **Request 0 - Resolve Secrets** item using Postman's built-in AWS Signature v4 auth (`auth.type: awsv4`). This calls AWS Secrets Manager to resolve credentials at runtime -- no secrets are stored in collections.

In CI environments, Request 0 is skipped via a pre-request script that checks for `pm.environment.get("CI") === "true"`. The CI workflow passes `--env-var "CI=true"` to Postman CLI collection runs.

## Workspace Git Sync

The pipeline connects each provisioned workspace to its GitHub repo, making the workspace show "Connected to source control" in Postman and enabling `postman workspace push`.

> **Note**: The CLI only supports `postman workspace push` (local → cloud). There is no `workspace pull` command — bi-directional sync is handled by the Postman desktop app.

**Current implementation**: Uses a session token (`POSTMAN_ACCESS_TOKEN`) to connect the workspace to the repo via the Postman filesystem API.

**Repo structure created by the pipeline**:
```
.postman/config.json              # Links workspace to repo, lists entity paths
postman/collections/*.json        # Exported collection files (v2.1.0 format)
postman/environments/*.json       # Exported environment files
postman/specs/openapi.yaml        # OpenAPI specification (syncs with Spec Hub)
postman/mocks/mock.json           # Local mock manifest (name, port, routes)
postman/mocks/mock.js             # Auto-generated route handlers from spec
postman/globals/*.json             # Workspace-level global variables
```

**Sync entity surface**:

| Entity | Directory | Synced by Pipeline | Notes |
|--------|-----------|-------------------|-------|
| Collections | `postman/collections/` | ✅ | Baseline, smoke, contract |
| Environments | `postman/environments/` | ✅ | Per-stage (dev, QA, staging, prod) |
| Specifications | `postman/specs/` | ✅ | OpenAPI YAML, syncs with Spec Hub |
| Local Mocks | `postman/mocks/` | ✅ | Route handlers auto-generated from spec |
| Globals | `postman/globals/` | ✅ | Workspace-level variables |
| SDKs | `postman/sdks/` | — | Not generated by this pipeline |
| Flows | — | — | Feature-flagged, not yet available |

The pipeline exports entities via direct Postman API calls and writes them to the repo. The filesystem API connects the workspace to the repo for bi-directional sync via the Postman app. The CLI supports `postman workspace push` (local → cloud) but not pull.

## Governance Groups

The pipeline assigns each new workspace to a governance group matching its domain (e.g. `wealth`, `payments`). Governance groups control which API governance rules and vulnerability checks apply to workspaces within the group — a workspace-level policy layer on top of the organization-wide rules.

**API**: `PATCH /configure/workspace-groups/{groupId}` with body `{"workspaces": {"add": ["<workspace-uuid>"]}}`

**How it works**: On provisioning, the pipeline lists all governance groups, finds one whose name matches the request domain, and patches it to add the new workspace. If no matching group exists, the step is skipped with a log message.

> **Note**: Governance group assignment uses a session token.

## CI/CD Workflow (Generated)

The boilerplate `ci.yml` supports three trigger modes:

| Trigger | What runs |
|---------|-----------|
| `push` to main | Unit tests + lint -> spec validation -> **pre-deploy tests** (smoke + contract against local container) -> deploy to Lambda -> smoke + contract tests against live infra -> rollback on failure -> report |
| `schedule` (6h cron) | Smoke + contract tests against existing deployment (no re-deploy) |
| `workflow_dispatch` | Manual trigger with test level and environment selection |

The **pre-deploy tests** job builds the Docker container and runs both smoke and contract collections against it on `http://localhost:5000` before any AWS deployment. If any collection run fails, the deploy job is skipped entirely. Post-deploy, the same collections run against the live Lambda invoke URL — failures trigger an automatic rollback to the previous Lambda version.

The generated `ci.yml` uses `npm install -g postman-cli` for Postman CLI installation and runs smoke + contract tests via `postman collection run`. The ci.yml content is base64-encoded in the provision workflow to avoid GitHub Actions expression evaluation during provisioning.

## Test Generation

Collections are generated from the OpenAPI spec via Spec Hub, then tests are injected by matching endpoints using a shared path canonicalization function (`_canonicalize_path`). This normalizes `{param}`, `:param`, and `{{param}}` styles for consistent key matching.

| Collection | Tests | Prefix |
|-----------|-------|--------|
| Baseline | None (docs only) | -- |
| Smoke | Status code, response time, non-empty body | `[Smoke]` |
| Contract | All smoke tests + Content-Type, required field presence, type assertions, JSON Schema validation, property constraints, error structure | `[Smoke]` + `[Contract]` |

### Contract Test Layers

Contract tests use a **belt-and-suspenders** approach — human-readable field-level assertions for clear failure diagnostics, plus full JSON Schema validation for structural completeness:

1. **Smoke baseline**: Status code, response time, non-empty body (inherited from smoke)
2. **Content-Type**: Validates `application/json` header on non-204 responses
3. **Required field presence**: Asserts `to.have.property` for all `required` fields in the response schema (wrapper and direct object patterns)
4. **Type assertions**: `typeof` checks on required fields mapped from OpenAPI types (`string`→`"string"`, `integer`→`"number"`, `array`→`Array.isArray`, etc.)
5. **Property constraints**: Enum values, string format patterns (uuid, date-time, email, etc.), regex patterns, min/maxLength, numeric min/max/exclusiveMin/exclusiveMax/multipleOf
6. **Array constraints**: `minItems`, `maxItems`, `uniqueItems` validation
7. **Nullable handling**: OpenAPI 3.0 `nullable: true` fields are guarded against null in all assertions to prevent false failures
8. **Full JSON Schema validation**: `pm.response.to.have.jsonSchema()` using AJV with the resolved response schema embedded inline — catches type mismatches, unexpected structure, and nested validation issues that field-level checks may miss
9. **Error structure**: 4xx/5xx responses checked for `error`, `message`, or `detail` fields

A coverage assertion warns if fewer than 50% of spec endpoints matched collection items during injection.

## Deployment

```bash
# Teardown provisioned resources
python scripts/teardown.py --project advisor-portfolio-api [--dry-run]
```

## Mock Server

### Cloud Mock

The pipeline creates a Postman mock server against the baseline collection after provisioning. The mock URL is returned in the provisioning results and included in the workspace description. Consumers can immediately hit `https://{mockId}.mock.pstmn.io/` against the full spec without waiting for AWS deployment.

### Local Mock (Postman App)

Postman's desktop app (via Agent Mode) supports **local mock servers** that run on your machine. The `createLocalMock` tool generates a Node.js `http.createServer` handler in `postman/mocks/` with a companion `.json` manifest. Mocks are started/stopped via `startMockServer`/`stopMockServer` and listen on `process.env.PORT || 3000`.

**This pipeline auto-generates a local mock** from the OpenAPI spec during provisioning to achieve full filesystem sync parity with the Postman desktop app. When a workspace is connected to a repo via the Bifrost filesystem API, Postman expects the `postman/mocks/` directory to contain a runnable mock server — the same structure the desktop app's `createLocalMock` tool produces. By generating these files at provisioning time, the repo is immediately compatible with Postman's local mock lifecycle (`startMockServer`/`stopMockServer`) and developers can run `node postman/mocks/mock.js` without any additional setup.

Local mocks are useful for:
- **Pre-deploy testing**: Run smoke/contract collections against `http://localhost:3000` *before* deploying to AWS, catching spec violations without infrastructure spend (see [CI/CD pre-deploy stage](#cicd-workflow-generated))
- **Offline development**: Frontend teams can develop against the mock without waiting for a live backend
- **Agent Mode workflows**: Postman's AI assistant can generate and iterate on mock handlers interactively

**Structure**: Local mocks use the Node.js `http` module (not Express) with route matching (`if (method === "GET" && url === "/path")`) and a 404 fallback for unmocked routes. This convention matches the Postman app's `filesystem-tools/mock.ts` reference implementation.

## Monitoring Alternatives

The pipeline generates a CI/CD workflow with a 6-hour cron schedule that runs smoke and contract tests via Postman CLI against the existing deployment. This replaces Postman Monitors for automated drift detection. Three alternatives exist depending on the customer's requirements:

| Approach | Pros | Cons |
|----------|------|------|
| **Postman CLI on CI cron** (current) | Runs in customer's infra, no secrets in Postman cloud, uses existing CI runner | Requires CI runner availability, no Postman UI visibility |
| **Postman Monitors** | Visible in Postman UI, feeds API Catalog health, no CI dependency | Secrets must be in Postman Vault (not yet supported in monitors), runs in Postman cloud |
| **Postman CLI on self-hosted runner** | Full control over execution environment, can access internal networks | Requires dedicated runner infrastructure |

All approaches use the same collection and environment UIDs generated during provisioning. The CI workflow stores these as GitHub Actions variables: `POSTMAN_SMOKE_COLLECTION_UID`, `POSTMAN_CONTRACT_COLLECTION_UID`, `POSTMAN_ENVIRONMENT_UID`.

### Postman Runner (Beta)

The Postman CLI includes a `[BETA]` `postman runner start` command that runs a long-lived agent process on your own infrastructure. The agent polls Postman's service for pending collection runs and executes them locally using `postman-runtime`.

```bash
postman runner start --id <runner-id> --key <runner-key> [--region <region>]
```

| Option | Details |
|--------|---------|
| `--id <id>` | **(required)** The runner ID from Postman |
| `--key <key>` | Runner secret key (prompted interactively if omitted) |
| `--region <region>` | Region (`us` default, `eu` for EU) |
| `--proxy <url>` | External proxy URL |
| `--egress-proxy` | Enable built-in MITM egress proxy (requires `--egress-proxy-authz-url`) |
| `--ssl-extra-ca-certs <path>` | Additional trusted CA certificates (PEM) |
| `--metrics` | Enable health/metrics endpoint (default port 9090) |

**Behavior**: The agent polls every 5 seconds for pending runs, executes them, and loops. It auto-recovers from errors and shuts down gracefully on `SIGINT`/`SIGTERM`. After 3 consecutive 401 errors it exits, requiring re-authentication.

**When to use**: The runner is the future replacement for both the CI cron approach and Postman Monitors. It runs on your infrastructure (no secrets in Postman cloud), provides continuous monitoring without CI runner availability constraints, and will eventually feed results into the Postman API Catalog. Use the CI cron approach today; evaluate migrating to `postman runner` as it exits beta.

**Note**: Localhost and internal addresses (`127.0.0.1`, `169.254.169.254`, etc.) are restricted by default for security.

## Workspace Access

Workspaces are created as **private** (visible to the team, accessible only to invited members). The pipeline resolves the requester's email to a Postman user ID via `GET /team/members` and adds them as an editor via `POST /workspaces/{id}/members`. If the email doesn't match a team member, a warning is logged and provisioning continues without blocking.

## Known Limitations

- Workspace description update returns 403 (API key role restriction, non-blocking)
- Workspace git sync and governance group assignment require a session token that must be periodically refreshed
- Member add requires the requester's email to match a Postman team member; external users cannot be added via API
