# sticker-sound-mcp

MCP server that makes WhatsApp stickers from images, GIFs and videos, including "sticker with sound". Free, local, only needs Node 20+ and ffmpeg.

WhatsApp now has **native sound stickers** (Android beta 2.26.47.1+, gradual rollout; sources: [WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-new-sound-sticker-messages-on-android/), [TN](https://tn.com.ar/tecno/aplicaciones/2026/11/25/como-hacer-stickers-con-audio-para-whatsapp-paso-a-paso/)). They are created inside the app (sticker keyboard > Create sticker > pick a video > audio button; up to 5 s of original audio or 10 s of imported audio). The format has no public spec, so this server cannot generate one directly. Use `prepare_native_sound_sticker` to get the clip ready, then finish in the app.

For accounts without the feature, `create_sound_sticker` gives a fallback of three files:

1. `.webp` sticker (512x512, auto-shrunk under WhatsApp's limits: 100 KB static, 500 KB animated, max 10 s)
2. `.ogg` Opus clip with the sound (send it right after the sticker, it plays as a voice note)
3. `.mp4` 512x512 video where picture and sound play together

## Tools

| Tool | What it does |
| --- | --- |
| `create_sticker` | Image/GIF/video to WebP sticker. Optional caption, `contain` or `cover` fit, start and duration. |
| `prepare_native_sound_sticker` | Prepares a 512x512 clip (max 5 s with original audio, 10 s with separate audio) for the in-app native sound sticker flow. |
| `create_sound_sticker` | Same, plus the `.ogg` and `.mp4`. Sound comes from the video, or from a separate `audio` file/URL. |
| `inspect_sticker` | Validates a `.webp` against the WhatsApp rules above. |

Sources can be local paths or http(s) URLs (100 MB cap).

## Install

```bash
git clone https://github.com/FranprzDev/sticker-sound-mcp && cd sticker-sound-mcp
npm install
```

MCP client config:

```json
{
  "mcpServers": {
    "sticker-sound": {
      "command": "node",
      "args": ["/absolute/path/sticker-sound-mcp/src/server.js"],
      "env": { "STICKER_OUT_DIR": "/home/you/stickers" }
    }
  }
}
```

Env vars: `STICKER_OUT_DIR` (default `~/stickers`), `FFMPEG_PATH`, `FFPROBE_PATH`, `STICKER_FONT` (a .ttf for captions; DejaVu, Liberation and Arial are found automatically). ffmpeg needs `libwebp`, `libopus`, `libx264` (standard builds have them).

## Test

```bash
npm test
```
Tests generate their own media with ffmpeg and check real outputs. No network, no API keys.
