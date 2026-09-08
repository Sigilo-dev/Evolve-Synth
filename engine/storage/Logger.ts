import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

let pendingWrite = Promise.resolve();

export function writeTechnicalLog(dataDirectory: string, level: "INFO" | "ERROR", event: string, message: string): void {
  const safeMessage = message.replace(/(password|authorization|cookie|token)=\S+/gi, "$1=[redacted]");
  const file = join(dataDirectory, "Diagnostics", "engine.log");
  pendingWrite = pendingWrite
    .then(() => mkdir(join(dataDirectory, "Diagnostics"), { recursive: true }))
    .then(() => appendFile(file, `${new Date().toISOString()} ${level} ${event} ${safeMessage}\n`, "utf8"))
    .catch(() => undefined);
}
