export interface AppConfig {
  githubToken: string;
  allowedRepos: Set<string>;
  host: string;
  port: number;
  allowedOrigins: Set<string>;
  trustedProxy: boolean;
  routerRepository: string;
  routerWorkflowPath: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function normalizeRepository(value: string): string {
  const repo = value.trim();
  if (!REPO_RE.test(repo)) {
    throw new Error(`invalid repository name: ${value}`);
  }
  return repo.toLowerCase();
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const githubToken = (env.GITHUB_TOKEN ?? "").trim();
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const allowed = splitCsv(env.ALLOWED_REPOS);
  if (allowed.length === 0) {
    throw new Error("ALLOWED_REPOS must contain at least one explicit owner/repo");
  }
  if (allowed.includes("*")) {
    throw new Error("ALLOWED_REPOS does not support wildcard access");
  }

  const allowedRepos = new Set(allowed.map(normalizeRepository));
  const host = (env.HOST ?? "127.0.0.1").trim();
  const trustedProxy = env.MCP_TRUSTED_PROXY === "true";
  if (!isLoopbackHost(host) && !trustedProxy) {
    throw new Error(
      "refusing non-loopback bind without MCP_TRUSTED_PROXY=true; use Secure MCP Tunnel or an authenticated reverse proxy",
    );
  }

  const port = Number.parseInt(env.PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const routerRepository = normalizeRepository(
    env.ROUTER_REPOSITORY ?? "johnyoonh/github-agent-router",
  );
  const routerWorkflowPath = (
    env.ROUTER_WORKFLOW_PATH ?? ".github/workflows/jules-router.yml"
  ).trim();
  if (!routerWorkflowPath || routerWorkflowPath.startsWith("/")) {
    throw new Error("ROUTER_WORKFLOW_PATH must be a repository-relative path");
  }

  return {
    githubToken,
    allowedRepos,
    host,
    port,
    allowedOrigins: new Set(splitCsv(env.MCP_ALLOWED_ORIGINS)),
    trustedProxy,
    routerRepository,
    routerWorkflowPath,
  };
}
