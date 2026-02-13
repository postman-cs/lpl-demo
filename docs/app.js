/* --------------------------------------------------------
   BRAVE Portal - Client-side logic
   --------------------------------------------------------
   Calls the real orchestrator backend via SSE for live
   provisioning. Falls back to simulation if backend
   is unavailable.
   -------------------------------------------------------- */

// Same-origin when served by the Cloudflare Worker (routes /api/* to container)
const API_BASE = "";

// -- Auth / Identity -------------------------------------------------------

let _currentUser = null;

async function fetchIdentity() {
  try {
    const resp = await fetch("/cdn-cgi/access/get-identity");
    if (!resp.ok) return null;
    const identity = await resp.json();
    return {
      name: identity.name || identity.user_name || identity.email || "User",
      email: identity.email || "",
      avatar: identity.idp?.claims?.avatar_url || "",
      login: identity.idp?.claims?.login || identity.user_name || "",
    };
  } catch {
    return null;
  }
}

function githubLogin() {
  // Cloudflare Access already authenticated the user (Layer 1).
  // Fetch their identity and transition to the app.
  fetchIdentity().then((user) => {
    if (user) {
      enterApp(user);
    } else {
      // Fallback: if identity endpoint unavailable, let them enter manually
      enterApp({ name: "Developer", email: "", avatar: "", login: "" });
    }
  });
}

function enterApp(user) {
  _currentUser = user;

  // Populate email field
  if (user.email) {
    document.getElementById("email").value = user.email;
  }

  // Load Postman teams for dropdown
  loadTeams();

  // Show user info in nav
  const navUser = document.getElementById("nav-user");
  if (user.avatar) {
    document.getElementById("nav-avatar").src = user.avatar;
    document.getElementById("nav-avatar").style.display = "";
  } else {
    document.getElementById("nav-avatar").style.display = "none";
  }
  document.getElementById("nav-username").textContent = user.name || user.login;
  navUser.style.display = "flex";

  // Transition screens
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-shell").style.display = "";

  // Persist login state for session
  sessionStorage.setItem("brave_user", JSON.stringify(user));
}

function logoutUser() {
  // Layer 2 logout: return to the login screen without revoking Cloudflare Access
  sessionStorage.removeItem("brave_user");
  _currentUser = null;
  document.getElementById("email").value = "";
  document.getElementById("app-shell").style.display = "none";
  document.getElementById("login-screen").style.display = "";
}

// On page load, check for existing session
document.addEventListener("DOMContentLoaded", () => {
  const saved = sessionStorage.getItem("brave_user");
  if (saved) {
    try {
      enterApp(JSON.parse(saved));
    } catch {
      // corrupt data, show login
    }
  }
});

// -- View management -------------------------------------------------------

const ALL_VIEWS = ["view-templates", "view-form", "view-status", "view-docs"];

function hideAllViews() {
  ALL_VIEWS.forEach((id) => document.getElementById(id).classList.add("hidden"));
}

function setActiveNav(id) {
  document.querySelectorAll(".sidebar-link").forEach((el) => el.classList.remove("active"));
  if (id) document.getElementById(id)?.classList.add("active");
}

function showTemplates() {
  hideAllViews();
  document.getElementById("view-templates").classList.remove("hidden");
  setActiveNav("nav-templates");
  setBreadcrumb("New Landing Zone (LZ)");
}

function showForm() {
  hideAllViews();
  document.getElementById("view-form").classList.remove("hidden");
  setActiveNav("nav-templates");
  setBreadcrumb("Python 3.11 Flask Experience API");
}

function showStatus(projectName) {
  hideAllViews();
  document.getElementById("view-status").classList.remove("hidden");
  document.getElementById("status-project-name").textContent =
    "Project: " + projectName;
  ["github", "postman", "spec", "aws", "postman-env", "sync", "notify"].forEach((id) => {
    setStepState(id, "");
    setStepDetail(id, "");
    delete stepLogs[id];
  });
  document.getElementById("result-summary").classList.add("hidden");
  document.getElementById("mock-panels").classList.add("hidden");
  setActiveNav("nav-templates");
  setBreadcrumb("Provisioning: " + projectName);
}

function showDocs() {
  hideAllViews();
  document.getElementById("view-docs").classList.remove("hidden");
  setActiveNav("nav-docs");
  setBreadcrumb("Postman Integration");
}

function setBreadcrumb(current) {
  document.getElementById("breadcrumb-current").textContent = current;
}

// -- Toast for unavailable sidebar links ------------------------------------

let _toastTimer = null;
function showToast(label) {
  const toast = document.getElementById("toast");
  toast.textContent = `${label} -- available in production environment`;
  toast.classList.add("visible");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
}

// -- Workspace naming helpers -----------------------------------------------

const DOMAIN_CODES = {
  wealth: "WEAL",
  payments: "PAYM",
  identity: "IDEN",
  platform: "PLAT",
};

function deriveWorkspaceName() {
  const projectName = document.getElementById("projectName").value;
  const domainSelect = document.getElementById("domain");
  const code = domainSelect.selectedOptions[0]?.dataset?.code || "WEAL";
  return code ? `[${code}] ${projectName}` : projectName;
}

function updateWorkspaceName() {
  document.getElementById("workspaceName").value = deriveWorkspaceName();
}

function updateOctopusGroup() {
  const domain = document.getElementById("domain").value;
  const mapping = {
    wealth: "WealthMgmt-APIs",
    payments: "Payments-APIs",
    identity: "Identity-APIs",
    platform: "Platform-APIs",
  };
  document.getElementById("octopusGroup").value = mapping[domain] || "";
}

// -- Postman team loader ----------------------------------------------------

const FALLBACK_TEAMS = [{ id: 132319, name: "CSE v12" }];

async function loadTeams() {
  const select = document.getElementById("postmanTeam");
  try {
    const resp = await fetch(`${API_BASE}/api/teams`, { mode: "cors" });
    if (!resp.ok) throw new Error("Backend returned " + resp.status);
    const data = await resp.json();
    const teams = data.teams && data.teams.length > 0 ? data.teams : FALLBACK_TEAMS;
    populateTeamDropdown(select, teams);
  } catch {
    populateTeamDropdown(select, FALLBACK_TEAMS);
  }
}

function populateTeamDropdown(select, teams) {
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a team...";
  placeholder.disabled = true;
  placeholder.selected = true;
  select.appendChild(placeholder);
  teams.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name + (t.memberCount ? ` (${t.memberCount} members)` : "");
    select.appendChild(opt);
  });
}

// -- Form submission -------------------------------------------------------

function submitForm(event) {
  event.preventDefault();

  const projectName = document.getElementById("projectName").value;
  const domain = document.getElementById("domain").value;
  const workspaceName = deriveWorkspaceName();

  const specSelect = document.getElementById("specSelect");
  const specSource = specSelect.value;
  const specUrl = specSelect.selectedOptions[0]?.dataset?.url || "";

  const envCheckboxes = document.querySelectorAll('input[name="env"]:checked');
  const environments = Array.from(envCheckboxes).map((cb) => cb.value);

  const request = {
    project_name: projectName,
    domain: domain,
    workspace_name: workspaceName,
    application_id: document.getElementById("applicationId").value,
    requester_email: document.getElementById("email").value,
    product_code: document.getElementById("productCode").value,
    environments: environments,
    spec_source: specSource,
    spec_url: specUrl,
    spec_hub_url: specSource === "custom-url" ? document.getElementById("specHubUrl").value : "",
    aws_account_id: document.getElementById("awsAccount").value,
    api_gateway: document.querySelector('input[name="apiGateway"]:checked').value,
    create_jira: document.querySelector('input[name="createJira"]:checked').value === "yes",
    postman_team_id: document.getElementById("postmanTeam").value,
    template: "python-3.11-flask-experience-api",
  };

  showStatus(request.project_name);
  realProvisioning(request);
}

// -- Real provisioning via backend SSE ------------------------------------

async function realProvisioning(request) {
  try {
    const healthResp = await fetch(`${API_BASE}/api/health`, { mode: "cors" });
    if (!healthResp.ok) throw new Error("Backend unhealthy");
  } catch (e) {
    console.warn("Backend unavailable, falling back to simulation:", e);
    simulateProvisioning(request);
    return;
  }

  ["postman", "spec", "aws", "sync", "notify"].forEach((id) => {
    setStepDetail(id, "Waiting...");
  });
  lastRunningStep = "github";

  try {
    const resp = await fetch(`${API_BASE}/api/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      mode: "cors",
    });

    if (!resp.ok) {
      const err = await resp.json();
      setStepState("postman", "error");
      setStepDetail("postman", `Error: ${err.error || "Unknown error"}`);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.substring(6));
        handleSSEEvent(event, request);
        if (event.phase === "complete" && event.status === "complete") finalData = event.data;
      }
    }

    if (finalData) {
      showRealResultSummary(request, finalData);
      showTeardownFab(finalData.project);
      // Retroactively update spec step with warning/error counts
      if (finalData.lint) {
        const warnings = finalData.lint.warnings || 0;
        const errors = finalData.lint.errors || 0;
        const badge = errors === 0
          ? '<span style="color:#16a34a;font-weight:600">PASSED</span>'
          : '<span style="color:#dc2626;font-weight:600">FAILED</span>';
        setStepDetail("spec", `<div class="step-summary">Spec governance: ${badge} — ${errors} errors, ${warnings} warnings</div>`);
      }
    }
  } catch (e) {
    console.error("SSE provisioning failed:", e);
    setStepState("postman", "error");
    setStepDetail("postman", `Connection error: ${e.message}`);
  }
}

let lastRunningStep = "spec";
const stepLogs = {};

function appendStepLog(stepId, icon, text) {
  if (!stepLogs[stepId]) stepLogs[stepId] = [];
  // If same text exists, upgrade its icon (running → success/error)
  const existing = stepLogs[stepId].find(l => l.text === text);
  if (existing) {
    if (existing.icon !== icon) {
      existing.icon = icon;
      renderStepLog(stepId);
    }
    return;
  }
  stepLogs[stepId].push({ icon, text });
  // Cap at 8 visible lines per phase
  if (stepLogs[stepId].length > 8) stepLogs[stepId].shift();
  renderStepLog(stepId);
}

function renderStepLog(stepId) {
  const el = document.getElementById("detail-" + stepId);
  if (!el) return;
  const lines = stepLogs[stepId] || [];
  el.innerHTML = '<div class="step-log">' +
    lines.map(l =>
      `<div class="log-line"><span class="log-icon ${l.icon}">${
        l.icon === "success" ? "✓" : l.icon === "running" ? "⟳" : l.icon === "error" ? "✗" : "·"
      }</span><span>${l.text}</span></div>`
    ).join("") + '</div>';
  el.scrollTop = el.scrollHeight;
}

function handleSSEEvent(event, request) {
  const phaseMap = {
    spec: "spec",
    postman: "postman",
    "postman-env": "postman-env",
    github: "github",
    aws: "aws",
    sync: "sync",
    complete: "notify",
  };

  const stepId = phaseMap[event.phase] || lastRunningStep || "postman";

  if (event.status === "running") {
    lastRunningStep = stepId;
    setStepState(stepId, "running");
    appendStepLog(stepId, "running", event.message);
  } else if (event.status === "success") {
    // Individual sub-step completed successfully (phase still in progress)
    appendStepLog(stepId, "success", event.message);
  } else if (event.status === "complete") {
    setStepState(stepId, "complete");

    switch (event.phase) {
      case "spec":
        if (event.data && event.data.passed !== undefined) {
          const badge = event.data.passed ? '<span style="color:#16a34a;font-weight:600">PASSED</span>' : '<span style="color:#dc2626;font-weight:600">FAILED</span>';
          const warnings = event.data.warnings || 0;
          const errors = event.data.errors || 0;
          setStepDetail(stepId, `<div class="step-summary">Spec governance: ${badge} — ${errors} errors, ${warnings} warnings</div>`);
        } else {
          appendStepLog(stepId, "success", event.message);
        }
        break;
      case "postman":
        if (event.data) {
          setStepDetail(
            stepId,
            `<div class="step-summary">` +
            `Workspace: <a href="${event.data.workspace_url}" target="_blank">${request.workspace_name}</a>` +
            `</div>`
          );
        } else {
          appendStepLog(stepId, "success", event.message);
        }
        break;
      case "postman-env":
        if (event.data) {
          setStepDetail(
            stepId,
            `<div class="step-summary">` +
            `Environments: dev, prod` +
            (event.data.mock_url ? `<br>Mock: <a href="${event.data.mock_url}" target="_blank">${event.data.mock_url}</a>` : "") +
            `</div>`
          );
        } else {
          appendStepLog(stepId, "success", event.message);
        }
        break;
      case "github":
        if (event.data) {
          setStepDetail(
            stepId,
            `<div class="step-summary">` +
            `Repository: <a href="${event.data.repo_url}" target="_blank">${event.data.repo_url}</a><br>` +
            `Synced: collections, environments, specs, mocks, globals` +
            `</div>`
          );
        } else {
          appendStepLog(stepId, "success", event.message);
        }
        break;
      case "aws":
        if (event.data) {
          setStepDetail(
            stepId,
            `<div class="step-summary">` +
            `Function: ${event.data.function_name}<br>` +
            `Invoke URL: <a href="${event.data.invoke_url}/health" target="_blank">${event.data.invoke_url}</a>` +
            `</div>`
          );
        } else {
          appendStepLog(stepId, "success", event.message);
        }
        break;
      case "sync":
        appendStepLog(stepId, "success", "Artifacts exported and CI/CD configured");
        break;
      case "complete":
        appendStepLog(stepId, "success", `Provisioning complete for ${request.requester_email}`);
        break;
    }
  } else if (event.status === "error") {
    setStepState(stepId, "error");
    appendStepLog(stepId, "error", event.message);
  }
}

function showRealResultSummary(request, data) {
  const summary = document.getElementById("result-summary");
  summary.classList.remove("hidden");

  summary.innerHTML = `
    <h2>Provisioning Complete</h2>
    <div class="result-row">
      <span class="result-label">Project</span>
      <span class="result-value">${data.project}</span>
    </div>
    <div class="result-row">
      <span class="result-label">Requester</span>
      <span class="result-value">${request.requester_email}</span>
    </div>
    <div class="result-row">
      <span class="result-label">GitHub Repo</span>
      <span class="result-value"><a href="${data.github.repo_url}" target="_blank">${data.github.repo_url}</a></span>
    </div>
    <div class="result-row">
      <span class="result-label">Postman Workspace</span>
      <span class="result-value"><a href="${data.postman.workspace_url}" target="_blank">Open Workspace</a></span>
    </div>
    <div class="result-row">
      <span class="result-label">Smoke Tests</span>
      <span class="result-value">${data.postman.smoke_uid}</span>
    </div>
    <div class="result-row">
      <span class="result-label">Contract Tests</span>
      <span class="result-value">${data.postman.contract_uid}</span>
    </div>
    <div class="result-row">
      <span class="result-label">API Gateway URL</span>
      <span class="result-value"><a href="${data.aws.invoke_url}/health" target="_blank">${data.aws.invoke_url}</a></span>
    </div>
    <div class="result-row">
      <span class="result-label">Mock Server</span>
      <span class="result-value">${data.postman.mock_url ? `<a href="${data.postman.mock_url}" target="_blank">${data.postman.mock_url}</a>` : "N/A"}</span>
    </div>
    <div class="result-row">
      <span class="result-label">CI/CD</span>
      <span class="result-value"><a href="${data.github.repo_url}/actions" target="_blank">GitHub Actions</a></span>
    </div>
    <div class="result-row">
      <span class="result-label"></span>
      <span class="result-value"><button class="btn btn-secondary" onclick="teardownProject('${data.project}')">Teardown Resources</button></span>
    </div>
  `;

  // Render mock panels
  renderMockPanels(request, data);
}

function renderMockPanels(request, data) {
  const panels = document.getElementById("mock-panels");
  panels.classList.remove("hidden");

  // Mock email notification
  document.getElementById("mock-email").innerHTML = `
    <h3>Email Notification <span class="panel-badge passed">Sent</span></h3>
    <div class="email-preview">
      <div class="email-header">
        <strong>From:</strong> brave-platform@lplfinancial.com<br>
        <strong>To:</strong> ${request.requester_email}<br>
        <strong>Subject:</strong> [BRAVE] Provisioning Complete: ${request.project_name}
      </div>
      <div class="email-body">
        Your API has been provisioned successfully.<br><br>
        <strong>GitHub Repository:</strong> <a href="${data.github.repo_url}">${data.github.repo_url}</a><br>
        <strong>Postman Workspace:</strong> <a href="${data.postman.workspace_url}">Open in Postman</a><br>
        <strong>API Gateway URL:</strong> <a href="${data.aws.invoke_url}/health">${data.aws.invoke_url}</a><br>
        <strong>Mock Server:</strong> ${data.postman.mock_url || "N/A"}<br>
        <strong>Smoke Tests:</strong> ${data.postman.smoke_uid}<br>
        <strong>Contract Tests:</strong> ${data.postman.contract_uid}<br><br>
        CI/CD pipeline is configured. Postman CLI runs smoke and contract tests on every push to main.<br><br>
        -- BRAVE Platform Team
      </div>
    </div>
  `;

  // Mock SonarQube
  document.getElementById("mock-sonarqube").innerHTML = `
    <h3>SonarQube Analysis <span class="panel-badge passed">Passed</span></h3>
    <div class="panel-row"><span class="panel-label">Quality Gate</span><span class="panel-value" style="color:#16a34a">Passed</span></div>
    <div class="panel-row"><span class="panel-label">Coverage</span><span class="panel-value">87.2%</span></div>
    <div class="panel-row"><span class="panel-label">Bugs</span><span class="panel-value">0</span></div>
    <div class="panel-row"><span class="panel-label">Code Smells</span><span class="panel-value">2</span></div>
    <div class="panel-row"><span class="panel-label">Security Hotspots</span><span class="panel-value">0</span></div>
    <div class="panel-row"><span class="panel-label">Duplications</span><span class="panel-value">1.3%</span></div>
  `;

  // Mock Jira ticket
  const ticketId = "BRAVE-" + (4000 + Math.floor(Math.random() * 999));
  document.getElementById("mock-jira").innerHTML = `
    <h3>Jira Ticket <span class="panel-badge open">Open</span></h3>
    <div class="panel-row"><span class="panel-label">Ticket</span><span class="panel-value">${ticketId}</span></div>
    <div class="panel-row"><span class="panel-label">Title</span><span class="panel-value">${request.project_name} - Initial API Provisioning</span></div>
    <div class="panel-row"><span class="panel-label">Status</span><span class="panel-value">Open</span></div>
    <div class="panel-row"><span class="panel-label">Assignee</span><span class="panel-value">${request.requester_email}</span></div>
    <div class="panel-row"><span class="panel-label">Priority</span><span class="panel-value">Medium</span></div>
    <div class="panel-row"><span class="panel-label">Labels</span><span class="panel-value">brave-provisioned, experience-api</span></div>
  `;
}

// -- Teardown -------------------------------------------------------------

async function executeTeardown(projectName) {
  const fab = document.getElementById("teardown-fab");
  const label = fab.querySelector(".fab-label");

  // Show FAB in tearing-down state
  _activeProject = projectName;
  fab.classList.remove("hidden", "teardown-success");
  fab.classList.add("tearing-down");
  label.textContent = "Starting teardown...";

  try {
    const resp = await fetch(`${API_BASE}/api/teardown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_name: projectName }),
      mode: "cors",
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.error || "Teardown failed");
    }

    // Parse SSE stream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.substring(6));

        if (event.status === "running") {
          label.textContent = event.message;
        } else if (event.phase === "complete" && event.status === "complete") {
          completed = true;
        } else if (event.status === "error" && event.phase === "error") {
          throw new Error(event.message);
        }
      }
    }

    if (completed) {
      // Brief green success state before hiding
      fab.classList.remove("tearing-down");
      fab.classList.add("teardown-success");
      label.textContent = "Teardown complete";
      hideOrphanBanner();
      setTimeout(() => {
        hideTeardownFab();
        fab.classList.remove("teardown-success");
        // If on status page, go back to templates
        if (!document.getElementById("view-status").classList.contains("hidden")) {
          showTemplates();
        }
      }, 1500);
    }
  } catch (e) {
    // Reset FAB to clickable state
    fab.classList.remove("tearing-down", "teardown-success");
    label.textContent = `Teardown: ${projectName}`;
    showToast(`Teardown failed: ${e.message}`);
  }
}

async function teardownProject(projectName) {
  if (!confirm(`Tear down all resources for "${projectName}"?`)) return;
  await executeTeardown(projectName);
}

// -- Simulation fallback ---------------------------------------------------

async function simulateProvisioning(request) {
  const steps = [
    { id: "github", duration: 2500 },
    { id: "postman", duration: 3000 },
    { id: "spec", duration: 1500 },
    { id: "aws", duration: 4000 },
    { id: "postman-env", duration: 2000 },
    { id: "sync", duration: 1500 },
    { id: "notify", duration: 1000 },
  ];

  for (const step of steps) {
    setStepState(step.id, "running");
    setStepDetail(step.id, "In progress (simulated -- backend unavailable)...");
    await sleep(step.duration);
    setStepState(step.id, "complete");
    setStepDetail(step.id, "Complete (simulated)");
  }

  const summary = document.getElementById("result-summary");
  summary.classList.remove("hidden");
  summary.innerHTML = `
    <h2>Simulation Complete</h2>
    <p>The Worker could not connect to GitHub API. This was a simulated run.</p>
    <p>Ensure Worker secrets are configured via <code>wrangler secret put</code>.</p>
  `;
}

// -- Spec Source / Form Utilities ------------------------------------------

function handleSpecSelect() {
  const value = document.getElementById("specSelect").value;
  const preview = document.getElementById("spec-preview");
  document.getElementById("spec-upload-group").classList.toggle("hidden", value !== "custom-upload");
  document.getElementById("spec-url-group").classList.toggle("hidden", value !== "custom-url");
  preview.classList.toggle("hidden", value !== "advisor-portfolio-api");
}

function handleSpecFile(input) {
  if (input.files && input.files[0]) {
    document.querySelector(".drop-text").textContent = input.files[0].name;
  }
}

function autoPopulateFromAccount() {
  const accountId = document.getElementById("awsAccount").value;
  if (!accountId) return;
  const mapping = {
    "780401591112": { code: "WEALTH-001", service: "Advisor Portfolio Service" },
    "123456789012": { code: "PAY-001", service: "Payment Processing Service" },
    "111222333444": { code: "ID-001", service: "Identity Verification Service" },
  };
  const data = mapping[accountId];
  if (data) {
    flashField("productCode", data.code);
    flashField("businessServiceName", data.service);
  }
}

function flashField(id, value) {
  const field = document.getElementById(id);
  if (!field) return;
  field.value = value;
  field.classList.add("auto-populated");
  setTimeout(() => field.classList.remove("auto-populated"), 600);
}

// -- Helpers ---------------------------------------------------------------

function setStepState(stepId, state) {
  const el = document.getElementById("step-" + stepId);
  if (el) el.className = "status-step " + state;
}

function setStepDetail(stepId, html) {
  const el = document.getElementById("detail-" + stepId);
  if (el) el.innerHTML = html;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -- Floating teardown button (FAB) ----------------------------------------

let _activeProject = null;

// Check for active/orphan resources on page load
(async function checkActiveResources() {
  try {
    const projectName = document.getElementById("projectName")?.value || "advisor-portfolio-api";
    const resp = await fetch(`${API_BASE}/api/status?project=${encodeURIComponent(projectName)}`, { mode: "cors" });
    if (resp.ok) {
      const data = await resp.json();
      if (data.active_project) {
        _activeProject = data.active_project;
        showTeardownFab(_activeProject);
        showOrphanBanner(data.active_project, data.resources, data.source);
      }
    }
  } catch (e) {
    // Backend not available -- no banner, no FAB
  }
})();

function showOrphanBanner(project, resources, source) {
  const banner = document.getElementById("orphan-banner");
  if (!banner) return;
  const detail = document.getElementById("orphan-banner-detail");
  const parts = [];
  if (resources?.github) parts.push("GitHub repo");
  if (resources?.lambda) parts.push("Lambda");
  if (resources?.api_gateway) parts.push("API Gateway");
  if (resources?.postman) parts.push("Postman workspace");
  if (source === "memory") {
    detail.textContent = `Active provisioning session: ${parts.join(", ") || project}`;
  } else {
    detail.textContent = `Orphan resources detected: ${parts.join(", ")}. Clean up before re-provisioning.`;
  }
  banner.classList.remove("hidden");
}

function hideOrphanBanner() {
  const banner = document.getElementById("orphan-banner");
  if (banner) banner.classList.add("hidden");
}

async function cleanupOrphans() {
  const project = _activeProject;
  if (!project) return;
  const btn = document.querySelector("#orphan-banner .btn");
  if (btn) { btn.textContent = "Cleaning up..."; btn.disabled = true; }
  await executeTeardown(project);
  if (btn) { btn.textContent = "Clean Up"; btn.disabled = false; }
}

function showTeardownFab(projectName) {
  _activeProject = projectName;
  const fab = document.getElementById("teardown-fab");
  const label = fab.querySelector(".fab-label");
  label.textContent = `Teardown: ${projectName}`;
  fab.classList.remove("hidden");
}

function hideTeardownFab() {
  _activeProject = null;
  document.getElementById("teardown-fab").classList.add("hidden");
}

async function teardownFromFab() {
  const project = _activeProject;
  if (!project) return;
  if (!confirm(`Tear down all resources for "${project}"?\n\nThis will delete the Postman workspace, GitHub repo, and AWS Lambda.`)) return;
  await executeTeardown(project);
}
