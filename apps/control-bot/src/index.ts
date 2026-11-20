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
    { command: "start", description: "Start using SubPilot" },
    { command: "newproject", description: "Create a project" },
    { command: "projects", description: "List projects in the active workspace" },
    { command: "createagency", description: "Create an agency workspace" },
    { command: "workspaces", description: "List your workspaces" },
    { command: "switchworkspace", description: "Switch active workspace" },
    { command: "renameproject", description: "Rename a project" },
    { command: "archiveproject", description: "Archive a project" },
    { command: "connectbot", description: "Connect a bot to a project" },
    { command: "cancel", description: "Cancel the current operation" },
    { command: "help", description: "Show available commands" }
  ]);

  console.info("SubPilot control bot is starting...");
  await bot.start({
    onStart: (botInfo) => {
      console.info(`SubPilot control bot started: @${botInfo.username}`);
    }
  });
}
