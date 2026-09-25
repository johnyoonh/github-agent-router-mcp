import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RouterFacade } from "./router.js";

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const nonEmptyString = z.string().trim().min(1);
const positiveInt = z.number().int().positive();

function asToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, data: value }, null, 2),
      },
    ],
  };
}

function asToolError(error: unknown) {
  const err = error as Error & { status?: number };
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            error: {
              name: err?.name ?? "Error",
              message: err?.message ?? String(error),
              status: err?.status,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function createMcpServer(facade: RouterFacade): McpServer {
  const server = new McpServer({
    name: "github-agent-router-mcp",
    version: "0.1.0",
  });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
    annotations: ToolAnnotations,
  ): void => {
    const wrapped = async (args: unknown) => {
      try {
        return asToolResult(await handler(args as z.infer<z.ZodObject<S>>));
      } catch (error) {
        return asToolError(error);
      }
    };
    server.registerTool(
      name,
      { description, inputSchema, annotations },
      wrapped as never,
    );
  };

  const readOnly: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const writeIdempotent: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
  const writeNonIdempotent: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };

  tool(
    "router_delegate",
    "Create a new focused GitHub issue and signal it to github-agent-router by adding jules:run. Use for new coding work. The MCP server never calls Jules directly. If issue creation succeeds but label routing fails, the response contains a recovery instruction; do not blindly retry delegate.",
    {
      repository: nonEmptyString.describe("Allowlisted owner/repo target"),
      title: nonEmptyString.max(120).describe("Focused GitHub issue title"),
      instructions: nonEmptyString.describe("Complete implementation instructions for the routed Jules task"),
    },
    async (args) => facade.delegate(args),
    writeNonIdempotent,
  );

  tool(
    "router_route_existing",
    "Signal an existing open GitHub issue or pull request to github-agent-router by adding jules:run. Repeated calls are safe: an already routed/signaled item is returned without toggling labels or creating duplicate work.",
    {
      repository: nonEmptyString.describe("Allowlisted owner/repo target"),
      number: positiveInt.describe("Existing GitHub issue or pull request number"),
    },
    async (args) => facade.routeExisting(args),
    writeIdempotent,
  );

  tool(
    "router_continue",
    "Continue already-routed work by posting a /jules follow-up comment on the source issue or pull request. github-agent-router decides whether the existing sticky Jules session can receive the message or a new permitted sticky verification round is required.",
    {
      repository: nonEmptyString.describe("Allowlisted owner/repo target"),
      number: positiveInt.describe("Routed GitHub issue or pull request number"),
      instruction: nonEmptyString.describe("New evidence, correction, or follow-up instruction for Jules"),
    },
    async (args) => facade.continue(args),
    writeNonIdempotent,
  );

  tool(
    "router_status",
    "Read the target repository harness readiness plus the GitHub item labels and a sanitized view of the latest github-agent-router state. Router HMAC signatures, operation IDs, and event history are never returned.",
    {
      repository: nonEmptyString.describe("Allowlisted owner/repo target"),
      number: positiveInt.describe("GitHub issue or pull request number"),
    },
    async (args) => facade.status(args),
    readOnly,
  );

  return server;
}
