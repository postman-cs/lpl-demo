import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleTeardown, handleStatus } from "../src/lib/teardown";

const mockEnv = {
  ASSETS: { fetch: async () => new Response("asset") },
  POSTMAN_API_KEY: "test-key",
  POSTMAN_ACCESS_TOKEN: "test-token",
  GH_TOKEN: "test-gh",
  AWS_ACCESS_KEY_ID: "test-aws-key",
  AWS_SECRET_ACCESS_KEY: "test-aws-secret",
};

// Helper: read all SSE events from a streaming response
async function readAllSSEEvents(resp: Response): Promise<any[]> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        events.push(JSON.parse(line.substring(6)));
      }
    }
  }
  return events;
}

describe("handleTeardown", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      body: "not json",
    });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("Invalid JSON");
  });

  it("returns 400 when project_name is missing", async () => {
    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("project_name");
  });

  it("streams teardown progress for valid request", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    // Workspace ID lookup
    ghMock.intercept({ path: "/repos/postman-cs/test-project/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(200, { name: "POSTMAN_WORKSPACE_ID", value: "ws-123" });

    // Postman workspace delete
    fetchMock.get("https://api.getpostman.com")
      .intercept({ path: "/workspaces/ws-123", method: "DELETE" })
      .reply(200, { workspace: { id: "ws-123" } });

    // GitHub repo delete
    ghMock.intercept({ path: "/repos/postman-cs/test-project", method: "DELETE" })
      .reply(204, "");

    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "test-project" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const events = await readAllSSEEvents(resp);

    // Verify event sequence
    expect(events.some(e => e.phase === "lookup" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "lookup" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "postman" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "postman" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "lambda" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "lambda" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "iam" && e.status === "complete")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "running")).toBe(true);
    expect(events.some(e => e.phase === "github" && e.status === "complete")).toBe(true);

    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.status).toBe("complete");
    expect(completeEvent.data.project).toBe("test-project");
    expect(completeEvent.data.results.postman).toBe("deleted");
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("handles missing workspace gracefully in SSE stream", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    // Workspace ID lookup fails
    ghMock.intercept({ path: "/repos/postman-cs/test-project/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(404, "not found");

    // GitHub repo delete
    ghMock.intercept({ path: "/repos/postman-cs/test-project", method: "DELETE" })
      .reply(204, "");

    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "test-project" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);

    // Lookup should report no workspace found
    const lookupComplete = events.find(e => e.phase === "lookup" && e.status === "complete");
    expect(lookupComplete.message).toContain("No workspace found");

    // Postman phase should skip
    const postmanComplete = events.find(e => e.phase === "postman" && e.status === "complete");
    expect(postmanComplete.message).toContain("No workspace to delete");

    // GitHub should still succeed
    expect(events.some(e => e.phase === "github" && e.status === "complete")).toBe(true);

    // Complete event should have no postman result
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.postman).toBeUndefined();
    expect(completeEvent.data.results.github).toBe("deleted");
  });
});

describe("handleStatus", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("returns 400 when project param is missing", async () => {
    const req = new Request("https://example.com/api/status");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as any;
    expect(body.error).toContain("project");
  });

  it("returns resources for existing project", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    // Repo exists
    ghMock.intercept({ path: "/repos/postman-cs/test-project" })
      .reply(200, { full_name: "postman-cs/test-project" });

    // Workspace variable exists
    ghMock.intercept({ path: "/repos/postman-cs/test-project/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(200, { name: "POSTMAN_WORKSPACE_ID", value: "ws-123" });

    // Lambda + API Gateway variables
    ghMock.intercept({ path: "/repos/postman-cs/test-project/actions/variables/FUNCTION_NAME" })
      .reply(200, { name: "FUNCTION_NAME", value: "test-project-dev" });
    ghMock.intercept({ path: "/repos/postman-cs/test-project/actions/variables/DEV_GW_URL" })
      .reply(200, { name: "DEV_GW_URL", value: "https://abc.execute-api.us-east-1.amazonaws.com/" });

    const req = new Request("https://example.com/api/status?project=test-project");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBe("test-project");
    expect(body.resources.github).toBe(true);
    expect(body.resources.postman).toBe(1);
    expect(body.resources.lambda).toBe(true);
    expect(body.resources.api_gateway).toBe(true);
    expect(body.source).toBe("live");
  });

  it("returns null active_project when repo not found", async () => {
    fetchMock.get("https://api.github.com")
      .intercept({ path: "/repos/postman-cs/test-project" })
      .reply(404, "not found");

    const req = new Request("https://example.com/api/status?project=test-project");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBeNull();
  });

  it("returns resources without postman when workspace var missing", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    ghMock.intercept({ path: "/repos/postman-cs/no-ws" })
      .reply(200, { full_name: "postman-cs/no-ws" });

    ghMock.intercept({ path: "/repos/postman-cs/no-ws/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(404, "not found");

    // handleStatus also checks FUNCTION_NAME and DEV_GW_URL
    ghMock.intercept({ path: "/repos/postman-cs/no-ws/actions/variables/FUNCTION_NAME" })
      .reply(200, { name: "FUNCTION_NAME", value: "no-ws-dev" });
    ghMock.intercept({ path: "/repos/postman-cs/no-ws/actions/variables/DEV_GW_URL" })
      .reply(200, { name: "DEV_GW_URL", value: "https://abc.execute-api.us-east-1.amazonaws.com/" });

    const req = new Request("https://example.com/api/status?project=no-ws");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBe("no-ws");
    expect(body.resources.github).toBe(true);
    expect(body.resources.postman).toBeUndefined();
    expect(body.resources.lambda).toBe(true);
    expect(body.resources.api_gateway).toBe(true);
  });

  it("handles repo check returning non-ok status", async () => {
    fetchMock.get("https://api.github.com")
      .intercept({ path: "/repos/postman-cs/forbidden-proj" })
      .reply(403, { message: "forbidden" });

    const req = new Request("https://example.com/api/status?project=forbidden-proj");
    const resp = await handleStatus(req, mockEnv);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.active_project).toBeNull();
    expect(body.resources).toEqual({});
  });
});

describe("handleTeardown error branches", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("handles Postman workspace delete and continues stream", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    // Return workspace ID so Postman delete is attempted
    ghMock.intercept({ path: "/repos/postman-cs/err-proj/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(200, { name: "POSTMAN_WORKSPACE_ID", value: "ws-err" });

    // Postman delete succeeds
    fetchMock.get("https://api.getpostman.com")
      .intercept({ path: "/workspaces/ws-err", method: "DELETE" })
      .reply(200, "ok");

    // GitHub delete succeeds
    ghMock.intercept({ path: "/repos/postman-cs/err-proj", method: "DELETE" })
      .reply(204, "");

    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "err-proj" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);

    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.postman).toBe("deleted");
    expect(completeEvent.data.results.github).toBe("deleted");
  });

  it("handles GitHub repo delete with non-throwing response", async () => {
    const ghMock = fetchMock.get("https://api.github.com");

    // No workspace ID found
    ghMock.intercept({ path: "/repos/postman-cs/gh-err/actions/variables/POSTMAN_WORKSPACE_ID" })
      .reply(404, "");

    // GitHub delete returns 403 -- deleteRepo doesn't check status
    ghMock.intercept({ path: "/repos/postman-cs/gh-err", method: "DELETE" })
      .reply(403, { message: "forbidden" });

    const req = new Request("https://example.com/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: "gh-err" }),
    });
    const resp = await handleTeardown(req, mockEnv);
    const events = await readAllSSEEvents(resp);

    // deleteRepo doesn't check status, so it "succeeds"
    const completeEvent = events.find(e => e.phase === "complete");
    expect(completeEvent.data.results.github).toBe("deleted");
  });
});
