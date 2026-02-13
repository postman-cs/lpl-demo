// GitHub API helpers for the provisioning Worker
// All calls go through the GitHub REST API v3

import nacl from "tweetnacl";
import sealedbox from "tweetnacl-sealedbox-js";

const GH_API = "https://api.github.com";
const ORG = "postman-cs";

interface GitHubOptions {
  token: string;
}

async function ghFetch(
  path: string,
  opts: GitHubOptions & RequestInit & { json?: unknown }
): Promise<Response> {
  /* istanbul ignore next -- @preserve defensive: all callers use relative paths */
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "lpl-brave-worker",
  };
  if (opts.json) headers["Content-Type"] = "application/json";

  return fetch(url, {
    method: opts.method || "GET",
    headers: { ...headers, ...(opts.headers as Record<string, string>) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
}

export async function createRepo(
  token: string,
  name: string,
  description: string
): Promise<{ full_name: string; html_url: string; default_branch: string }> {
  const resp = await ghFetch(`/orgs/${ORG}/repos`, {
    token,
    method: "POST",
    json: {
      name,
      description,
      private: true,
      auto_init: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    },
  });
  if (!resp.ok) {
    const err = await resp.json();
    throw new Error(`Failed to create repo: ${(err as any).message}`);
  }
  return resp.json() as any;
}

export async function addCollaborator(
  token: string,
  repo: string,
  username: string,
  permission = "admin"
): Promise<void> {
  const resp = await ghFetch(
    `/repos/${ORG}/${repo}/collaborators/${username}`,
    { token, method: "PUT", json: { permission } }
  );
  if (!resp.ok && resp.status !== 204) {
    console.warn(`Failed to add collaborator ${username}: ${resp.status}`);
  }
}

export async function lookupUser(
  token: string,
  email: string
): Promise<string | null> {
  const resp = await ghFetch(
    `/search/users?q=${encodeURIComponent(email)}+in:email`,
    { token }
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  return data.total_count > 0 ? data.items[0].login : null;
}

// Retry helper for transient GitHub API failures (e.g. repo not yet ready after creation)
/* istanbul ignore next -- @preserve default params */
async function retryFetch(
  fn: () => Promise<Response>,
  label: string,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response> {
  let lastResp: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fn();
    if (resp.ok) return resp;
    lastResp = resp;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
  const body = await lastResp!.text().catch(() => "");
  throw new Error(`${label}: ${lastResp!.status} ${body}`.trim());
}

// Push a full tree in one commit via the Git Data API
export async function pushTree(
  token: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch = "main",
  retryDelay = 1000
): Promise<string> {
  // Create blobs for each file (with retry for newly-created repos)
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    const blobResp = await retryFetch(
      () => ghFetch(`/repos/${ORG}/${repo}/git/blobs`, {
        token,
        method: "POST",
        json: { content: file.content, encoding: "utf-8" },
      }),
      `Failed to create blob for ${file.path}`,
      3,
      retryDelay
    );
    const blob = (await blobResp.json()) as any;
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Create tree
  const treeResp = await ghFetch(`/repos/${ORG}/${repo}/git/trees`, {
    token,
    method: "POST",
    json: { tree },
  });
  if (!treeResp.ok) throw new Error("Failed to create tree");
  const treeData = (await treeResp.json()) as any;

  // Create commit (no parent = initial commit)
  const commitResp = await ghFetch(`/repos/${ORG}/${repo}/git/commits`, {
    token,
    method: "POST",
    json: { message, tree: treeData.sha },
  });
  if (!commitResp.ok) throw new Error("Failed to create commit");
  const commit = (await commitResp.json()) as any;

  // Create ref (main branch)
  const refResp = await ghFetch(`/repos/${ORG}/${repo}/git/refs`, {
    token,
    method: "POST",
    json: { ref: `refs/heads/${branch}`, sha: commit.sha },
  });
  if (!refResp.ok) throw new Error("Failed to create ref");

  return commit.sha;
}

// Append a commit to an existing branch
export async function appendCommit(
  token: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch = "main",
  retryDelay = 1000
): Promise<string> {
  // Get current ref
  const refResp = await ghFetch(
    `/repos/${ORG}/${repo}/git/refs/heads/${branch}`,
    { token }
  );
  if (!refResp.ok) throw new Error("Failed to get ref");
  const refData = (await refResp.json()) as any;
  const parentSha = refData.object.sha;

  // Get parent commit's tree
  const parentCommitResp = await ghFetch(
    `/repos/${ORG}/${repo}/git/commits/${parentSha}`,
    { token }
  );
  if (!parentCommitResp.ok) throw new Error("Failed to get parent commit");
  const parentCommit = (await parentCommitResp.json()) as any;

  // Create blobs (with retry)
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    const blobResp = await retryFetch(
      () => ghFetch(`/repos/${ORG}/${repo}/git/blobs`, {
        token,
        method: "POST",
        json: { content: file.content, encoding: "utf-8" },
      }),
      `Failed to create blob for ${file.path}`,
      3,
      retryDelay
    );
    const blob = (await blobResp.json()) as any;
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Create tree with base
  const treeResp = await ghFetch(`/repos/${ORG}/${repo}/git/trees`, {
    token,
    method: "POST",
    json: { base_tree: parentCommit.tree.sha, tree },
  });
  if (!treeResp.ok) throw new Error("Failed to create tree");
  const treeData = (await treeResp.json()) as any;

  // Create commit
  const commitResp = await ghFetch(`/repos/${ORG}/${repo}/git/commits`, {
    token,
    method: "POST",
    json: { message, tree: treeData.sha, parents: [parentSha] },
  });
  if (!commitResp.ok) throw new Error("Failed to create commit");
  const commit = (await commitResp.json()) as any;

  // Update ref
  const updateResp = await ghFetch(
    `/repos/${ORG}/${repo}/git/refs/heads/${branch}`,
    { token, method: "PATCH", json: { sha: commit.sha } }
  );
  if (!updateResp.ok) throw new Error("Failed to update ref");

  return commit.sha;
}

// Encrypt a secret value using the repo's public key (libsodium sealed box via BLAKE2b)
export function encryptSecret(publicKeyB64: string, secretValue: string): string {
  const publicKey = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const messageBytes = new TextEncoder().encode(secretValue);
  const sealed = sealedbox.seal(messageBytes, publicKey);
  return btoa(String.fromCharCode(...sealed));
}

export async function createRepoSecret(
  token: string,
  repo: string,
  name: string,
  value: string
): Promise<void> {
  // Get the repo's public key for encrypting secrets
  const keyResp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/secrets/public-key`,
    { token }
  );
  if (!keyResp.ok) throw new Error("Failed to get repo public key");
  const keyData = (await keyResp.json()) as any;

  const encryptedValue = encryptSecret(keyData.key, value);

  const resp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/secrets/${name}`,
    {
      token,
      method: "PUT",
      json: {
        encrypted_value: encryptedValue,
        key_id: keyData.key_id,
      },
    }
  );
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`Failed to create secret ${name}: ${resp.status}`);
  }
}

export async function createRepoVariable(
  token: string,
  repo: string,
  name: string,
  value: string
): Promise<void> {
  // Try update first, then create
  const updateResp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/variables/${name}`,
    { token, method: "PATCH", json: { name, value } }
  );
  if (updateResp.ok || updateResp.status === 204) return;

  const createResp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/variables`,
    { token, method: "POST", json: { name, value } }
  );
  if (!createResp.ok && createResp.status !== 201) {
    console.warn(`Failed to create variable ${name}: ${createResp.status}`);
  }
}

export async function triggerWorkflow(
  token: string,
  repo: string,
  workflow: string,
  inputs: Record<string, string>,
  ref = "main"
): Promise<void> {
  const resp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/workflows/${workflow}/dispatches`,
    { token, method: "POST", json: { ref, inputs } }
  );
  if (!resp.ok && resp.status !== 204) {
    const err = await resp.text();
    throw new Error(`Failed to trigger workflow: ${err}`);
  }
}

export async function getLatestWorkflowRun(
  token: string,
  repo: string,
  workflow: string
): Promise<{ id: number; status: string; conclusion: string | null; html_url: string } | null> {
  const resp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
    { token }
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as any;
  if (data.total_count === 0) return null;
  const run = data.workflow_runs[0];
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
  };
}

export async function getWorkflowJobs(
  token: string,
  repo: string,
  runId: number
): Promise<{ name: string; status: string; conclusion: string | null; steps: { name: string; status: string; conclusion: string | null; number: number }[] }[]> {
  const resp = await ghFetch(
    `/repos/${ORG}/${repo}/actions/runs/${runId}/jobs`,
    { token }
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as any;
  return data.jobs.map((j: any) => ({
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    steps: (j.steps || []).map((s: any) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
    })),
  }));
}

export async function deleteRepo(
  token: string,
  repo: string
): Promise<void> {
  await ghFetch(`/repos/${ORG}/${repo}`, { token, method: "DELETE" });
}

export { ORG, GH_API, retryFetch };
