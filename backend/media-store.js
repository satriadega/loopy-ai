import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static") || "ffmpeg";
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    return "ffmpeg";
  }
}

export async function saveMedia({ url, format, id, outputDir }) {
  const filename = id + (format === "gif" ? ".gif" : ".mp4");
  const workDir = path.join(outputDir, ".tmp", id);
  const input = path.join(workDir, "source.mp4");
  const output = path.join(workDir, filename);

  await mkdir(workDir, { recursive: true });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) {
      throw new Error(`Download from LTX-Video failed (HTTP ${response.status}).`);
    }
    await pipeline(response.body, createWriteStream(input));

    if (format === "gif") {
      await run(ffmpegPath(), [
        "-nostdin", "-v", "error", "-i", input,
        "-filter_complex_threads", "1",
        "-filter_complex",
        "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-loop", "0", output,
      ], { timeout: 60_000 });
    }

    await rename(format === "gif" ? output : input, path.join(outputDir, filename));
    return filename;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(console.error);
  }
}

export async function deleteMedia({ outputDir, variations }, saveHistory) {
  const filenames = new Set(variations.map(({ url }) => {
    const match = /^\/outputs\/([\w-]+\.(?:gif|mp4))$/.exec(url);
    if (!match) throw new Error("Invalid saved media URL.");
    return match[1];
  }));
  if (!filenames.size) return saveHistory();

  const temporaryDir = path.join(outputDir, ".tmp");
  await mkdir(temporaryDir, { recursive: true });
  const workDir = await mkdtemp(path.join(temporaryDir, "delete-"));
  const movedFiles = [];
  let removeWorkDir = true;
  try {
    for (const filename of filenames) {
      try {
        await rename(path.join(outputDir, filename), path.join(workDir, filename));
        movedFiles.push(filename);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return await saveHistory();
  } catch (error) {
    const restored = await Promise.allSettled(movedFiles.map((filename) =>
      rename(path.join(workDir, filename), path.join(outputDir, filename))));
    for (const result of restored) {
      if (result.status === "rejected") {
        removeWorkDir = false;
        console.error(result.reason);
      }
    }
    throw error;
  } finally {
    if (removeWorkDir) await rm(workDir, { recursive: true, force: true }).catch(console.error);
  }
}
