import { readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync, renameSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { QUEUE_PATH, LOCK_PATH, LOG_PATH, ensureHome } from "./config.ts";
import { submitPost, reply, type PostInput } from "./reddit.ts";
import { openDraft, notify } from "./assisted.ts";

// "ready" = assisted-mode draft opened for you to post by hand.
export type Status = "scheduled" | "publishing" | "ready" | "published" | "failed" | "cancelled";

export type QueuedPost = Omit<PostInput, "subreddit" | "title"> & {
  // "post" (default) submits a new post; "comment" replies to parent_id.
  action?: "post" | "comment";
  subreddit: string;
  title?: string;
  parent_id?: string;
  // "api" posts through the Reddit API; "assisted" opens a draft page for you to post by hand.
  mode?: "api" | "assisted";
  thread_url?: string;
  draft_page?: string;
  id: string;
  publish_at: string; // ISO UTC
  status: Status;
  created_at: string;
  published_url?: string;
  error?: string;
  attempted_at?: string;
};

function read(): QueuedPost[] {
  if (!existsSync(QUEUE_PATH)) return [];
  return JSON.parse(readFileSync(QUEUE_PATH, "utf8"));
}

function write(q: QueuedPost[]) {
  ensureHome();
  const tmp = QUEUE_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, QUEUE_PATH);
}

// Cross-process lock so the MCP server and the launchd worker never publish the same post twice.
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureHome();
  for (let i = 0; i < 50; i++) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      closeSync(fd);
      try { return await fn(); } finally { unlinkSync(LOCK_PATH); }
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Break a stale lock left by a crashed process.
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > 5 * 60_000) unlinkSync(LOCK_PATH);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Queue is locked by another process; try again shortly.");
}

export function log(msg: string) {
  ensureHome();
  appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
}

export async function schedule(p: Partial<QueuedPost> & { subreddit: string }, publishAt: Date, status: Status = "scheduled"): Promise<QueuedPost> {
  return withLock(async () => {
    const q = read();
    const item: QueuedPost = {
      ...p,
      subreddit: p.subreddit.replace(/^\/?r\//i, "").trim(),
      action: p.action ?? "post",
      id: randomUUID().slice(0, 8),
      publish_at: publishAt.toISOString(),
      status,
      created_at: new Date().toISOString(),
    };
    q.push(item);
    write(q);
    return item;
  });
}

export function list(includeDone = false): QueuedPost[] {
  return read()
    .filter((p) => includeDone || ["scheduled", "failed", "publishing", "ready"].includes(p.status))
    .sort((a, b) => a.publish_at.localeCompare(b.publish_at));
}

export async function update(id: string, patch: Partial<QueuedPost>) {
  return withLock(async () => {
    const q = read();
    const item = q.find((p) => p.id === id);
    if (!item) throw new Error(`No queued post ${id}`);
    if (!["scheduled", "failed", "ready"].includes(item.status)) throw new Error(`Post ${id} is ${item.status}; only scheduled, ready or failed items can be edited.`);
    Object.assign(item, { status: "scheduled" }, patch, { error: undefined });
    write(q);
    return item;
  });
}

export async function cancel(id: string) {
  return withLock(async () => {
    const q = read();
    const item = q.find((p) => p.id === id);
    if (!item) throw new Error(`No queued post ${id}`);
    if (item.status === "published") throw new Error(`Post ${id} is already published: ${item.published_url}`);
    item.status = "cancelled";
    write(q);
    return item;
  });
}

export async function markPosted(id: string, url?: string) {
  return withLock(async () => {
    const q = read();
    const item = q.find((p) => p.id === id);
    if (!item) throw new Error(`No queued item ${id}`);
    item.status = "published";
    if (url) item.published_url = url;
    write(q);
    log(`marked posted ${item.id} r/${item.subreddit}${url ? ` ${url}` : ""}`);
    return item;
  });
}

// Publishes every scheduled post whose time has come. A post is marked "publishing" before the
// API call; if the process dies mid-call it stays "publishing" and is NOT retried automatically,
// because Reddit may have accepted it and a retry would double-post.
export async function publishDue(now = new Date()) {
  return withLock(async () => {
    const q = read();
    const due = q.filter((p) => p.status === "scheduled" && new Date(p.publish_at) <= now);
    const results: QueuedPost[] = [];
    for (const item of due) {
      if (item.mode === "assisted") {
        const opened = openDraft(item);
        item.status = "ready";
        item.draft_page = opened.draft_page;
        notify(`Reddit ${item.action === "comment" ? "reply" : "post"} ready: r/${item.subreddit}`, item.title ?? item.text?.slice(0, 80) ?? "");
        log(`ready ${item.id} r/${item.subreddit} ${opened.draft_page}`);
        write(q);
        results.push(item);
        continue;
      }
      item.status = "publishing";
      item.attempted_at = new Date().toISOString();
      write(q);
      try {
        const r = item.action === "comment"
          ? await reply({ parent_id: item.parent_id!, text: item.text ?? "" })
          : await submitPost(item as PostInput);
        item.status = "published";
        item.published_url = r.url;
        log(`published ${item.id} r/${item.subreddit} ${r.url}`);
      } catch (e: any) {
        item.status = "failed";
        item.error = e.message;
        log(`failed ${item.id} r/${item.subreddit}: ${e.message}`);
      }
      write(q);
      results.push(item);
    }
    return results;
  });
}
