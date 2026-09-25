import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, type AppConfig } from "./config.js";
import { GitHubClient } from "./github.js";
import { createMcpServer } from "./mcp.js";
import { RouterFacade } from "./router.js";

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function originGuard(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }
    if (!config.allowedOrigins.has(origin)) {
      res.status(403).json({ error: "origin is not allowed" });
      return;
    }
    next();
  };
}

function sessionId(req: Request): string | undefined {
  const value = req.header("mcp-session-id");
  return value?.trim() || undefined;
}

export function createHttpApp(config: AppConfig) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(originGuard(config));

  const facade = new RouterFacade(new GitHubClient(config));
  const sessions = new Map<string, SessionEntry>();

  app.get("/healthz", (_req, res) => {
    res.json({
      ok: true,
      service: "github-agent-router-mcp",
      version: "0.1.0",
    });
  });

  app.post("/mcp", async (req, res) => {
    try {
      const existingId = sessionId(req);
      if (existingId) {
        const entry = sessions.get(existingId);
        if (!entry) {
          res.status(404).json({ error: "unknown MCP session" });
          return;
        }
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          error: "missing MCP session id; initialize the connection first",
        });
        return;
      }

      const server = createMcpServer(facade);
      let initializedId: string | undefined;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          initializedId = id;
          sessions.set(id, { server, transport });
        },
      });
      transport.onclose = () => {
        if (initializedId) {
          sessions.delete(initializedId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "MCP request failed",
        });
      }
    }
  });

  const handleExistingSession = async (req: Request, res: Response) => {
    const id = sessionId(req);
    if (!id) {
      res.status(400).json({ error: "missing mcp-session-id header" });
      return;
    }
    const entry = sessions.get(id);
    if (!entry) {
      res.status(404).json({ error: "unknown MCP session" });
      return;
    }
    try {
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          error: error instanceof Error ? error.message : "MCP request failed",
        });
      }
    }
  };

  app.get("/mcp", handleExistingSession);
  app.delete("/mcp", handleExistingSession);

  return { app, sessions };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = createHttpApp(config);
  app.listen(config.port, config.host, () => {
    console.log(
      `github-agent-router-mcp listening on http://${config.host}:${config.port}/mcp`,
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
