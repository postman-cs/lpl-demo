import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDomainCode, handleProvision, buildFinalData } from "../src/lib/provision";

// Mock sleep to resolve instantly -- eliminates ~42s of real delays across 9 pipeline tests
vi.mock("../src/lib/sleep", () => ({
  sleep: () => Promise.resolve(),
}));

describe("getDomainCode", () => {
  it("maps wealth to WEAL", () => {
    expect(getDomainCode("wealth")).toBe("WEAL");
  });

  it("maps payments to PAYM", () => {
    expect(getDomainCode("payments")).toBe("PAYM");
  });

  it("maps identity to IDEN", () => {
    expect(getDomainCode("identity")).toBe("IDEN");
  });

  it("maps platform to PLAT", () => {
    expect(getDomainCode("platform")).toBe("PLAT");
  });

  it("defaults unknown domains to WEAL", () => {
    expect(getDomainCode("unknown")).toBe("WEAL");
    expect(getDomainCode("")).toBe("WEAL");
  });
});


const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset") },
  POSTMAN_API_KEY: "test-key",
  POSTMAN_ACCESS_TOKEN: "test-token",
  GH_TOKEN: "test-gh",
  AWS_ACCESS_KEY_ID: "test-aws-key",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
};

describe("handleProvision", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      body: "not json",
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when project_name is missing", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requester_email: "test@test.com" }),
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("required");
  });

  it("returns 400 when requester_email is missing", async () => {
    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "test" }),
    });
    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("required");
  });
});

// Helper to set up the full mock chain for a successful pipeline
function setupPipelineMocks(repoName: string) {
  const ghApi = fetchMock.get("https://api.github.com");
  const rawGh = fetchMock.get("https://raw.githubusercontent.com");

  // createRepo
  ghApi.intercept({ path: "/orgs/postman-cs/repos", method: "POST" })
    .reply(201, { full_name: `postman-cs/${repoName}`, html_url: `https://github.com/postman-cs/${repoName}`, default_branch: "main" });

  // fetchBoilerplate
  for (const p of ["app/__init__.py", "app/models.py", "app/routes.py", "app/wsgi.py", "tests/__init__.py", "tests/test_health.py", "requirements.txt", "requirements-dev.txt", "Dockerfile", "openapi.yaml"]) {
    rawGh.intercept({ path: `/postman-cs/lpl-demo/main/server/boilerplate/${p}` }).reply(200, "c");
  }

  // appendCommit: get ref → get parent commit → 13 blobs → tree → commit → update ref
  ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/refs/heads/main` })
    .reply(200, { object: { sha: "parent-sha" } });
  ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/commits/parent-sha` })
    .reply(200, { sha: "parent-sha", tree: { sha: "parent-tree" } });
  for (let i = 0; i < 13; i++) {
    ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/blobs`, method: "POST" }).reply(201, { sha: `b${i}` });
  }
  ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/trees`, method: "POST" }).reply(201, { sha: "tree" });
  ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/commits`, method: "POST" }).reply(201, { sha: "commit" });
  ghApi.intercept({ path: `/repos/postman-cs/${repoName}/git/refs/heads/main`, method: "PATCH" }).reply(200, { object: { sha: "commit" } });

  // lookupUser
  ghApi.intercept({ path: /\/search\/users/ }).reply(200, { total_count: 0, items: [] });

  // createRepoSecret — 5 secrets
  for (let i = 0; i < 5; i++) {
    const kb = new Uint8Array(32); crypto.getRandomValues(kb);
    ghApi.intercept({ path: /\/actions\/secrets\/public-key/ }).reply(200, { key: btoa(String.fromCharCode(...kb)), key_id: "k" });
    ghApi.intercept({ path: /\/actions\/secrets\//, method: "PUT" }).reply(204, "");
  }

  // triggerWorkflow
  ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/dispatches/, method: "POST" }).reply(204, "");

  // createRepoVariable (POSTMAN_TEAM_ID) — PATCH then POST
  ghApi.intercept({ path: /\/actions\/variables\/POSTMAN_TEAM_ID/, method: "PATCH" }).reply(204, "");

  return ghApi;
}

async function readSSEStream(resp: Response): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe("handleProvision pipeline", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("streams SSE events for a successful pipeline run", async () => {
    const ghApi = setupPipelineMocks("test");

    // getLatestWorkflowRun — completed immediately
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 99, status: "completed", conclusion: "success", html_url: "https://github.com/run/99" }] });

    // getWorkflowJobs
    ghApi.intercept({ path: /\/actions\/runs\/99\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "success",
        steps: [
          { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 1 },
          { name: "Deploy Lambda Functions", status: "completed", conclusion: "success", number: 2 },
          { name: "Summary", status: "completed", conclusion: "success", number: 3 },
        ] }] });

    // Second poll
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 99, status: "completed", conclusion: "success", html_url: "https://github.com/run/99" }] });

    // buildFinalData
    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/test/actions/variables/${name}` }).reply(200, { name, value: `v-${name}` });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "test", domain: "wealth", requester_email: "user@test.com", spec_url: "https://example.com/spec.yaml" }),
    });

    const resp = await handleProvision(req, mockEnv);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"github"');
    expect(text).toContain('"phase":"postman"');
    expect(text).toContain('"phase":"complete"');
    expect(text).toContain('"status":"complete"');
  });

  it("streams error when createRepo fails", async () => {
    fetchMock.get("https://api.github.com")
      .intercept({ path: "/orgs/postman-cs/repos", method: "POST" })
      .reply(422, { message: "already exists" });

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "fail-test", domain: "wealth", requester_email: "user@test.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"error"');
    expect(text).toContain("Failed to create repo");
  });

  it("handles workflow that fails", async () => {
    const ghApi = setupPipelineMocks("wf-fail");

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 77, status: "completed", conclusion: "failure", html_url: "https://github.com/run/77" }] });

    ghApi.intercept({ path: /\/actions\/runs\/77\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "failure",
        steps: [{ name: "Deploy Lambda Functions", status: "completed", conclusion: "failure", number: 1 }] }] });

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 77, status: "completed", conclusion: "failure", html_url: "https://github.com/run/77" }] });

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "wf-fail", domain: "payments", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"status":"error"');
    expect(text).toContain("Workflow failed");
  });

  it("handles in_progress step status", async () => {
    const ghApi = setupPipelineMocks("prog");

    // Find-run poll: in_progress (sets runId)
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 88, status: "in_progress", conclusion: null, html_url: "https://github.com/run/88" }] });

    // Main loop iteration 1: still in_progress (exercises in_progress step handling)
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 88, status: "in_progress", conclusion: null, html_url: "https://github.com/run/88" }] });
    ghApi.intercept({ path: /\/actions\/runs\/88\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "in_progress", conclusion: null,
        steps: [{ name: "Install Postman CLI", status: "in_progress", conclusion: null, number: 1 }] }] });

    // Main loop iteration 2: completed
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 88, status: "completed", conclusion: "success", html_url: "https://github.com/run/88" }] });
    ghApi.intercept({ path: /\/actions\/runs\/88\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "success",
        steps: [
          { name: "Install Postman CLI", status: "completed", conclusion: "success", number: 1 },
          { name: "Summary", status: "completed", conclusion: "success", number: 2 },
        ] }] });

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/prog/actions/variables/${name}` }).reply(200, { name, value: "v" });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "prog", domain: "platform", requester_email: "u@t.com", environments: ["dev"] }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
  });

  it("handles polling retry when workflow run not immediately found", async () => {
    const ghApi = setupPipelineMocks("poll-retry");

    // First getLatestWorkflowRun → null (triggers polling retry)
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 0, workflow_runs: [] });

    // Second getLatestWorkflowRun → found
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 42, status: "completed", conclusion: "success", html_url: "https://github.com/run/42" }] });

    ghApi.intercept({ path: /\/actions\/runs\/42\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "success",
        steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }] }] });

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 42, status: "completed", conclusion: "success", html_url: "https://github.com/run/42" }] });

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/poll-retry/actions/variables/${name}` }).reply(200, { name, value: "v" });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "poll-retry", domain: "wealth", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    expect(text).toContain('"phase":"complete"');
    expect(text).toContain('"status":"complete"');
  });

  it("handles secret injection failure gracefully", async () => {
    const ghApi = fetchMock.get("https://api.github.com");
    const rawGh = fetchMock.get("https://raw.githubusercontent.com");

    ghApi.intercept({ path: "/orgs/postman-cs/repos", method: "POST" })
      .reply(201, { full_name: "postman-cs/sec-fail", html_url: "https://github.com/postman-cs/sec-fail", default_branch: "main" });

    for (const p of ["app/__init__.py", "app/models.py", "app/routes.py", "app/wsgi.py", "tests/__init__.py", "tests/test_health.py", "requirements.txt", "requirements-dev.txt", "Dockerfile", "openapi.yaml"]) {
      rawGh.intercept({ path: `/postman-cs/lpl-demo/main/server/boilerplate/${p}` }).reply(200, "c");
    }

    // appendCommit: get ref → get parent commit → blobs → tree → commit → update ref
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/refs/heads/main" })
      .reply(200, { object: { sha: "parent-sha" } });
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/commits/parent-sha" })
      .reply(200, { sha: "parent-sha", tree: { sha: "parent-tree" } });
    for (let i = 0; i < 13; i++) {
      ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/blobs", method: "POST" }).reply(201, { sha: `b${i}` });
    }
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/trees", method: "POST" }).reply(201, { sha: "t" });
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/commits", method: "POST" }).reply(201, { sha: "c" });
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/git/refs/heads/main", method: "PATCH" }).reply(200, { object: { sha: "c" } });

    // lookupUser — found this time
    ghApi.intercept({ path: /\/search\/users/ }).reply(200, { total_count: 1, items: [{ login: "testuser" }] });
    ghApi.intercept({ path: "/repos/postman-cs/sec-fail/collaborators/testuser", method: "PUT" }).reply(204, "");

    // Secret injection — all fail at public key fetch
    for (let i = 0; i < 5; i++) {
      ghApi.intercept({ path: /\/actions\/secrets\/public-key/ }).reply(500, "error");
    }

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/dispatches/, method: "POST" }).reply(204, "");

    // createRepoVariable (POSTMAN_TEAM_ID)
    ghApi.intercept({ path: /\/actions\/variables\/POSTMAN_TEAM_ID/, method: "PATCH" }).reply(204, "");

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 55, status: "completed", conclusion: "success", html_url: "https://github.com/run/55" }] });
    ghApi.intercept({ path: /\/actions\/runs\/55\/jobs/ })
      .reply(200, { jobs: [{ name: "p", status: "completed", conclusion: "success", steps: [{ name: "Summary", status: "completed", conclusion: "success", number: 1 }] }] });
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 55, status: "completed", conclusion: "success", html_url: "https://github.com/run/55" }] });

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/sec-fail/actions/variables/${name}` }).reply(200, { name, value: "v" });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "sec-fail", domain: "wealth", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    // Pipeline continues even when secrets fail (try/catch around each)
    expect(text).toContain('"phase":"complete"');
  });
});

describe("buildFinalData", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("fetches repo variables and builds summary", async () => {
    const ghApi = fetchMock.get("https://api.github.com");

    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(200, { name: "POSTMAN_WORKSPACE_ID", value: "ws-abc" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/POSTMAN_SMOKE_COLLECTION_UID" })
      .reply(200, { name: "POSTMAN_SMOKE_COLLECTION_UID", value: "smoke-uid" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/POSTMAN_CONTRACT_COLLECTION_UID" })
      .reply(200, { name: "POSTMAN_CONTRACT_COLLECTION_UID", value: "contract-uid" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/DEV_GW_URL" })
      .reply(200, { name: "DEV_GW_URL", value: "https://abc123.execute-api.us-east-1.amazonaws.com/" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/MOCK_URL" })
      .reply(200, { name: "MOCK_URL", value: "https://mock.pstmn.io" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/FUNCTION_NAME" })
      .reply(200, { name: "FUNCTION_NAME", value: "test-dev" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/LINT_WARNINGS" })
      .reply(200, { name: "LINT_WARNINGS", value: "21" });
    ghApi.intercept({ path: "/repos/postman-cs/test/actions/variables/LINT_ERRORS" })
      .reply(200, { name: "LINT_ERRORS", value: "0" });

    const result = await buildFinalData("token", "test", { project_name: "test", requester_email: "x@x.com", domain: "wealth" } as any);

    expect((result.postman as any).workspace_url).toContain("ws-abc");
    expect((result.postman as any).smoke_uid).toBe("smoke-uid");
    expect((result.aws as any).invoke_url).not.toMatch(/\/$/);
    expect((result.aws as any).function_name).toBe("test-dev");
  });

  it("handles missing variables gracefully", async () => {
    const ghApi = fetchMock.get("https://api.github.com");

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/test/actions/variables/${name}` }).reply(404, "not found");
    }

    const result = await buildFinalData("token", "test", { project_name: "test", requester_email: "x@x.com", domain: "wealth" } as any);

    expect((result.postman as any).smoke_uid).toBe("");
    expect((result.aws as any).function_name).toBe("");
  });
});

function parseSSEEvents(text: string): Array<{phase: string; status: string; message?: string}> {
  return text.split("\n")
    .filter(l => l.startsWith("data: "))
    .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
    .filter(Boolean);
}

describe("phase completion with realistic step ordering", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("sends postman phase complete after Store Postman UIDs step", async () => {
    const ghApi = setupPipelineMocks("phase-test");

    // Realistic step ordering matching the actual provision.yml
    const realisticSteps = [
      { name: "Install Postman CLI", status: "completed", conclusion: "success", number: 4 },
      { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 5 },
      { name: "Assign Workspace to Governance Group", status: "completed", conclusion: "success", number: 6 },
      { name: "Invite Requester to Workspace", status: "completed", conclusion: "success", number: 7 },
      { name: "Upload Spec to Spec Hub", status: "completed", conclusion: "success", number: 8 },
      { name: "Lint Spec via Postman CLI", status: "completed", conclusion: "success", number: 9 },
      { name: "Generate Collections from Spec", status: "completed", conclusion: "success", number: 10 },
      { name: "Inject Test Scripts & Request 0", status: "completed", conclusion: "success", number: 11 },
      { name: "Tag Collections", status: "completed", conclusion: "success", number: 12 },
      { name: "Store Postman UIDs as Repo Variables", status: "completed", conclusion: "success", number: 13 },
      { name: "Configure AWS Credentials", status: "completed", conclusion: "success", number: 14 },
      { name: "Health Check", status: "completed", conclusion: "success", number: 18 },
      { name: "Create Postman Environments", status: "completed", conclusion: "success", number: 19 },
      { name: "Create Mock Server", status: "completed", conclusion: "success", number: 20 },
      { name: "Commit Artifacts & Replace Provision with CI Workflow", status: "completed", conclusion: "success", number: 24 },
      { name: "Summary", status: "completed", conclusion: "success", number: 25 },
    ];

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 100, status: "completed", conclusion: "success", html_url: "https://github.com/run/100" }] });
    ghApi.intercept({ path: /\/actions\/runs\/100\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "success", steps: realisticSteps }] });
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 100, status: "completed", conclusion: "success", html_url: "https://github.com/run/100" }] });

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/phase-test/actions/variables/${name}` }).reply(200, { name, value: "v" });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "phase-test", domain: "wealth", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    // Postman phase should get a "complete" event after "Store Postman UIDs"
    const postmanComplete = events.find(e => e.phase === "postman" && e.status === "complete");
    expect(postmanComplete).toBeDefined();

    // Spec phase should get a "complete" event (renamed from lint)
    const specComplete = events.find(e => e.phase === "spec" && e.status === "complete");
    expect(specComplete).toBeDefined();

    // AWS phase should get a "complete" event
    const awsComplete = events.find(e => e.phase === "aws" && e.status === "complete");
    expect(awsComplete).toBeDefined();

    // postman-env phase should get a "complete" event
    const postmanEnvComplete = events.find(e => e.phase === "postman-env" && e.status === "complete");
    expect(postmanEnvComplete).toBeDefined();

    // sync phase should get a "complete" event
    const syncComplete = events.find(e => e.phase === "sync" && e.status === "complete");
    expect(syncComplete).toBeDefined();
  });

  it("postman phase completes even when AWS phase fails", async () => {
    const ghApi = setupPipelineMocks("aws-fail");

    // AWS fails at Deploy Lambda — postman steps (1-4) and spec steps (5-10) already completed
    const steps = [
      { name: "Install Postman CLI", status: "completed", conclusion: "success", number: 4 },
      { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 5 },
      { name: "Assign Workspace to Governance Group", status: "completed", conclusion: "success", number: 6 },
      { name: "Invite Requester to Workspace", status: "completed", conclusion: "success", number: 7 },
      { name: "Upload Spec to Spec Hub", status: "completed", conclusion: "success", number: 8 },
      { name: "Lint Spec via Postman CLI", status: "completed", conclusion: "success", number: 9 },
      { name: "Generate Collections from Spec", status: "completed", conclusion: "success", number: 10 },
      { name: "Store Postman UIDs as Repo Variables", status: "completed", conclusion: "success", number: 13 },
      { name: "Configure AWS Credentials", status: "completed", conclusion: "success", number: 14 },
      { name: "Deploy Lambda Functions", status: "completed", conclusion: "failure", number: 17 },
    ];

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 200, status: "completed", conclusion: "failure", html_url: "https://github.com/run/200" }] });
    ghApi.intercept({ path: /\/actions\/runs\/200\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "failure", steps }] });
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 200, status: "completed", conclusion: "failure", html_url: "https://github.com/run/200" }] });

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "aws-fail", domain: "wealth", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    // Postman phase MUST still be marked complete (all its steps succeeded)
    const postmanComplete = events.find(e => e.phase === "postman" && e.status === "complete");
    expect(postmanComplete).toBeDefined();

    // Spec phase MUST still be marked complete (renamed from lint)
    const specComplete = events.find(e => e.phase === "spec" && e.status === "complete");
    expect(specComplete).toBeDefined();

    // AWS phase should get an error
    const awsError = events.find(e => e.phase === "aws" && e.status === "error");
    expect(awsError).toBeDefined();

    // postman-env should NOT get a complete (never ran)
    const postmanEnvComplete = events.find(e => e.phase === "postman-env" && e.status === "complete");
    expect(postmanEnvComplete).toBeUndefined();
  });

  it("skips internal GH Actions steps (Post Run, Set up job)", async () => {
    const ghApi = setupPipelineMocks("internal-steps");

    const steps = [
      { name: "Set up job", status: "completed", conclusion: "success", number: 1 },
      { name: "Run actions/checkout@v4", status: "completed", conclusion: "success", number: 2 },
      { name: "Create Postman Workspace", status: "completed", conclusion: "success", number: 4 },
      { name: "Invite Requester to Workspace", status: "completed", conclusion: "success", number: 7 },
      { name: "Store Postman UIDs as Repo Variables", status: "completed", conclusion: "success", number: 13 },
      { name: "Summary", status: "completed", conclusion: "success", number: 20 },
      { name: "Post Run actions/checkout@v4", status: "completed", conclusion: "success", number: 21 },
      { name: "Complete job", status: "completed", conclusion: "success", number: 22 },
    ];

    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 300, status: "completed", conclusion: "success", html_url: "https://github.com/run/300" }] });
    ghApi.intercept({ path: /\/actions\/runs\/300\/jobs/ })
      .reply(200, { jobs: [{ name: "provision", status: "completed", conclusion: "success", steps }] });
    ghApi.intercept({ path: /\/actions\/workflows\/provision.yml\/runs/ })
      .reply(200, { total_count: 1, workflow_runs: [{ id: 300, status: "completed", conclusion: "success", html_url: "https://github.com/run/300" }] });

    for (const name of ["POSTMAN_WORKSPACE_ID", "POSTMAN_SMOKE_COLLECTION_UID", "POSTMAN_CONTRACT_COLLECTION_UID", "DEV_GW_URL", "MOCK_URL", "FUNCTION_NAME", "LINT_WARNINGS", "LINT_ERRORS"]) {
      ghApi.intercept({ path: `/repos/postman-cs/internal-steps/actions/variables/${name}` }).reply(200, { name, value: "v" });
    }

    const req = new Request("https://example.com/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "internal-steps", domain: "wealth", requester_email: "u@t.com" }),
    });

    const resp = await handleProvision(req, mockEnv);
    const text = await readSSEStream(resp);
    const events = parseSSEEvents(text);

    // Should not have events for internal steps
    const internalEvents = events.filter(e => e.message && (e.message.includes("Set up job") || e.message.includes("Post Run") || e.message.includes("Complete job")));
    expect(internalEvents).toHaveLength(0);

    // Postman phase should still complete
    const postmanComplete = events.find(e => e.phase === "postman" && e.status === "complete");
    expect(postmanComplete).toBeDefined();
  });
});
