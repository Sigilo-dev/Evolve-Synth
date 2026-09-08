import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const release = join(root, "src-tauri", "target", "release");
const engine = join(release, "resources", "engine");
const required = [
  join(release, "evolve-synth.exe"),
  join(engine, "node.exe"),
  join(engine, "dist", "index.js"),
  join(engine, "node_modules", "better-sqlite3")
];
const missing = required.filter(path => !existsSync(path));
if (missing.length) { console.error(`Demo package verification failed. Missing: ${missing.join(", ")}`); process.exit(1); }
console.log(`Demo package verified: ${release}`);
