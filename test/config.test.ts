import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, normalizeRepository } from "../src/config.js";

test("normalizes repositories", () => {
  assert.equal(normalizeRepository("John/Repo"), "john/repo");
  assert.throws(() => normalizeRepository("not a repo"));
});

test("requires an explicit repository allowlist", () => {
  assert.throws(
    () => loadConfig({ GITHUB_TOKEN: "token" }),
    /ALLOWED_REPOS/,
  );
  assert.throws(
    () => loadConfig({ GITHUB_TOKEN: "token", ALLOWED_REPOS: "*" }),
    /wildcard/,
  );
});

test("rejects remote bind without a trusted boundary", () => {
  assert.throws(
    () =>
      loadConfig({
        GITHUB_TOKEN: "token",
        ALLOWED_REPOS: "owner/repo",
        HOST: "0.0.0.0",
      }),
    /MCP_TRUSTED_PROXY/,
  );
});

test("accepts loopback defaults", () => {
  const config = loadConfig({
    GITHUB_TOKEN: "token",
    ALLOWED_REPOS: "Owner/Repo,owner/second",
  });
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.deepEqual([...config.allowedRepos].sort(), ["owner/repo", "owner/second"]);
});
