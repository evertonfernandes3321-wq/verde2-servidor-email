import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startServer } from "./runtime.js";
export { buildApp } from "./app.js";
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startServer().catch(() => {
    console.error("startup_failed");
    process.exitCode = 1;
  });
