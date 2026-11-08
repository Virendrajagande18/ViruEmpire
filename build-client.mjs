// Builds the CEO panel client for the standalone (Render) server.
// Same bundle config the space uses (Bun.build + tailwind plugin, production
// mode, hashed assets) — written here so the standalone deploy does not
// depend on the space build pipeline. Run: bun ./build-client.mjs

import { basename } from "node:path";
import { rm } from "node:fs/promises";
import tailwindPlugin from "/home/hatch/workspace/ts-spaces/viru-empire-ceo-panel/node_modules/bun-plugin-tailwind/index.js";

const SPACE = "/home/hatch/workspace/ts-spaces/viru-empire-ceo-panel";
const ENTRY = `${SPACE}/client/index.html`;
const OUTDIR = "./client-dist";

await rm(OUTDIR, { force: true, recursive: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  naming: {
    asset: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    entry: "[name].[ext]",
  },
  plugins: [tailwindPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Client build failed.");
}

// Re-prefix bare imported-asset URLs to ./assets/... (same fix as the SDK).
const assetFiles = result.outputs
  .filter((o) => o.kind === "asset")
  .map((o) => basename(o.path));
for (const output of result.outputs) {
  if (!/\.(js|css|html)$/.test(output.path)) continue;
  let text = await output.text();
  let changed = false;
  for (const name of assetFiles) {
    const bare = `./${name}`;
    if (text.includes(bare)) {
      text = text.split(bare).join(`./assets/${name}`);
      changed = true;
    }
  }
  if (changed) await Bun.write(output.path, text);
}

console.log("Client built into ./client-dist");
for (const o of result.outputs) console.log(" ", o.path);
