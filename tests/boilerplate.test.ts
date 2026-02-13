import { fetchMock } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  fetchBoilerplate,
  generateGitignore,
  generateEnvExample,
} from "../src/lib/boilerplate";

describe("generateGitignore", () => {
  it("returns a non-empty string", () => {
    const result = generateGitignore();
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes Python patterns", () => {
    const result = generateGitignore();
    expect(result).toContain("__pycache__/");
    expect(result).toContain("*.py[cod]");
  });

  it("includes environment and deployment patterns", () => {
    const result = generateGitignore();
    expect(result).toContain(".env");
    expect(result).toContain("deployment.zip");
    expect(result).toContain("venv/");
  });
});

describe("generateEnvExample", () => {
  it("includes the project name in a comment", () => {
    const result = generateEnvExample("my-project");
    expect(result).toContain("# my-project");
  });

  it("includes Postman and AWS variables", () => {
    const result = generateEnvExample("test");
    expect(result).toContain("POSTMAN_API_KEY=");
    expect(result).toContain("AWS_ACCESS_KEY_ID=");
    expect(result).toContain("AWS_REGION=us-east-1");
    expect(result).toContain("FUNCTION_NAME=");
  });

  it("includes Flask env", () => {
    const result = generateEnvExample("test");
    expect(result).toContain("FLASK_ENV=development");
  });
});

describe("fetchBoilerplate", () => {
  beforeEach(() => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(() => {
    try { fetchMock.assertNoPendingInterceptors(); } finally { fetchMock.deactivate(); }
  });

  it("fetches all boilerplate files successfully", async () => {
    const mock = fetchMock.get("https://raw.githubusercontent.com");

    // Mock all 10 boilerplate paths
    const paths = [
      "app/__init__.py", "app/models.py", "app/routes.py", "app/wsgi.py",
      "tests/__init__.py", "tests/test_health.py",
      "requirements.txt", "requirements-dev.txt", "Dockerfile", "openapi.yaml",
    ];
    for (const p of paths) {
      mock.intercept({
        path: `/postman-cs/lpl-demo/main/server/boilerplate/${p}`,
      }).reply(200, `content-of-${p}`);
    }

    const files = await fetchBoilerplate("fake-token");
    expect(files).toHaveLength(10);
    expect(files[0].path).toBe("app/__init__.py");
    expect(files[0].content).toBe("content-of-app/__init__.py");
  });

  it("skips files that return non-200", async () => {
    const mock = fetchMock.get("https://raw.githubusercontent.com");

    const paths = [
      "app/__init__.py", "app/models.py", "app/routes.py", "app/wsgi.py",
      "tests/__init__.py", "tests/test_health.py",
      "requirements.txt", "requirements-dev.txt", "Dockerfile", "openapi.yaml",
    ];
    // First file succeeds, rest fail
    mock.intercept({
      path: `/postman-cs/lpl-demo/main/server/boilerplate/${paths[0]}`,
    }).reply(200, "ok");

    for (let i = 1; i < paths.length; i++) {
      mock.intercept({
        path: `/postman-cs/lpl-demo/main/server/boilerplate/${paths[i]}`,
      }).reply(404, "not found");
    }

    const files = await fetchBoilerplate("fake-token");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("app/__init__.py");
  });
});
