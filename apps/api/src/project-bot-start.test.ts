import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Bot } from "grammy";
import { handleProjectBotUpdate } from "./project-bot-updates.js";

test("first private /start initializes the project bot and requests a language", async () => {
  const calls: string[] = [];
  let reply = "";
  const server = createServer(async (req, res) => {
    const method = req.url?.split("/").pop() ?? "";
    calls.push(method);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (method === "sendMessage") reply = Buffer.concat(chunks).toString();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: method === "getMe"
      ? { id: 42, first_name: "Test", is_bot: true, username: "test_bot" }
      : { message_id: 2 } }));
  });
  server.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bot = new Bot("42:test", { client: { apiRoot: `http://127.0.0.1:${address.port}` } });
    await handleProjectBotUpdate("42:test", "project", "bot", { update_id: 1, message: {
      message_id: 1, date: 1, chat: { type: "private", id: 7, first_name: "Buyer" },
      from: { id: 7, first_name: "Buyer", is_bot: false }, text: "/start",
      entities: [{ offset: 0, length: 6, type: "bot_command" }]
    } }, 1, 0, bot);
    assert.deepEqual(calls, ["getMe", "sendMessage"]);
    assert.match(reply, /buyer:locale:ru/);
    assert.match(reply, /buyer:locale:en/);
    assert.doesNotMatch(reply, /buyer:plans/);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
