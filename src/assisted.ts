// Assisted mode: no Reddit API. Claude writes the draft; a local page opens with the text ready
// to copy and a link to Reddit's submit page or the thread. You review it and click Post yourself.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { DRAFTS_DIR } from "./config.ts";

export type Draft = {
  id: string;
  action?: "post" | "comment";
  subreddit: string;
  title?: string;
  kind?: "self" | "link";
  text?: string;
  url?: string;
  thread_url?: string;
  flair_text?: string;
};

const sub = (s: string) => s.replace(/^\/?r\//i, "").trim();

// old.reddit's submit form reliably accepts title/text/url prefill from the query string.
// Long bodies are left out of the URL (browsers and Reddit cap URL length); the draft page
// always has a Copy button for the body.
export function submitUrl(d: Draft) {
  const q = new URLSearchParams({ title: d.title ?? "" });
  if (d.kind === "link" && d.url) q.set("url", d.url);
  else {
    q.set("selftext", "true");
    if ((d.text ?? "").length <= 4000) q.set("text", d.text ?? "");
  }
  return `https://old.reddit.com/r/${sub(d.subreddit)}/submit?${q}`;
}

const esc = (s = "") => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(d: Draft) {
  const isReply = d.action === "comment";
  const target = isReply ? d.thread_url! : submitUrl(d);
  const sr = sub(d.subreddit);
  const block = (label: string, value: string, rows: number) => `
    <section>
      <div class="row"><h2>${label}</h2><button data-copy="${esc(label)}">Copy</button></div>
      <textarea id="${esc(label)}" rows="${rows}" readonly>${esc(value)}</textarea>
    </section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isReply ? "Reply" : "Post"} draft · r/${esc(sr)}</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1b; --muted:#6b6f73; --line:#dcdfe2; --accent:#d93a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141516; --fg:#e8eaed; --muted:#9aa0a6; --line:#33363a; --accent:#ff6a33; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; } .meta { color:var(--muted); margin:0 0 24px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0; }
  section { margin:0 0 20px; } .row { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
  textarea { width:100%; box-sizing:border-box; padding:12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:15px/1.5 ui-monospace, Menlo, monospace; resize:vertical; }
  button, a.go { font:inherit; font-size:14px; padding:6px 14px; border-radius:999px; border:1px solid var(--line); background:transparent; color:inherit; cursor:pointer; text-decoration:none; }
  a.go { display:inline-block; background:var(--accent); border-color:var(--accent); color:#fff; padding:10px 20px; font-size:16px; }
  ol { padding-left:20px; color:var(--muted); } .done { color:var(--accent); }
</style></head><body><main>
  <h1>${isReply ? "Reply" : "Post"} draft for r/${esc(sr)}</h1>
  <p class="meta">Draft ${esc(d.id)}${d.flair_text ? ` · flair: ${esc(d.flair_text)}` : ""}</p>
  ${isReply ? "" : block("Title", d.title ?? "", 2)}
  ${d.kind === "link" && d.url ? block("Link", d.url, 1) : ""}
  ${d.text ? block(isReply ? "Reply" : "Body", d.text, 14) : ""}
  <p><a class="go" href="${esc(target)}" target="_blank" rel="noopener">${isReply ? "Open the thread" : `Open r/${esc(sr)} submit page`}</a></p>
  <ol>
    ${isReply
      ? "<li>Copy the reply.</li><li>Open the thread, find the post or comment, click Reply, paste.</li>"
      : "<li>The submit page opens with the title and body filled in. If the body is empty, copy it from here.</li><li>Pick the flair if the subreddit requires one.</li>"}
    <li>Read it once more, then click Post.</li>
    <li>Tell Claude it's posted (optionally with the link) so the queue marks it done.</li>
  </ol>
  <p class="meta"><a href="https://www.reddit.com/r/${esc(sr)}/about/rules" target="_blank" rel="noopener" style="color:inherit">r/${esc(sr)} rules</a></p>
</main>
<script>
  document.querySelectorAll("button[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const t = document.getElementById(b.dataset.copy);
    t.select();
    const ok = () => { b.textContent = "Copied"; b.classList.add("done"); setTimeout(() => { b.textContent = "Copy"; b.classList.remove("done"); }, 1500); };
    (navigator.clipboard ? navigator.clipboard.writeText(t.value) : Promise.reject()).then(ok, () => { document.execCommand("copy"); ok(); });
  }));
</script></body></html>`;
}

export function writeDraftPage(d: Draft) {
  mkdirSync(DRAFTS_DIR, { recursive: true });
  const path = join(DRAFTS_DIR, `${d.id}.html`);
  writeFileSync(path, page(d));
  return path;
}

// REDDIT_MCP_NO_OPEN=1 skips opening pages and notifications (tests, headless use).
const quiet = () => process.env.REDDIT_MCP_NO_OPEN === "1";

export function openPath(path: string) {
  if (quiet()) return;
  if (process.platform === "darwin") execFile("open", [path]);
  else if (process.platform === "linux") execFile("xdg-open", [path]);
}

export function notify(title: string, message: string) {
  if (quiet() || process.platform !== "darwin") return;
  const q = (s: string) => JSON.stringify(s.slice(0, 200));
  execFile("osascript", ["-e", `display notification ${q(message)} with title ${q(title)} sound name "Glass"`]);
}

export function openDraft(d: Draft) {
  const path = writeDraftPage(d);
  openPath(path);
  return { draft_page: path, reddit_url: d.action === "comment" ? d.thread_url : submitUrl(d) };
}
