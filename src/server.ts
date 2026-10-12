#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { submitPost, subredditInfo, me, recentPosts, listPosts, search, getThread, inbox, reply, editText, deleteThing } from "./reddit.ts";
import * as queue from "./queue.ts";
import { hasApiAuth } from "./config.ts";
import { openDraft } from "./assisted.ts";

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

const modeShape = z.enum(["api", "assisted"]).optional()
  .describe("api = publish through the Reddit API; assisted = open a draft page for the user to post by hand. Defaults to api once authorized, else assisted.");
const resolveMode = (m?: "api" | "assisted") => m ?? (hasApiAuth() ? "api" : "assisted");

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
  description: "Queue a post for a future time. The local worker (launchd, every 5 min) handles it, so Claude Code need not be running: in api mode it publishes; in assisted mode it notifies the user and opens a draft page so they can post by hand. publish_at is ISO 8601; include a UTC offset.",
  inputSchema: { ...postShape, publish_at: z.string().describe("e.g. 2026-10-14T09:00:00-04:00"), mode: modeShape },
}, wrap(async ({ publish_at, mode, ...p }) => {
  const when = parseWhen(publish_at);
  if (when.getTime() < Date.now() - 60_000) throw new Error("publish_at is in the past; use reddit_submit_post to publish now.");
  if (p.kind === "link" && !p.url) throw new Error("kind=link requires url");
  const item = await queue.schedule({ ...p, action: "post", mode: resolveMode(mode) }, when);
  return { ...item, publish_at_local: describeLocal(item.publish_at) };
}));

server.registerTool("reddit_list_scheduled", {
  description: "List queued posts and replies (scheduled, failed, or stuck publishing). Set include_done to also show published/cancelled.",
  inputSchema: { include_done: z.boolean().optional() },
}, wrap(async ({ include_done }) =>
  queue.list(include_done).map((p) => ({ ...p, publish_at_local: describeLocal(p.publish_at) }))));

server.registerTool("reddit_update_scheduled", {
  description: "Edit a scheduled or failed post or reply (text, title, publish_at, etc.). Editing a failed item re-queues it.",
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
  description: "Cancel a queued post or reply so it never publishes.",
  inputSchema: { id: z.string() },
}, wrap(async ({ id }) => queue.cancel(id)));

server.registerTool("reddit_publish_due", {
  description: "Handle all queued items whose time has passed right now (publish api items, open assisted drafts) instead of waiting for the worker.",
  inputSchema: {},
}, wrap(async () => queue.publishDue()));

server.registerTool("reddit_recent_posts", {
  description: "List the account's recent submissions with score, comments and whether they were removed. Use to check how published posts are doing.",
  inputSchema: { limit: z.number().int().min(1).max(100).optional() },
}, wrap(async ({ limit }) => recentPosts(limit)));

// ---- Assisted mode (no API needed) ----

server.registerTool("reddit_draft_post", {
  description: "Assisted mode: open a draft page in the user's browser with the post's title and body ready to copy and a button to Reddit's submit page (prefilled where Reddit allows). The user reviews and clicks Post. Works without Reddit API access. The draft is tracked in the queue as 'ready'; call reddit_mark_posted once they've posted it.",
  inputSchema: postShape,
}, wrap(async (p) => {
  if (p.kind === "link" && !p.url) throw new Error("kind=link requires url");
  const item = await queue.schedule({ ...p, action: "post", mode: "assisted" }, new Date(), "ready");
  const opened = openDraft(item);
  await queue.update(item.id, { draft_page: opened.draft_page, status: "ready" } as any);
  return { id: item.id, ...opened, next: "User posts it by hand, then call reddit_mark_posted." };
}));

server.registerTool("reddit_draft_reply", {
  description: "Assisted mode: open a draft page with the reply text ready to copy and a button to the thread. The user pastes it as a reply and posts. Works without Reddit API access.",
  inputSchema: {
    thread_url: z.string().url().describe("Link to the post, or the comment's permalink"),
    text: z.string().min(1),
    subreddit: z.string(),
  },
}, wrap(async (c) => {
  const item = await queue.schedule({ ...c, action: "comment", mode: "assisted" }, new Date(), "ready");
  const opened = openDraft(item);
  await queue.update(item.id, { draft_page: opened.draft_page, status: "ready" } as any);
  return { id: item.id, ...opened, next: "User posts it by hand, then call reddit_mark_posted." };
}));

server.registerTool("reddit_mark_posted", {
  description: "Mark a ready (assisted) draft as posted once the user confirms, optionally with the live Reddit link.",
  inputSchema: { id: z.string(), url: z.string().url().optional() },
}, wrap(async ({ id, url }) => queue.markPosted(id, url)));

// ---- Browsing ----

server.registerTool("reddit_list_posts", {
  description: "Browse a subreddit's feed. Returns post ids (t3_...) usable as reply parents.",
  inputSchema: {
    subreddit: z.string(),
    sort: z.enum(["hot", "new", "top", "rising"]).optional().describe("Default hot"),
    time: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe("For sort=top; default week"),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, wrap(async ({ subreddit, sort, time, limit }) => listPosts(subreddit, sort, limit, time)));

server.registerTool("reddit_search", {
  description: "Search posts across Reddit or within one subreddit, e.g. to find people asking about a problem.",
  inputSchema: {
    query: z.string(),
    subreddit: z.string().optional(),
    sort: z.enum(["relevance", "new", "top", "comments"]).optional(),
    time: z.enum(["hour", "day", "week", "month", "year", "all"]).optional().describe("Default month"),
    limit: z.number().int().min(1).max(100).optional(),
  },
}, wrap(async ({ query, subreddit, sort, time, limit }) => search(query, subreddit, sort, time, limit)));

server.registerTool("reddit_get_thread", {
  description: "Read a post and its comment tree. Accepts a post URL or id. Comment ids (t1_...) are usable as reply parents.",
  inputSchema: {
    post: z.string().describe("Post URL, base36 id, or t3_ fullname"),
    limit: z.number().int().min(1).max(500).optional().describe("Max comments, default 50"),
    depth: z.number().int().min(1).max(10).optional().describe("Max reply depth, default 4"),
    sort: z.enum(["top", "new", "best", "controversial", "old"]).optional(),
  },
}, wrap(async ({ post, limit, depth, sort }) => getThread(post, limit, depth, sort)));

server.registerTool("reddit_inbox", {
  description: "List replies to your posts and comments (unread by default), so you can follow up.",
  inputSchema: { unread_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
}, wrap(async ({ unread_only, limit }) => inbox(limit, unread_only ?? true)));

// ---- Replying ----

server.registerTool("reddit_reply", {
  description: "Post a comment reply to a post (t3_...) or comment (t1_...) immediately. Publicly visible; confirm wording with the user first and follow the subreddit's rules.",
  inputSchema: { parent_id: z.string().describe("t3_ or t1_ fullname"), text: z.string().min(1).describe("Markdown") },
}, wrap(async (c) => reply(c)));

server.registerTool("reddit_schedule_reply", {
  description: "Queue a comment reply for a future time. api mode needs parent_id and publishes it; assisted mode needs thread_url and opens a draft page for the user. Manage it with the reddit_*_scheduled tools.",
  inputSchema: {
    parent_id: z.string().optional().describe("t3_ or t1_ fullname (api mode)"),
    thread_url: z.string().url().optional().describe("Link to the post or comment being replied to (assisted mode)"),
    text: z.string().min(1),
    publish_at: z.string().describe("ISO 8601 with offset"),
    subreddit: z.string(),
    mode: modeShape,
  },
}, wrap(async ({ publish_at, mode, ...c }) => {
  const when = parseWhen(publish_at);
  if (when.getTime() < Date.now() - 60_000) throw new Error("publish_at is in the past; reply now instead.");
  const m = resolveMode(mode);
  if (m === "api" && !/^t[13]_/.test(c.parent_id ?? "")) throw new Error("api mode needs parent_id as a t3_ or t1_ fullname");
  if (m === "assisted" && !c.thread_url) throw new Error("assisted mode needs thread_url");
  const item = await queue.schedule({ ...c, action: "comment", mode: m }, when);
  return { ...item, publish_at_local: describeLocal(item.publish_at) };
}));

server.registerTool("reddit_edit", {
  description: "Edit the text of your own comment (t1_) or self post (t3_).",
  inputSchema: { id: z.string(), text: z.string().min(1) },
}, wrap(async ({ id, text }) => editText(id, text)));

server.registerTool("reddit_delete", {
  description: "Delete your own comment or post. Irreversible; confirm with the user first.",
  inputSchema: { id: z.string().describe("t1_ or t3_ fullname") },
}, wrap(async ({ id }) => deleteThing(id)));

await server.connect(new StdioServerTransport());
