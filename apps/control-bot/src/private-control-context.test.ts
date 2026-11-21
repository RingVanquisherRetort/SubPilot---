import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrivateControlChat } from "./private-control-context.js";

test("control bot accepts only ordinary private chat contexts", () => {
  assert.equal(isPrivateControlChat("private"), true);
  assert.equal(isPrivateControlChat("group"), false);
  assert.equal(isPrivateControlChat("supergroup"), false);
  assert.equal(isPrivateControlChat("channel"), false);
  assert.equal(isPrivateControlChat(undefined), false);
});
