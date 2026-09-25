import {
  type GitHubComment,
  type GitHubIssue,
  type HarnessInfo,
} from "./github.js";

const ROUTER_MARKER_RE = /<!-- github-agent-router:(\{.*?\}) -->/s;
const ACTIVE_STATES = new Set([
  "QUEUED",
  "PLANNING",
  "AWAITING_PLAN_APPROVAL",
  "IN_PROGRESS",
  "PAUSED",
  "AWAITING_USER_FEEDBACK",
]);

export interface RouterBackend {
  inspectHarness(repository: string): Promise<HarnessInfo>;
  getIssue(repository: string, number: number): Promise<GitHubIssue>;
  createIssue(repository: string, title: string, body: string): Promise<GitHubIssue>;
  addLabels(repository: string, number: number, labels: string[]): Promise<void>;
  addComment(repository: string, number: number, body: string): Promise<GitHubComment>;
  listComments(repository: string, number: number): Promise<GitHubComment[]>;
}

function labelNames(issue: GitHubIssue): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter(Boolean);
}

function sanitizeRouterState(comments: GitHubComment[]): Record<string, unknown> | null {
  for (const comment of [...comments].reverse()) {
    const user = comment.user ?? {};
    if (user.login !== "github-actions[bot]" || user.type !== "Bot") {
      continue;
    }
    const match = ROUTER_MARKER_RE.exec(comment.body ?? "");
    if (!match?.[1]) {
      continue;
    }
    try {
      const raw = JSON.parse(match[1]) as Record<string, unknown>;
      return {
        owner: raw.owner,
        session: raw.session,
        url: raw.url,
        round: raw.round,
        state: raw.state,
        repository: raw.repository,
        number: raw.number,
        branch: raw.branch,
        pending: raw.pending,
        needsUser: raw.needs_user,
        verification: raw.verification,
        handoffIssue: raw.handoff_issue,
        feedbackNudges: raw.feedback_nudges,
        commentId: comment.id,
      };
    } catch {
      return null;
    }
  }
  return null;
}

function classify(labels: string[], state: Record<string, unknown> | null): string {
  if (labels.includes("jules:certified")) {
    return "certified";
  }
  if (labels.includes("jules:needs-user")) {
    return "needs_user";
  }
  if (labels.includes("jules:changes-required")) {
    return "changes_required";
  }
  if (labels.includes("agent:blocked")) {
    return "blocked";
  }
  if (state && typeof state.state === "string" && ACTIVE_STATES.has(state.state)) {
    return "active";
  }
  if (state) {
    return "routed";
  }
  if (labels.includes("jules:run")) {
    return "signaled";
  }
  return "idle";
}

export class RouterFacade {
  constructor(private readonly backend: RouterBackend) {}

  private async requireHarness(repository: string): Promise<HarnessInfo> {
    const harness = await this.backend.inspectHarness(repository);
    if (!harness.ready) {
      throw new Error(
        `router harness is not ready for ${repository}: ${harness.reason ?? harness.mode}`,
      );
    }
    return harness;
  }

  async delegate(input: {
    repository: string;
    title: string;
    instructions: string;
  }): Promise<Record<string, unknown>> {
    const harness = await this.requireHarness(input.repository);
    const body = [
      input.instructions.trim(),
      "",
      "<!-- github-agent-router-mcp:delegate:v1 -->",
      "Delegated through github-agent-router-mcp. Jules routing is owned by github-agent-router.",
    ].join("\n");

    const issue = await this.backend.createIssue(input.repository, input.title.trim(), body);
    try {
      await this.backend.addLabels(input.repository, issue.number, ["jules:run"]);
    } catch (error) {
      return {
        status: "created_not_routed",
        repository: input.repository,
        issueNumber: issue.number,
        issueUrl: issue.html_url,
        harness,
        recovery:
          "The issue exists but the routing label write failed. Do not call router_delegate again; call router_route_existing for this issue after fixing GitHub access.",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      status: "signaled",
      repository: input.repository,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      harness,
      next: "Use router_status to observe sticky Jules ownership and verification state.",
    };
  }

  async routeExisting(input: {
    repository: string;
    number: number;
  }): Promise<Record<string, unknown>> {
    const harness = await this.requireHarness(input.repository);
    const issue = await this.backend.getIssue(input.repository, input.number);
    if (issue.state !== "open") {
      throw new Error(`cannot route closed item #${input.number}`);
    }

    const labels = labelNames(issue);
    if (
      labels.includes("jules:run") ||
      labels.includes("jules-owner:a") ||
      labels.includes("jules-owner:b")
    ) {
      return {
        status: "already_routed_or_signaled",
        repository: input.repository,
        number: input.number,
        url: issue.html_url,
        labels,
        harness,
        next: "Use router_status instead of toggling labels; do not force a duplicate dispatch.",
      };
    }

    await this.backend.addLabels(input.repository, input.number, ["jules:run"]);
    return {
      status: "signaled",
      repository: input.repository,
      number: input.number,
      url: issue.html_url,
      harness,
    };
  }

  async continue(input: {
    repository: string;
    number: number;
    instruction: string;
  }): Promise<Record<string, unknown>> {
    const harness = await this.requireHarness(input.repository);
    const issue = await this.backend.getIssue(input.repository, input.number);
    if (issue.state !== "open") {
      throw new Error(`cannot continue closed item #${input.number}`);
    }

    const labels = labelNames(issue);
    const comments = await this.backend.listComments(input.repository, input.number);
    const state = sanitizeRouterState(comments);
    const owned =
      labels.includes("jules-owner:a") ||
      labels.includes("jules-owner:b") ||
      state !== null;
    if (!owned) {
      throw new Error(
        "no routed session state exists yet; use router_route_existing and wait for router_status before continuing",
      );
    }

    const comment = await this.backend.addComment(
      input.repository,
      input.number,
      `/jules ${input.instruction.trim()}`,
    );
    return {
      status: "follow_up_signaled",
      repository: input.repository,
      number: input.number,
      issueUrl: issue.html_url,
      commentUrl: comment.html_url,
      harness,
      next: "The GitHub Actions router will decide whether to message the active sticky session or create a permitted sticky follow-up round.",
    };
  }

  async status(input: {
    repository: string;
    number: number;
  }): Promise<Record<string, unknown>> {
    const harness = await this.backend.inspectHarness(input.repository);
    const issue = await this.backend.getIssue(input.repository, input.number);
    const labels = labelNames(issue);
    const comments = await this.backend.listComments(input.repository, input.number);
    const state = sanitizeRouterState(comments);

    return {
      repository: input.repository,
      number: input.number,
      url: issue.html_url,
      title: issue.title,
      itemType: issue.pull_request ? "pull_request" : "issue",
      open: issue.state === "open",
      harness,
      labels,
      routingStatus: classify(labels, state),
      routerState: state,
    };
  }
}
