#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSticker, createSoundSticker, inspectSticker } from "./media.js";

const server = new McpServer({ name: "sticker-sound-mcp", version: "0.1.0" });

const source = z.string().min(1).describe("Local file path or http(s) URL of an image, GIF or video.");
const common = {
  start: z.number().min(0).default(0).describe("Start offset in seconds for videos/GIFs."),
  duration: z.number().min(0.5).max(10).default(6).describe("Clip length in seconds (max 10, WhatsApp limit)."),
  caption: z.string().max(80).optional().describe("Optional text burned into the bottom of the sticker."),
  fit: z.enum(["contain", "cover"]).default("contain").describe("contain keeps the whole frame with transparent padding; cover crops to fill 512x512."),
  name: z.string().max(60).optional().describe("Base name for the output files."),
};

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

server.registerTool("create_sticker", {
  title: "Create WhatsApp sticker",
  description: "Convert an image, GIF or video into a WhatsApp-ready WebP sticker (512x512, auto-shrunk under 100 KB static / 500 KB animated). No sound: WhatsApp stickers cannot carry audio.",
  inputSchema: { source, ...common },
}, async (a) => { try { return text(await createSticker(a)); } catch (e) { return fail(e); } });

server.registerTool("create_sound_sticker", {
  title: "Create sticker with sound",
  description: "Make a sticker with audio. WhatsApp stickers cannot play sound, so this returns three files: the WebP sticker, an Opus .ogg clip (send it right after the sticker as a voice note) and a 512x512 MP4 where picture and sound play together. Sound comes from the source video, or from the `audio` file/URL.",
  inputSchema: {
    source, ...common,
    audio: z.string().optional().describe("Optional separate audio file or URL. Defaults to the source's own audio."),
    audioStart: z.number().min(0).optional().describe("Start offset in the audio. Defaults to `start` (or 0 for a separate audio)."),
  },
}, async (a) => { try { return text(await createSoundSticker(a)); } catch (e) { return fail(e); } });

server.registerTool("inspect_sticker", {
  title: "Validate a sticker",
  description: "Check a .webp file against WhatsApp sticker rules: 512x512, size limits, max 10 s.",
  inputSchema: { path: z.string().min(1).describe("Path to a .webp sticker file.") },
}, async ({ path }) => { try { return text(await inspectSticker(path)); } catch (e) { return fail(e); } });

await server.connect(new StdioServerTransport());
