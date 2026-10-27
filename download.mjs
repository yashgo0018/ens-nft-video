#!/usr/bin/env node
// Download the animation of an ENSv2 commemorative NFT as an MP4.
//
// The NFT's animation_url is a live WebGL page, not a video file, so this
// drives headless Chrome over the DevTools protocol, steps the artwork's
// built-in capture mode through its 600-frame (10s @ 60fps) loop, and pipes
// each frame into ffmpeg. No npm dependencies: needs Node 22+, Chrome, ffmpeg.
//
// Usage:
//   node download.mjs <opensea-url | tokenId> [-o out.mp4] [--loops N] [--scale 1|2] [--transparent]

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONTRACT = "0x20262e3433306a4ff250a64d20a8e0f09b2c7f68";
const RPC_URL = process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1400;
const FPS = 60;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: node download.mjs <opensea-url | tokenId> [-o out.mp4] [--loops N] [--scale 1|2] [--transparent]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { loops: 1, scale: 1, transparent: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "--loops") opts.loops = Number(argv[++i]);
    else if (a === "--scale") opts.scale = Number(argv[++i]);
    else if (a === "--transparent") opts.transparent = true;
    else if (a === "-h" || a === "--help") usage();
    else rest.push(a);
  }
  if (rest.length !== 1) usage("expected exactly one OpenSea URL or token ID");
  if (!(opts.loops >= 1)) usage("--loops must be >= 1");
  if (![1, 2].includes(opts.scale)) usage("--scale must be 1 or 2");
  opts.input = rest[0];
  return opts;
}

function parseTokenId(input) {
  if (/^\d+$/.test(input)) return input;
  let url;
  try {
    url = new URL(input);
  } catch {
    usage(`not a URL or token ID: ${input}`);
  }
  // https://opensea.io/item/ethereum/<contract>/<tokenId>
  // https://opensea.io/assets/ethereum/<contract>/<tokenId>
  const parts = url.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => p.toLowerCase() === CONTRACT);
  if (i === -1 || !/^\d+$/.test(parts[i + 1] ?? "")) {
    usage(`URL is not an ENS commemorative NFT (${CONTRACT}): ${input}`);
  }
  return parts[i + 1];
}

async function tokenURI(tokenId) {
  const data = "0xc87b56dd" + BigInt(tokenId).toString(16).padStart(64, "0");
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: CONTRACT, data }, "latest"],
    }),
  });
  const { result, error } = await res.json();
  if (error || !result || result === "0x") {
    throw new Error(`tokenURI(${tokenId}) failed: ${error?.message ?? "empty result"}`);
  }
  const hex = result.slice(2);
  const offset = parseInt(hex.slice(0, 64), 16) * 2;
  const len = parseInt(hex.slice(offset, offset + 64), 16) * 2;
  return Buffer.from(hex.slice(offset + 64, offset + 64 + len), "hex").toString("utf8");
}

async function fetchMetadata(tokenId) {
  const uri = await tokenURI(tokenId);
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`metadata fetch failed: ${res.status} ${uri}`);
  return res.json();
}

async function launchChrome(userDataDir) {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error("Chrome not found; set CHROME_PATH");
  const proc = spawn(
    bin,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let buf = "";
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 20_000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`Chrome exited (${code}): ${buf}`)));
  });
  return { proc, wsUrl };
}

// Minimal CDP client over Node's built-in WebSocket.
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not connect to Chrome DevTools"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else {
      listeners.get(`${msg.sessionId}:${msg.method}`)?.forEach((fn) => fn(msg.params));
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const on = (sessionId, method, fn) => {
    const key = `${sessionId}:${method}`;
    listeners.set(key, [...(listeners.get(key) ?? []), fn]);
  };
  return { send, on, close: () => ws.close() };
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tokenId = parseTokenId(opts.input);

  console.log(`token ${tokenId}`);
  const meta = await fetchMetadata(tokenId);
  console.log(`name  ${meta.name}`);
  const pageUrl = new URL(meta.animation_url);
  if (opts.transparent) pageUrl.searchParams.set("transparent", "1");

  const out = opts.out ?? `${meta.name ?? tokenId}${opts.transparent ? ".webm" : ".mp4"}`;
  const width = CARD_WIDTH * opts.scale;
  const height = CARD_HEIGHT * opts.scale;

  const userDataDir = await mkdtemp(join(tmpdir(), "ens-nft-chrome-"));
  const { proc: chrome, wsUrl } = await launchChrome(userDataDir);
  let ffmpeg;
  try {
    const cdp = await connect(wsUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: CARD_WIDTH, height: CARD_HEIGHT, deviceScaleFactor: opts.scale, mobile: false },
      sessionId,
    );

    console.log(`load  ${pageUrl}`);
    const loaded = new Promise((r) => cdp.on(sessionId, "Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url: pageUrl.href }, sessionId);
    await loaded;

    // Wait for the renderer to draw its first frame (fonts, textures, shaders).
    await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve, reject) => {
        const t0 = Date.now();
        (function poll() {
          const app = window.ens;
          if (app?.rendererFailed) return reject(new Error("artwork renderer failed"));
          if (document.querySelector(".error")) return reject(new Error(document.querySelector(".error").textContent));
          if (app?.rendererReady) return setTimeout(resolve, 1500);
          if (Date.now() - t0 > 60000) return reject(new Error("timed out waiting for artwork"));
          setTimeout(poll, 100);
        })();
      })`,
    );

    const { loopFrames, w, h } = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const app = window.ens;
        app.time.captureMode = true;
        const c = app.canvas;
        return { loopFrames: app.time.loopFrames, w: c.width, h: c.height };
      })()`,
    );
    if (w !== width || h !== height) {
      console.warn(`warn  canvas is ${w}x${h}, expected ${width}x${height}`);
    }

    const totalFrames = loopFrames * opts.loops;
    const codecArgs = opts.transparent
      ? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "18", "-row-mt", "1"]
      : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "slow", "-movflags", "+faststart"];
    ffmpeg = spawn(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
        ...codecArgs, out],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const ffmpegDone = once(ffmpeg, "exit");

    // Render and read back in the same task: the WebGL context doesn't
    // preserve its drawing buffer, so toDataURL must run right after render.
    for (let f = 0; f < totalFrames; f++) {
      const dataUrl = await evaluate(
        cdp,
        sessionId,
        `(() => { const app = window.ens; app.time.stepCapture(${f % loopFrames});
          if (app.rendererFailed) throw new Error("renderer failed at frame ${f}");
          return app.canvas.toDataURL("image/png"); })()`,
      );
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
      if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, "drain");
      process.stdout.write(`\rframe ${f + 1}/${totalFrames}`);
    }
    process.stdout.write("\n");
    ffmpeg.stdin.end();
    const [code] = await ffmpegDone;
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    cdp.close();
    console.log(`saved ${out} (${width}x${height}, ${(totalFrames / FPS).toFixed(1)}s @ ${FPS}fps)`);
  } finally {
    ffmpeg?.stdin.destroy();
    chrome.kill();
    await once(chrome, "exit").catch(() => {});
    await rm(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
});
