# reddit-mcp

An MCP server that lets Claude Code (or any MCP client) publish and schedule Reddit posts through **your own** Reddit API app. It's a self-hosted, single-account alternative to hosted connectors like Composio or Postiz: no third-party service holds your token.

- **Publish now:** text (self) and link posts, with flair, NSFW, spoiler and reply settings.
- **Schedule:** posts go into a local queue, and a small launchd job publishes them when they're due. Claude Code doesn't need to be running.
- **Check before posting:** reads a subreddit's rules, post requirements (title/body regex, required flair) and flair ids.
- **Follow up:** lists your recent submissions with score, comment count and whether they were removed.

## Tools

| Tool | What it does |
|---|---|
| `reddit_whoami` | Shows the authorized account and its karma |
| `reddit_subreddit_info` | Gets rules, post requirements, allowed post types and flair ids |
| `reddit_submit_post` | Publishes immediately |
| `reddit_schedule_post` | Queues a post for an ISO 8601 `publish_at` |
| `reddit_list_scheduled` | Lists queued, failed and stuck posts (`include_done` adds history) |
| `reddit_update_scheduled` | Edits a queued or failed post; editing a failed post re-queues it |
| `reddit_cancel_scheduled` | Cancels a queued post |
| `reddit_publish_due` | Publishes everything that's due right now |
| `reddit_recent_posts` | Lists your recent submissions and how they're doing |

## Requirements

- Node.js 23.6 or later (it runs the TypeScript directly; there's no build step)
- macOS for the bundled launchd scheduler. On Linux, run `node src/worker.ts` from cron every 5 minutes instead.
- A Reddit account and a Reddit API app. Reddit reviews new API apps under its developer terms, so app creation or access may need approval first.

## Setup

```sh
git clone https://github.com/meyerappstudio/reddit-mcp && cd reddit-mcp
npm install
```

1. **Create a Reddit app** at <https://www.reddit.com/prefs/apps>. Choose the **installed app** type and set the redirect URI to `http://localhost:8765/callback`.
2. **Authorize:** run `npm run auth`, paste the client ID, then approve in the browser. This saves a refresh token to `~/.reddit-mcp/config.json` (mode 600).
3. **Add it to Claude Code:**
   ```sh
   claude mcp add --scope user reddit -- node "$PWD/src/server.ts"
   ```
4. **Start the scheduler** (macOS): `npm run install-worker`. It runs every 5 minutes; remove it with `npm run uninstall-worker`.

Then ask Claude something like: *"Check r/SideProject's rules, then schedule this launch post for Tuesday 9am Eastern."*

## How scheduling works

- The queue lives at `~/.reddit-mcp/queue.json`, and a lock file keeps the MCP server and the worker from publishing the same post twice.
- A post is marked `publishing` before the API call. If the process dies mid-call, the post stays `publishing` and is **not** retried, because Reddit may already have accepted it. Check `reddit_recent_posts`, then cancel or re-queue it.
- If Reddit rejects a post (rules, rate limit, flair required), it's marked `failed` with Reddit's error. Fix it with `reddit_update_scheduled` and it's queued again.
- The worker log is at `~/.reddit-mcp/worker.log`.
- Set `REDDIT_MCP_HOME` to keep state somewhere else.

## Limits

- Image, video and gallery posts aren't supported yet; they need Reddit's media-upload flow.
- One account per state directory.
- The worker publishes within 5 minutes of `publish_at`, and only while the Mac is awake.

## Posting responsibly

Reddit and most subreddits restrict self-promotion and repetitive cross-posting, and bans happen fast. Always call `reddit_subreddit_info` first, follow each subreddit's rules, and don't schedule the same post across many subreddits. This tool doesn't evade rate limits or spam filters, and it isn't meant to.

## License

MIT
