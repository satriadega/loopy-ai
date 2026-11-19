import { Client } from "@gradio/client";

export async function generateVideo({ prompt, format, seed }) {
  const token = process.env.HF_TOKEN;
  const client = await Client.connect("Lightricks/ltx-video-distilled", token ? { token } : {});
  const shortLoop = format === "gif";

  const { data: [media, usedSeed] } = await client.predict("/text_to_video", {
    prompt,
    negative_prompt: "worst quality, inconsistent motion, blurry, jittery, distorted",
    input_image_filepath: null,
    input_video_filepath: null,
    mode: "text-to-video",
    height_ui: shortLoop ? 384 : 480,
    width_ui: shortLoop ? 512 : 704,
    duration_ui: shortLoop ? 2 : 3,
    seed_ui: seed,
    randomize_seed: false,
  });

  const url = media?.video?.url;
  if (typeof url !== "string" || !Number.isInteger(usedSeed)) {
    throw new Error("The LTX-Video response is missing a video URL or a valid seed.");
  }
  return { url, seed: usedSeed };
}
