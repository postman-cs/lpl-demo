import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("Worker Route Dispatcher", () => {
  // Task 1.5: GET /api/health returns 200 with { status: "ok" }
  it("GET /api/health returns 200 with status ok", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/health");
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  // Task 1.4: CORS preflight returns 204
  it("OPTIONS /api/* returns CORS preflight", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/health", {
      method: "OPTIONS",
    });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  // Task 1.4: Unknown API routes return 404
  it("GET /api/unknown returns 404", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/nonexistent");
    expect(resp.status).toBe(404);
  });

  // Task 1.4: API responses include CORS headers
  it("API responses include CORS headers", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/health");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // Task 1.1: No BraveBackend class exported
  it("does not export BraveBackend", async () => {
    const mod = await import("../src/index");
    expect((mod as any).BraveBackend).toBeUndefined();
  });

  // Task 1.4: POST /api/provision validates input
  it("POST /api/provision returns 400 without required fields", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/provision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string };
    expect(body.error).toContain("required");
  });

  // Task 7.1: POST /api/teardown validates input
  it("POST /api/teardown returns 400 without project_name", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/teardown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  // Task 7.2: GET /api/status validates input
  it("GET /api/status returns 400 without project param", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/api/status");
    expect(resp.status).toBe(400);
  });

  // Non-API routes go through ASSETS
  it("non-API route returns asset content", async () => {
    const resp = await SELF.fetch("https://lpl.pm-demo.dev/index.html");
    // In test env, ASSETS serves from docs/ directory
    expect(resp.status).toBe(200);
  });
});
