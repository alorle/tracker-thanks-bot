import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRejection } from "../src/rejection.ts";

void test("Livewire's own refusals are placed without asking anyone", async () => {
  for (const message of ["Component payload was altered!", "Wrong component!"]) {
    assert.equal(
      await classifyRejection(message),
      "protocol_error",
      `"${message}" is the framework refusing our payload, not the Site refusing a thanks`,
    );
  }
});

void test("the Site's own words go unplaced", async () => {
  assert.equal(
    await classifyRejection("Has alcanzado el límite de agradecimientos de hoy."),
    "other",
  );
});
