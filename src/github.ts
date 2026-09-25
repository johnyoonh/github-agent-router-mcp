import { normalizeRepository, type AppConfig } from "./config.js";

const API_ROOT = "https://api.github.com";
const MANAGED_MARKER = "# Managed by github-agent-router; schema=1";

export class GitHubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface HarnessInfo {
  ready: boolean;
  mode: "managed" | "router-self" | "missing" | "invalid";
  routerRef?: string;
  defaultBranch: string;
  reason?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  labels?: Array<string | { name?: string | null }>;
  pull_request?: unknown;
}

export interface GitHubComment {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: {
    login?: string;
    type?: string;
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
}

export class GitHubClient {
  constructor(private readonly config: AppConfig) {}

  assertAllowed(repository: string): string {
    const normalized = normalizeRepository(repository);
    if (!this.config.allowedRepos.has(normalized)) {
      throw new Error(`repository is not allowlisted: ${normalized}`);
    }
    return normalized;
  }

  private async request<T>(
    method: string,
    repository: string,
    path: string,
    payload?: unknown,
  ): Promise<T> {
    const repo = this.assertAllowed(repository);
    const response = await fetch(`${API_ROOT}/repos/${repo}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new GitHubError(
        response.status,
        `GitHub request failed with status ${response.status}`,
      );
    }
    if (response.status === 204) {
      return {} as T;
    }
    return (await response.json()) as T;
  }

  async getRepository(repository: string): Promise<{
    default_branch: string;
    archived?: boolean;
    private?: boolean;
  }> {
    return this.request("GET", repository, "");
  }

  async getFileText(
    repository: string,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    try {
      const data = await this.request<{
        type?: string;
        encoding?: string;
        content?: string;
      }>("GET", repository, `/contents/${encodedPath}${query}`);
      if (data.type && data.type !== "file") {
        throw new Error(`expected regular file at ${path}`);
      }
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        throw new Error(`unsupported GitHub content encoding at ${path}`);
      }
      return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async inspectHarness(repository: string): Promise<HarnessInfo> {
    const repo = this.assertAllowed(repository);
    const info = await this.getRepository(repo);
    const defaultBranch = info.default_branch || "main";
    if (info.archived) {
      return {
        ready: false,
        mode: "invalid",
        defaultBranch,
        reason: "repository is archived",
      };
    }

    const text = await this.getFileText(repo, this.config.routerWorkflowPath, defaultBranch);
    if (text === null) {
      return {
        ready: false,
        mode: "missing",
        defaultBranch,
        reason: `missing ${this.config.routerWorkflowPath} on ${defaultBranch}`,
      };
    }

    if (repo === this.config.routerRepository) {
      const localReusable = "uses: ./.github/workflows/reusable-router.yml";
      const selfRef = "router_ref: ${{ github.workflow_sha }}";
      if (text.includes(localReusable) && text.includes(selfRef)) {
        return {
          ready: true,
          mode: "router-self",
          routerRef: "github.workflow_sha",
          defaultBranch,
        };
      }
      return {
        ready: false,
        mode: "invalid",
        defaultBranch,
        reason: "router self-workflow is not bound to the local reusable workflow revision",
      };
    }

    if (!text.startsWith(`${MANAGED_MARKER}\n`)) {
      return {
        ready: false,
        mode: "invalid",
        defaultBranch,
        reason: "router workflow is not managed by github-agent-router",
      };
    }

    const router = escapeRegExp(this.config.routerRepository);
    const uses = new RegExp(
      `uses:\\s+${router.replace("/", "\\/")}\\/.github\\/workflows\\/reusable-router\\.yml@([0-9a-f]{40})`,
    ).exec(text);
    if (!uses?.[1]) {
      return {
        ready: false,
        mode: "invalid",
        defaultBranch,
        reason: "managed workflow does not pin the reusable router to a full commit SHA",
      };
    }

    const refMatches = new RegExp(`router_ref:\\s+${uses[1]}(?:\\s|$)`).test(text);
    if (!refMatches) {
      return {
        ready: false,
        mode: "invalid",
        defaultBranch,
        reason: "router_ref does not match the pinned reusable workflow SHA",
      };
    }

    return {
      ready: true,
      mode: "managed",
      routerRef: uses[1],
      defaultBranch,
    };
  }

  async getIssue(repository: string, number: number): Promise<GitHubIssue> {
    return this.request("GET", repository, `/issues/${number}`);
  }

  async createIssue(
    repository: string,
    title: string,
    body: string,
  ): Promise<GitHubIssue> {
    return this.request("POST", repository, "/issues", { title, body });
  }

  async addLabels(
    repository: string,
    number: number,
    labels: string[],
  ): Promise<void> {
    await this.request("POST", repository, `/issues/${number}/labels`, { labels });
  }

  async addComment(
    repository: string,
    number: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.request("POST", repository, `/issues/${number}/comments`, { body });
  }

  async listComments(repository: string, number: number): Promise<GitHubComment[]> {
    const comments: GitHubComment[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await this.request<GitHubComment[]>(
        "GET",
        repository,
        `/issues/${number}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch);
      if (batch.length < 100) {
        return comments;
      }
    }
    throw new Error("comment pagination exceeded the 500-comment safety bound");
  }
}
