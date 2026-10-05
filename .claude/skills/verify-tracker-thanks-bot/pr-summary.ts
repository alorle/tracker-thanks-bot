#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [runRoot, title = "tracker-thanks-bot"] = process.argv.slice(2);
if (!runRoot) {
  console.error('usage: pr-summary.ts <run-dir> ["<title>"]');
  process.exit(2);
}
const evidence = join(runRoot, "evidence");
const read = (name: string): string | null => {
  const path = join(evidence, name);
  return existsSync(path) ? readFileSync(path, "utf-8").trimEnd() : null;
};
const block = (text: string): string => "```\n" + text + "\n```";

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf-8" }).trim();
const revision =
  git("rev-parse", "--short", "HEAD") +
  (git("status", "--porcelain") ? " + uncommitted changes" : "");

const sections = [
  `### Verification: ${title}`,
  `Real bot process (\`node src/index.ts\`) driven against local fake qBittorrent and fake Site, revision \`${revision}\`.`,
];

const notCaptures = new Set(["metrics.txt", "session-cache.txt"]);
const captures = readdirSync(evidence)
  .filter((name) => name.endsWith(".txt") && !notCaptures.has(name))
  .sort();
const withoutConfig = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !line.startsWith("[config]") && !line.includes("Endpoints:"))
    .join("\n");
if (captures.length > 0) {
  sections.push(
    "#### Actions",
    ...captures.map((name) => `\`${name}\`\n\n${block(withoutConfig(read(name)!))}`),
  );
}

const botLog = read("bot.log");
if (botLog) sections.push("#### Bot log", block(withoutConfig(botLog)));

const state = read("fake-state.json");
if (state) {
  const { logins, clicks } = JSON.parse(state) as {
    logins: { username: string; ok: boolean }[];
    clicks: { torrentId: string; authed: boolean }[];
  };
  const loginLines = logins.map(
    (l) => `- login \`${l.username}\`: ${l.ok ? "accepted" : "refused"}`,
  );
  const clickLines = clicks.map(
    (c) =>
      `- thanks on torrent \`${c.torrentId}\`${c.authed ? " (authenticated session)" : " (NO session)"}`,
  );
  sections.push(
    "#### What the fake Site saw",
    [...loginLines, ...clickLines].join("\n") || "- nothing: no login and no thanks",
  );
}

const metrics = read("metrics.txt");
if (metrics) {
  const lines = metrics
    .split("\n")
    .filter((line) => line.startsWith("tracker_") && !/_(bucket|sum|count)\{/.test(line))
    .map((line) => line.replace(/,?app="tracker-thanks-bot"/, ""));
  sections.push("#### Metrics", block(lines.join("\n")));
}

const sessionCache = read("session-cache.txt");
if (sessionCache) {
  const files = sessionCache
    .split("\n")
    .filter((line) => /^[-d]/.test(line))
    .map((line) => {
      const fields = line.split(/\s+/);
      return `${fields[0]} ${fields.at(-1)}`;
    });
  sections.push("#### Session cache", block(files.join("\n")));
}

const markdown = sections.join("\n\n") + "\n";
writeFileSync(join(evidence, "PR.md"), markdown);
process.stdout.write(markdown);
