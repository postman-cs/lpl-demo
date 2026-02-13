import { describe, it, expect } from "vitest";
import { generateProvisionWorkflow } from "../src/lib/provision-workflow";

describe("generateProvisionWorkflow", () => {
  const workflow = generateProvisionWorkflow();

  it("returns a non-empty string", () => {
    expect(workflow.length).toBeGreaterThan(0);
  });

  it("declares required workflow_dispatch inputs", () => {
    expect(workflow).toContain("project_name:");
    expect(workflow).toContain("domain:");
    expect(workflow).toContain("domain_code:");
    expect(workflow).toContain("requester_email:");
    expect(workflow).toContain("spec_url:");
    expect(workflow).toContain("environments:");
  });

  it("contains the provision job", () => {
    expect(workflow).toContain("provision:");
    expect(workflow).toContain("Provision Postman + AWS");
  });

  it("contains all expected Postman steps", () => {
    expect(workflow).toContain("Install Postman CLI");
    expect(workflow).toContain("Create Postman Workspace");
    expect(workflow).toContain("Assign Workspace to Governance Group");
    expect(workflow).toContain("Invite Requester to Workspace");
    expect(workflow).toContain("Upload Spec to Spec Hub");
    expect(workflow).toContain("Lint Spec via Postman CLI");
    expect(workflow).toContain("Generate Collections from Spec");
    expect(workflow).toContain("Inject Test Scripts & Request 0");
    expect(workflow).toContain("Tag Collections");
    expect(workflow).toContain("Create Postman Environments");
    expect(workflow).toContain("Create Mock Server");
  });

  it("contains all expected AWS steps", () => {
    expect(workflow).toContain("Configure AWS Credentials");
    expect(workflow).toContain("Create IAM Execution Role");
    expect(workflow).toContain("Package Lambda");
    expect(workflow).toContain("Deploy Lambda Functions");
    expect(workflow).toContain("Health Check");
  });

  it("contains sync and finalization steps", () => {
    expect(workflow).toContain("Store Postman UIDs as Repo Variables");
    expect(workflow).toContain("Store AWS Outputs as Repo Variables");
    expect(workflow).toContain("Export Postman Artifacts to Repo");
    expect(workflow).toContain("Connect Workspace via Bifrost");
    expect(workflow).toContain("Commit Artifacts & Replace Provision with CI Workflow");
    expect(workflow).toContain("Summary");
  });

  it("contains the cleanup job for failure", () => {
    expect(workflow).toContain("cleanup:");
    expect(workflow).toContain("Cleanup on Failure");
    expect(workflow).toContain("if: failure()");
    expect(workflow).toContain("Delete Postman Workspace");
    expect(workflow).toContain("Delete Lambda Functions");
    expect(workflow).toContain("Delete IAM Role");
  });

  it("uses correct env vars", () => {
    expect(workflow).toContain("POSTMAN_API_BASE:");
    expect(workflow).toContain("AWS_REGION:");
    expect(workflow).toContain("PYTHON_VERSION:");
  });

  it("outputs workspace_id and collection UIDs", () => {
    expect(workflow).toContain("workspace_id:");
    expect(workflow).toContain("baseline_uid:");
    expect(workflow).toContain("smoke_uid:");
    expect(workflow).toContain("contract_uid:");
    expect(workflow).toContain("mock_url:");
  });

  it("contains only valid GitHub Actions expression contexts", () => {
    // GitHub Actions expressions (${{ }}) can only reference known contexts:
    // steps, inputs, secrets, env, github, needs, runner, matrix, strategy, job
    const VALID_CONTEXTS = [
      "steps", "inputs", "secrets", "env", "github", "needs",
      "runner", "matrix", "strategy", "job", "vars", "format",
    ];
    // Match all ${{ ... }} expressions (after TypeScript template literal unescaping,
    // the generated YAML has literal ${{ ... }} -- but in the TS source they appear as \${{ ... }}).
    // In the generated string, they are actual ${{ ... }}.
    const exprRegex = /\$\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let match;
    const foundContexts = new Set<string>();
    while ((match = exprRegex.exec(workflow)) !== null) {
      foundContexts.add(match[1]);
    }
    for (const ctx of foundContexts) {
      expect(
        VALID_CONTEXTS.includes(ctx),
        `Invalid GitHub Actions expression context: '${ctx}' -- only ${VALID_CONTEXTS.join(", ")} are allowed`
      ).toBe(true);
    }
  });

  describe("Deploy Lambda Functions step", () => {
    it("exits with error if function creation fails after retries", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      expect(deploySection).toContain("get-function --function-name");
      expect(deploySection).toContain("exit 1");
    });

    it("does not swallow wait function-active-v2 failure", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      const waitLine = deploySection.split("\n").find(l => l.includes("wait function-active-v2"));
      expect(waitLine).toBeDefined();
      expect(waitLine).not.toContain("|| sleep");
    });

    it("uses lookup-first pattern for API Gateway", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      // Should check get-apis first, then create-api if not found
      const getIdx = deploySection.indexOf("apigatewayv2 get-apis");
      const createIdx = deploySection.indexOf("apigatewayv2 create-api");
      expect(getIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(getIdx);
    });

    it("uses jq to parse API Gateway lookup", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      expect(deploySection).toContain("jq -r");
    });

    it("uses dynamic statement-id for add-permission", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      // Statement ID must include API_ID for idempotency across re-runs
      expect(deploySection).toContain("ApiGwInvoke-${API_ID}");
      // Should NOT use a static statement-id
      expect(deploySection).not.toMatch(/--statement-id\s+"ApiGatewayInvoke"/);
    });

    it("does not hardcode AWS account ID", () => {
      const deploySection = workflow.split("Deploy Lambda Functions")[1]?.split("- name:")[0] || "";
      // source-arn should use dynamic account lookup, not hardcoded ID
      expect(deploySection).toContain("sts get-caller-identity");
      expect(deploySection).not.toContain("780401591112");
    });
  });

  describe("Health Check step", () => {
    it("does not use env.ENV_NAME in GitHub Actions expressions", () => {
      // ENV_NAME is a shell variable in a for loop, NOT a GitHub Actions env variable.
      // Using env.ENV_NAME in ${{ }} expressions won't resolve correctly.
      expect(workflow).not.toContain("env.ENV_NAME");
    });

    it("retrieves API Gateway URL from AWS directly", () => {
      // Health Check should look up the API Gateway endpoint by name
      const healthSection = workflow.split("Health Check")[1]?.split("- name:")[0] || "";
      expect(healthSection).toContain("apigatewayv2 get-apis");
    });
  });

  describe("Lint step stores LINT vars as repo variables directly", () => {
    it("stores LINT_WARNINGS and LINT_ERRORS as repo variables in the lint step", () => {
      const lintSection = workflow.split("Lint Spec via Postman CLI")[1]?.split("- name:")[0] || "";
      expect(lintSection).toContain('store_lint_var "LINT_WARNINGS"');
      expect(lintSection).toContain('store_lint_var "LINT_ERRORS"');
    });

    it("does NOT store LINT vars in the Store Postman UIDs step", () => {
      const storeSection = workflow.split("Store Postman UIDs as Repo Variables")[1]?.split("- name:")[0] || "";
      expect(storeSection).not.toContain("LINT_WARNINGS");
      expect(storeSection).not.toContain("LINT_ERRORS");
    });
  });

  describe("cleanup job", () => {
    it("deletes API Gateway before Lambda functions", () => {
      const cleanupSection = workflow.split("Delete Lambda Functions")[1]?.split("- name:")[0] || "";
      expect(cleanupSection).toContain("apigatewayv2 delete-api");
      expect(cleanupSection).toContain("delete-function");
    });
  });
});
