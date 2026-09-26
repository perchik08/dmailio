import test from "node:test";
import assert from "node:assert/strict";
import {
  loadWarmupScenarios,
  pickWarmupScenario,
} from "../warmup-scenarios.mjs";

test("warmup scenario bank validates the supplied 50-scenario JSON", () => {
  const scenarios = loadWarmupScenarios();
  assert.equal(scenarios.length, 50);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, 50);
  assert.equal(
    new Set(scenarios.map((scenario) => scenario.uniqueness_key)).size,
    50,
  );
  for (const scenario of scenarios) {
    assert.ok(scenario.messages.length >= 2 && scenario.messages.length <= 5);
    for (let index = 1; index < scenario.messages.length; index += 1)
      assert.notEqual(
        scenario.messages[index].from,
        scenario.messages[index - 1].from,
      );
  }
});

test("warmup scenario selection avoids scenarios already used by a mailbox pair", () => {
  const scenarios = loadWarmupScenarios();
  const selected = pickWarmupScenario(
    scenarios,
    new Set([scenarios[0].id]),
    "pair-a",
  );
  assert.ok(selected);
  assert.notEqual(selected.id, scenarios[0].id);
});
