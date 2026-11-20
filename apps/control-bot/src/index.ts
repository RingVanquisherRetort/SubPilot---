import "dotenv/config";
import { createControlBot } from "./bot.js";
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

  await bot.api.setMyCommands([
    { command: "start", description: "Открыть главное меню SubPilot" },
    { command: "help", description: "Помощь по интерфейсу" },
    { command: "testnotifications", description: "Отправить тестовые уведомления себе" }
  ]);

  console.info("SubPilot control bot is starting...");
  await bot.start({
    onStart: (botInfo) => {
      console.info(`SubPilot control bot started: @${botInfo.username}`);
    }
  });
}
