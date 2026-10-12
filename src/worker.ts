// Run by launchd every few minutes: publishes due queued posts, then exits.
import { publishDue, log } from "./queue.ts";

try {
  const results = await publishDue();
  if (results.length) console.log(JSON.stringify(results, null, 2));
} catch (e: any) {
  log(`worker error: ${e.message}`);
  console.error(e);
  process.exitCode = 1;
}
