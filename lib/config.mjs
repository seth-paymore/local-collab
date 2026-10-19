import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(process.env.LOCAL_COLLAB_CONFIG ?? join(APP_DIR, "local-collab.config.json"));
const local = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const ac = local.activeCollab ?? {};
const number = (value, name) => {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${name}`);
  return Number(value);
};
export const config = {
  notesDir: resolve(process.env.LOCAL_COLLAB_NOTES ?? local.notesDir ?? join(homedir(), ".local-collab", "notes")),
  port: number(process.env.LOCAL_COLLAB_PORT ?? local.port ?? 4317, "port"),
  author: process.env.LOCAL_COLLAB_AUTHOR ?? local.author ?? "Human",
  activeCollab: {
    accountId: process.env.ACTIVECOLLAB_ACCOUNT_ID ?? ac.accountId,
    projectId: process.env.ACTIVECOLLAB_PROJECT_ID ?? ac.projectId,
    userId: process.env.ACTIVECOLLAB_USER_ID ?? ac.userId,
    tokenFile: process.env.ACTIVECOLLAB_TOKEN_FILE ?? ac.tokenFile,
  },
};
if (config.port > 65535) throw new Error("Invalid port");
if (typeof config.author !== "string" || !/^[A-Za-z][\w .-]{0,39}$/.test(config.author)) throw new Error("Invalid default author");
const settings = config.activeCollab;
settings.enabled = [settings.accountId, settings.projectId, settings.userId].some(v => v !== undefined);
if (settings.enabled) {
  for (const key of ["accountId", "projectId", "userId"]) settings[key] = number(settings[key], `ActiveCollab ${key}`);
}
export const publicConfig = () => ({author:config.author, activeCollabEnabled:settings.enabled});
