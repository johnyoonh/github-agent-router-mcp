# Agent policy

## Architectural boundary

- This repository is an MCP facade for `johnyoonh/github-agent-router`. It is not an independent Jules orchestrator.
- Never call the Jules REST API from this repository and never store Jules API keys here.
- State-changing MCP tools must signal work through GitHub issues, pull requests, labels, or comments so `github-agent-router` and its GitHub Actions workflow remain the routing, serialization, recovery, and sticky-account authority.
- Before dispatching or continuing work, verify the target repository has the managed, SHA-pinned `.github/workflows/jules-router.yml` harness (or is the router repository using its self workflow). Fail closed when the harness is missing or unpinned.
- Keep repository access allowlisted with `ALLOWED_REPOS`; do not add wildcard repository access.
- Do not expose credentials, router state signatures, operation IDs, or raw private GitHub response bodies in MCP responses or logs.

## Integration discipline

- Preserve the public MCP tool names and input shapes unless a coordinated ChatGPT app refresh is planned.
- Prefer idempotent GitHub mutations when possible. If a partial write occurs, return a recovery instruction instead of blindly retrying and creating duplicate work.
- `router_continue` must use a `/jules ...` source comment; it must not message Jules directly.
- Local worktree synchronization and local evidence remain responsibilities of git-fleet/chatgpt-opencli, not this service.

## Verification

- Run `npm test` before opening or updating a pull request.
- Keep implementation changes on a focused task branch and merge through a pull request.
