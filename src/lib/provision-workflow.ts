// Generate the provision.yml GitHub Actions workflow for new repos

// CI/CD workflow content that gets written to provisioned repos
// This is the ci.yml that replaces provision.yml after provisioning completes
export const CI_WORKFLOW_CONTENT = `name: CI/CD Pipeline
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: "0 */6 * * *"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Install Postman CLI
        run: |
          npm install -g postman-cli
          postman login --with-api-key \${{ secrets.POSTMAN_API_KEY }}
      - name: Run Smoke Tests
        run: postman collection run \${{ vars.POSTMAN_SMOKE_COLLECTION_UID }} -e \${{ vars.POSTMAN_ENVIRONMENT_UID }}
      - name: Run Contract Tests
        run: postman collection run \${{ vars.POSTMAN_CONTRACT_COLLECTION_UID }} -e \${{ vars.POSTMAN_ENVIRONMENT_UID }}
`;

// Base64 encode the CI workflow to avoid GHA expression evaluation and YAML escaping issues
function getCiWorkflowBase64(): string {
  return Buffer.from(CI_WORKFLOW_CONTENT).toString('base64');
}

export function generateProvisionWorkflow(): string {
  const ciBase64 = getCiWorkflowBase64();
  return `name: Provision API Lifecycle

on:
  workflow_dispatch:
    inputs:
      project_name:
        description: "Project name"
        required: true
        type: string
      domain:
        description: "Business domain"
        required: true
        type: string
      domain_code:
        description: "Domain code (e.g., WEAL)"
        required: true
        type: string
      requester_email:
        description: "Requester email address"
        required: true
        type: string
      spec_url:
        description: "OpenAPI spec URL (raw GitHub URL)"
        required: true
        type: string
      environments:
        description: "JSON array of environment names"
        required: true
        type: string
        default: '["dev","prod"]'
      postman_team_id:
        description: "Postman team ID for workspace creation"
        required: false
        type: string
        default: '132319'

env:
  POSTMAN_API_BASE: "https://api.getpostman.com"
  AWS_REGION: "us-east-1"
  PYTHON_VERSION: "3.11"

jobs:
  provision:
    name: Provision Postman + AWS
    runs-on: ubuntu-latest
    outputs:
      workspace_id: \${{ steps.workspace.outputs.workspace_id }}
      workspace_url: \${{ steps.workspace.outputs.workspace_url }}
      spec_id: \${{ steps.spec.outputs.spec_id }}
      baseline_uid: \${{ steps.collections.outputs.baseline_uid }}
      smoke_uid: \${{ steps.collections.outputs.smoke_uid }}
      contract_uid: \${{ steps.collections.outputs.contract_uid }}
      mock_url: \${{ steps.mock.outputs.mock_url }}

    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.GH_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install Postman CLI
        run: |
          npm install -g postman-cli
          postman login --with-api-key \${{ secrets.POSTMAN_API_KEY }}

      - name: Create Postman Workspace
        id: workspace
        run: |
          WORKSPACE_NAME="[\${{ inputs.domain_code }}] \${{ inputs.project_name }}"
          RESPONSE=$(curl -sf -X POST "\${{ env.POSTMAN_API_BASE }}/workspaces" \\
            -H "X-Api-Key: \${{ secrets.POSTMAN_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"workspace\\": {
                \\"name\\": \\"\${WORKSPACE_NAME}\\",
                \\"type\\": \\"team\\",
                \\"description\\": \\"Auto-provisioned by BRAVE for \${{ inputs.project_name }}\\",
                \\"about\\": \\"Auto-provisioned by BRAVE\\",
                \\"teamId\\": \\"\${{ inputs.postman_team_id }}\\"
              }
            }")
          WORKSPACE_ID=$(echo "$RESPONSE" | jq -r '.workspace.id')
          echo "workspace_id=\${WORKSPACE_ID}" >> "$GITHUB_OUTPUT"
          echo "workspace_url=https://go.postman.co/workspace/\${WORKSPACE_ID}" >> "$GITHUB_OUTPUT"
          echo "Workspace created: \${WORKSPACE_ID}"

      - name: Assign Workspace to Governance Group
        continue-on-error: true
        run: |
          DOMAIN="\${{ inputs.domain }}"
          GROUP_MAPPING='{"wealth":"WealthMgmt-APIs","payments":"Payments-APIs","identity":"Identity-APIs","platform":"Platform-APIs"}'
          GROUP_NAME=$(echo "$GROUP_MAPPING" | jq -r ".\\"\${DOMAIN}\\"")
          if [ "\${GROUP_NAME}" = "null" ]; then
            echo "No governance group for domain: \${DOMAIN}"
            exit 0
          fi
          GROUPS=$(curl -sf "https://gateway.postman.com/configure/workspace-groups" \\
            -H "x-access-token: \${{ secrets.POSTMAN_ACCESS_TOKEN }}")
          GROUP_ID=$(echo "$GROUPS" | jq -r ".data[] | select(.name==\\"\${GROUP_NAME}\\") | .id")
          if [ -n "\${GROUP_ID}" ]; then
            curl -sf -X PATCH "https://gateway.postman.com/configure/workspace-groups/\${GROUP_ID}" \\
              -H "x-access-token: \${{ secrets.POSTMAN_ACCESS_TOKEN }}" \\
              -H "Content-Type: application/json" \\
              -d "{\\"workspaces\\": [\\"\${{ steps.workspace.outputs.workspace_id }}\\"]}"
            echo "Workspace assigned to group: \${GROUP_NAME}"
          fi

      - name: Invite Requester to Workspace
        continue-on-error: true
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"
          USERS=$(curl -sf "\${{ env.POSTMAN_API_BASE }}/users" \\
            -H "X-Api-Key: \${API_KEY}")
          USER_ID=$(echo "$USERS" | jq -r ".data[] | select(.email==\\"\${{ inputs.requester_email }}\\") | .id")
          if [ -n "\${USER_ID}" ]; then
            curl -sf -X PATCH "\${{ env.POSTMAN_API_BASE }}/workspaces/\${{ steps.workspace.outputs.workspace_id }}/roles" \\
              -H "X-Api-Key: \${API_KEY}" \\
              -H "Content-Type: application/json" \\
              -d "{\\"roles\\": [{\\"op\\": \\"add\\", \\"path\\": \\"/user\\", \\"value\\": [{\\"id\\": \${USER_ID}, \\"role\\": 2}]}]}"
            echo "Invited user: \${{ inputs.requester_email }} (userId: \${USER_ID}) as Editor"
          else
            echo "User not found in org: \${{ inputs.requester_email }}"
          fi

      - name: Upload Spec to Spec Hub
        id: spec
        run: |
          SPEC_CONTENT=$(cat openapi.yaml)
          PAYLOAD=$(jq -n --arg content "\${SPEC_CONTENT}" '{
            "name": "\${{ inputs.project_name }}",
            "type": "OPENAPI:3.0",
            "files": [{"path": "openapi.yaml", "content": \$content}]
          }')
          RESPONSE=$(curl -sf -X POST "\${{ env.POSTMAN_API_BASE }}/specs?workspaceId=\${{ steps.workspace.outputs.workspace_id }}" \\
            -H "X-Api-Key: \${{ secrets.POSTMAN_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            -d "\${PAYLOAD}")
          SPEC_ID=$(echo "$RESPONSE" | jq -r '.id')
          echo "spec_id=\${SPEC_ID}" >> "$GITHUB_OUTPUT"
          echo "Spec uploaded: \${SPEC_ID}"

      - name: Lint Spec via Postman CLI
        id: lint
        run: |
          SPEC_UID="\${{ steps.spec.outputs.spec_id }}"
          LINT_OUTPUT=$(postman spec lint openapi.yaml -o json 2>&1) || true
          echo "$LINT_OUTPUT" | jq '.' > /dev/null 2>&1 || { echo "::error::Spec lint output is not valid JSON"; exit 1; }

          ERRORS=$(echo "$LINT_OUTPUT" | jq '[.violations[] | select(.severity=="ERROR")] | length')
          WARNINGS=$(echo "$LINT_OUTPUT" | jq '[.violations[] | select(.severity=="WARNING")] | length')
          TOTAL=$(echo "$LINT_OUTPUT" | jq '.violations | length')

          echo "lint_errors=\${ERRORS}" >> "$GITHUB_OUTPUT"
          echo "lint_warnings=\${WARNINGS}" >> "$GITHUB_OUTPUT"
          echo "lint_total=\${TOTAL}" >> "$GITHUB_OUTPUT"

          # Store violations as base64 for downstream steps
          echo "lint_violations=$(echo "$LINT_OUTPUT" | jq -c '.violations' | base64 | tr -d '\\n')" >> "$GITHUB_OUTPUT"

          echo "Lint results: \${ERRORS} errors, \${WARNINGS} warnings"
          if [ "\${ERRORS}" -gt 0 ]; then
            echo "::error::Spec lint found \${ERRORS} errors"
            echo "$LINT_OUTPUT" | jq -r '.violations[] | select(.severity=="ERROR") | "  \\(.path): \\(.issue)"'
            exit 1
          fi
          if [ "\${WARNINGS}" -gt 0 ]; then
            echo "::warning::Spec lint found \${WARNINGS} governance warnings"
            echo "$LINT_OUTPUT" | jq -r '.violations[] | select(.severity=="WARNING") | "  \\(.path): \\(.issue)"'
          fi

          # Store lint results as repo variables immediately (for real-time SSE display)
          GH_TOKEN="\${{ secrets.GH_TOKEN }}"
          REPO="\${{ github.repository }}"
          store_lint_var() {
            local NAME="$1"
            local VALUE="$2"
            curl -sf -X PATCH "https://api.github.com/repos/\${REPO}/actions/variables/\${NAME}" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"\${NAME}\\", \\"value\\": \\"\${VALUE}\\"}" 2>/dev/null || \\
            curl -sf -X POST "https://api.github.com/repos/\${REPO}/actions/variables" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"\${NAME}\\", \\"value\\": \\"\${VALUE}\\"}"
          }
          store_lint_var "LINT_WARNINGS" "\${WARNINGS}"
          store_lint_var "LINT_ERRORS" "\${ERRORS}"

      - name: Generate Collections from Spec
        id: collections
        run: |
          SPEC_ID="\${{ steps.spec.outputs.spec_id }}"
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"

          generate_collection() {
            local PREFIX="$1"
            RESPONSE=$(curl -sf -X POST "\${{ env.POSTMAN_API_BASE }}/specs/\${SPEC_ID}/generations/collection" \\
              -H "X-Api-Key: \${API_KEY}" \\
              -H "Content-Type: application/json" \\
              -d "{\\"name\\": \\"\${PREFIX} \${{ inputs.project_name }}\\", \\"options\\": {\\"requestNameSource\\": \\"Fallback\\"}}")
            TASK_URL=$(echo "$RESPONSE" | jq -r '.url')

            # Poll task until complete
            for i in $(seq 1 30); do
              sleep 2
              TASK=$(curl -sf "\${{ env.POSTMAN_API_BASE }}\${TASK_URL}" \\
                -H "X-Api-Key: \${API_KEY}")
              STATUS=$(echo "$TASK" | jq -r '.status')
              if [ "\${STATUS}" = "completed" ]; then
                echo "$TASK" | jq -r '.details.resources[0].id'
                return 0
              elif [ "\${STATUS}" = "failed" ]; then
                echo "::error::Collection generation failed for \${PREFIX}" >&2
                return 1
              fi
            done
            echo "::error::Collection generation timed out for \${PREFIX}" >&2
            return 1
          }

          BASELINE_UID=$(generate_collection "[Baseline]")
          SMOKE_UID=$(generate_collection "[Smoke]")
          CONTRACT_UID=$(generate_collection "[Contract]")

          echo "baseline_uid=\${BASELINE_UID}" >> "$GITHUB_OUTPUT"
          echo "smoke_uid=\${SMOKE_UID}" >> "$GITHUB_OUTPUT"
          echo "contract_uid=\${CONTRACT_UID}" >> "$GITHUB_OUTPUT"
          echo "Generated: Baseline=\${BASELINE_UID} Smoke=\${SMOKE_UID} Contract=\${CONTRACT_UID}"

      - name: Inject Test Scripts & Request 0
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"

          inject_tests() {
            local COL_UID="$1"
            local TYPE="$2"

            # Download collection
            COLLECTION=$(curl -sf "\${{ env.POSTMAN_API_BASE }}/collections/\${COL_UID}" \\
              -H "X-Api-Key: \${API_KEY}")

            # Inject tests using jq (simplified - test scripts are embedded)
            UPDATED=$(echo "$COLLECTION" | jq --arg type "\${TYPE}" '
              .collection.item = [
                {
                  "name": "00 - Resolve Secrets",
                  "request": {
                    "auth": {
                      "type": "awsv4",
                      "awsv4": [
                        {"key": "accessKey", "value": "{{AWS_ACCESS_KEY_ID}}"},
                        {"key": "secretKey", "value": "{{AWS_SECRET_ACCESS_KEY}}"},
                        {"key": "region", "value": "{{AWS_REGION}}"},
                        {"key": "service", "value": "secretsmanager"}
                      ]
                    },
                    "method": "POST",
                    "header": [
                      {"key": "X-Amz-Target", "value": "secretsmanager.GetSecretValue"},
                      {"key": "Content-Type", "value": "application/x-amz-json-1.1"}
                    ],
                    "body": {
                      "mode": "raw",
                      "raw": "{\\\"SecretId\\\": \\\"{{AWS_SECRET_NAME}}\\\"}"
                    },
                    "url": {
                      "raw": "https://secretsmanager.{{AWS_REGION}}.amazonaws.com",
                      "protocol": "https",
                      "host": ["secretsmanager","{{AWS_REGION}}","amazonaws","com"]
                    }
                  },
                  "event": [
                    {
                      "listen": "test",
                      "script": {
                        "exec": [
                          "if (pm.environment.get(\\\"CI\\\") === \\\"true\\\") { return; }",
                          "const body = pm.response.json();",
                          "if (body.SecretString) {",
                          "  const secrets = JSON.parse(body.SecretString);",
                          "  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));",
                          "}"
                        ]
                      }
                    }
                  ]
                }
              ] + .collection.item
            ')

            # Upload updated collection
            curl -sf -X PUT "\${{ env.POSTMAN_API_BASE }}/collections/\${COL_UID}" \\
              -H "X-Api-Key: \${API_KEY}" \\
              -H "Content-Type: application/json" \\
              -d "\${UPDATED}"
            echo "Injected tests into \${TYPE} collection: \${COL_UID}"
          }

          inject_tests "\${{ steps.collections.outputs.baseline_uid }}" "baseline"
          inject_tests "\${{ steps.collections.outputs.smoke_uid }}" "smoke"
          inject_tests "\${{ steps.collections.outputs.contract_uid }}" "contract"

      - name: Tag Collections
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"
          tag_collection() {
            local COL_UID="$1"
            shift
            local TAGS="$@"
            local TAG_JSON=$(echo "$TAGS" | jq -Rc 'split(" ") | map({"slug": .})')
            curl -sf -X PUT "\${{ env.POSTMAN_API_BASE }}/collections/\${COL_UID}/tags" \\
              -H "X-Api-Key: \${API_KEY}" \\
              -H "Content-Type: application/json" \\
              -d "{\\"tags\\": \${TAG_JSON}}"
          }
          tag_collection "\${{ steps.collections.outputs.baseline_uid }}" "generated docs"
          tag_collection "\${{ steps.collections.outputs.smoke_uid }}" "generated smoke"
          tag_collection "\${{ steps.collections.outputs.contract_uid }}" "generated contract"
          echo "Collections tagged"

      - name: Store Postman UIDs as Repo Variables
        run: |
          GH_TOKEN="\${{ secrets.GH_TOKEN }}"
          REPO="\${{ github.repository }}"
          set_var() {
            local NAME="$1"
            local VALUE="$2"
            curl -sf -X PATCH "https://api.github.com/repos/\${REPO}/actions/variables/\${NAME}" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"\${NAME}\\", \\"value\\": \\"\${VALUE}\\"}" 2>/dev/null || \\
            curl -sf -X POST "https://api.github.com/repos/\${REPO}/actions/variables" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"\${NAME}\\", \\"value\\": \\"\${VALUE}\\"}"
          }
          set_var "POSTMAN_WORKSPACE_ID" "\${{ steps.workspace.outputs.workspace_id }}"
          set_var "POSTMAN_BASELINE_COLLECTION_UID" "\${{ steps.collections.outputs.baseline_uid }}"
          set_var "POSTMAN_SMOKE_COLLECTION_UID" "\${{ steps.collections.outputs.smoke_uid }}"
          set_var "POSTMAN_CONTRACT_COLLECTION_UID" "\${{ steps.collections.outputs.contract_uid }}"
          echo "Repo variables set"

      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: \${{ env.AWS_REGION }}

      - name: Create IAM Execution Role
        id: iam
        run: |
          PROJECT="\${{ inputs.project_name }}"
          ROLE_NAME="cse-lpl-\${PROJECT}-lambda-role"
          TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

          ROLE_ARN=$(aws iam create-role \\
            --role-name "\${ROLE_NAME}" \\
            --assume-role-policy-document "\${TRUST_POLICY}" \\
            --query 'Role.Arn' --output text 2>/dev/null) || \\
          ROLE_ARN=$(aws iam get-role --role-name "\${ROLE_NAME}" --query 'Role.Arn' --output text)

          aws iam attach-role-policy \\
            --role-name "\${ROLE_NAME}" \\
            --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true

          echo "Waiting for IAM propagation..."
          sleep 15
          echo "role_arn=\${ROLE_ARN}" >> "$GITHUB_OUTPUT"
          echo "role_name=\${ROLE_NAME}" >> "$GITHUB_OUTPUT"

      - name: Package Lambda
        run: |
          pip install -r requirements.txt -t package/ -q
          cp -r app/ package/app/
          cp openapi.yaml package/
          cd package && zip -r ../deployment.zip . -q

      - name: Deploy Lambda Functions
        id: lambda
        run: |
          PROJECT="\${{ inputs.project_name }}"
          ROLE_ARN="\${{ steps.iam.outputs.role_arn }}"
          ENVS=$(echo '\${{ inputs.environments }}' | jq -r '.[]')

          for ENV_NAME in \${ENVS}; do
            FUNC_NAME="\${PROJECT}-\${ENV_NAME}"

            # Create or update function (retry for IAM propagation)
            for attempt in 1 2 3; do
              aws lambda create-function \\
                --function-name "\${FUNC_NAME}" \\
                --runtime python3.11 \\
                --handler app.wsgi.handler \\
                --role "\${ROLE_ARN}" \\
                --zip-file fileb://deployment.zip \\
                --memory-size 256 \\
                --timeout 30 \\
                --query 'FunctionArn' --output text 2>/dev/null && break
              aws lambda update-function-code \\
                --function-name "\${FUNC_NAME}" \\
                --zip-file fileb://deployment.zip \\
                --query 'FunctionArn' --output text 2>/dev/null && break
              echo "Attempt \${attempt} failed, waiting for IAM propagation..."
              sleep 10
            done

            # Verify function exists before proceeding
            if ! aws lambda get-function --function-name "\${FUNC_NAME}" --query 'Configuration.State' --output text; then
              echo "::error::Lambda function \${FUNC_NAME} does not exist after 3 create attempts"
              exit 1
            fi

            aws lambda wait function-active-v2 --function-name "\${FUNC_NAME}"

            FUNC_ARN=$(aws lambda get-function --function-name "\${FUNC_NAME}" --query 'Configuration.FunctionArn' --output text)
            echo "Function active: \${FUNC_ARN}"

            # Create API Gateway HTTP API (lookup first, then create)
            API_NAME="\${FUNC_NAME}-api"
            API_ID=$(aws apigatewayv2 get-apis --output json | \\
              jq -r ".Items[] | select(.Name==\\"\${API_NAME}\\") | .ApiId" | head -1)

            if [ -z "\${API_ID}" ]; then
              API_ID=$(aws apigatewayv2 create-api \\
                --name "\${API_NAME}" \\
                --protocol-type HTTP \\
                --target "\${FUNC_ARN}" \\
                --query 'ApiId' --output text)
              echo "Created API Gateway: \${API_ID}"
            else
              echo "API Gateway already exists: \${API_ID}"
            fi

            if [ -z "\${API_ID}" ] || [ "\${API_ID}" = "None" ]; then
              echo "::error::Failed to create or find API Gateway for \${FUNC_NAME}"
              exit 1
            fi
            echo "API Gateway \${API_ID} ready for \${FUNC_NAME}"

            # Grant API Gateway permission to invoke Lambda (statement-id includes API_ID for idempotency)
            aws lambda add-permission \\
              --function-name "\${FUNC_NAME}" \\
              --statement-id "ApiGwInvoke-\${API_ID}" \\
              --action "lambda:InvokeFunction" \\
              --principal "apigateway.amazonaws.com" \\
              --source-arn "arn:aws:execute-api:\${{ env.AWS_REGION }}:\$(aws sts get-caller-identity --query Account --output text):\${API_ID}/*" 2>/dev/null || true

            API_URL="https://\${API_ID}.execute-api.\${{ env.AWS_REGION }}.amazonaws.com/"
            echo "\${ENV_NAME}_gw_url=\${API_URL}" >> "$GITHUB_OUTPUT"
            echo "\${ENV_NAME}_function_name=\${FUNC_NAME}" >> "$GITHUB_OUTPUT"
            echo "\${ENV_NAME}_api_id=\${API_ID}" >> "$GITHUB_OUTPUT"
            echo "Deployed \${FUNC_NAME}: \${API_URL}"
          done

      - name: Health Check
        run: |
          ENVS=$(echo '\${{ inputs.environments }}' | jq -r '.[]')
          for ENV_NAME in \${ENVS}; do
            FUNC_NAME="\${{ inputs.project_name }}-\${ENV_NAME}"
            API_NAME="\${FUNC_NAME}-api"
            API_ID=$(aws apigatewayv2 get-apis --output json | \\
              jq -r ".Items[] | select(.Name==\\"\${API_NAME}\\") | .ApiId" | head -1)
            if [ -z "\${API_ID}" ]; then
              echo "::warning::No API Gateway for \${FUNC_NAME}, skipping health check"
              continue
            fi
            API_URL="https://\${API_ID}.execute-api.\${{ env.AWS_REGION }}.amazonaws.com/"
            echo "Checking \${API_URL}health..."
            for i in $(seq 1 10); do
              if curl -sf "\${API_URL}health" > /dev/null 2>&1; then
                echo "\${FUNC_NAME} is healthy"
                break
              fi
              echo "Waiting (\${i}/10)..."
              sleep 3
            done
          done

      - name: Create Postman Environments
        id: environments
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"
          WORKSPACE_ID="\${{ steps.workspace.outputs.workspace_id }}"
          ENVS=$(echo '\${{ inputs.environments }}' | jq -r '.[]')

          for ENV_NAME in \${ENVS}; do
            FUNC_NAME="\${{ inputs.project_name }}-\${ENV_NAME}"
            API_NAME="\${FUNC_NAME}-api"
            API_ID=$(aws apigatewayv2 get-apis --output json | \\
              jq -r ".Items[] | select(.Name==\\"\${API_NAME}\\") | .ApiId" | head -1)
            GW_URL="https://\${API_ID}.execute-api.\${{ env.AWS_REGION }}.amazonaws.com"
            BASE_URL="\${GW_URL}"

            RESPONSE=$(curl -sf -X POST "\${{ env.POSTMAN_API_BASE }}/environments?workspace=\${WORKSPACE_ID}" \\
              -H "X-Api-Key: \${API_KEY}" \\
              -H "Content-Type: application/json" \\
              -d "{
                \\"environment\\": {
                  \\"name\\": \\"\${{ inputs.project_name }} - \${ENV_NAME}\\",
                  \\"values\\": [
                    {\\"key\\": \\"baseUrl\\", \\"value\\": \\"\${BASE_URL}\\", \\"type\\": \\"default\\"},
                    {\\"key\\": \\"CI\\", \\"value\\": \\"false\\", \\"type\\": \\"default\\"},
                    {\\"key\\": \\"RESPONSE_TIME_THRESHOLD\\", \\"value\\": \\"2000\\", \\"type\\": \\"default\\"},
                    {\\"key\\": \\"AWS_ACCESS_KEY_ID\\", \\"value\\": \\"\\", \\"type\\": \\"secret\\"},
                    {\\"key\\": \\"AWS_SECRET_ACCESS_KEY\\", \\"value\\": \\"\\", \\"type\\": \\"secret\\"},
                    {\\"key\\": \\"AWS_REGION\\", \\"value\\": \\"us-east-1\\", \\"type\\": \\"default\\"},
                    {\\"key\\": \\"AWS_SECRET_NAME\\", \\"value\\": \\"api-credentials-\${ENV_NAME}\\", \\"type\\": \\"default\\"}
                  ]
                }
              }")
            ENV_UID=$(echo "$RESPONSE" | jq -r '.environment.uid')
            echo "\${ENV_NAME}_env_uid=\${ENV_UID}" >> "$GITHUB_OUTPUT"
            echo "Environment \${ENV_NAME}: \${ENV_UID}"
          done

      - name: Create Mock Server
        id: mock
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"
          RESPONSE=$(curl -sf -X POST "\${{ env.POSTMAN_API_BASE }}/mocks" \\
            -H "X-Api-Key: \${API_KEY}" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"mock\\": {
                \\"name\\": \\"\${{ inputs.project_name }} Mock\\",
                \\"collection\\": \\"\${{ steps.collections.outputs.baseline_uid }}\\",
                \\"environment\\": \\"\${{ steps.environments.outputs.dev_env_uid }}\\"
              }
            }")
          MOCK_URL=$(echo "$RESPONSE" | jq -r '.mock.mockUrl // .mock.config.serverResponseId // ""')
          echo "mock_url=\${MOCK_URL}" >> "$GITHUB_OUTPUT"
          echo "Mock server: \${MOCK_URL}"

      - name: Store AWS Outputs as Repo Variables
        run: |
          GH_TOKEN="\${{ secrets.GH_TOKEN }}"
          REPO="\${{ github.repository }}"
          set_var() {
            curl -sf -X PATCH "https://api.github.com/repos/\${REPO}/actions/variables/$1" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"$1\\", \\"value\\": \\"$2\\"}" 2>/dev/null || \\
            curl -sf -X POST "https://api.github.com/repos/\${REPO}/actions/variables" \\
              -H "Authorization: Bearer \${GH_TOKEN}" \\
              -H "X-GitHub-Api-Version: 2022-11-28" \\
              -d "{\\"name\\": \\"$1\\", \\"value\\": \\"$2\\"}"
          }
          set_var "FUNCTION_NAME" "\${{ inputs.project_name }}-dev"
          set_var "DEV_GW_URL" "\${{ steps.lambda.outputs.dev_gw_url }}"
          set_var "PROD_GW_URL" "\${{ steps.lambda.outputs.prod_gw_url }}"
          set_var "POSTMAN_ENVIRONMENT_UID" "\${{ steps.environments.outputs.dev_env_uid }}"
          set_var "MOCK_URL" "\${{ steps.mock.outputs.mock_url }}"
          echo "AWS outputs stored"

      - name: Export Postman Artifacts to Repo
        run: |
          API_KEY="\${{ secrets.POSTMAN_API_KEY }}"
          mkdir -p postman/collections postman/environments postman/specs postman/mocks postman/globals .postman

          # Export collections
          curl -sf "\${{ env.POSTMAN_API_BASE }}/collections/\${{ steps.collections.outputs.baseline_uid }}" \\
            -H "X-Api-Key: \${API_KEY}" | jq '.collection' > postman/collections/baseline.postman_collection.json
          curl -sf "\${{ env.POSTMAN_API_BASE }}/collections/\${{ steps.collections.outputs.smoke_uid }}" \\
            -H "X-Api-Key: \${API_KEY}" | jq '.collection' > postman/collections/smoke.postman_collection.json
          curl -sf "\${{ env.POSTMAN_API_BASE }}/collections/\${{ steps.collections.outputs.contract_uid }}" \\
            -H "X-Api-Key: \${API_KEY}" | jq '.collection' > postman/collections/contract.postman_collection.json

          # Export environments
          ENVS=$(echo '\${{ inputs.environments }}' | jq -r '.[]')
          for ENV_NAME in \${ENVS}; do
            FUNC_NAME="\${{ inputs.project_name }}-\${ENV_NAME}"
            ENV_UID=$(curl -sf "\${{ env.POSTMAN_API_BASE }}/environments?workspace=\${{ steps.workspace.outputs.workspace_id }}" \\
              -H "X-Api-Key: \${API_KEY}" | jq -r ".environments[] | select(.name | contains(\\"\${ENV_NAME}\\")) | .uid")
            if [ -n "\${ENV_UID}" ]; then
              curl -sf "\${{ env.POSTMAN_API_BASE }}/environments/\${ENV_UID}" \\
                -H "X-Api-Key: \${API_KEY}" | jq '.environment' > "postman/environments/\${ENV_NAME}.postman_environment.json"
            fi
          done

          # Copy spec
          cp openapi.yaml postman/specs/openapi.yaml

          # Generate .postman/config.json
          cat > .postman/config.json << 'EOF'
          {
            "workspaceId": "\${{ steps.workspace.outputs.workspace_id }}",
            "collectionPaths": ["postman/collections/"],
            "environmentPaths": ["postman/environments/"],
            "specPaths": ["postman/specs/"]
          }
          EOF

          echo "Artifacts exported"

      - name: Connect Workspace via Bifrost
        continue-on-error: true
        run: |
          REPO_URL="https://github.com/\${{ github.repository }}.git"
          curl -sf -X POST "https://bifrost-v10.getpostman.com/ws/proxy" \\
            -H "x-access-token: \${{ secrets.POSTMAN_ACCESS_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d "{
              \\"service\\": \\"workspaces\\",
              \\"method\\": \\"POST\\",
              \\"path\\": \\"/workspaces/\${{ steps.workspace.outputs.workspace_id }}/filesystem\\",
              \\"body\\": {
                \\"path\\": \\"/\\",
                \\"repo\\": \\"\${REPO_URL}\\",
                \\"versionControl\\": true
              }
            }"
          echo "Bifrost connection attempted"

      - name: Commit Artifacts & Replace Provision with CI Workflow
        run: |
          git config user.name "BRAVE Platform"
          git config user.email "brave-platform@lplfinancial.com"

          # Add exported artifacts
          git add postman/ .postman/
          git commit -m "chore: add Postman artifacts (collections, environments, spec)" || true

          # Generate ci.yml from base64 to avoid GHA expression evaluation
          echo "${ciBase64}" | base64 -d > .github/workflows/ci.yml

          # Remove provision.yml and add ci.yml atomically
          git rm .github/workflows/provision.yml
          git add .github/workflows/ci.yml
          git commit -m "feat: replace provision workflow with CI/CD pipeline"

          git push origin main

      - name: Summary
        run: |
          echo "## Provisioning Complete" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "| Resource | Value |" >> "$GITHUB_STEP_SUMMARY"
          echo "|----------|-------|" >> "$GITHUB_STEP_SUMMARY"
          echo "| Workspace | [\${{ steps.workspace.outputs.workspace_id }}](\${{ steps.workspace.outputs.workspace_url }}) |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Baseline Collection | \${{ steps.collections.outputs.baseline_uid }} |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Smoke Collection | \${{ steps.collections.outputs.smoke_uid }} |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Contract Collection | \${{ steps.collections.outputs.contract_uid }} |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Mock Server | \${{ steps.mock.outputs.mock_url }} |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Dev API Gateway URL | \${{ steps.lambda.outputs.dev_gw_url }} |" >> "$GITHUB_STEP_SUMMARY"

  cleanup:
    name: Cleanup on Failure
    needs: provision
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Delete Postman Workspace
        continue-on-error: true
        run: |
          WORKSPACE_ID="\${{ needs.provision.outputs.workspace_id }}"
          if [ -n "\${WORKSPACE_ID}" ]; then
            curl -sf -X DELETE "\${{ env.POSTMAN_API_BASE }}/workspaces/\${WORKSPACE_ID}" \\
              -H "X-Api-Key: \${{ secrets.POSTMAN_API_KEY }}"
            echo "Workspace deleted: \${WORKSPACE_ID}"
          fi
        env:
          POSTMAN_API_BASE: "https://api.getpostman.com"

      - name: Delete Lambda Functions
        continue-on-error: true
        run: |
          PROJECT="\${{ github.event.inputs.project_name }}"
          ENVS=$(echo '\${{ github.event.inputs.environments }}' | jq -r '.[]')
          for ENV_NAME in \${ENVS}; do
            FUNC_NAME="\${PROJECT}-\${ENV_NAME}"
            API_NAME="\${FUNC_NAME}-api"
            API_ID=$(aws apigatewayv2 get-apis --output json | \\
              jq -r ".Items[] | select(.Name==\\"\${API_NAME}\\") | .ApiId" | head -1)
            if [ -n "\${API_ID}" ]; then
              aws apigatewayv2 delete-api --api-id "\${API_ID}" 2>/dev/null || true
              echo "Deleted API Gateway: \${API_ID}"
            fi
            aws lambda delete-function --function-name "\${FUNC_NAME}" 2>/dev/null || true
            echo "Deleted Lambda: \${FUNC_NAME}"
          done

      - name: Delete IAM Role
        continue-on-error: true
        run: |
          PROJECT="\${{ github.event.inputs.project_name }}"
          ROLE_NAME="cse-lpl-\${PROJECT}-lambda-role"
          aws iam detach-role-policy \\
            --role-name "\${ROLE_NAME}" \\
            --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
          aws iam delete-role --role-name "\${ROLE_NAME}" 2>/dev/null || true
          echo "Deleted IAM role: \${ROLE_NAME}"
`;
}
