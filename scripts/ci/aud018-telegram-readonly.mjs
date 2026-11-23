import { strict as assert } from "node:assert";
const token = process.env.AUD018_TEST_BOT_TOKEN;
const chatId = process.env.AUD018_TEST_CHAT_ID;
const userId = process.env.AUD018_TEST_USER_ID;
if (!token || !chatId || !userId) {
  console.error("BLOCKED: configure all three AUD018_TEST_* repository secrets.");
  process.exitCode = 2;
} else {
  // Read-only probe. No webhook changes, bans, invites, payments or updates.
  async function call(method, body) {
    const response = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12_000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      // Telegram descriptions may include identifiers; never print response body.
      throw new Error(method + " failed (HTTP " + response.status + ")");
    }
    return result.result;
  }
  try {
    assert.match(chatId, /^-?\\d+$/);
    assert.match(userId, /^\\d+$/);
    const me = await call("getMe", {});
    assert.equal(me.is_bot, true);
    const chat = await call("getChat", { chat_id: chatId });
    assert.ok(["channel", "supergroup", "group"].includes(chat.type));
    const botMembership = await call("getChatMember", {
      chat_id: chatId, user_id: me.id
    });
    assert.ok(["administrator", "creator"].includes(botMembership.status),
      "test bot must be an administrator of the isolated test chat");
    const membership = await call("getChatMember", {
      chat_id: chatId, user_id: Number(userId)
    });
    console.log("PASS: Telegram API reachable; bot is administrator; test member status=" +
      membership.status);
    console.log("NOTE: read-only preflight, not AUD-018 live acceptance or deployment.");
  } catch (error) {
    console.error("BLOCKED: " + (error instanceof Error ? error.message : "unknown error"));
    process.exitCode = 1;
  }
}
