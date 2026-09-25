# github-agent-router-mcp

A small Model Context Protocol (MCP) facade for `johnyoonh/github-agent-router`.

The service intentionally **does not call Jules directly**. ChatGPT signals work through GitHub, and the existing router GitHub Action remains authoritative for Jules account selection, sticky sessions, serialization, signed state, recovery, certification, and handoff.

## Architecture

```text
ChatGPT.com
    |
    | MCP (Streamable HTTP)
    v
github-agent-router-mcp
    |
    | GitHub issue / label / comment
    v
target repository GitHub Actions
    |
    v
github-agent-router
    |
    +--> Jules account A
    +--> Jules account B
    |
    +--> chatgpt:handoff --> git-fleet / chatgpt-opencli when local evidence is needed
```

The MCP layer refuses to dispatch into a target repository unless the default branch contains the router-managed, full-SHA-pinned `.github/workflows/jules-router.yml`. The router repository itself is accepted when it uses its local reusable workflow.

## MCP tools

| Tool | Mutation | Purpose |
| --- | --- | --- |
| `router_delegate` | yes | Create a focused GitHub issue, then add `jules:run` so the GitHub Actions router owns dispatch. |
| `router_route_existing` | yes, idempotent | Add `jules:run` to an existing issue or PR. |
| `router_continue` | yes | Post a `/jules ...` follow-up to an already routed issue/PR. |
| `router_status` | no | Read harness readiness, labels, and a sanitized view of the latest router state. |

There is deliberately no raw `approvePlan`, `createSession`, or `sendMessage` tool. Those would bypass the router state machine.

## Configuration

Required:

```bash
export GITHUB_TOKEN=...
export ALLOWED_REPOS=owner/repo,owner/another-repo
```

Optional:

```bash
export HOST=127.0.0.1
export PORT=8787
export MCP_ALLOWED_ORIGINS=https://example.internal
export ROUTER_REPOSITORY=johnyoonh/github-agent-router
export ROUTER_WORKFLOW_PATH=.github/workflows/jules-router.yml
```

`ALLOWED_REPOS` is mandatory and does not support wildcards.

The server binds to loopback by default. A non-loopback bind is rejected unless `MCP_TRUSTED_PROXY=true` is explicitly set. That override is intended only when an authenticated reverse proxy or equivalent trusted boundary is in front of the process.

## Run locally

```bash
npm install
npm test
npm start
```

Endpoints:

- `GET /healthz` — basic process health only; does not test GitHub credentials.
- `POST|GET|DELETE /mcp` — MCP Streamable HTTP endpoint.

## Connect from ChatGPT.com

For ChatGPT Business developer mode, keep this service private and connect the local `/mcp` endpoint through **Secure MCP Tunnel**. This avoids putting a GitHub write token on a public unauthenticated service.

If this server is later deployed as a public HTTPS MCP endpoint, add OAuth 2.1 resource-server authentication before doing so. Do not use `MCP_TRUSTED_PROXY=true` by itself as an authentication mechanism.

## Provision a target repository first

The target repository must already have the router harness merged on its default branch. Provision it from `github-agent-router` using the reviewed full router commit SHA. The MCP service will fail closed if it sees a missing, unmanaged, floating, or inconsistent workflow reference.

## Why not embed jules-dispatch?

`@yuuqq/jules-dispatch` is a useful reference for MCP ergonomics and current Jules interaction states, but installing it as the execution layer here would create a second Jules control plane. This service keeps only the MCP/GitHub adapter and leaves all Jules API access in `github-agent-router`.
