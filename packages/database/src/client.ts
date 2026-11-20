import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

// pnpm runs workspace scripts from each package directory.
// Load the repository-root .env explicitly so apps share the same config.
const packageDirectory = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(packageDirectory, "../../../.env") });

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to initialize the database client.");
}

const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
