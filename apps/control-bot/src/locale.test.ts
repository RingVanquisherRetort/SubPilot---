import { test } from "node:test";
import assert from "node:assert/strict";
import { localizedCommands, resolveLocale, translate } from "./locale.js";

test("locale resolution supports English variants and Russian fallback", () => {
  for (const value of ["en", "EN-us", " en_GB "]) assert.equal(resolveLocale(value), "en");
  for (const value of [undefined, null, "", "ru-RU", "th", "fr"]) assert.equal(resolveLocale(value), "ru");
});

test("localized command catalogues preserve identifiers and Telegram limits", () => {
  const ru = localizedCommands("ru");
  const en = localizedCommands("en");
  assert.deepEqual(ru.map(x => x.command), en.map(x => x.command));
  assert.equal(new Set(ru.map(x => x.command)).size, ru.length);
  for (const item of [...ru, ...en]) {
    assert.match(item.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(item.description.length >= 1 && item.description.length <= 256);
  }
  assert.notEqual(translate("ru", "start"), translate("en", "start"));
});
