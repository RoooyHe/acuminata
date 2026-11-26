// 生成测试用的 HLS 分片夹具（segment-0.ts / segment-1.ts）。
//
// 画面是色条，由 Chromium 自己的 VideoEncoder 编码——夹具因此不携带任何
// 第三方内容。两段的时间轴是连续的（第二段接着第一段），所以
// [segment-0, segment-1] 播起来是一条两秒的连续流。
//
// 用法：node_modules/electron/dist/electron.exe test/fixtures/media/make-fixtures.js
//
// tsmux.js 是这里用到的极小 MPEG-TS 封装器（PAT/PMT + 一帧一个 PES）。
//
// 真实站点的清单另有两份夹具（real-*.m3u8），那是抓下来的，不是生成的。

const { app, BrowserWindow } = require("electron");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { mux } = require("./tsmux");

const W = 160;
const H = 120;
const FPS = 30;
const FRAMES = 60;

async function encodeFrames() {
  const w = new BrowserWindow({ show: false });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<body></body>");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await w.loadURL(`http://127.0.0.1:${port}/`);
  const out = await w.webContents.executeJavaScript(`(async () => {
    if (typeof VideoEncoder === "undefined") return { err: "no VideoEncoder" };
    const c = document.createElement("canvas"); c.width = ${W}; c.height = ${H};
    const ctx = c.getContext("2d");
    const chunks = [];
    const enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); chunks.push(b); },
      error: (e) => console.error(e),
    });
    const cfg = { codec: "avc1.42001E", width: ${W}, height: ${H}, framerate: ${FPS}, bitrate: 200000, avc: { format: "annexb" } };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup.supported) return { err: "unsupported" };
    enc.configure(cfg);
    for (let i = 0; i < ${FRAMES}; i++) {
      ctx.fillStyle = "rgb(" + (i * 6 % 255) + ",80,160)"; ctx.fillRect(0, 0, ${W}, ${H});
      ctx.fillStyle = "#fff"; ctx.fillRect(10 + (i * 2) % (${W} - 40), 40, 20, 40);
      const frame = new VideoFrame(c, { timestamp: i * 33333, duration: 33333 });
      enc.encode(frame, { keyFrame: i === 0 });
      frame.close();
      if (i % 15 === 14) await new Promise((r) => setTimeout(r, 5));
    }
    await enc.flush();
    return { count: chunks.length, b64: chunks.map((c) => btoa(String.fromCharCode.apply(null, c))) };
  })()`);
  w.destroy();
  server.close();
  return out;
}

// Chromium 的 H.264 解析器只认 4 字节的 Annex B 起始码。
function toFourByteStartCodes(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      out.push(0, 0, 0, 1);
      i += 4;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      out.push(0, 0, 0, 1);
      i += 3;
    } else {
      out.push(buf[i]);
      i += 1;
    }
  }
  return Buffer.from(out);
}

async function main() {
  await app.whenReady();
  app.on("window-all-closed", () => {});
  const enc = await encodeFrames();
  if (enc.err) {
    console.error("encode failed:", enc.err);
    app.exit(1);
    return;
  }
  const frames = enc.b64.map((b) => toFourByteStartCodes(Buffer.from(b, "base64")));
  console.log("encoded frames:", frames.length);

  const half = frames.length / 2;
  fs.writeFileSync(path.join(__dirname, "segment-0.ts"), mux(frames.slice(0, half), FPS, 0));
  fs.writeFileSync(path.join(__dirname, "segment-1.ts"), mux(frames.slice(half), FPS, half));
  console.log("wrote segment-0.ts / segment-1.ts");
  app.exit(0);
}

main();
