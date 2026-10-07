import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { Queue, Worker } from "bullmq";
import { createRedis } from "./db/redis.js";
import { loadConfig } from "./config/index.js";
import { createPool } from "./db/postgres.js";
import { Store } from "./store.js";
import { deliver, publishOutbox, recover } from "./dispatch.js";
export async function startWorker() {
  const config = loadConfig();
  const ca = await readFile(config.smtpCaFile);
  const pool = createPool(config);
  const store = new Store(pool, config);
  const connection = createRedis(config);
  await connection.connect();
  const queue = new Queue("verde2", { connection });
  queue.on("error", () => console.error("queue_connection_error"));
  const transportFactory = async (smtp) =>
    nodemailer.createTransport({
      host: config.smtpHost,
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      name: config.emailDomain,
      auth: { user: smtp.username, pass: smtp.password },
      tls: {
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: config.smtpHost,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 60000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
  const worker = new Worker(
    "verde2",
    (job) => deliver(store, job.data.id, transportFactory),
    { connection, concurrency: config.concurrency },
  );
  worker.on("error", () => console.error("worker_error"));
  worker.on("failed", () => console.error("job_failed"));
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await recover(store);
      await publishOutbox(store, queue);
    } catch {
      console.error("dispatch_tick_failed");
    } finally {
      running = false;
    }
  };
  const interval = setInterval(tick, 5000);
  await tick();
  const stop = async () => {
    stopped = true;
    clearInterval(interval);
    await worker.close();
    await queue.close();
    await connection.quit();
    await pool.end();
  };
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () =>
      stop().catch(() => {
        process.exitCode = 1;
      }),
    );
  return { stop, worker, queue };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startWorker().catch(() => {
    console.error("worker_start_failed");
    process.exitCode = 1;
  });
