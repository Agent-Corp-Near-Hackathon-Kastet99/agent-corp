import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Run = (cmd: string, args: string[]) => Promise<void>;
const defaultRun: Run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", d => { err += String(d); if (err.length > 2000) err = err.slice(-2000); });
  p.on("error", reject);
  p.on("close", code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-300)}`)));
});

/** Two cuts of a recorded gameplay clip with local FFmpeg (args array, no shell): 16:9 master and 9:16 centre crop. */
export async function cutClip(input: string, outDir: string, run: Run = defaultRun) {
  if (!existsSync(input)) throw new Error("clip: input file not found");
  mkdirSync(outDir, { recursive: true });
  const wide = join(outDir, "clip-16x9.mp4");
  const tall = join(outDir, "clip-9x16.mp4");
  const common = ["-y", "-i", input, "-t", "30", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  await run("ffmpeg", [...common, "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2", wide]);
  await run("ffmpeg", [...common, "-vf", "crop=ih*9/16:ih,scale=720:1280", tall]);
  return { wide, tall };
}
