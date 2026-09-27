import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRejection } from "../src/rejection.ts";

void test("the Site's own words go unplaced", async () => {
  assert.equal(
    await classifyRejection("Has alcanzado el límite de agradecimientos de hoy."),
    "other",
  );
});
