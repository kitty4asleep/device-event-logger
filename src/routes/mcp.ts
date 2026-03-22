import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { handleMcpPost } from "../lib/mcp-protocol.ts";

const mcp = new Hono<{ Bindings: Env; Variables: Vars }>();

mcp.post("/", handleMcpPost);

mcp.on(["GET", "DELETE"], "/", (c) => {
  c.header("Allow", "POST, OPTIONS");
  return c.body(null, 405);
});

export { mcp };
