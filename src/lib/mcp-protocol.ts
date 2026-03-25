import type { Context } from "hono";
import type postgres from "postgres";
import type { Env, Vars, JsonRpcId, JsonRpcMessage } from "../types.ts";
import {
  queryEvents,
  parseEventQueryFromToolArgs,
  buildEventSummaryText,
} from "./queries.ts";
import { withRetry } from "./db.ts";

const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

const MCP_SERVER_INFO = {
  name: "device-event-logger",
  title: "User Device Event Logger",
  version: "1.1.1",
  description:
    "Query user device event records and app usage summaries from a database. Read-only.",
};

const QUERY_EVENTS_TOOL = {
  name: "query_events",
  title: "Query Events",
  description: "Query event records by time range, type, and value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Defaults to 6 when since is omitted.",
        minimum: 0.001,
      },
      since: {
        type: "string",
        description:
          "Start time in ISO 8601 format. Overrides the default hours window.",
      },
      until: {
        type: "string",
        description: "End time in ISO 8601 format. Defaults to now.",
      },
      type: {
        type: "string",
        description:
          "Event type filter (dot-separated lowercase alphanumeric, e.g. 'app.open'). Prefix match when no dot is present; exact match otherwise. Use the list_event_types tool to discover available types.",
      },
      value: {
        type: "string",
        description: "Exact value filter.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of events to return. Default 100, max 1000.",
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "integer",
        description: "Pagination offset. Default 0.",
        minimum: 0,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      total: { type: "integer" },
      events: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "integer" },
            type: { type: "string" },
            value: { anyOf: [{ type: "string" }, { type: "null" }] },
            ts: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["id", "type", "value", "ts"],
        },
      },
    },
    required: ["total", "events"],
  },
};

const LIST_EVENT_TYPES_TOOL = {
  name: "list_event_types",
  title: "List Event Types",
  description: "List all distinct event types currently stored in the database.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      types: { type: "array", items: { type: "string" } },
    },
    required: ["types"],
  },
};

const QUERY_APP_SUMMARY_TOOL = {
  name: "query_app_summary",
  title: "Query App Summary",
  description: "Summarize app usage durations from app.open/app.close events.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hours: {
        type: "number",
        description: "Look back N hours. Default 24.",
        minimum: 0.001,
      },
      value: {
        type: "string",
        description: "Exact app name filter, e.g. 小红书",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      hours: { type: "number" },
      range: {
        type: "object",
        additionalProperties: false,
        properties: {
          since: { type: "string" },
          until: { type: "string" },
        },
        required: ["since", "until"],
      },
      totalApps: { type: "integer" },
      apps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            opens: { type: "integer" },
            closes: { type: "integer" },
            sessions: { type: "integer" },
            durationSeconds: { type: "integer" },
            currentlyOpen: { type: "boolean" },
            duplicateOpens: { type: "integer" },
            orphanCloses: { type: "integer" },
          },
          required: [
            "name",
            "opens",
            "closes",
            "sessions",
            "durationSeconds",
            "currentlyOpen",
            "duplicateOpens",
            "orphanCloses",
          ],
        },
      },
    },
    required: ["ok", "hours", "range", "totalApps", "apps"],
  },
};

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function isJsonRpcRequest(message: JsonRpcMessage): boolean {
  return (
    typeof message.method === "string" &&
    Object.prototype.hasOwnProperty.call(message, "id")
  );
}

function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return (
    typeof message.method === "string" &&
    !Object.prototype.hasOwnProperty.call(message, "id")
  );
}

function isJsonRpcResponse(message: JsonRpcMessage): boolean {
  return (
    Object.prototype.hasOwnProperty.call(message, "result") ||
    Object.prototype.hasOwnProperty.call(message, "error")
  );
}

function getProtocolVersionFromHeaders(c: Context): string {
  const header = c.req.header("mcp-protocol-version")?.trim();
  return header || DEFAULT_MCP_PROTOCOL_VERSION;
}

async function callQueryEventsTool(
  args: Record<string, unknown>,
  sql: postgres.Sql,
  offsetMinutes: number
) {
  const parsed = parseEventQueryFromToolArgs(args);
  if (typeof parsed === "string") {
    return { content: [{ type: "text", text: parsed }], isError: true };
  }

  try {
    const result = await queryEvents(parsed, sql, offsetMinutes);
    return {
      content: [{ type: "text", text: buildEventSummaryText(result.events, result.total) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP query_events failed:", error);
    return {
      content: [{ type: "text", text: "Database error while querying events." }],
      isError: true,
    };
  }
}

async function callListEventTypesTool(sql: postgres.Sql) {
  try {
    const rows = await withRetry(() =>
      sql.unsafe("SELECT DISTINCT type FROM events ORDER BY type")
    );
    const types = rows.map((r: Record<string, unknown>) => String(r.type));
    return {
      content: [{ type: "text", text: types.length ? types.join("\n") : "No event types found." }],
      structuredContent: { types },
      isError: false,
    };
  } catch (error) {
    console.error("MCP list_event_types failed:", error);
    return {
      content: [{ type: "text", text: "Database error while listing event types." }],
      isError: true,
    };
  }
}

async function callQueryAppSummaryTool(
  args: Record<string, unknown>,
  sql: postgres.Sql
) {
  const hours = typeof args.hours === "number" ? args.hours : 24;
  const value =
    typeof args.value === "string" && args.value.trim() ? args.value.trim() : null;

  if (!Number.isFinite(hours) || hours <= 0) {
    return {
      content: [{ type: "text", text: "Invalid 'hours'. It must be a positive number." }],
      isError: true,
    };
  }

  const sinceDate = new Date(Date.now() - hours * 3600_000);
  const untilDate = new Date();
  const since = sinceDate.toISOString();
  const until = untilDate.toISOString();

  try {
    const rows = value
      ? await withRetry(() =>
          sql`
            SELECT type, value, ts
            FROM events
            WHERE ts >= ${since}
              AND ts <= ${until}
              AND type IN ('app.open', 'app.close')
              AND value = ${value}
            ORDER BY ts ASC
          `
        )
      : await withRetry(() =>
          sql`
            SELECT type, value, ts
            FROM events
            WHERE ts >= ${since}
              AND ts <= ${until}
              AND type IN ('app.open', 'app.close')
            ORDER BY ts ASC
          `
        );

    type EventRow = {
      type: string;
      value: string | null;
      ts: string;
    };

    type SummaryItem = {
      name: string;
      opens: number;
      closes: number;
      sessions: number;
      durationSeconds: number;
      currentlyOpen: boolean;
      duplicateOpens: number;
      orphanCloses: number;
      _openAt: Date | null;
    };

    const appMap = new Map<string, SummaryItem>();

    for (const row of rows as EventRow[]) {
      const name = row.value ?? "(unknown)";
      const ts = new Date(row.ts);
      if (Number.isNaN(ts.getTime())) continue;

      if (!appMap.has(name)) {
        appMap.set(name, {
          name,
          opens: 0,
          closes: 0,
          sessions: 0,
          durationSeconds: 0,
          currentlyOpen: false,
          duplicateOpens: 0,
          orphanCloses: 0,
          _openAt: null,
        });
      }

      const item = appMap.get(name)!;

      if (row.type === "app.open") {
        item.opens += 1;
        if (item._openAt === null) {
          item._openAt = ts;
        } else {
          item.duplicateOpens += 1;
          item._openAt = ts; // 用最新 open 覆盖旧 open，避免跨段误配
        }
      } else if (row.type === "app.close") {
        item.closes += 1;
        if (item._openAt !== null && ts.getTime() >= item._openAt.getTime()) {
          item.sessions += 1;
          item.durationSeconds += Math.floor(
            (ts.getTime() - item._openAt.getTime()) / 1000
          );
          item._openAt = null;
        } else {
          item.orphanCloses += 1;
        }
      }
    }

    const apps = Array.from(appMap.values()).map((item) => {
      if (item._openAt !== null) {
        item.currentlyOpen = true;
        // 按你的口径：未闭合 open 不累计时长
      }
      const { _openAt, ...rest } = item;
      return rest;
    });

    apps.sort((a, b) => {
      if (b.durationSeconds !== a.durationSeconds) {
        return b.durationSeconds - a.durationSeconds;
      }
      return b.opens - a.opens;
    });

    const result = {
      ok: true,
      hours,
      range: { since, until },
      totalApps: apps.length,
      apps,
    };

    const text =
      apps.length === 0
        ? "No app usage found in the selected range."
        : apps
            .slice(0, 20)
            .map(
              (app, i) =>
                `${i + 1}. ${app.name} | ${app.durationSeconds}s | opens=${app.opens} closes=${app.closes} sessions=${app.sessions} currentlyOpen=${app.currentlyOpen}`
            )
            .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    console.error("MCP query_app_summary failed:", error);
    return {
      content: [{ type: "text", text: "Database error while summarizing app usage." }],
      isError: true,
    };
  }
}

async function handleMcpRequest(
  message: JsonRpcMessage,
  sql: postgres.Sql,
  offsetMinutes: number
) {
  const id = (message.id ?? null) as JsonRpcId;
  const method = typeof message.method === "string" ? message.method : "";
  const params =
    message.params && typeof message.params === "object"
      ? (message.params as Record<string, unknown>)
      : {};

  switch (method) {
    case "initialize": {
      const requestedVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : "";

      if (!requestedVersion || !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(requestedVersion)) {
        return jsonRpcError(id, -32602, "Unsupported protocolVersion", {
          supported: Array.from(SUPPORTED_MCP_PROTOCOL_VERSIONS),
        });
      }

      return jsonRpcResult(id, {
        protocolVersion: requestedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: MCP_SERVER_INFO,
        instructions:
          "This server provides read-only access to user device event records and app usage summaries. Use list_event_types to discover types, query_events for raw records, and query_app_summary for app usage duration statistics.",
      });
    }

    case "notifications/initialized":
      return null;

    case "ping":
      return jsonRpcResult(id, {});

    case "tools/list":
      return jsonRpcResult(id, {
        tools: [QUERY_EVENTS_TOOL, LIST_EVENT_TYPES_TOOL, QUERY_APP_SUMMARY_TOOL],
      });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";

      if (name === LIST_EVENT_TYPES_TOOL.name) {
        return jsonRpcResult(id, await callListEventTypesTool(sql));
      }

      if (name === QUERY_APP_SUMMARY_TOOL.name) {
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        return jsonRpcResult(id, await callQueryAppSummaryTool(args, sql));
      }

      if (name === QUERY_EVENTS_TOOL.name) {
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        return jsonRpcResult(id, await callQueryEventsTool(args, sql, offsetMinutes));
      }

      return jsonRpcError(id, -32601, `Unknown tool: ${name || "(empty)"}`);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method || "(empty)"}`);
  }
}

export async function handleMcpPost(
  c: Context<{ Bindings: Env; Variables: Vars }>
): Promise<Response> {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;

  const version = c.req.header("mcp-protocol-version")?.trim();
  if (version && !SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) {
    return c.json({ error: `Unsupported MCP protocol version: ${version}` }, 400);
  }

  const protocolVersion = getProtocolVersionFromHeaders(c);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
  }

  if (Array.isArray(body)) {
    if (!body.length) {
      c.header("MCP-Protocol-Version", protocolVersion);
      return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
    }

    const responses: unknown[] = [];
    for (const item of body) {
      if (!item || typeof item !== "object") {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }

      const message = item as JsonRpcMessage;
      if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) continue;
      if (!isJsonRpcRequest(message)) {
        responses.push(jsonRpcError(null, -32600, "Invalid Request"));
        continue;
      }

      responses.push(await handleMcpRequest(message, sql, offsetMinutes));
    }

    if (!responses.length) {
      return c.body(null, 202);
    }

    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(responses);
  }

  if (!body || typeof body !== "object") {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }

  const message = body as JsonRpcMessage;

  if (isJsonRpcNotification(message) || isJsonRpcResponse(message)) {
    return c.body(null, 202);
  }

  if (!isJsonRpcRequest(message)) {
    c.header("MCP-Protocol-Version", protocolVersion);
    return c.json(jsonRpcError(null, -32600, "Invalid Request"), 400);
  }

  const response = await handleMcpRequest(message, sql, offsetMinutes);
  if (response == null) {
    return c.body(null, 202);
  }

  c.header("MCP-Protocol-Version", protocolVersion);
  return c.json(response);
}
