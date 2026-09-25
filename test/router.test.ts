import assert from "node:assert/strict";
import test from "node:test";
import type {
  GitHubComment,
  GitHubIssue,
  HarnessInfo,
} from "../src/github.js";
import { RouterFacade, type RouterBackend } from "../src/router.js";

class FakeBackend implements RouterBackend {
  harness: HarnessInfo = {
    ready: true,
    mode: "managed",
    routerRef: "a".repeat(40),
    defaultBranch: "main",
  };
  issue: GitHubIssue = {
    number: 7,
    title: "Task",
    body: "Body",
    state: "open",
    html_url: "https://github.com/owner/repo/issues/7",
    labels: [],
  };
  comments: GitHubComment[] = [];
  labelsAdded: string[][] = [];
  commentsAdded: string[] = [];
  failLabels = false;

  async inspectHarness(): Promise<HarnessInfo> {
    return this.harness;
  }

  async getIssue(): Promise<GitHubIssue> {
    return this.issue;
  }

  async createIssue(_repository: string, title: string, body: string): Promise<GitHubIssue> {
    this.issue = { ...this.issue, title, body };
    return this.issue;
  }

  async addLabels(_repository: string, _number: number, labels: string[]): Promise<void> {
    if (this.failLabels) {
      throw new Error("synthetic label failure");
    }
    this.labelsAdded.push(labels);
    const existing = new Set(
      (this.issue.labels ?? []).map((label) =>
        typeof label === "string" ? label : label.name ?? "",
      ),
    );
    for (const label of labels) existing.add(label);
    this.issue.labels = [...existing].filter(Boolean);
  }

  async addComment(
    _repository: string,
    _number: number,
    body: string,
  ): Promise<GitHubComment> {
    this.commentsAdded.push(body);
    return {
      id: 99,
      body,
      html_url: "https://github.com/owner/repo/issues/7#issuecomment-99",
      user: { login: "maintainer", type: "User" },
    };
  }

  async listComments(): Promise<GitHubComment[]> {
    return this.comments;
  }
}

test("delegate creates an issue then signals the router", async () => {
  const backend = new FakeBackend();
  const facade = new RouterFacade(backend);

  const result = await facade.delegate({
    repository: "owner/repo",
    title: "Implement feature",
    instructions: "Add the feature with tests.",
  });

  assert.equal(result.status, "signaled");
  assert.deepEqual(backend.labelsAdded, [["jules:run"]]);
  assert.match(String(backend.issue.body), /github-agent-router-mcp:delegate:v1/);
});

test("delegate reports partial write recovery instead of hiding a duplicate risk", async () => {
  const backend = new FakeBackend();
  backend.failLabels = true;
  const facade = new RouterFacade(backend);

  const result = await facade.delegate({
    repository: "owner/repo",
    title: "Implement feature",
    instructions: "Add the feature with tests.",
  });

  assert.equal(result.status, "created_not_routed");
  assert.match(String(result.recovery), /router_route_existing/);
});

test("route existing is idempotent when already signaled", async () => {
  const backend = new FakeBackend();
  backend.issue.labels = ["jules:run"];
  const facade = new RouterFacade(backend);

  const result = await facade.routeExisting({
    repository: "owner/repo",
    number: 7,
  });

  assert.equal(result.status, "already_routed_or_signaled");
  assert.deepEqual(backend.labelsAdded, []);
});

test("continue refuses to invent a Jules session before router state exists", async () => {
  const backend = new FakeBackend();
  backend.issue.labels = ["jules:run"];
  const facade = new RouterFacade(backend);

  await assert.rejects(
    () =>
      facade.continue({
        repository: "owner/repo",
        number: 7,
        instruction: "Use the new evidence.",
      }),
    /no routed session state exists/,
  );
  assert.deepEqual(backend.commentsAdded, []);
});

test("continue posts the canonical slash-jules command after routing", async () => {
  const backend = new FakeBackend();
  backend.issue.labels = ["jules:run", "jules-owner:a"];
  const facade = new RouterFacade(backend);

  const result = await facade.continue({
    repository: "owner/repo",
    number: 7,
    instruction: "Use the new evidence.",
  });

  assert.equal(result.status, "follow_up_signaled");
  assert.deepEqual(backend.commentsAdded, ["/jules Use the new evidence."]);
});

test("status sanitizes signed router state", async () => {
  const backend = new FakeBackend();
  backend.issue.labels = ["jules:run", "jules-owner:a", "jules:certified"];
  backend.comments = [
    {
      id: 12,
      user: { login: "github-actions[bot]", type: "Bot" },
      body:
        '<!-- github-agent-router:{"owner":"a","session":"sessions/s1","state":"COMPLETED","round":1,"repository":"owner/repo","number":7,"verification":"certified","operation":"secret-op","events":["event"],"signature":"deadbeef"} -->',
    },
  ];
  const facade = new RouterFacade(backend);

  const result = await facade.status({
    repository: "owner/repo",
    number: 7,
  });

  assert.equal(result.routingStatus, "certified");
  const serialized = JSON.stringify(result.routerState);
  assert.doesNotMatch(serialized, /signature|secret-op|events/);
  assert.match(serialized, /sessions\/s1/);
});
