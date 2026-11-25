import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, FFMPEG, createSticker, createSoundSticker, inspectSticker, probe } from "../src/media.js";

const dir = mkdtempSync(join(tmpdir(), "stk-test-"));
const clip = join(dir, "clip.mp4");
const photo = join(dir, "photo.png");

test.before(async () => {
  await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", clip]);
  await run(FFMPEG, ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=300x500", "-frames:v", "1", photo]);
});

test("static image becomes a valid static sticker", async () => {
  const r = await createSticker({ source: photo, caption: "hola", outDir: dir });
  assert.equal(r.animated, false);
  const v = await inspectSticker(r.path);
  assert.equal(v.valid, true, v.issues.join());
  assert.equal(v.width, 512);
});

test("video becomes a valid animated sticker under 500 KB", async () => {
  const r = await createSticker({ source: clip, start: 0.5, duration: 3, outDir: dir });
  assert.equal(r.animated, true);
  const v = await inspectSticker(r.path);
  assert.equal(v.valid, true, v.issues.join());
  assert.ok(v.bytes <= 500 * 1024);
});

test("sound sticker returns webp + opus + mp4 with audio", async () => {
  const r = await createSoundSticker({ source: clip, duration: 3, caption: "beep", outDir: dir });
  assert.equal((await inspectSticker(r.sticker.path)).valid, true);
  const a = await probe(r.audio.path);
  assert.ok(a.hasAudio && a.duration > 2.5);
  const m = await probe(r.video.path);
  assert.ok(m.hasAudio && m.hasVideo);
  assert.equal(m.width, 512);
});

test("separate audio over a still image", async () => {
  const r = await createSoundSticker({ source: photo, audio: clip, duration: 2, outDir: dir });
  const m = await probe(r.video.path);
  assert.ok(m.hasAudio && m.hasVideo && m.duration > 1.5);
});

test("errors are clear", async () => {
  await assert.rejects(createSticker({ source: join(dir, "nope.png") }), /File not found/);
  await assert.rejects(createSoundSticker({ source: photo, outDir: dir }), /No audio found/);
});
