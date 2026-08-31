import { existsSync } from "fs";
import { join } from "path";

/**
 * ffmpeg / ffprobe binary path resolution — allows commands to target the bundled binary,
 * supporting Electron packaging.
 *
 * Development: uses installed bundled binaries when available, then falls back to `ffmpeg` /
 * `ffprobe` on the system PATH.
 * Electron package: the main process injects the absolute paths extracted from ffmpeg-static /
 * @ffprobe-installer into FFMPEG_PATH / FFPROBE_PATH, so users don't need to install ffmpeg themselves.
 *
 * Note: return values are interpolated into shell command strings; paths may contain spaces —
 * callers must wrap them in double quotes.
 */

/** Path to the ffmpeg executable (callers must quote it if it contains spaces) */
export function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** Path to the ffprobe executable (callers must quote it if it contains spaces) */
export function ffprobeBin(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    // Resolve the optional platform binary by path instead of importing its .exe. This keeps
    // Turbopack from treating the executable as a JavaScript module during Next builds.
    const binary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
    const bundled = join(process.cwd(), "node_modules", "@ffprobe-installer", `${process.platform}-${process.arch}`, binary);
    if (existsSync(bundled)) return bundled;
  } catch {
    // Fall through to the historical system PATH lookup.
  }
  return "ffprobe";
}
