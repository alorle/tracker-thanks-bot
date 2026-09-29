import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import type { TestEvent } from "node:test/reporters";

const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeCell = (text: string) => text.replaceAll("|", "\\|");

export default async function* githubReporter(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  const failures: string[] = [];

  for await (const event of source) {
    if (event.type === "test:fail") {
      const { name, file, line, details } = event.data;
      const error = details.error as Error & { failureType?: string };
      if (details.type === "suite" || error.failureType === "subtestsFailed") {
        continue;
      }

      const message = (error.cause instanceof Error ? error.cause : error).message;
      const path = file ? relative(process.cwd(), file) : "";
      yield `::error file=${path},line=${line ?? 1}::${escapeData(`${name}: ${message}`)}\n`;
      failures.push(`| ${escapeCell(name)} | \`${path}:${line ?? 1}\` |`);
    }

    if (event.type === "test:summary" && event.data.file === undefined) {
      const { counts, duration_ms, success } = event.data;
      const lines = [
        "### Tests",
        "",
        `${success ? "✅" : "❌"} ${counts.passed} passed, ${failures.length} failed, ${counts.skipped + counts.todo} skipped in ${(duration_ms / 1000).toFixed(1)} s`,
      ];
      if (failures.length > 0) {
        lines.push("", "| Failed test | Where |", "| --- | --- |", ...failures);
      }
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) appendFileSync(summaryFile, lines.join("\n") + "\n");
    }
  }
}
