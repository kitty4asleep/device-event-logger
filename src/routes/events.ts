import { Hono } from "hono";
import type { Env, Vars } from "../types.ts";
import { parseEventQueryFromUrl, queryEvents } from "../lib/queries.ts";
import { withRetry } from "../lib/db.ts";

const events = new Hono<{ Bindings: Env; Variables: Vars }>();

events.post("/", async (c) => {
  const sql = c.var.sql;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const { type, value } = body as Record<string, unknown>;

  if (!type || typeof type !== "string") {
    return c.json({ error: "Missing or invalid 'type'" }, 400);
  }

  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(type)) {
    return c.json(
      {
        error:
          "Invalid 'type' format: use dot-separated lowercase alphanumeric (e.g. app.open)",
      },
      400,
    );
  }

  const eventValue = value != null ? String(value) : null;
  const now = new Date().toISOString();

  try {
    await withRetry(() =>
      sql`INSERT INTO events (type, value, ts) VALUES (${type}, ${eventValue}, ${now})`
    );
    return c.json({ ok: true });
  } catch (e) {
    console.error("DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

events.get("/summary", async (c) => {
  const sql = c.var.sql;
  const url = new URL(c.req.url);

  const hoursParam = url.searchParams.get("hours");
  const valueParam = url.searchParams.get("value")?.trim() || null;

  const hours = hoursParam ? Number(hoursParam) : 24;
  if (!Number.isFinite(hours) || hours <= 0) {
    return c.json({ error: "Invalid 'hours'" }, 400);
  }

  const sinceDate = new Date(Date.now() - hours * 3600_000);
  const untilDate = new Date();
  const since = sinceDate.toISOString();
  const until = untilDate.toISOString();

  try {
    const rows = valueParam
      ? await withRetry(() =>
          sql`
            SELECT type, value, ts
            FROM events
            WHERE ts >= ${since}
              AND ts <= ${until}
              AND type IN ('app.open', 'app.close')
              AND value = ${valueParam}
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
        }
      } else if (row.type === "app.close") {
        item.closes += 1;
        if (item._openAt !== null && ts.getTime() >= item._openAt.getTime()) {
          item.sessions += 1;
          item.durationSeconds += Math.floor(
            (ts.getTime() - item._openAt.getTime()) / 1000,
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
        item.durationSeconds += Math.floor(
          (untilDate.getTime() - item._openAt.getTime()) / 1000,
        );
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

    return c.json({
      ok: true,
      hours,
      range: {
        since,
        until,
      },
      totalApps: apps.length,
      apps,
    });
  } catch (e) {
    console.error("Summary DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

events.get("/", async (c) => {
  const sql = c.var.sql;
  const offsetMinutes = c.var.offsetMinutes;
  const url = new URL(c.req.url);
  const parsed = parseEventQueryFromUrl(url);

  if ("error" in parsed) {
    return c.json(parsed, 400);
  }

  try {
    return c.json(await queryEvents(parsed, sql, offsetMinutes));
  } catch (e) {
    console.error("DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

events.delete("/", async (c) => {
  const sql = c.var.sql;
  const url = new URL(c.req.url);
  const daysParam = url.searchParams.get("days");

  if (!daysParam) {
    return c.json({ error: "Missing 'days' parameter" }, 400);
  }

  const days = Number(daysParam);
  if (isNaN(days) || !Number.isInteger(days) || days < 1) {
    return c.json({ error: "'days' must be an integer >= 1" }, 400);
  }

  const cutoff = new Date(Date.now() - days * 86400_000);

  try {
    const result = await withRetry(() =>
      sql`DELETE FROM events WHERE ts < ${cutoff.toISOString()}`
    );
    return c.json({ ok: true, deleted: (result as { count: number }).count });
  } catch (e) {
    console.error("DB error:", e);
    return c.json({ error: "Database error" }, 500);
  }
});

export { events };
