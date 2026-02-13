import { handleProvision } from "./lib/provision";
import { handleTeams } from "./lib/teams";
import { handleTeardown, handleStatus } from "./lib/teardown";

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  POSTMAN_API_KEY: string;
  POSTMAN_ACCESS_TOKEN: string;
  GH_TOKEN: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    /* istanbul ignore else -- @preserve ASSETS path covered by worker.test.ts */
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const route = url.pathname.replace(/\/+$/, "");
      let response: Response;

      switch (route) {
        case "/api/health":
          response = json({ status: "ok" });
          break;
        case "/api/provision":
          response = await handleProvision(request, env);
          break;
        case "/api/teams":
          response = await handleTeams(env);
          break;
        case "/api/teardown":
          response = await handleTeardown(request, env);
          break;
        case "/api/status":
          response = await handleStatus(request, env);
          break;
        default:
          response = json({ error: "Not found" }, 404);
      }

      return response;
    }

    /* istanbul ignore next -- @preserve covered by worker.test.ts but instrumentation doesn't track SELF.fetch */
    return env.ASSETS.fetch(request);
  },
};
