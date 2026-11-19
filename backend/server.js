import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const configuredInterval = Number(process.env.WALLPAPER_INTERVAL_SECONDS);
const maxTimerSeconds = Math.floor(2_147_483_647 / 1000);
const wallpaperIntervalSeconds = Number.isInteger(configuredInterval) && configuredInterval > 0
  && configuredInterval <= maxTimerSeconds ? configuredInterval : undefined;

const app = createApp({
  dataDir: fileURLToPath(new URL("./data/", import.meta.url)),
  outputDir: fileURLToPath(new URL("./outputs/", import.meta.url)),
  frontendDir: fileURLToPath(new URL("../frontend/dist/", import.meta.url)),
  wallpaperIntervalSeconds,
});

const host = process.env.HOST || "127.0.0.1";

app.listen(3001, host, () => {
  console.log(`Loopy API is listening at http://${host}:3001`);
});
