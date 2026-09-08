import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, "src-tauri", "resources", "engine");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(process.execPath, join(destination, "node.exe"));
await cp(join(root, "engine", "dist"), join(destination, "dist"), { recursive: true });
await cp(join(root, "node_modules"), join(destination, "node_modules"), { recursive: true, filter: source => !source.includes(".cache") && !source.includes("@tauri-apps") && !source.includes("vite") && !source.includes("typescript") && !source.includes("tsx") });
const required = [join(destination, "node.exe"), join(destination, "dist", "index.js"), join(destination, "node_modules", "better-sqlite3")];
const missing = required.filter(path => !existsSync(path));
if (missing.length) { console.error(`Incomplete engine runtime. Missing: ${missing.join(", ")}`); process.exit(1); }
console.log(`Prepared demo engine resources in ${destination}`);
