import type { Env } from "../index";

const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface PostmanTeam {
  id: number;
  name: string;
  handle: string;
  memberCount: number;
}

export async function handleTeams(env: Env): Promise<Response> {
  try {
    const resp = await fetch("https://api.getpostman.com/teams", {
      headers: { "X-Api-Key": env.POSTMAN_API_KEY },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.warn("Postman /teams failed:", resp.status, text);
      return jsonResponse({ teams: [], error: `Postman API returned ${resp.status}` });
    }

    const body = (await resp.json()) as { data: PostmanTeam[] };
    const teams = (body.data || []).map((t) => ({
      id: t.id,
      name: t.name,
      handle: t.handle,
      memberCount: t.memberCount,
    }));

    return jsonResponse({ teams }, {
      "Cache-Control": "public, max-age=300",
    });
  } catch (err) {
    console.error("Failed to fetch teams:", err);
    return jsonResponse({ teams: [], error: "Failed to fetch teams" });
  }
}

function jsonResponse(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}
