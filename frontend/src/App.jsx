import { useCallback, useEffect, useRef, useState } from "react";

const formats = [
  { value: "gif", label: "GIF", description: "Loop · about 2 seconds" },
  { value: "video", label: "MP4", description: "Video · about 3 seconds" },
];

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || "Could not reach the local server.");
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [format, setFormat] = useState("gif");
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [index, setIndex] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [wallpaperIntervalSeconds, setWallpaperIntervalSeconds] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [deletingPrompt, setDeletingPrompt] = useState(false);
  const [error, setError] = useState("");
  const [liveWallpaper, setLiveWallpaper] = useState(null);
  const [pendingPreview, setPendingPreview] = useState(null);
  const [retryDelay, setRetryDelay] = useState(0);
  const previewRef = useRef(null);
  const previewInfoRef = useRef(null);
  const lastSavedWallpaperId = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState("");
  const [showInlineInfo, setShowInlineInfo] = useState(true);
  const [showFullscreenInfo, setShowFullscreenInfo] = useState(false);

  const session = sessions.find(({ id }) => id === sessionId);
  const slide = session?.variations[index];
  const showPreviewInfo = isFullscreen ? showFullscreenInfo : showInlineInfo;
  const busy = historyLoading || generating || deletingPrompt || Boolean(liveWallpaper);
  const hasSavedWallpapers = sessions.some((entry) => entry.variations.length > 0);
  const playingSavedWallpapers = Boolean(liveWallpaper && hasSavedWallpapers);

  useEffect(() => {
    const controller = new AbortController();
    request("/api/config", { signal: controller.signal })
      .then((config) => setWallpaperIntervalSeconds(config.wallpaperIntervalSeconds))
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    request("/api/history", { signal: controller.signal })
      .then((history) => {
        setSessions(history);
        if (history.length) {
          setSessionId(history[0].id);
          setIndex(history[0].variations.length - 1);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function syncFullscreen() {
      const fullscreen = document.fullscreenElement === previewRef.current;
      setIsFullscreen(fullscreen);
      if (fullscreen) previewInfoRef.current?.focus({ preventScroll: true });
      else setShowFullscreenInfo(false);
      setFullscreenError("");
    }

    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  function togglePreviewInfo() {
    const setInfoVisibility = isFullscreen ? setShowFullscreenInfo : setShowInlineInfo;
    setInfoVisibility((visible) => !visible);
  }

  async function toggleFullscreen() {
    const preview = previewRef.current;
    if (!preview) return;

    setFullscreenError("");
    const exiting = document.fullscreenElement === preview;
    try {
      if (exiting) {
        await document.exitFullscreen();
      } else {
        await preview.requestFullscreen();
      }
    } catch {
      setFullscreenError(exiting
        ? "Could not exit fullscreen."
        : "Could not open the preview in fullscreen.");
    }
  }

  function openSession(id) {
    const selected = sessions.find((entry) => entry.id === id);
    if (!selected) return;
    setSessionId(id);
    setIndex(selected.variations.length - 1);
  }

  async function deletePrompt() {
    if (!session || busy) return;
    if (!window.confirm(`Delete all saved GIFs and videos for this prompt?\n\n${session.prompt}`)) return;

    setDeletingPrompt(true);
    setError("");
    try {
      const history = await request("/api/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: session.prompt }),
      });
      const first = history[0];
      setSessions(history);
      setSessionId(first?.id ?? null);
      setIndex(first ? first.variations.length - 1 : 0);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setDeletingPrompt(false);
    }
  }

  const generateMedia = useCallback(async (input, liveRun) => {
    if (liveRun?.controller.signal.aborted) return;

    setGenerating(true);
    setError("");
    setRetryDelay(0);

    try {
      const result = await request("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setSessions((previous) => previous.some((entry) => entry.id === result.id)
        ? previous.map((entry) => entry.id === result.id ? result : entry)
        : [result, ...previous]);

      const nextIndex = result.variations.length - 1;
      if (liveRun) {
        if (liveRun.controller.signal.aborted) return;
        setPendingPreview({ session: result, index: nextIndex });
      } else {
        setSessionId(result.id);
        setIndex(nextIndex);
      }
    } catch (failure) {
      if (liveRun?.controller.signal.aborted) return;
      setError(failure.message);
      if (liveRun) {
        if (failure.status === 429) {
          setLiveWallpaper({ ...liveRun, generationUnavailable: true });
        } else if (!failure.status || failure.status === 409 || failure.status >= 500) {
          setRetryDelay(wallpaperIntervalSeconds);
        } else {
          setLiveWallpaper(null);
        }
      }
    } finally {
      setGenerating(false);
    }
  }, [wallpaperIntervalSeconds]);

  useEffect(() => {
    if (!liveWallpaper?.input || liveWallpaper.generationUnavailable || playingSavedWallpapers || generating) return;
    const timer = window.setTimeout(() => {
      void generateMedia(liveWallpaper.input, liveWallpaper);
    }, retryDelay * 1000);
    return () => window.clearTimeout(timer);
  }, [generateMedia, generating, liveWallpaper, playingSavedWallpapers, retryDelay]);

  useEffect(() => {
    if (!playingSavedWallpapers || pendingPreview) return;

    const wallpapers = sessions.flatMap((entry) =>
      entry.variations.map((variation, index) => ({ session: entry, index, id: variation.id })));
    if (!wallpapers.some(({ id }) => id !== slide?.id)) return;

    const lastId = lastSavedWallpaperId.current ?? slide?.id;
    const lastIndex = wallpapers.findIndex(({ id }) => id === lastId);
    let next = wallpapers[(lastIndex + 1) % wallpapers.length];
    if (next.id === slide?.id) next = wallpapers[(lastIndex + 2) % wallpapers.length];

    const timer = window.setTimeout(() => {
      lastSavedWallpaperId.current = next.id;
      setPendingPreview(next);
    }, (lastId ? wallpaperIntervalSeconds : 0) * 1000);
    return () => window.clearTimeout(timer);
  }, [pendingPreview, playingSavedWallpapers, sessions, slide, wallpaperIntervalSeconds]);

  function generate(variation = false) {
    if (busy || (variation ? !session : !prompt.trim())) return;
    void generateMedia(variation ? { sessionId: session.id } : { prompt, format });
  }

  function toggleLiveWallpaper() {
    if (liveWallpaper) {
      liveWallpaper.controller.abort();
      setLiveWallpaper(null);
      setPendingPreview(null);
      setRetryDelay(0);
      setError("");
      return;
    }

    if (busy || !wallpaperIntervalSeconds || (!hasSavedWallpapers && !prompt.trim())) return;
    setError("");
    lastSavedWallpaperId.current = null;
    setLiveWallpaper({
      controller: new AbortController(),
      input: hasSavedWallpapers ? null : { prompt, format },
    });
  }

  const failPendingPreview = useCallback(() => {
    setError("Could not load the next variation.");
    setPendingPreview(null);
  }, []);

  useEffect(() => {
    if (!pendingPreview) return;
    const timer = window.setTimeout(failPendingPreview, 30_000);
    return () => window.clearTimeout(timer);
  }, [failPendingPreview, pendingPreview]);

  function showPendingPreview() {
    if (!pendingPreview || !liveWallpaper || liveWallpaper.controller.signal.aborted) return;
    setSessionId(pendingPreview.session.id);
    setIndex(pendingPreview.index);
    setError("");
    setPendingPreview(null);
  }

  const previewItems = [];
  if (slide) previewItems.push({ slide, session, staging: false });
  if (pendingPreview) {
    previewItems.push({
      slide: pendingPreview.session.variations[pendingPreview.index],
      session: pendingPreview.session,
      staging: true,
    });
  }

  let liveStatus = "Generating the next variation…";
  if (pendingPreview) liveStatus = "Loading the next variation…";
  else if (playingSavedWallpapers) liveStatus = "Playing saved wallpapers.";
  else if (liveWallpaper?.generationUnavailable) liveStatus = "No saved wallpapers available.";
  else if (retryDelay) liveStatus = `Retrying in ${retryDelay} seconds…`;

  return (
    <main>
      <header className="heading">
        <div className="wordmark"><span aria-hidden="true">∞</span> Loopy</div>
        <h1>GIF &amp; Video Generator</h1>
      </header>

      <div className="workspace">
        <section className="panel composer" aria-labelledby="composer-title">
          <h2 id="composer-title">Create a new GIF or video</h2>
          <form onSubmit={(event) => { event.preventDefault(); generate(); }}>
            <label htmlFor="prompt">Prompt</label>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={2000}
              disabled={busy}
              placeholder="Example: a cartoon cat wearing glasses and typing on a laptop"
              required
            />
            <fieldset disabled={busy}>
              <legend>Format</legend>
              <div className="formats">
                {formats.map((option) => (
                  <label className="format" key={option.value}>
                    <input type="radio" name="format" value={option.value}
                      checked={format === option.value}
                      onChange={(event) => setFormat(event.target.value)} />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="primary" type="submit" disabled={busy || !prompt.trim()}>
              Generate
            </button>
          </form>

          {sessions.length > 0 && (
            <div className="history">
              <label htmlFor="history">Local history</label>
              <select id="history" value={sessionId ?? ""} disabled={busy}
                onChange={(event) => openSession(event.target.value)}>
                {!sessionId && <option value="">Select a session</option>}
                {sessions.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.format === "gif" ? "GIF" : "MP4"} · {entry.prompt.slice(0, 90)}
                  </option>
                ))}
              </select>
              <button className="delete-prompt" type="button" disabled={busy || !session} onClick={deletePrompt}>
                {deletingPrompt ? "Deleting prompt…" : "Delete prompt"}
              </button>
            </div>
          )}
        </section>

        <section className="panel results" aria-labelledby="results-title">
          <div className="result-heading">
            <h2 id="results-title">Preview</h2>
            {slide && <span className="format-label">{session.format === "gif" ? "GIF" : "MP4"}</span>}
          </div>
          <div ref={previewRef} className="preview" aria-busy={historyLoading}>
            {previewItems.map(({ slide: media, session: source, staging }) => (
              source.format === "gif" ? (
                <img
                  key={media.id}
                  className={staging ? "staged-media" : undefined}
                  src={media.url}
                  alt={staging ? "" : source.prompt}
                  aria-hidden={staging || undefined}
                  onLoad={staging ? showPendingPreview : undefined}
                  onError={staging ? failPendingPreview : undefined}
                />
              ) : (
                <video
                  key={media.id}
                  className={staging ? "staged-media" : undefined}
                  src={media.url}
                  controls={!staging && showPreviewInfo}
                  controlsList={liveWallpaper || document.fullscreenEnabled ? "nofullscreen" : undefined}
                  autoPlay muted loop playsInline preload="auto"
                  aria-hidden={staging || undefined}
                  aria-label={staging ? undefined : source.prompt}
                  onCanPlay={staging ? showPendingPreview : undefined}
                  onError={staging ? failPendingPreview : undefined}
                />
              )
            ))}
            {!slide && (
              <p className="preview-placeholder" role="status">
                {historyLoading ? "Loading history…" : "Your GIF or video will appear here."}
              </p>
            )}
            <div className="preview-controls">
              <button
                className="live-wallpaper-button"
                type="button"
                hidden={!showPreviewInfo}
                aria-pressed={Boolean(liveWallpaper)}
                disabled={!liveWallpaper && (busy || !wallpaperIntervalSeconds || (!hasSavedWallpapers && !prompt.trim()))}
                onClick={toggleLiveWallpaper}
              >
                Live Wallpaper
              </button>
              {showPreviewInfo && slide && (document.fullscreenEnabled || isFullscreen) && (
                <button type="button" onClick={toggleFullscreen}>
                  {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                </button>
              )}
              <button
                ref={previewInfoRef}
                className="preview-info-button"
                type="button"
                aria-label="Show preview information and controls"
                aria-pressed={showPreviewInfo}
                title={showPreviewInfo ? "Hide preview information and controls" : "Show preview information and controls"}
                onClick={togglePreviewInfo}
              >
                <span aria-hidden="true">ⓘ</span>
              </button>
            </div>
            {showPreviewInfo && (liveWallpaper || fullscreenError) && (
              <div className="preview-feedback">
                {liveWallpaper && <p className="status" role="status">{liveStatus}</p>}
                {liveWallpaper && error && <p className="error" role="alert">{error}</p>}
                {fullscreenError && <p className="error" role="alert">{fullscreenError}</p>}
              </div>
            )}
          </div>
          {generating && !liveWallpaper && <p className="status" role="status">Generating on Hugging Face…</p>}
          {error && !liveWallpaper && <p className="error" role="alert">{error}</p>}
          {slide && (
            <>
              <p className="result-prompt">{session.prompt}</p>
              <div className="result-meta" aria-live="polite">
                <span>Variation {index + 1} of {session.variations.length}</span>
                <span>Seed {slide.seed}</span>
              </div>
              <nav className="navigation" aria-label="Variation navigation">
                <button type="button" onClick={() => setIndex(index - 1)} disabled={busy || index === 0}>
                  ← Previous
                </button>
                <a href={slide.url} download>Download</a>
                <button type="button" onClick={() => setIndex(index + 1)}
                  disabled={busy || index === session.variations.length - 1}>
                  Next →
                </button>
              </nav>
              <button type="button" className="variation" onClick={() => generate(true)} disabled={busy}>
                Generate next variation
              </button>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
