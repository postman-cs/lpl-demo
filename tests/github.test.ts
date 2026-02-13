import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createRepo,
  lookupUser,
  addCollaborator,
  deleteRepo,
  createRepoVariable,
  triggerWorkflow,
  getLatestWorkflowRun,
  getWorkflowJobs,
  pushTree,
  appendCommit,
  createRepoSecret,
  encryptSecret,
  retryFetch,
  ORG,
  GH_API,
} from "../src/lib/github";

describe("github helpers", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  describe("createRepo", () => {
    it("creates a repo and returns metadata", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/orgs/${ORG}/repos`, method: "POST" })
        .reply(201, { full_name: "postman-cs/test", html_url: "https://github.com/postman-cs/test", default_branch: "main" });

      const result = await createRepo("token", "test", "A test repo");
      expect(result.full_name).toBe("postman-cs/test");
      expect(result.html_url).toContain("postman-cs/test");
    });

    it("throws on error response", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/orgs/${ORG}/repos`, method: "POST" })
        .reply(422, { message: "already exists" });

      await expect(createRepo("token", "test", "desc")).rejects.toThrow("Failed to create repo");
    });
  });

  describe("lookupUser", () => {
    it("returns username when found", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/search\/users/ })
        .reply(200, { total_count: 1, items: [{ login: "jsmith" }] });

      const result = await lookupUser("token", "j@test.com");
      expect(result).toBe("jsmith");
    });

    it("returns null when not found", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/search\/users/ })
        .reply(200, { total_count: 0, items: [] });

      const result = await lookupUser("token", "nobody@test.com");
      expect(result).toBeNull();
    });

    it("returns null on API error", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/search\/users/ })
        .reply(500, "error");

      const result = await lookupUser("token", "x@test.com");
      expect(result).toBeNull();
    });
  });

  describe("addCollaborator", () => {
    it("adds collaborator without error on 204", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/collaborators/user1`, method: "PUT" })
        .reply(204, "");

      // Should not throw
      await addCollaborator("token", "test", "user1");
    });

    it("handles non-204 non-ok gracefully", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/collaborators/user1`, method: "PUT" })
        .reply(404, { message: "not found" });

      // Should not throw (warns to console)
      await addCollaborator("token", "test", "user1");
    });
  });

  describe("deleteRepo", () => {
    it("calls DELETE on the repo", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test`, method: "DELETE" })
        .reply(204, "");

      await deleteRepo("token", "test");
    });
  });

  describe("createRepoVariable", () => {
    it("updates existing variable", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/variables/MY_VAR`, method: "PATCH" })
        .reply(204, "");

      await createRepoVariable("token", "test", "MY_VAR", "my-value");
    });

    it("creates variable when update fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/actions/variables/NEW_VAR`, method: "PATCH" })
        .reply(404, "not found");
      mock.intercept({ path: `/repos/${ORG}/test/actions/variables`, method: "POST" })
        .reply(201, "");

      await createRepoVariable("token", "test", "NEW_VAR", "new-value");
    });

    it("handles create failure gracefully", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/actions/variables/BAD_VAR`, method: "PATCH" })
        .reply(404, "");
      mock.intercept({ path: `/repos/${ORG}/test/actions/variables`, method: "POST" })
        .reply(500, "error");

      // Should not throw (warns to console)
      await createRepoVariable("token", "test", "BAD_VAR", "val");
    });
  });

  describe("triggerWorkflow", () => {
    it("dispatches workflow successfully", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/workflows/ci.yml/dispatches`, method: "POST" })
        .reply(204, "");

      await triggerWorkflow("token", "test", "ci.yml", { key: "val" });
    });

    it("throws on failure", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/workflows/ci.yml/dispatches`, method: "POST" })
        .reply(500, "server error");

      await expect(triggerWorkflow("token", "test", "ci.yml", {})).rejects.toThrow("Failed to trigger");
    });
  });

  describe("getLatestWorkflowRun", () => {
    it("returns latest run when available", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/actions\/workflows\/ci.yml\/runs/ })
        .reply(200, {
          total_count: 1,
          workflow_runs: [{ id: 42, status: "completed", conclusion: "success", html_url: "https://example.com" }],
        });

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).not.toBeNull();
      expect(run!.id).toBe(42);
      expect(run!.status).toBe("completed");
    });

    it("returns null when no runs exist", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/actions\/workflows\/ci.yml\/runs/ })
        .reply(200, { total_count: 0, workflow_runs: [] });

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).toBeNull();
    });

    it("returns null on API error", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: /\/actions\/workflows\/ci.yml\/runs/ })
        .reply(500, "error");

      const run = await getLatestWorkflowRun("token", "test", "ci.yml");
      expect(run).toBeNull();
    });
  });

  describe("getWorkflowJobs", () => {
    it("returns mapped jobs with steps", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/runs/42/jobs` })
        .reply(200, {
          jobs: [{
            name: "build",
            status: "completed",
            conclusion: "success",
            steps: [
              { name: "Checkout", status: "completed", conclusion: "success", number: 1 },
              { name: "Build", status: "completed", conclusion: "success", number: 2 },
            ],
          }],
        });

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe("build");
      expect(jobs[0].steps).toHaveLength(2);
      expect(jobs[0].steps[0].name).toBe("Checkout");
    });

    it("returns empty array on error", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/runs/42/jobs` })
        .reply(500, "error");

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs).toEqual([]);
    });

    it("handles jobs with no steps", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/runs/42/jobs` })
        .reply(200, {
          jobs: [{ name: "job1", status: "queued", conclusion: null, steps: undefined }],
        });

      const jobs = await getWorkflowJobs("token", "test", 42);
      expect(jobs[0].steps).toEqual([]);
    });
  });

  describe("pushTree", () => {
    it("creates blobs, tree, commit, and ref", async () => {
      const mock = fetchMock.get("https://api.github.com");

      // 2 blob creates
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "blob1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "blob2" });

      // tree
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "tree-sha" });

      // commit
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(201, { sha: "commit-sha" });

      // ref
      mock.intercept({ path: `/repos/${ORG}/test/git/refs`, method: "POST" })
        .reply(201, { ref: "refs/heads/main" });

      const sha = await pushTree("token", "test", [
        { path: "a.txt", content: "aaa" },
        { path: "b.txt", content: "bbb" },
      ], "initial commit");

      expect(sha).toBe("commit-sha");
    });

    it("throws when blob creation fails after retries", async () => {
      const mock = fetchMock.get("https://api.github.com");
      // 4 attempts total (1 initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
          .reply(500, "server error");
      }

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0))
        .rejects.toThrow("Failed to create blob for a.txt: 500");
    });

    it("retries blob creation on transient failure", async () => {
      const mock = fetchMock.get("https://api.github.com");

      // First attempt fails, retry succeeds
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(500, "not ready");
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "blob1" });

      // tree, commit, ref
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "tree-sha" });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(201, { sha: "commit-sha" });
      mock.intercept({ path: `/repos/${ORG}/test/git/refs`, method: "POST" })
        .reply(201, { ref: "refs/heads/main" });

      const sha = await pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0);
      expect(sha).toBe("commit-sha");
    });

    it("throws when tree creation fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "blob1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(500, "error");

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create tree");
    });

    it("throws when commit creation fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "b1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "t1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(500, "error");

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create commit");
    });

    it("throws when ref creation fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "b1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "t1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(201, { sha: "c1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/refs`, method: "POST" })
        .reply(500, "error");

      await expect(pushTree("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create ref");
    });
  });

  describe("appendCommit", () => {
    it("creates commit on existing branch", async () => {
      const mock = fetchMock.get("https://api.github.com");

      // get ref
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "parent-sha" } });

      // get parent commit
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/parent-sha` })
        .reply(200, { tree: { sha: "parent-tree-sha" } });

      // blob
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "blob1" });

      // tree
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "new-tree-sha" });

      // commit
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(201, { sha: "new-commit-sha" });

      // update ref
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main`, method: "PATCH" })
        .reply(200, { ref: "refs/heads/main" });

      const sha = await appendCommit("token", "test", [{ path: "file.txt", content: "hi" }], "update");
      expect(sha).toBe("new-commit-sha");
    });

    it("throws when ref lookup fails", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(404, "not found");

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to get ref");
    });

    it("throws when parent commit lookup fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "parent-sha" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/parent-sha` })
        .reply(500, "error");

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to get parent commit");
    });

    it("throws when blob creation fails in appendCommit after retries", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "ps" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/ps` })
        .reply(200, { tree: { sha: "ts" } });
      // 4 attempts (1 initial + 3 retries)
      for (let i = 0; i < 4; i++) {
        mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
          .reply(500, "error");
      }

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg", "main", 0))
        .rejects.toThrow("Failed to create blob for a.txt: 500");
    });

    it("throws when tree creation fails in appendCommit", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "ps" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/ps` })
        .reply(200, { tree: { sha: "ts" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "b1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(500, "error");

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create tree");
    });

    it("throws when commit creation fails in appendCommit", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "ps" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/ps` })
        .reply(200, { tree: { sha: "ts" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "b1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "t1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(500, "error");

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to create commit");
    });

    it("throws when ref update fails", async () => {
      const mock = fetchMock.get("https://api.github.com");
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main` })
        .reply(200, { object: { sha: "ps" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits/ps` })
        .reply(200, { tree: { sha: "ts" } });
      mock.intercept({ path: `/repos/${ORG}/test/git/blobs`, method: "POST" })
        .reply(201, { sha: "b1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/trees`, method: "POST" })
        .reply(201, { sha: "t1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/commits`, method: "POST" })
        .reply(201, { sha: "c1" });
      mock.intercept({ path: `/repos/${ORG}/test/git/refs/heads/main`, method: "PATCH" })
        .reply(500, "error");

      await expect(appendCommit("token", "test", [{ path: "a.txt", content: "x" }], "msg"))
        .rejects.toThrow("Failed to update ref");
    });
  });

  describe("createRepoSecret", () => {
    it("encrypts and stores a secret", async () => {
      const mock = fetchMock.get("https://api.github.com");

      // Generate a real NaCl key pair for testing
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      const publicKeyB64 = btoa(String.fromCharCode(...keyBytes));

      mock.intercept({ path: `/repos/${ORG}/test/actions/secrets/public-key` })
        .reply(200, { key: publicKeyB64, key_id: "key-123" });

      mock.intercept({ path: `/repos/${ORG}/test/actions/secrets/MY_SECRET`, method: "PUT" })
        .reply(204, "");

      await createRepoSecret("token", "test", "MY_SECRET", "secret-value");
    });

    it("throws when public key fetch fails", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: `/repos/${ORG}/test/actions/secrets/public-key` })
        .reply(500, "error");

      await expect(createRepoSecret("token", "test", "S", "v"))
        .rejects.toThrow("Failed to get repo public key");
    });

    it("throws when secret PUT fails with non-204", async () => {
      const mock = fetchMock.get("https://api.github.com");
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      mock.intercept({ path: `/repos/${ORG}/test/actions/secrets/public-key` })
        .reply(200, { key: btoa(String.fromCharCode(...keyBytes)), key_id: "k1" });
      mock.intercept({ path: `/repos/${ORG}/test/actions/secrets/BAD`, method: "PUT" })
        .reply(500, "error");

      await expect(createRepoSecret("token", "test", "BAD", "v"))
        .rejects.toThrow("Failed to create secret");
    });
  });

  describe("encryptSecret", () => {
    it("returns a base64 string", () => {
      const keyBytes = new Uint8Array(32);
      crypto.getRandomValues(keyBytes);
      const publicKeyB64 = btoa(String.fromCharCode(...keyBytes));

      const result = encryptSecret(publicKeyB64, "my-secret");
      expect(typeof result).toBe("string");
      // Should be valid base64
      expect(() => atob(result)).not.toThrow();
      // Sealed box = 32 (ephemeral pk) + 16 (mac) + message length
      const decoded = atob(result);
      expect(decoded.length).toBeGreaterThan(48);
    });
  });

  describe("retryFetch", () => {
    it("returns immediately on success", async () => {
      fetchMock.get("https://api.github.com")
        .intercept({ path: "/test" })
        .reply(200, "ok");

      const resp = await retryFetch(
        () => fetch("https://api.github.com/test"),
        "test op",
        3,
        10 // fast delay for tests
      );
      expect(resp.ok).toBe(true);
    });

    it("retries on failure then succeeds", async () => {
      const mock = fetchMock.get("https://api.github.com");
      // Fail twice, then succeed
      mock.intercept({ path: "/test" }).reply(500, "fail");
      mock.intercept({ path: "/test" }).reply(500, "fail");
      mock.intercept({ path: "/test" }).reply(200, "ok");

      const resp = await retryFetch(
        () => fetch("https://api.github.com/test"),
        "test op",
        3,
        10
      );
      expect(resp.ok).toBe(true);
    });

    it("throws after exhausting retries with status and body", async () => {
      const mock = fetchMock.get("https://api.github.com");
      for (let i = 0; i < 4; i++) {
        mock.intercept({ path: "/test" }).reply(503, "service unavailable");
      }

      await expect(
        retryFetch(
          () => fetch("https://api.github.com/test"),
          "test op",
          3,
          10
        )
      ).rejects.toThrow("test op: 503");
    });
  });

  it("exports ORG and GH_API constants", () => {
    expect(ORG).toBe("postman-cs");
    expect(GH_API).toBe("https://api.github.com");
  });
});
