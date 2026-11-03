import { expect, test } from "bun:test";
import { userTagSchema } from "../src/user-tags.js";

test("user tags normalize and accept public identity characters", () => {
  expect(userTagSchema.parse("  Julie_Writes-2 ")).toBe("julie_writes-2");
});

test("user tags reject short, malformed, and reserved names", () => {
  for (const value of ["ab", "-name", "two words", "admin", "adminmachine", "JobsAI"]) {
    expect(userTagSchema.safeParse(value).success).toBe(false);
  }
});
