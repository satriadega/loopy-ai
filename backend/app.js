import { randomInt, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createHistoryStore } from "./history-store.js";
import { generateVideo } from "./ltx-video.js";
import { deleteMedia, saveMedia } from "./media-store.js";

export function createApp({ outputDir, dataDir, frontendDir, wallpaperIntervalSeconds = 15, renderVideo = generateVideo }) {
  const app = express();
  const history = createHistoryStore(dataDir);
  const activeSessions = new Set();
  let generationRequests = 0;
  let deletingPrompt = false;

  app.use(express.json());

  app.get("/api/config", (_req, res) => {
    res.json({ wallpaperIntervalSeconds });
  });

  app.get("/api/history", async (_req, res) => {
    res.json(await history.list());
  });

  app.delete("/api/history", async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Choose a prompt to delete." });
    }
    if (deletingPrompt || generationRequests) {
      return res.status(409).json({ error: "Wait for generation or deletion to finish before deleting a prompt." });
    }

    deletingPrompt = true;
    try {
      const sessions = (await history.list()).filter((session) => session.prompt === prompt);
      if (!sessions.length) return res.status(404).json({ error: "Prompt not found in history." });

      const variations = sessions.flatMap((session) => session.variations);
      const remaining = await deleteMedia({ outputDir, variations }, () => history.deletePrompt(prompt));
      return res.json(remaining);
    } finally {
      deletingPrompt = false;
    }
  });

  app.post("/api/generate", async (req, res) => {
    if (deletingPrompt) {
      return res.status(409).json({ error: "Wait for prompt deletion to finish before generating." });
    }

    generationRequests++;
    try {
      return await generate(req, res);
    } finally {
      generationRequests--;
    }
  });

  async function generate(req, res) {
    const { sessionId, prompt, format } = req.body ?? {};
    let session;
    if (sessionId !== undefined) {
      session = (await history.list()).find(({ id }) => id === sessionId);
      if (!session) return res.status(404).json({ error: "Generation session not found." });
      if (activeSessions.has(session.id)) {
        return res.status(409).json({ error: "A variation is already being generated for this session." });
      }
    } else {
      if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 2000) {
        return res.status(400).json({ error: "The prompt must be between 1 and 2,000 characters." });
      }
      if (format !== "gif" && format !== "video") {
        return res.status(400).json({ error: "Choose GIF or MP4." });
      }
      session = { id: randomUUID(), prompt: prompt.trim(), format };
    }

    activeSessions.add(session.id);
    try {
      const usedSeeds = new Set(session.variations?.map(({ seed }) => seed));
      let seed;
      do {
        seed = randomInt(2 ** 32);
      } while (usedSeeds.has(seed));

      let video;
      try {
        video = await renderVideo({ prompt: session.prompt, format: session.format, seed });
      } catch (error) {
        const detail = String(error?.message ?? error);
        console.error("LTX-Video:", detail);
        const accessUnavailable = [401, 403, 429].includes(error?.status)
          || /quota|zero.?gpu|rate limit|too many requests|not authorized|unauthori[sz]ed|forbidden|authentication|(?:invalid|expired) (?:access )?token|HTTP\s+(?:401|403|429)\b/i.test(detail);
        return res.status(accessUnavailable ? 429 : 502).json({ error: accessUnavailable
          ? "The Hugging Face Space quota has been reached or authentication is required. Try again later or set HF_TOKEN on the server."
          : "LTX-Video could not generate the video. Try again in a moment." });
      }

      const id = randomUUID();
      const filename = await saveMedia({ url: video.url, format: session.format, id, outputDir });
      try {
        const variation = { id, url: "/outputs/" + filename, seed: video.seed };
        const savedSession = await history.saveVariation({
          id: session.id, prompt: session.prompt, format: session.format,
        }, variation);
        return res.status(201).json(savedSession);
      } catch (error) {
        await rm(path.join(outputDir, filename), { force: true }).catch(console.error);
        throw error;
      }
    } finally {
      activeSessions.delete(session.id);
    }
  }

  app.use("/outputs", express.static(outputDir, { index: false, redirect: false }));
  app.use(express.static(frontendDir));
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed") {
      return res.status(400).json({ error: "The request body contains invalid JSON." });
    }
    console.error(error);
    return res.status(500).json({ error: "The local server could not process the request." });
  });

  return app;
}
