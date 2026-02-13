// Fetch boilerplate files from the lpl-demo repo for pushing to new repos

const RAW_BASE = "https://raw.githubusercontent.com/postman-cs/lpl-demo/main/server/boilerplate";

const BOILERPLATE_PATHS = [
  "app/__init__.py",
  "app/models.py",
  "app/routes.py",
  "app/wsgi.py",
  "tests/__init__.py",
  "tests/test_health.py",
  "requirements.txt",
  "requirements-dev.txt",
  "Dockerfile",
  "openapi.yaml",
];

export async function fetchBoilerplate(
  token: string
): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];

  for (const path of BOILERPLATE_PATHS) {
    const resp = await fetch(`${RAW_BASE}/${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "lpl-brave-worker",
      },
    });
    if (!resp.ok) {
      console.warn(`Failed to fetch boilerplate/${path}: ${resp.status}`);
      continue;
    }
    files.push({ path, content: await resp.text() });
  }

  return files;
}

export function generateGitignore(): string {
  return `# Python
__pycache__/
*.py[cod]
*.egg-info/
dist/
build/
.eggs/
*.egg
venv/
.venv/
env/

# IDE
.vscode/
.idea/
*.swp
*.swo

# Environment
.env
.env.local

# Testing
.coverage
htmlcov/
.pytest_cache/
*.xml

# Deployment
package/
deployment.zip
*.zip

# OS
.DS_Store
Thumbs.db
`;
}

export function generateEnvExample(projectName: string): string {
  return `# ${projectName} - Environment Variables
# Copy to .env and fill in values

# Postman
POSTMAN_API_KEY=
POSTMAN_SMOKE_COLLECTION_UID=
POSTMAN_CONTRACT_COLLECTION_UID=
POSTMAN_ENVIRONMENT_UID=

# AWS
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1
FUNCTION_NAME=
API_GATEWAY_URL=

# App
FLASK_ENV=development
`;
}
