import "dotenv/config";
import { createControlBot } from "./bot.js";
import { localizedCommands } from "./locale.js";
import { prisma } from "@subpilot/database";

const token = process.env.CONTROL_BOT_TOKEN;

if (!token) {
  console.warn("CONTROL_BOT_TOKEN is empty. Central bot was not started.");
} else {
  const bot = createControlBot(token);

  process.once("SIGINT", () => {
    bot.stop();
    void prisma.$disconnect();
  });

  process.once("SIGTERM", () => {
    bot.stop();
    void prisma.$disconnect();
  });

  await bot.api.setMyCommands(localizedCommands("ru"));
  await bot.api.setMyCommands(localizedCommands("en"), { language_code: "en" });

  console.info("SubPilot control bot is starting...");
  await bot.start({
    onStart: (botInfo) => {
      console.info(`SubPilot control bot started: @${botInfo.username}`);
    }
  });
}
