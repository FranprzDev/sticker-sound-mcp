import { spawn } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, extname, basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
export const OUT_DIR = resolve(process.env.STICKER_OUT_DIR || join(homedir(), "stickers"));

// WhatsApp limits: 512x512 WebP, animated <= 500 KB and <= 10 s, static <= 100 KB.
export const LIMITS = { size: 512, animatedBytes: 500 * 1024, staticBytes: 100 * 1024, maxSeconds: 10 };
const MAX_DOWNLOAD = 100 * 1024 * 1024;

export function run(cmd, args, { timeoutMs = 120000 } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { p.kill("SIGKILL"); rej(new Error(`${cmd} timed out`)); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", (e) => { clearTimeout(t); rej(new Error(e.code === "ENOENT" ? `${cmd} not found. Install ffmpeg or set FFMPEG_PATH.` : e.message)); });
    p.on("close", (code) => { clearTimeout(t); code === 0 ? res({ out, err }) : rej(new Error(`${cmd} failed (${code}): ${err.split("\n").slice(-6).join("\n")}`)); });
  });
}

/** Resolve a local path or http(s) URL to a local file. Returns { path, cleanup }. */
export async function fetchSource(src) {
  if (/^https?:\/\//i.test(src)) {
    const dir = await mkdtemp(join(tmpdir(), "stk-"));
    const res = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_DOWNLOAD) throw new Error("Source is larger than 100 MB");
    let ext = extname(new URL(src).pathname).slice(0, 6).replace(/[^.\w]/g, "");
    const path = join(dir, "source" + (ext || ".bin"));
    let n = 0;
    const body = Readable.fromWeb(res.body);
    body.on("data", (c) => { n += c.length; if (n > MAX_DOWNLOAD) body.destroy(new Error("Source is larger than 100 MB")); });
    await pipeline(body, createWriteStream(path));
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }
  const path = resolve(src.replace(/^file:\/\//, ""));
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`File not found: ${path}`);
  return { path, cleanup: async () => {} };
}

export async function probe(path) {
  const { out } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1) || (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  return {
    hasVideo: !!v, hasAudio: !!a,
    width: v?.width, height: v?.height, codec: v?.codec_name,
    duration: Number(j.format?.duration) || 0,
    frames: Number(v?.nb_frames) || 0,
    format: j.format?.format_name,
    size: Number(j.format?.size) || 0,
  };
}

const FONT_CANDIDATES = [
  process.env.STICKER_FONT,
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
].filter(Boolean);

function findFont() {
  const f = FONT_CANDIDATES.find((p) => existsSync(p));
  if (!f) throw new Error("No font found for captions. Set STICKER_FONT to a .ttf path.");
  return f;
}

const esc = (s) => s.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function slug(s) {
  return basename(s).replace(/\.[^.]*$/, "").replace(/[^\w-]+/g, "_").slice(0, 40) || "sticker";
}

/** Build the video filter chain for a 512x512 transparent-padded sticker frame. */
function frameFilter({ fit, fps, captionFile, animated }) {
  const S = LIMITS.size;
  const scale = fit === "cover"
    ? `scale=${S}:${S}:force_original_aspect_ratio=increase,crop=${S}:${S}`
    : `scale=${S}:${S}:force_original_aspect_ratio=decrease,format=rgba,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  const parts = [];
  if (animated) parts.push(`fps=${fps}`);
  parts.push(scale, "format=rgba");
  if (captionFile) {
    parts.push(
      `drawtext=fontfile='${esc(findFont())}':textfile='${esc(captionFile)}':fontcolor=white:borderw=4:bordercolor=black:fontsize=44:x=(w-text_w)/2:y=h-text_h-24`
    );
  }
  return parts.join(",");
}

async function encodeWebp({ input, out, start, duration, fit, captionFile, animated, still }) {
  const ladder = animated
    ? [{ fps: 15, q: 60 }, { fps: 15, q: 45 }, { fps: 12, q: 40 }, { fps: 10, q: 32 }, { fps: 8, q: 25 }, { fps: 6, q: 15 }]
    : [{ q: 75 }, { q: 55 }, { q: 40 }, { q: 25 }, { q: 10 }];
  const limit = animated ? LIMITS.animatedBytes : LIMITS.staticBytes;
  let last;
  for (const step of ladder) {
    const args = ["-y", "-v", "error"];
    if (start) args.push("-ss", String(start));
    if (animated) args.push("-t", String(duration));
    args.push("-i", input, "-an", "-vf", frameFilter({ fit, fps: step.fps, captionFile, animated }));
    if (animated) args.push("-c:v", "libwebp_anim", "-loop", "0", "-q:v", String(step.q), "-compression_level", "6", "-pix_fmt", "yuva420p");
    else args.push("-frames:v", "1", "-c:v", "libwebp", "-q:v", String(step.q), "-compression_level", "6");
    args.push(out);
    await run(FFMPEG, args);
    last = statSync(out).size;
    if (last <= limit) return { bytes: last, fps: step.fps, quality: step.q };
  }
  throw new Error(`Could not fit the sticker under ${Math.round(limit / 1024)} KB (got ${Math.round(last / 1024)} KB). Use a shorter clip.`);
}

async function makeCaptionFile(caption) {
  if (!caption) return { file: null, cleanup: async () => {} };
  const dir = await mkdtemp(join(tmpdir(), "stkc-"));
  const file = join(dir, "caption.txt");
  await writeFile(file, caption.slice(0, 80));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Create a WhatsApp-compliant WebP sticker. */
export async function createSticker({ source, start = 0, duration = 6, caption, fit = "contain", name, outDir = OUT_DIR }) {
  const src = await fetchSource(source);
  const cap = await makeCaptionFile(caption);
  try {
    const info = await probe(src.path);
    if (!info.hasVideo) throw new Error("Source has no image or video stream.");
    const dur = Math.min(Math.max(duration, 0.5), LIMITS.maxSeconds);
    const isMoving = info.duration > 0.2 && (info.frames === 0 || info.frames > 1);
    const animated = isMoving && !/^(image2|png_pipe|jpeg_pipe|webp_pipe)$/.test(info.format || "") ? true : (info.format || "").includes("gif");
    await mkdir(outDir, { recursive: true });
    const out = join(outDir, `${name ? slug(name) : slug(source)}-${Date.now().toString(36)}.webp`);
    const meta = await encodeWebp({ input: src.path, out, start, duration: dur, fit, captionFile: cap.file, animated });
    return { path: out, animated, durationSeconds: animated ? Math.min(dur, Math.max(info.duration - start, 0.1)) : 0, ...meta };
  } finally {
    await src.cleanup(); await cap.cleanup();
  }
}

/**
 * WhatsApp stickers cannot carry audio. A "sound sticker" is therefore three files:
 * the WebP sticker, an Opus .ogg clip (sends as a voice note), and a 512x512 MP4 with the sound.
 */
export async function createSoundSticker({ source, audio, start = 0, duration = 6, audioStart, caption, fit = "contain", name, outDir = OUT_DIR }) {
  const src = await fetchSource(source);
  const aud = audio ? await fetchSource(audio) : null;
  const cap = await makeCaptionFile(caption);
  try {
    const vInfo = await probe(src.path);
    if (!vInfo.hasVideo) throw new Error("Source has no image or video stream.");
    const audioPath = aud ? aud.path : src.path;
    const aInfo = aud ? await probe(aud.path) : vInfo;
    if (!aInfo.hasAudio) throw new Error("No audio found. Pass `audio` (file or URL) or use a video that has sound.");
    const dur = Math.min(Math.max(duration, 0.5), LIMITS.maxSeconds);
    const aStart = audioStart ?? (aud ? 0 : start);
    await mkdir(outDir, { recursive: true });
    const base = join(outDir, `${name ? slug(name) : slug(source)}-${Date.now().toString(36)}`);

    const sticker = await createSticker({ source: src.path, start, duration: dur, caption, fit, name: basename(base), outDir });

    const ogg = `${base}.ogg`;
    await run(FFMPEG, ["-y", "-v", "error", "-ss", String(aStart), "-t", String(dur), "-i", audioPath, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", ogg]);

    const mp4 = `${base}.mp4`;
    const isStill = !(vInfo.duration > 0.2 && (vInfo.frames === 0 || vInfo.frames > 1));
    const vArgs = ["-y", "-v", "error"];
    if (isStill) vArgs.push("-loop", "1", "-t", String(dur), "-i", src.path);
    else vArgs.push("-ss", String(start), "-t", String(dur), "-stream_loop", "-1", "-i", src.path);
    vArgs.push("-ss", String(aStart), "-t", String(dur), "-i", audioPath);
    const vf = frameFilter({ fit: "contain", fps: 24, captionFile: cap.file, animated: false }).replace("format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000", "pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black");
    vArgs.push("-map", "0:v:0", "-map", "1:a:0", "-vf", vf.replace(/format=rgba/g, "format=yuv420p"), "-t", String(dur), "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "1", "-shortest", "-movflags", "+faststart", mp4);
    await run(FFMPEG, vArgs);
    return { sticker, audio: { path: ogg, bytes: statSync(ogg).size }, video: { path: mp4, bytes: statSync(mp4).size }, durationSeconds: dur };
  } finally {
    await src.cleanup(); if (aud) await aud.cleanup(); await cap.cleanup();
  }
}

/** Parse a WebP RIFF container: canvas size, animation flag, frame count and total duration (ms). */
export function parseWebp(buf) {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const out = { width: 0, height: 0, animated: false, frames: 0, durationMs: 0 };
  let off = 12;
  while (off + 8 <= buf.length) {
    const tag = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const d = off + 8;
    if (tag === "VP8X") {
      out.animated = (buf[d] & 0x02) !== 0;
      out.width = 1 + buf.readUIntLE(d + 4, 3);
      out.height = 1 + buf.readUIntLE(d + 7, 3);
    } else if (tag === "ANMF") {
      out.frames++;
      out.durationMs += buf.readUIntLE(d + 12, 3);
    } else if (tag === "VP8 " && !out.width) {
      out.width = buf.readUInt16LE(d + 6) & 0x3fff; out.height = buf.readUInt16LE(d + 8) & 0x3fff;
    } else if (tag === "VP8L" && !out.width) {
      const b = buf.readUInt32LE(d + 1);
      out.width = (b & 0x3fff) + 1; out.height = ((b >> 14) & 0x3fff) + 1;
    }
    off = d + size + (size & 1);
  }
  return out;
}

/** Check a WebP file against WhatsApp's sticker rules. */
export async function inspectSticker(path) {
  const p = resolve(path);
  if (!existsSync(p)) throw new Error(`File not found: ${p}`);
  const buf = await readFile(p);
  const w = parseWebp(buf);
  const issues = [];
  if (!w) return { path: p, valid: false, issues: ["Not a WebP file."] };
  const bytes = buf.length;
  const limit = w.animated ? LIMITS.animatedBytes : LIMITS.staticBytes;
  if (w.width !== 512 || w.height !== 512) issues.push(`Size is ${w.width}x${w.height}, WhatsApp needs 512x512.`);
  if (bytes > limit) issues.push(`File is ${Math.round(bytes / 1024)} KB, limit is ${Math.round(limit / 1024)} KB.`);
  const seconds = w.durationMs / 1000;
  if (w.animated && seconds > LIMITS.maxSeconds + 0.05) issues.push(`Animation is ${seconds.toFixed(1)} s, limit is 10 s.`);
  return { path: p, valid: issues.length === 0, animated: w.animated, width: w.width, height: w.height, bytes, frames: w.frames, durationSeconds: seconds, issues };
}
