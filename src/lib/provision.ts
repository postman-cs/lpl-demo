// POST /api/provision handler
// Creates repo, pushes files, injects secrets, triggers workflow, streams SSE

import type { Env } from "../index";
import { sleep } from "./sleep";
import {
  createRepo,
  addCollaborator,
  lookupUser,
  appendCommit,
  createRepoSecret,
  createRepoVariable,
  triggerWorkflow,
  getLatestWorkflowRun,
  getWorkflowJobs,
  ORG,
} from "./github";
import { SSEWriter, type SSEEvent } from "./sse";
import { fetchBoilerplate, generateGitignore, generateEnvExample } from "./boilerplate";
import { generateProvisionWorkflow } from "./provision-workflow";

interface ProvisionRequest {
  project_name: string;
  domain: string;
  workspace_name?: string;
  application_id?: string;
  requester_email: string;
  product_code?: string;
  environments?: string[];
  spec_source?: string;
  spec_url?: string;
  aws_account_id?: string;
  postman_team_id?: string;
  template?: string;
}

// Human-friendly descriptions for provision.yml step names
const STEP_DESCRIPTIONS: Record<string, string> = {
  "Install Postman CLI": "Installing Postman CLI on runner",
  "Create Postman Workspace": "Creating team workspace",
  "Assign Workspace to Governance Group": "Assigning workspace to governance group",
  "Invite Requester to Workspace": "Granting requester editor access",
  "Upload Spec to Spec Hub": "Uploading OpenAPI spec to Spec Hub",
  "Lint Spec via Postman CLI": "Validating spec against governance rules",
  "Generate Collections from Spec": "Generating Baseline, Smoke, and Contract collections",
  "Inject Test Scripts & Request 0": "Injecting test scripts and secrets resolver",
  "Tag Collections": "Tagging collections (generated, smoke, contract)",
  "Store Postman UIDs as Repo Variables": "Storing Postman UIDs as repo variables",
  "Configure AWS Credentials": "Configuring AWS credentials",
  "Create IAM Execution Role": "Creating Lambda execution role",
  "Package Lambda": "Packaging Flask app for Lambda",
  "Deploy Lambda Functions": "Deploying Lambda functions with API Gateway",
  "Health Check": "Running health checks against deployed functions",
  "Create Postman Environments": "Creating Postman environments with deploy URLs",
  "Create Mock Server": "Creating mock server from baseline collection",
  "Store AWS Outputs as Repo Variables": "Storing deploy URLs as repo variables",
  "Export Postman Artifacts to Repo": "Exporting collections and environments to repo",
  "Connect Workspace via Bifrost": "Connecting workspace to source control",
  "Commit Artifacts & Replace Provision with CI Workflow": "Committing CI/CD pipeline, removing provisioning workflow",
  "Summary": "Generating provisioning summary",
};

// Map provision.yml step names to portal SSE phases
const STEP_PHASE_MAP: Record<string, string> = {
  "Install Postman CLI": "postman",
  "Create Postman Workspace": "postman",
  "Assign Workspace to Governance Group": "postman",
  "Invite Requester to Workspace": "postman",
  "Upload Spec to Spec Hub": "spec",
  "Lint Spec via Postman CLI": "spec",
  "Generate Collections from Spec": "spec",
  "Inject Test Scripts & Request 0": "spec",
  "Tag Collections": "spec",
  "Store Postman UIDs as Repo Variables": "spec",
  "Configure AWS Credentials": "aws",
  "Create IAM Execution Role": "aws",
  "Package Lambda": "aws",
  "Deploy Lambda Functions": "aws",
  "Health Check": "aws",
  "Create Postman Environments": "postman-env",
  "Create Mock Server": "postman-env",
  "Store AWS Outputs as Repo Variables": "sync",
  "Export Postman Artifacts to Repo": "sync",
  "Connect Workspace via Bifrost": "sync",
  "Commit Artifacts & Replace Provision with CI Workflow": "sync",
  "Summary": "complete",
};

// Last workflow step in each portal phase — triggers phase-level "complete"
const PHASE_LAST_STEP: Record<string, string> = {
  postman: "Invite Requester to Workspace",
  spec: "Store Postman UIDs as Repo Variables",
  aws: "Health Check",
  "postman-env": "Create Mock Server",
  sync: "Commit Artifacts & Replace Provision with CI Workflow",
};

export async function handleProvision(
  request: Request,
  env: Env
): Promise<Response> {
  let body: ProvisionRequest;
  try {
    body = (await request.json()) as ProvisionRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }

  if (!body.project_name || !body.requester_email) {
    return new Response(
      JSON.stringify({ error: "project_name and requester_email are required" }),
      { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }

  const sse = new SSEWriter();
  const response = sse.toResponse();

  // Run the provisioning pipeline asynchronously
  const pipeline = runPipeline(body, env, sse);

  // Use waitUntil to keep the Worker alive while streaming
  // (The response is already being streamed to the client)
  // We need to handle this carefully — the pipeline promise
  // will keep running after we return the response.
  /* istanbul ignore next -- @preserve defensive: runPipeline has internal try/catch */
  pipeline.catch((err) => {
    console.error("Pipeline error:", err);
    sse.send({ phase: "error", status: "error", message: err.message });
    sse.close();
  });

  return response;
}

async function runPipeline(
  req: ProvisionRequest,
  env: Env,
  sse: SSEWriter
): Promise<void> {
  const repoName = req.project_name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const domainCode = getDomainCode(req.domain);
  const environments = req.environments || ["dev", "prod"];

  try {
    // Phase: Repo Bootstrap
    sse.send({ phase: "github", status: "running", message: "Creating repository..." });

    const repo = await createRepo(
      env.GH_TOKEN,
      repoName,
      `${req.project_name} — Auto-provisioned by BRAVE`
    );

    sse.send({ phase: "github", status: "running", message: "Fetching boilerplate files..." });

    // Fetch boilerplate and build the initial file tree
    const boilerplate = await fetchBoilerplate(env.GH_TOKEN);
    const provisionYml = generateProvisionWorkflow();

    const files = [
      ...boilerplate,
      { path: ".gitignore", content: generateGitignore() },
      { path: ".env.example", content: generateEnvExample(req.project_name) },
      { path: ".github/workflows/provision.yml", content: provisionYml },
    ];

    sse.send({ phase: "github", status: "running", message: "Pushing initial commit..." });
    await appendCommit(env.GH_TOKEN, repoName, files, "feat: initial API scaffold (BRAVE provisioned)");

    // Grant requester access
    sse.send({ phase: "github", status: "running", message: "Granting collaborator access..." });
    const ghUsername = await lookupUser(env.GH_TOKEN, req.requester_email);
    if (ghUsername) {
      await addCollaborator(env.GH_TOKEN, repoName, ghUsername);
    }

    // Inject secrets
    sse.send({ phase: "github", status: "running", message: "Injecting secrets..." });
    const secrets: Record<string, string> = {
      POSTMAN_API_KEY: env.POSTMAN_API_KEY,
      POSTMAN_ACCESS_TOKEN: env.POSTMAN_ACCESS_TOKEN,
      GH_TOKEN: env.GH_TOKEN,
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
    };
    for (const [name, value] of Object.entries(secrets)) {
      try {
        await createRepoSecret(env.GH_TOKEN, repoName, name, value);
      } catch (err) {
        console.warn(`Failed to set secret ${name}:`, err);
      }
    }

    sse.send({
      phase: "github",
      status: "complete",
      message: "Repository created",
      data: { repo_url: repo.html_url },
    });

    // Set repo variables needed by provision workflow
    try {
      await createRepoVariable(env.GH_TOKEN, repoName, "POSTMAN_TEAM_ID", req.postman_team_id || "132319");
    } catch (err) {
      console.warn("Failed to set POSTMAN_TEAM_ID variable:", err);
    }

    // Trigger provision.yml (retry — GitHub Actions may need time to index new workflow)
    sse.send({ phase: "postman", status: "running", message: "Triggering provisioning workflow..." });
    let triggerAttempts = 0;
    while (triggerAttempts < 5) {
      try {
        await triggerWorkflow(env.GH_TOKEN, repoName, "provision.yml", {
          project_name: req.project_name,
          domain: req.domain,
          domain_code: domainCode,
          requester_email: req.requester_email,
          spec_url: req.spec_url || "",
          environments: JSON.stringify(environments),
          postman_team_id: req.postman_team_id || "132319",
        });
        break;
      } catch (err: any) {
        triggerAttempts++;
        if (triggerAttempts >= 5) throw err;
        await sleep(3000);
      }
    }

    // Wait for workflow run to appear
    await sleep(3000);

    // Poll for workflow status
    let runId: number | null = null;
    let attempts = 0;

    // Find the run ID
    while (!runId && attempts < 20) {
      const run = await getLatestWorkflowRun(env.GH_TOKEN, repoName, "provision.yml");
      /* istanbul ignore next -- @preserve */
      if (run) {
        runId = run.id;
        sse.send({
          phase: "postman",
          status: "running",
          message: "Workflow started...",
          data: { run_url: run.html_url },
        });
      } else {
        /* istanbul ignore next -- @preserve */
        await sleep(2000);
        /* istanbul ignore next -- @preserve */
        attempts++;
      }
    }

    /* istanbul ignore next -- @preserve timeout requires 40s of polling */
    if (!runId) {
      sse.send({ phase: "postman", status: "error", message: "Workflow did not start within timeout" });
      sse.close();
      return;
    }

    // Poll jobs/steps until terminal state
    let completed = false;
    let lastStepsSeen = 0;
    let stepFailed = false;

    while (!completed) {
      await sleep(3000);

      const run = await getLatestWorkflowRun(env.GH_TOKEN, repoName, "provision.yml");
      if (!run) continue;

      const jobs = await getWorkflowJobs(env.GH_TOKEN, repoName, runId);

      for (const job of jobs) {
        for (const step of job.steps) {
          /* istanbul ignore next -- @preserve dedup guard: step already processed in prior poll */
          if (step.number <= lastStepsSeen) continue;

          // Skip GH Actions internal steps (Post Run, Set up job, Complete job, etc.)
          if (!(step.name in STEP_PHASE_MAP)) {
            if (step.status === "completed") lastStepsSeen = Math.max(lastStepsSeen, step.number);
            continue;
          }

          const phase = STEP_PHASE_MAP[step.name];
          const desc = STEP_DESCRIPTIONS[step.name] || step.name;

          // Don't report new running steps after a failure
          if (stepFailed) {
            if (step.status === "completed") lastStepsSeen = Math.max(lastStepsSeen, step.number);
            continue;
          }

          /* istanbul ignore else -- @preserve */
          if (step.status === "in_progress") {
            sse.send({ phase, status: "running", message: desc });
          } else if (step.status === "completed") {
            /* istanbul ignore else -- @preserve */
            if (step.conclusion === "success") {
              sse.send({ phase, status: "success", message: desc });
              // Mark phase complete when its last step succeeds
              if (PHASE_LAST_STEP[phase] === step.name) {
                // Enrich spec phase with lint data for real-time display
                if (phase === "spec") {
                  try {
                    const lintData = await fetchLintVars(env.GH_TOKEN, repoName);
                    sse.send({ phase, status: "complete", message: desc, data: lintData });
                  } catch {
                    sse.send({ phase, status: "complete", message: desc });
                  }
                } else {
                  sse.send({ phase, status: "complete", message: desc });
                }
              }
            } else if (step.conclusion === "failure") {
              sse.send({ phase, status: "error", message: `Failed: ${desc}` });
              stepFailed = true;
            }
            lastStepsSeen = Math.max(lastStepsSeen, step.number);
          }
        }
      }

      /* istanbul ignore next -- @preserve polling loop: false branch continues loop */
      if (run.status === "completed") {
        completed = true;

        if (run.conclusion === "success") {
          // Build final data from repo variables
          const finalData = await buildFinalData(env.GH_TOKEN, repoName, req);

          sse.send({
            phase: "complete",
            status: "complete",
            message: "Provisioning complete!",
            data: finalData,
          });
        } else {
          sse.send({
            phase: "complete",
            status: "error",
            message: `Workflow failed: ${run.conclusion}`,
            data: { run_url: run.html_url },
          });
        }
      }
    }
    /* istanbul ignore next -- @preserve */
  } catch (err: any) {
    /* istanbul ignore next -- @preserve */
    sse.send({ phase: "error", status: "error", message: err.message || "Unknown error" });
  } finally {
    sse.close();
  }
}

async function fetchLintVars(
  token: string,
  repoName: string
): Promise<{ passed: boolean; warnings: number; errors: number }> {
  const fetchVar = async (name: string): Promise<string> => {
    const resp = await fetch(
      `https://api.github.com/repos/${ORG}/${repoName}/actions/variables/${name}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "lpl-brave-worker",
        },
      }
    );
    if (!resp.ok) return "0";
    const data = (await resp.json()) as any;
    return data.value || "0";
  };

  const warnings = parseInt(await fetchVar("LINT_WARNINGS"), 10);
  const errors = parseInt(await fetchVar("LINT_ERRORS"), 10);
  return { passed: errors === 0, warnings, errors };
}

export async function buildFinalData(
  token: string,
  repoName: string,
  req: ProvisionRequest
): Promise<Record<string, unknown>> {
  // Fetch repo variables to build the final summary
  const varNames = [
    "POSTMAN_WORKSPACE_ID",
    "POSTMAN_SMOKE_COLLECTION_UID",
    "POSTMAN_CONTRACT_COLLECTION_UID",
    "DEV_GW_URL",
    "MOCK_URL",
    "FUNCTION_NAME",
    "LINT_WARNINGS",
    "LINT_ERRORS",
  ];

  const vars: Record<string, string> = {};
  for (const name of varNames) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${ORG}/${repoName}/actions/variables/${name}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "lpl-brave-worker",
          },
        }
      );
      if (resp.ok) {
        const data = (await resp.json()) as any;
        vars[name] = data.value;
      }
    } catch {
      // Variable not set
    }
  }

  return {
    project: req.project_name,
    postman: {
      workspace_url: `https://go.postman.co/workspace/${vars.POSTMAN_WORKSPACE_ID || ""}`,
      smoke_uid: vars.POSTMAN_SMOKE_COLLECTION_UID || "",
      contract_uid: vars.POSTMAN_CONTRACT_COLLECTION_UID || "",
      mock_url: vars.MOCK_URL || "",
    },
    github: {
      repo_url: `https://github.com/${ORG}/${repoName}`,
    },
    aws: {
      invoke_url: (vars.DEV_GW_URL || "").replace(/\/$/, ""),
      function_name: vars.FUNCTION_NAME || "",
    },
    lint: {
      warnings: parseInt(vars.LINT_WARNINGS || "0", 10),
      errors: parseInt(vars.LINT_ERRORS || "0", 10),
    },
  };
}

export function getDomainCode(domain: string): string {
  const codes: Record<string, string> = {
    wealth: "WEAL",
    payments: "PAYM",
    identity: "IDEN",
    platform: "PLAT",
  };
  return codes[domain] || "WEAL";
}

// Re-exported from ./sleep so existing imports still work
export { sleep } from "./sleep";
