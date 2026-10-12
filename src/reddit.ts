import { loadConfig } from "./config.ts";

const VERSION = "0.1.0";

let cached: { token: string; expires: number } | null = null;

function userAgent(username?: string) {
  return `${process.platform}:reddit-mcp:v${VERSION} (by /u/${username ?? "unknown"})`;
}

function basicAuth(clientId: string, secret = "") {
  return "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64");
}

export async function exchangeToken(params: Record<string, string>, clientId: string, secret?: string) {
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: basicAuth(clientId, secret),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams(params),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`Token request failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
}

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expires - 60_000) return cached.token;
  const cfg = loadConfig();
  if (!cfg.refresh_token) throw new Error("Not authorized yet. Run: npm run auth");
  const t = await exchangeToken(
    { grant_type: "refresh_token", refresh_token: cfg.refresh_token },
    cfg.client_id,
    cfg.client_secret,
  );
  cached = { token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
  return cached.token;
}

export async function api(path: string, init: { method?: string; form?: Record<string, string> } = {}) {
  const cfg = loadConfig();
  const token = await accessToken();
  const res = await fetch(`https://oauth.reddit.com${path}`, {
    method: init.method ?? (init.form ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent(cfg.username),
      ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.form ? new URLSearchParams(init.form) : undefined,
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(`Reddit ${res.status} on ${path}${remaining ? ` (ratelimit remaining ${remaining})` : ""}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
  }
  return body;
}

export type PostInput = {
  subreddit: string;
  title: string;
  kind?: "self" | "link";
  text?: string;
  url?: string;
  flair_id?: string;
  flair_text?: string;
  nsfw?: boolean;
  spoiler?: boolean;
  send_replies?: boolean;
};

export function normalizeSub(s: string) {
  return s.replace(/^\/?r\//i, "").trim();
}

export async function submitPost(p: PostInput): Promise<{ id: string; name: string; url: string }> {
  const form: Record<string, string> = {
    api_type: "json",
    sr: normalizeSub(p.subreddit),
    kind: p.kind ?? "self",
    title: p.title,
    sendreplies: String(p.send_replies ?? true),
    nsfw: String(p.nsfw ?? false),
    spoiler: String(p.spoiler ?? false),
    resubmit: "true",
  };
  if (form.kind === "self") form.text = p.text ?? "";
  if (form.kind === "link") {
    if (!p.url) throw new Error("kind=link requires url");
    form.url = p.url;
  }
  if (p.flair_id) form.flair_id = p.flair_id;
  if (p.flair_text) form.flair_text = p.flair_text;

  const body = await api("/api/submit", { form });
  const errors = body?.json?.errors ?? [];
  if (errors.length) throw new Error(`Reddit rejected the post: ${JSON.stringify(errors)}`);
  const d = body?.json?.data;
  if (!d?.url) throw new Error(`Unexpected submit response: ${JSON.stringify(body).slice(0, 500)}`);
  return { id: d.id, name: d.name, url: d.url };
}

export async function subredditInfo(subreddit: string) {
  const sr = normalizeSub(subreddit);
  const settle = async <T>(p: Promise<T>) => p.catch((e: Error) => ({ unavailable: e.message }));
  const [about, rules, requirements, flairs] = await Promise.all([
    settle(api(`/r/${sr}/about`)),
    settle(api(`/r/${sr}/about/rules`)),
    settle(api(`/api/v1/${sr}/post_requirements`)),
    settle(api(`/r/${sr}/api/link_flair_v2`)),
  ]);
  const a: any = (about as any)?.data ?? about;
  return {
    subreddit: sr,
    about: a?.unavailable ? a : {
      title: a.title,
      subscribers: a.subscribers,
      submission_type: a.submission_type, // any | link | self
      allow_images: a.allow_images,
      over18: a.over18,
      user_is_banned: a.user_is_banned,
      submit_text: a.submit_text,
    },
    rules: (rules as any)?.rules?.map((r: any) => ({ name: r.short_name, description: r.description, applies_to: r.kind })) ?? rules,
    post_requirements: requirements,
    flairs: Array.isArray(flairs) ? flairs.map((f: any) => ({ id: f.id, text: f.text, text_editable: f.text_editable })) : flairs,
  };
}

export async function me() {
  const m = await api("/api/v1/me");
  return { name: m.name, link_karma: m.link_karma, comment_karma: m.comment_karma, created_utc: m.created_utc };
}

export async function recentPosts(limit = 10) {
  const cfg = loadConfig();
  const m = cfg.username ?? (await me()).name;
  const listing = await api(`/user/${m}/submitted?limit=${limit}&raw_json=1`);
  return listing.data.children.map((c: any) => ({
    subreddit: c.data.subreddit,
    title: c.data.title,
    url: `https://www.reddit.com${c.data.permalink}`,
    score: c.data.score,
    num_comments: c.data.num_comments,
    removed: Boolean(c.data.removed_by_category),
    created: new Date(c.data.created_utc * 1000).toISOString(),
  }));
}

// ---- Browsing ----

function summarizePost(d: any) {
  return {
    id: d.name, // t3_ fullname, usable as a reply parent
    subreddit: d.subreddit,
    title: d.title,
    author: d.author,
    score: d.score,
    num_comments: d.num_comments,
    created: new Date(d.created_utc * 1000).toISOString(),
    flair: d.link_flair_text ?? undefined,
    url: `https://www.reddit.com${d.permalink}`,
    link: d.is_self ? undefined : d.url,
    text: d.selftext ? d.selftext.slice(0, 1500) : undefined,
  };
}

export async function listPosts(subreddit: string, sort = "hot", limit = 15, time = "week") {
  const sr = normalizeSub(subreddit);
  const q = new URLSearchParams({ limit: String(limit), raw_json: "1", ...(sort === "top" ? { t: time } : {}) });
  const listing = await api(`/r/${sr}/${sort}?${q}`);
  return listing.data.children.map((c: any) => summarizePost(c.data));
}

export async function search(query: string, subreddit?: string, sort = "relevance", time = "month", limit = 15) {
  const q = new URLSearchParams({ q: query, sort, t: time, limit: String(limit), raw_json: "1", type: "link" });
  const path = subreddit ? `/r/${normalizeSub(subreddit)}/search?${q}&restrict_sr=1` : `/search?${q}`;
  const listing = await api(path);
  return listing.data.children.map((c: any) => summarizePost(c.data));
}

export function postIdFrom(input: string) {
  const m = input.match(/comments\/([a-z0-9]+)/i);
  if (m) return m[1];
  return input.replace(/^t3_/, "");
}

export async function getThread(postUrlOrId: string, limit = 50, depth = 4, sort = "top") {
  const id = postIdFrom(postUrlOrId);
  const q = new URLSearchParams({ limit: String(limit), depth: String(depth), sort, raw_json: "1" });
  const [postListing, commentListing] = await api(`/comments/${id}?${q}`);
  const comments: any[] = [];
  const walk = (children: any[], level: number) => {
    for (const c of children) {
      if (c.kind !== "t1") continue;
      const d = c.data;
      comments.push({
        id: d.name, // t1_ fullname, usable as a reply parent
        parent_id: d.parent_id,
        depth: level,
        author: d.author,
        score: d.score,
        body: d.body,
        created: new Date(d.created_utc * 1000).toISOString(),
        is_mine: d.author === loadConfig().username,
      });
      if (d.replies?.data?.children) walk(d.replies.data.children, level + 1);
    }
  };
  walk(commentListing.data.children, 0);
  return { post: summarizePost(postListing.data.children[0].data), comments };
}

export async function inbox(limit = 25, unreadOnly = true) {
  const listing = await api(`/message/${unreadOnly ? "unread" : "inbox"}?limit=${limit}&raw_json=1`);
  return listing.data.children
    .filter((c: any) => c.kind === "t1")
    .map((c: any) => ({
      id: c.data.name,
      subreddit: c.data.subreddit,
      author: c.data.author,
      body: c.data.body,
      context: `https://www.reddit.com${c.data.context}`,
      created: new Date(c.data.created_utc * 1000).toISOString(),
    }));
}

// ---- Replying ----

export type CommentInput = { parent_id: string; text: string };

function fullname(id: string) {
  if (/^t[13]_/.test(id)) return id;
  throw new Error(`parent_id must be a fullname like t3_abc (post) or t1_abc (comment); got ${id}`);
}

export async function reply(c: CommentInput): Promise<{ id: string; url: string }> {
  const body = await api("/api/comment", { form: { api_type: "json", thing_id: fullname(c.parent_id), text: c.text } });
  const errors = body?.json?.errors ?? [];
  if (errors.length) throw new Error(`Reddit rejected the reply: ${JSON.stringify(errors)}`);
  const d = body?.json?.data?.things?.[0]?.data;
  if (!d) throw new Error(`Unexpected reply response: ${JSON.stringify(body).slice(0, 500)}`);
  return { id: d.name, url: `https://www.reddit.com${d.permalink}` };
}

export async function editText(thingId: string, text: string) {
  const body = await api("/api/editusertext", { form: { api_type: "json", thing_id: fullname(thingId), text } });
  const errors = body?.json?.errors ?? [];
  if (errors.length) throw new Error(`Reddit rejected the edit: ${JSON.stringify(errors)}`);
  return { id: thingId, edited: true };
}

export async function deleteThing(thingId: string) {
  await api("/api/del", { form: { id: fullname(thingId) } });
  return { id: thingId, deleted: true };
}
