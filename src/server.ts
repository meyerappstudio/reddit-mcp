#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { submitPost, subredditInfo, me, recentPosts } from "./reddit.ts";
import * as queue from "./queue.ts";

const server = new McpServer({ name: "reddit", version: "0.1.0" });

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: any) => ({ isError: true, content: [{ type: "text" as const, text: String(e?.message ?? e) }] });
const wrap = <A>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

const postShape = {
  subreddit: z.string().describe("Subreddit name, with or without r/ prefix"),
  title: z.string().min(1).max(300),
  kind: z.enum(["self", "link"]).optional().describe("self = text post (default), link = URL post"),
  text: z.string().optional().describe("Markdown body for self posts"),
  url: z.string().url().optional().describe("Required for link posts"),
  flair_id: z.string().optional().describe("Flair template id from reddit_subreddit_info"),
  flair_text: z.string().optional(),
  nsfw: z.boolean().optional(),
  spoiler: z.boolean().optional(),
  send_replies: z.boolean().optional().describe("Inbox replies (default true)"),
};

function parseWhen(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable publish_at: ${s}. Use ISO 8601, e.g. 2026-10-14T09:00:00-04:00`);
  return d;
}

const describeLocal = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

server.registerTool("reddit_whoami", {
  description: "Show the authorized Reddit account and karma. Use to confirm auth works.",
  inputSchema: {},
}, wrap(async () => me()));

server.registerTool("reddit_subreddit_info", {
  description: "Fetch a subreddit's rules, post requirements (title/body rules, required flair), allowed post types and flair ids. Call this before posting or scheduling to a subreddit.",
  inputSchema: { subreddit: z.string() },
}, wrap(async ({ subreddit }) => subredditInfo(subreddit)));

server.registerTool("reddit_submit_post", {
  description: "Publish a post to Reddit immediately. Publicly visible and irreversible from this tool; confirm content and subreddit with the user first.",
  inputSchema: postShape,
}, wrap(async (p) => submitPost(p)));

server.registerTool("reddit_schedule_post", {
  description: "Queue a post to publish at a future time. The local worker (launchd, every 5 min) publishes it, so Claude Code need not be running. publish_at is ISO 8601; include a UTC offset.",
  inputSchema: { ...postShape, publish_at: z.string().describe("e.g. 2026-10-14T09:00:00-04:00") },
}, wrap(async ({ publish_at, ...p }) => {
  const when = parseWhen(publish_at);
  if (when.getTime() < Date.now() - 60_000) throw new Error("publish_at is in the past; use reddit_submit_post to publish now.");
  if (p.kind === "link" && !p.url) throw new Error("kind=link requires url");
  const item = await queue.schedule(p, when);
  return { ...item, publish_at_local: describeLocal(item.publish_at) };
}));

server.registerTool("reddit_list_scheduled", {
  description: "List queued posts (scheduled, failed, or stuck publishing). Set include_done to also show published/cancelled.",
  inputSchema: { include_done: z.boolean().optional() },
}, wrap(async ({ include_done }) =>
  queue.list(include_done).map((p) => ({ ...p, publish_at_local: describeLocal(p.publish_at) }))));

server.registerTool("reddit_update_scheduled", {
  description: "Edit a scheduled or failed post (any post field or publish_at). Editing a failed post re-queues it.",
  inputSchema: {
    id: z.string(),
    ...Object.fromEntries(Object.entries(postShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
    publish_at: z.string().optional(),
  },
}, wrap(async ({ id, publish_at, ...patch }: any) => {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  return queue.update(id, { ...clean, ...(publish_at ? { publish_at: parseWhen(publish_at).toISOString() } : {}) });
}));

server.registerTool("reddit_cancel_scheduled", {
  description: "Cancel a queued post so it never publishes.",
  inputSchema: { id: z.string() },
}, wrap(async ({ id }) => queue.cancel(id)));

server.registerTool("reddit_publish_due", {
  description: "Publish all queued posts whose time has passed, right now, instead of waiting for the worker.",
  inputSchema: {},
}, wrap(async () => queue.publishDue()));

server.registerTool("reddit_recent_posts", {
  description: "List the account's recent submissions with score, comments and whether they were removed. Use to check how published posts are doing.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, wrap(async ({ limit }) => recentPosts(limit)));

await server.connect(new StdioServerTransport());
