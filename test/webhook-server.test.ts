import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeQBittorrent } from "./fake-qbittorrent.ts";

// The webhook endpoints are anonymous when the Operator leaves WEBHOOK_SECRET
// unset, so an oversized body must be refused as it arrives rather than
// buffered whole.
void test("an oversized webhook body is cut off and leaves the server healthy", async (t) => {
  const qbit = await startFakeQBittorrent();

  const tmpDir = mkdtempSync(join(tmpdir(), "thanks-bot-webhook-"));
  const sitesPath = join(tmpDir, "sites.json");
  writeFileSync(
    sitesPath,
    JSON.stringify({ sites: [{ id: "fake-site", base_url: "https://tracker.example.com" }] }),
  );

  const originalEnv = { ...process.env };
  process.env.SITES_CONFIG_PATH = sitesPath;
  process.env.FAKE_SITE_USERNAME = "operator-user";
  process.env.FAKE_SITE_PASSWORD = "operator-pw";
  process.env.QBIT_URL = qbit.baseUrl;
  process.env.QBIT_USERNAME = "qbit-user";
  process.env.QBIT_PASSWORD = "qbit-pw";
  delete process.env.QBIT_API_KEY;
  delete process.env.WEBHOOK_SECRET;

  const { loadSites } = await import("../src/config.ts");
  const { QBittorrentClient } = await import("../src/qbittorrent.ts");
  const { startServer } = await import("../src/webhook-server.ts");

  const server = await startServer(loadSites(), 0, QBittorrentClient.fromEnv());
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await qbit.close();
    rmSync(tmpDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  await assert.rejects(
    () =>
      fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "Grab", padding: "x".repeat(512 * 1024) }),
      }),
    "the connection must be cut instead of buffering the whole body",
  );

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200, "the server must still serve other requests");

  const small = await fetch(`http://127.0.0.1:${port}/webhook/radarr`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventType: "Download" }),
  });
  assert.equal(small.status, 200, "a normal payload must still be accepted");
});
