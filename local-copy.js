"use strict";

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { manifestReferences } = require("./media-manifest");
const { isManifestResponse } = require("./media-proxy");

function archiveName(url, kind) {
  let extension = path.extname(new URL(url).pathname).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    extension = kind === "playlist" ? ".m3u8" : ".bin";
  }
  const hash = crypto.createHash("sha256").update(url).digest("hex");
  return hash + extension;
}

/**
 * Save a raw HLS tree. The injected fetch keeps transport policy outside this module.
 * @param {{sourceUrl: string, directory: string, fetch: (url: string) => Promise<{status: number, headers: Object, body: Buffer, finalUrl: string}>}} opts
 */
async function saveMediaCopy({ sourceUrl, directory, fetch }) {
  let repairing = false;
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "source.json"), "utf8"));
    return { directory, sourceUrl: metadata.sourceUrl, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      repairing = (await fs.stat(directory)).isDirectory();
    } catch (statError) {
      if (statError.code !== "ENOENT") throw statError;
    }
  }

  const temporary = repairing ? directory : `${directory}.tmp`;
  if (!repairing) await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  const seen = new Set();
  let fileCount = 0;

  async function download(url, kind, root = false) {
    if (seen.has(url)) return;
    seen.add(url);
    const response = await fetch(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Media fetch failed with status ${response.status}: ${url}`);
    }

    const text = response.body.toString("utf8");
    const manifest = isManifestResponse(response.headers) || text.startsWith("#EXTM3U");
    const actualKind = manifest ? "playlist" : kind;
    const filename = root && manifest
      ? path.join(temporary, "index.m3u8")
      : path.join(
          temporary,
          manifest ? "manifests" : actualKind === "file" ? "files" : "segments",
          archiveName(url, actualKind),
        );
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, response.body);
    fileCount++;

    if (!manifest) return;
    for (const ref of manifestReferences(text, response.finalUrl)) {
      await download(ref.url, ref.kind);
    }
  }

  try {
    await download(sourceUrl, "segment", true);
    await fs.writeFile(path.join(temporary, "source.json"), JSON.stringify({ sourceUrl }));
    if (!repairing) await fs.rename(temporary, directory);
    return { directory, sourceUrl, reused: false, fileCount };
  } catch (error) {
    if (!repairing) await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { saveMediaCopy };
