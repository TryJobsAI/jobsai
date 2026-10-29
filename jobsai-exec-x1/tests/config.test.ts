import { describe, expect, test } from "bun:test";
import { collectRuntimeTokens } from "../src/config.js";

describe("worker connection keys", () => {
  test("loads any number of worker keys from comma or newline separated service settings", () => {
    expect(collectRuntimeTokens({ JOBSAI_AGENT_RUNTIME_TOKENS: " first ,\nsecond\nthird " })).toEqual(["first", "second", "third"]);
  });

  test("keeps legacy keys working and removes duplicate values", () => {
    expect(collectRuntimeTokens({ JOBSAI_AGENT_JULIE_RUNTIME_TOKEN: " first ", JOBSAI_AGENT_JOHN_RUNTIME_TOKEN: "second", JOBSAI_AGENT_RUNTIME_TOKENS: "first,third" })).toEqual(["first", "second", "third"]);
  });
});
