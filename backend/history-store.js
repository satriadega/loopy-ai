import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function createHistoryStore(directory) {
  const filename = path.join(directory, "history.json");
  let pendingWrite = Promise.resolve();

  async function list() {
    try {
      return JSON.parse(await readFile(filename, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function update(change) {
    const write = pendingWrite.then(async () => {
      const { sessions, result } = change(await list());

      await mkdir(directory, { recursive: true });
      const temporaryFile = filename + ".tmp";
      try {
        await writeFile(temporaryFile, JSON.stringify(sessions, null, 2) + "\n");
        await rename(temporaryFile, filename);
      } catch (error) {
        await rm(temporaryFile, { force: true }).catch(() => {});
        throw error;
      }
      return result;
    });
    pendingWrite = write.catch(() => {});
    return write;
  }

  function saveVariation(session, variation) {
    return update((sessions) => {
      let savedSession = sessions.find(({ id }) => id === session.id);
      if (!savedSession) {
        savedSession = { ...session, variations: [] };
        sessions.unshift(savedSession);
      }
      savedSession.variations.push(variation);
      return { sessions, result: savedSession };
    });
  }

  function deletePrompt(prompt) {
    return update((sessions) => {
      const remaining = sessions.filter((session) => session.prompt !== prompt);
      return { sessions: remaining, result: remaining };
    });
  }

  return { list, saveVariation, deletePrompt };
}
