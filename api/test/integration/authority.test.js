import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createPool, transaction } from "../../src/db/postgres.js";
import { migrate } from "../../src/db/migrate.js";
import { schemaFingerprint } from "../../src/db/fingerprint.js";
import { Store } from "../../src/store.js";
import { opaque, decrypt } from "../../src/crypto.js";
import {
  claim,
  beginSubmission,
  finish,
  deliver,
  publishOutbox,
  recover,
} from "../../src/dispatch.js";
import { maintenance } from "../../src/maintenance.js";
import { buildApp } from "../../src/app.js";
import { Queue } from "bullmq";
import { qualifyLegacy } from "../../scripts/qualify-legacy.js";
import Redis from "ioredis";
test(
  "PostgreSQL authority, isolation, quotas, leases and Redis reconstruction",
  { timeout: 120000 },
  async (t) => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(
      databaseUrl,
      "TEST_DATABASE_URL required, no skipped integration",
    );
    assert.match(
      new URL(databaseUrl).pathname,
      /^\/verde2_test[a-z0-9_]*$/,
      "dedicated disposable database required",
    );
    const config = {
      databaseUrl,
      contentKey: randomBytes(32),
      pepper: opaque(),
      internalToken: opaque(),
      emailDomain: "example.test",
      bounceDomain: "bounce.example.test",
      instanceId: "test-" + randomUUID(),
      httpRateLimit: 100000,
    };
    const pool = createPool(config);
    const store = new Store(pool, config);
    let app, admin;
    try {
      await migrate(pool);
      await migrate(pool);
      await pool.query(
        "TRUNCATE verde2.tenants,verde2.credentials,verde2.audit CASCADE",
      );
      await pool.query(
        "UPDATE control SET dispatch_enabled=false,service_daily=100000",
      );
      const expiry = new Date(Date.now() + 86400000).toISOString();
      const boot = await transaction(pool, (db) =>
        store.issueCredential(db, null, null, {
          kind: "admin",
          expiresAt: expiry,
        }),
      );
      admin = await store.credential(boot.secret, "admin");
      async function tenant(name, quota = 10000) {
        const { id } = await store.createTenant(admin, {
          slug: name,
          name,
          application: name,
          environment: "test",
          perMinute: quota,
          perDay: quota,
        });
        await store.sender(admin, id, {
          address: "sender@example.test",
          replyTo: true,
        });
        const key = await store.issue(admin, id, {
          kind: "http",
          expiresAt: expiry,
          scopes: ["send:raw", "templates:manage", "logs:read", "stats:read"],
        });
        const smtp = await store.issue(admin, id, {
          kind: "smtp",
          purpose: "worker",
          expiresAt: expiry,
        });
        const direct = await store.issue(admin, id, {
          kind: "smtp",
          purpose: "keycloak",
          expiresAt: expiry,
        });
        return {
          id,
          key,
          smtp,
          direct,
          actor: await store.credential(key.secret),
        };
      }
      const a = await tenant("app-a"),
        b = await tenant("app-b");
      const content = {
        from: "sender@example.test",
        to: "recipient@external.test",
        subject: "Synthetic",
        text: "secret reset token SYNTHETIC_ONLY",
      };
      app = await buildApp({ store, config });
      async function setDispatch(enabled) {
        const response = await app.inject({
          method: "PUT",
          url: "/api/v1/admin/dispatch",
          headers: { authorization: "Bearer " + boot.secret },
          payload: { enabled },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { ok: true });
      }
      await setDispatch(true);
      const headers = {
        authorization: "Bearer " + a.key.secret,
        "idempotency-key": "http-first",
      };
      await t.test(
        "HTTP factory hooks and exact routes accept only validated requests",
        async () => {
          const res = await app.inject({
            method: "POST",
            url: "/api/v1/send/raw",
            headers,
            payload: content,
          });
          assert.equal(res.statusCode, 202, res.body);
          const extra = await app.inject({
            method: "POST",
            url: "/api/v1/send/raw",
            headers: { ...headers, "idempotency-key": "extra" },
            payload: { ...content, tenantId: b.id },
          });
          assert.equal(extra.statusCode, 400);
          const noKey = await app.inject({
            method: "POST",
            url: "/api/v1/send/raw",
            headers: { authorization: headers.authorization },
            payload: content,
          });
          assert.equal(noKey.statusCode, 400);
        },
      );
      await t.test(
        "concurrent idempotency creates exactly one message and quota reservation",
        async () => {
          const answers = await Promise.all(
            Array.from({ length: 10 }, () =>
              store.admit(a.actor, content, "concurrent", true),
            ),
          );
          assert.equal(new Set(answers.map((x) => x.id)).size, 1);
          const id = answers[0].id;
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM reservations WHERE message_id=$1",
                [id],
              )
            ).rows[0].n,
            1,
          );
          await assert.rejects(
            store.admit(
              a.actor,
              { ...content, subject: "different" },
              "concurrent",
              true,
            ),
            (e) => e.statusCode === 409,
          );
          await assert.rejects(
            store.message(b.actor, id),
            (e) => e.statusCode === 404,
          );
        },
      );
      await t.test(
        "strict template rendering, cross-tenant access and encrypted immutable snapshot",
        async () => {
          const tpl = await store.template(a.actor, {
            slug: "reset",
            from: content.from,
            subject: "Hi {{name}}",
            text: "Reset {{name}}",
            variables: [{ name: "name", required: true }],
          });
          await assert.rejects(
            store.admit(
              b.actor,
              { to: content.to, templateId: tpl.id, variables: { name: "B" } },
              "cross",
            ),
            (e) => e.statusCode === 404,
          );
          await assert.rejects(
            store.admit(
              a.actor,
              { to: content.to, templateId: tpl.id, variables: {} },
              "missing",
            ),
            (e) => e.statusCode === 400,
          );
          const m = await store.admit(
            a.actor,
            {
              to: content.to,
              templateId: tpl.id,
              variables: { name: "Alice" },
            },
            "snapshot",
          );
          const row = (
            await pool.query("SELECT * FROM messages WHERE id=$1", [m.id])
          ).rows[0];
          assert.ok(!row.content_cipher.includes("Alice"));
          const before = decrypt(
            row.content_cipher,
            config.contentKey,
            "message:" + a.id + ":" + m.id,
          );
          await store.template(
            a.actor,
            {
              slug: "reset",
              from: content.from,
              subject: "Changed",
              text: "Changed",
              variables: [],
            },
            tpl.id,
          );
          const after = (
            await pool.query(
              "SELECT content_cipher FROM messages WHERE id=$1",
              [m.id],
            )
          ).rows[0].content_cipher;
          assert.deepEqual(
            decrypt(after, config.contentKey, "message:" + a.id + ":" + m.id),
            before,
          );
          await assert.rejects(
            store.template(
              b.actor,
              {
                slug: "reset",
                from: content.from,
                subject: "Hijack",
                text: "x",
              },
              tpl.id,
            ),
            (e) => e.statusCode === 404,
          );
        },
      );
      await t.test(
        "SQL rollback before commit leaves zero message, quota, idempotency or outbox",
        async () => {
          const wrapper = {
            connect: async () => {
              const c = await pool.connect();
              return {
                query: (sql, args) => {
                  if (sql === "INSERT INTO outbox(message_id) VALUES($1)")
                    throw new Error("fault-before-commit");
                  return c.query(sql, args);
                },
                release: () => c.release(),
              };
            },
          };
          const failing = new Store(wrapper, config);
          const before = (
            await pool.query("SELECT count(*)::int AS n FROM messages")
          ).rows[0].n;
          await assert.rejects(
            failing.admit(a.actor, content, "fault-before-commit", true),
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM messages"))
              .rows[0].n,
            before,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM idempotency WHERE key_hash=$1",
                [store.digest("fault-before-commit")],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "send-only cannot list logs, administer or raw send; admin cannot send",
        async () => {
          const key = await store.issue(admin, a.id, {
            kind: "http",
            expiresAt: expiry,
          });
          const h = { authorization: "Bearer " + key.secret };
          for (const url of [
            "/api/v1/logs",
            "/api/v1/stats",
            "/api/v1/templates",
            "/api/v1/admin/tenants",
          ])
            assert.ok(
              [401, 403].includes(
                (await app.inject({ url, headers: h })).statusCode,
              ),
            );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/send/raw",
                headers: { ...h, "idempotency-key": "denied" },
                payload: content,
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/v1/send/raw",
                headers: {
                  authorization: "Bearer " + boot.secret,
                  "idempotency-key": "admin",
                },
                payload: content,
              })
            ).statusCode,
            401,
          );
        },
      );
      await t.test(
        "API and direct SMTP share atomic tenant quota; rotation never resets it",
        async () => {
          const q = await tenant("quota", 1);
          const connectionId = randomUUID();
          await store.connection({ connectionId, username: q.direct.username });
          const direct = {
            username: q.direct.username,
            connectionId,
            envelopeFrom: content.from,
            headerFrom: content.from,
            recipient: content.to,
            messageId: "<direct@example.test>",
            contentHash: "a".repeat(64),
            mimeBytes: 1000,
            queueId: "quota123",
            instanceId: config.instanceId,
          };
          const results = await Promise.allSettled([
            store.admit(q.actor, content, "quota-api", true),
            store.reserve(direct),
          ]);
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.equal(
            results.find((r) => r.status === "rejected").reason.statusCode,
            429,
          );
          const rotated = await store.issue(admin, q.id, {
            kind: "http",
            expiresAt: expiry,
            scopes: ["send:raw"],
          });
          await assert.rejects(
            store.admit(
              await store.credential(rotated.secret),
              content,
              "rotated",
              true,
            ),
            (e) => e.statusCode === 429,
          );
          if (results[1].status === "fulfilled") {
            await store.release({
              reservationId: results[1].value.reservationId,
              instanceId: config.instanceId,
              queueId: direct.queueId,
              workerLease: null,
              provenNotAccepted: true,
            });
            await store.admit(q.actor, content, "released", true);
          }
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "global last slot shared across different tenants",
        async () => {
          const active = (
            await pool.query(
              "SELECT count(*)::int AS n FROM reservations WHERE state<>'released' AND created_at>=date_trunc('day',clock_timestamp())",
            )
          ).rows[0].n;
          await pool.query("UPDATE control SET service_daily=$1", [active + 1]);
          const result = await Promise.allSettled([
            store.admit(a.actor, content, "global-a", true),
            store.admit(b.actor, content, "global-b", true),
          ]);
          assert.equal(
            result.filter((r) => r.status === "fulfilled").length,
            1,
          );
          await pool.query("UPDATE control SET service_daily=100000");
        },
      );
      await t.test(
        "revocation blocks queued messages and prevents final policy admission",
        async () => {
          const r = await tenant("revoke");
          const m = await store.admit(r.actor, content, "revoke", true);
          await store.revoke(admin, r.key.id);
          assert.equal(await claim(store, m.id), null);
          await assert.rejects(
            store.admit(r.actor, content, "revoked-new", true),
            (e) => e.statusCode === 403,
          );
          const m2 = await store.admit(a.actor, content, "lease-revoke", true);
          const job = await claim(store, m2.id);
          await store.revoke(admin, job.smtp.id);
          await assert.rejects(
            beginSubmission(store, job),
            (e) => e.statusCode === 403,
          );
          a.smtp = await store.issue(admin, a.id, {
            kind: "smtp",
            purpose: "worker",
            expiresAt: expiry,
          });
        },
      );
      await t.test(
        "lease fencing binds worker credential, content, envelope and recipient without reserving twice",
        async () => {
          const m = await store.admit(a.actor, content, "binding", true);
          const job = await claim(store, m.id);
          await beginSubmission(store, job);
          const connectionId = randomUUID();
          await store.connection({ connectionId, username: job.smtp.username });
          const request = {
            username: job.smtp.username,
            connectionId,
            envelopeFrom: job.envelope_from,
            headerFrom: content.from,
            recipient: content.to,
            messageId: job.message_id,
            contentHash: job.content_hash,
            mimeBytes: 1000,
            queueId: "binding123",
            instanceId: config.instanceId,
            workerLease: job.lease,
          };
          await assert.rejects(
            store.reserve({ ...request, recipient: "different@example.test" }),
            (e) => e.statusCode === 403,
          );
          const reservation = await store.reserve(request);
          assert.ok(reservation.ok);
          assert.deepEqual(await store.reserve(request), reservation);
          await assert.rejects(
            store.reserve({ ...request, queueId: "differentQueue" }),
            (e) => e.statusCode === 403,
          );
          await pool.query(
            "UPDATE messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [m.id],
          );
          await assert.rejects(
            store.reserve(request),
            (e) => e.code === "lease_expired",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM reservations WHERE message_id=$1",
                [m.id],
              )
            ).rows[0].n,
            1,
          );
          await store.event({
            eventId: "binding-remote",
            queueId: "binding123",
            instanceId: config.instanceId,
            type: "accepted_remote",
            enhancedStatus: "2.0.0",
          });
          await finish(store, job, "accepted_local");
          assert.equal(
            (await store.message(a.actor, m.id)).state,
            "accepted_remote",
          );
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "crash after submission never retries blindly and survives restart recovery",
        async () => {
          const m = await store.admit(a.actor, content, "uncertain", true);
          const job = await claim(store, m.id);
          await beginSubmission(store, job);
          await pool.query(
            "UPDATE messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [m.id],
          );
          await recover(store);
          assert.equal(
            (await store.message(a.actor, m.id)).state,
            "outcome_unknown",
          );
          assert.equal(await claim(store, m.id), null);
          assert.equal(
            (
              await pool.query(
                "SELECT state FROM reservations WHERE message_id=$1",
                [m.id],
              )
            ).rows[0].state,
            "uncertain",
          );
        },
      );
      await t.test(
        "crash before submission may recover and old lease cannot finish the new attempt",
        async () => {
          const m = await store.admit(a.actor, content, "before-submit", true);
          const old = await claim(store, m.id);
          await pool.query(
            "UPDATE messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [m.id],
          );
          await recover(store);
          const next = await claim(store, m.id);
          assert.notEqual(next.lease, old.lease);
          await finish(store, old, "accepted_local");
          assert.equal((await store.message(a.actor, m.id)).state, "in_flight");
        },
      );
      await t.test(
        "explicit SMTP rejection retries safely while lost response retains uncertainty",
        async () => {
          let sends = 0;
          const m = await store.admit(a.actor, content, "smtp-450", true);
          await deliver(store, m.id, async () => ({
            sendMail: async () => {
              sends++;
              throw Object.assign(new Error("synthetic"), {
                responseCode: 450,
              });
            },
            close() {},
          }));
          assert.equal(sends, 1);
          assert.equal((await store.message(a.actor, m.id)).state, "queued");
          const n = await store.admit(a.actor, content, "smtp-lost", true);
          await deliver(store, n.id, async () => ({
            sendMail: async () => {
              throw new Error("connection lost");
            },
            close() {},
          }));
          assert.equal(
            (await store.message(a.actor, n.id)).state,
            "outcome_unknown",
          );
        },
      );
      await t.test(
        "out-of-order and duplicate events cannot regress state or suppress valid recipients",
        async () => {
          const connectionId = randomUUID();
          await store.connection({ connectionId, username: b.direct.username });
          const r = await store.reserve({
            username: b.direct.username,
            connectionId,
            envelopeFrom: content.from,
            headerFrom: content.from,
            recipient: "event@example.test",
            messageId: "<events@example.test>",
            contentHash: "b".repeat(64),
            mimeBytes: 1000,
            queueId: "events123",
            instanceId: config.instanceId,
          });
          const base = { instanceId: config.instanceId, queueId: "events123" };
          await store.event({
            ...base,
            eventId: "defer",
            type: "deferred",
            enhancedStatus: "4.0.0",
          });
          await store.event({
            ...base,
            eventId: "late-local",
            type: "accepted_local",
          });
          assert.equal(
            (await store.message(b.actor, r.messageId)).state,
            "deferred",
          );
          await store.event({
            ...base,
            eventId: "remote",
            type: "accepted_remote",
            enhancedStatus: "2.0.0",
          });
          await store.event({
            ...base,
            eventId: "remote",
            type: "accepted_remote",
            enhancedStatus: "2.0.0",
          });
          await store.event({
            ...base,
            eventId: "contradiction",
            type: "failed_permanent",
            enhancedStatus: "5.1.1",
          });
          assert.equal(
            (await store.message(b.actor, r.messageId)).state,
            "accepted_remote",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM suppressions WHERE tenant_id=$1 AND recipient_hash=$2",
                [b.id, store.digest("event@example.test")],
              )
            ).rowCount,
            0,
          );
          const before = await store.stats(b.actor);
          const dsn = {
            eventId: "dsn-duplicate",
            messageId: r.messageId,
            instanceId: config.instanceId,
            qualified: false,
            statuses: ["5.1.1"],
          };
          await store.dsn(dsn);
          await store.dsn(dsn);
          assert.deepEqual(await store.stats(b.actor), before);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM events WHERE message_id=$1 AND type='dsn_unverified'",
                [r.messageId],
              )
            ).rows[0].n,
            1,
          );
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "partial enqueue recovery and Redis loss preserve logical messages including published ones",
        async () => {
          assert.ok(process.env.TEST_REDIS_URL, "TEST_REDIS_URL required");
          const connection = new Redis(process.env.TEST_REDIS_URL, {
            maxRetriesPerRequest: null,
          });
          const queue = new Queue("verde2-test-" + randomUUID(), {
            connection,
          });
          try {
            const m = await store.admit(a.actor, content, "redis-loss", true);
            const next = await store.admit(
              a.actor,
              content,
              "redis-loss-next",
              true,
            );
            const ids = [m.id, next.id];
            await pool.query(
              "UPDATE outbox SET available_at=clock_timestamp()-CASE WHEN message_id=$1 THEN interval '2 days' ELSE interval '1 day' END WHERE message_id=ANY($2::uuid[])",
              [m.id, ids],
            );
            let completedPrefix = 0;
            await assert.rejects(
              publishOutbox(store, {
                add: async (...args) => {
                  if (completedPrefix === 1)
                    throw new Error("synthetic-enqueue-failure-after-prefix");
                  const job = await queue.add(...args);
                  completedPrefix++;
                  return job;
                },
              }),
              /synthetic-enqueue-failure-after-prefix/,
            );
            assert.equal(completedPrefix, 1);
            assert.ok(await queue.getJob(m.id));
            assert.equal(await queue.getJob(next.id), undefined);
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM outbox WHERE message_id=ANY($1::uuid[]) AND published_at IS NULL",
                  [ids],
                )
              ).rowCount,
              2,
            );
            let rejectPublication = true;
            const publicationFailure = {
              pool: {
                query: (sql, args) => {
                  if (
                    rejectPublication &&
                    sql.startsWith("UPDATE outbox SET published_at=")
                  ) {
                    rejectPublication = false;
                    throw new Error("synthetic-publication-write-failure");
                  }
                  return pool.query(sql, args);
                },
              },
            };
            try {
              await assert.rejects(
                publishOutbox(publicationFailure, queue),
                /synthetic-publication-write-failure/,
              );
              assert.equal(rejectPublication, false);
              for (const id of ids) assert.ok(await queue.getJob(id));
              assert.equal(
                (
                  await pool.query(
                    "SELECT 1 FROM outbox WHERE message_id=ANY($1::uuid[]) AND published_at IS NULL",
                    [ids],
                  )
                ).rowCount,
                2,
              );
            } finally {
              // The wrapper never replaces the shared pool; disable injection on every exit.
              rejectPublication = false;
            }
            await publishOutbox(store, queue);
            for (const id of ids) assert.ok(await queue.getJob(id));
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM outbox WHERE message_id=ANY($1::uuid[]) AND published_at IS NOT NULL",
                  [ids],
                )
              ).rowCount,
              2,
            );
            const waiting = await queue.getJobs(["wait"]);
            for (const id of ids)
              assert.equal(waiting.filter((job) => job.id === id).length, 1);
            await queue.obliterate({ force: true });
            for (const id of ids)
              assert.equal(await queue.getJob(id), undefined);
            await publishOutbox(store, queue);
            for (const id of ids) assert.ok(await queue.getJob(id));
            assert.equal(
              (await store.admit(a.actor, content, "redis-loss", true)).id,
              m.id,
            );
            assert.equal(
              (await store.admit(a.actor, content, "redis-loss-next", true)).id,
              next.id,
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM messages WHERE id=ANY($1::uuid[])",
                  [ids],
                )
              ).rowCount,
              2,
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM reservations WHERE message_id=ANY($1::uuid[])",
                  [ids],
                )
              ).rowCount,
              2,
            );
            // A terminal fixture retains its outbox row, but cannot re-enter Redis.
            await pool.query(
              "UPDATE messages SET state='failed_permanent',terminal_at=clock_timestamp() WHERE id=$1",
              [next.id],
            );
            await queue.obliterate({ force: true });
            await publishOutbox(store, queue);
            assert.ok(await queue.getJob(m.id));
            assert.equal(await queue.getJob(next.id), undefined);
            assert.equal(await claim(store, next.id), null);
            assert.equal(
              (await store.message(a.actor, next.id)).state,
              "failed_permanent",
            );
          } finally {
            await queue.obliterate({ force: true });
            await queue.close();
            await connection.quit();
          }
        },
      );
      await t.test(
        "lost HTTP response after commit remains idempotent",
        async () => {
          let inject = true;
          const wrapper = {
            connect: async () => {
              const db = await pool.connect();
              return {
                query: async (sql, args) => {
                  const result = await db.query(sql, args);
                  if (sql === "COMMIT" && inject) {
                    inject = false;
                    throw new Error("synthetic-after-commit");
                  }
                  return result;
                },
                release: () => db.release(),
              };
            },
          };
          const failing = new Store(wrapper, config);
          const before = (
            await pool.query("SELECT count(*)::int AS n FROM messages")
          ).rows[0].n;
          await assert.rejects(
            failing.admit(a.actor, content, "lost-http-response", true),
          );
          const retry = await store.admit(
            a.actor,
            content,
            "lost-http-response",
            true,
          );
          assert.ok(retry.id);
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM messages"))
              .rows[0].n,
            before + 1,
          );
        },
      );
      await t.test(
        "SMTP acceptance survives statistics failure while missing confirmation stays uncertain without resending",
        async () => {
          const m = await store.admit(
            a.actor,
            content,
            "lost-confirmation",
            true,
          );
          let sends = 0;
          const wrapper = {
            connect: async () => {
              const db = await pool.connect();
              return {
                query: (sql, args) => {
                  if (sql === "UPDATE messages SET state=$2 WHERE id=$1")
                    throw new Error("synthetic-confirmation-write");
                  return db.query(sql, args);
                },
                release: () => db.release(),
              };
            },
          };
          await assert.rejects(
            deliver(new Store(wrapper, config), m.id, async () => ({
              sendMail: async () => {
                sends++;
                return { accepted: [content.to] };
              },
              close() {},
            })),
          );
          await pool.query(
            "UPDATE messages SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
            [m.id],
          );
          await recover(store);
          await deliver(store, m.id, async () => {
            throw new Error("must-not-send");
          });
          assert.equal(sends, 1);
          assert.equal(
            (await store.message(a.actor, m.id)).state,
            "outcome_unknown",
          );
          const accepted = await store.admit(
            a.actor,
            content,
            "statistics-after-acceptance",
            true,
          );
          let acceptedSends = 0;
          await deliver(store, accepted.id, async () => ({
            sendMail: async () => {
              acceptedSends++;
              return { accepted: [content.to] };
            },
            close() {},
          }));
          const snapshot = async () => ({
            message: (
              await pool.query(
                "SELECT state,lease_id,lease_until,submission_started_at FROM messages WHERE id=$1",
                [accepted.id],
              )
            ).rows[0],
            reservations: (
              await pool.query(
                "SELECT * FROM reservations WHERE message_id=$1 ORDER BY id",
                [accepted.id],
              )
            ).rows,
            attempts: (
              await pool.query(
                "SELECT * FROM attempts WHERE message_id=$1 ORDER BY id",
                [accepted.id],
              )
            ).rows,
          });
          const beforeStatistics = await snapshot();
          assert.equal(acceptedSends, 1);
          assert.equal(beforeStatistics.message.state, "accepted_local");
          assert.equal(beforeStatistics.reservations.length, 1);
          assert.equal(beforeStatistics.reservations[0].state, "consumed");
          assert.equal(beforeStatistics.attempts.length, 1);
          assert.equal(beforeStatistics.attempts[0].outcome, "accepted_local");
          assert.ok(beforeStatistics.attempts[0].finished_at);
          let statisticsFailures = 0;
          const statisticsFailure = new Store(
            {
              connect: () => pool.connect(),
              query: (sql, args) => {
                if (
                  sql.startsWith(
                    "SELECT state,count(*)::int AS count FROM messages",
                  )
                ) {
                  statisticsFailures++;
                  throw new Error("synthetic-statistics-detail-must-not-leak");
                }
                return pool.query(sql, args);
              },
            },
            config,
          );
          const statisticsApp = await buildApp({
            store: statisticsFailure,
            config,
          });
          try {
            const response = await statisticsApp.inject({
              method: "GET",
              url: "/api/v1/stats",
              headers: { authorization: "Bearer " + a.key.secret },
            });
            assert.equal(response.statusCode, 500, response.body);
            assert.equal(statisticsFailures, 1);
            assert.deepEqual(Object.keys(response.json()).sort(), [
              "error",
              "requestId",
            ]);
            assert.equal(response.json().error, "internal_error");
            assert.equal(typeof response.json().requestId, "string");
            assert.ok(!response.body.includes("synthetic-statistics-detail"));
            let repeatedFactories = 0;
            await deliver(statisticsFailure, accepted.id, async () => {
              repeatedFactories++;
              throw new Error("accepted-message-must-not-open-transport");
            });
            assert.equal(repeatedFactories, 0);
            assert.equal(acceptedSends, 1);
            assert.deepEqual(await snapshot(), beforeStatistics);
          } finally {
            await statisticsApp.close();
          }
        },
      );
      await t.test(
        "late release from old attempt cannot cancel a new fenced lease",
        async () => {
          const m = await store.admit(a.actor, content, "stale-release", true);
          const first = await claim(store, m.id);
          await beginSubmission(store, first);
          const connectionId = randomUUID();
          await store.connection({
            connectionId,
            username: first.smtp.username,
          });
          const request = {
            username: first.smtp.username,
            connectionId,
            envelopeFrom: first.envelope_from,
            headerFrom: content.from,
            recipient: content.to,
            messageId: first.message_id,
            contentHash: first.content_hash,
            mimeBytes: 1000,
            queueId: "staleFirst",
            instanceId: config.instanceId,
            workerLease: first.lease,
          };
          const r = await store.reserve(request);
          await store.releaseByQueue({
            instanceId: config.instanceId,
            queueId: "staleFirst",
            eventId: "reject-first",
            reason: "milter_rejected",
            provenNotAccepted: true,
            responseCode: 451,
          });
          const second = await claim(store, m.id);
          assert.notEqual(second.lease, first.lease);
          await beginSubmission(store, second);
          await store.reserve({
            ...request,
            workerLease: second.lease,
            queueId: "staleSecond",
          });
          await store.release({
            reservationId: r.reservationId,
            instanceId: config.instanceId,
            queueId: "staleFirst",
            workerLease: first.lease,
            provenNotAccepted: true,
          });
          const after = (
            await pool.query(
              "SELECT m.state,m.lease_id,r.state AS reservation_state FROM messages m JOIN reservations r ON r.message_id=m.id WHERE m.id=$1",
              [m.id],
            )
          ).rows[0];
          assert.equal(after.state, "in_flight");
          assert.equal(after.lease_id, second.lease);
          assert.equal(after.reservation_state, "held");
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "direct SMTP policy replay is idempotent and rejects changed binding",
        async () => {
          const connectionId = randomUUID();
          await store.connection({ connectionId, username: b.direct.username });
          const request = {
            username: b.direct.username,
            connectionId,
            envelopeFrom: content.from,
            headerFrom: content.from,
            recipient: "replay@example.test",
            messageId: "<replay@example.test>",
            contentHash: "c".repeat(64),
            mimeBytes: 1000,
            queueId: "directReplay",
            instanceId: config.instanceId,
          };
          const first = await store.reserve(request);
          assert.deepEqual(await store.reserve(request), first);
          await assert.rejects(
            store.reserve({ ...request, contentHash: "d".repeat(64) }),
            (e) => e.statusCode === 403,
          );
          await pool.query(
            "UPDATE messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [first.messageId],
          );
          await assert.rejects(
            store.reserve(request),
            (e) => e.code === "reservation_expired",
          );
          await store.releaseByQueue({
            instanceId: config.instanceId,
            queueId: "directReplay",
            eventId: "directReject",
            reason: "milter_rejected",
            provenNotAccepted: true,
            responseCode: 451,
          });
          assert.equal(
            (
              await pool.query("SELECT state FROM reservations WHERE id=$1", [
                first.reservationId,
              ])
            ).rows[0].state,
            "released",
          );
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "retention eligibility crossing 30 days cannot expand the deletion batch",
        async () => {
          const connectionId = randomUUID();
          await store.connection({ connectionId, username: b.direct.username });
          const m = await store.reserve({
            username: b.direct.username,
            connectionId,
            envelopeFrom: content.from,
            headerFrom: content.from,
            recipient: "boundary@example.test",
            messageId: "<boundary@example.test>",
            contentHash: "e".repeat(64),
            mimeBytes: 1000,
            queueId: "retentionBoundary",
            instanceId: config.instanceId,
          });
          await store.event({
            eventId: "retention-boundary",
            instanceId: config.instanceId,
            queueId: "retentionBoundary",
            type: "accepted_local",
          });
          let crossed = false;
          const wrapper = {
            connect: async () => {
              const db = await pool.connect();
              return {
                query: async (sql, args) => {
                  if (!crossed && sql.startsWith("DELETE FROM events")) {
                    crossed = true;
                    // Position the synthetic row immediately before its real database-clock deadline.
                    const deadline = (
                      await db.query(
                        "UPDATE messages SET created_at=clock_timestamp()-interval '30 days'+interval '1 second' WHERE id=$1 RETURNING extract(epoch FROM created_at+interval '30 days')::double precision AS deadline",
                        [m.messageId],
                      )
                    ).rows[0].deadline;
                    const result = await db.query(sql, args);
                    await db.query(
                      "SELECT pg_sleep(GREATEST(0,$1::double precision-extract(epoch FROM clock_timestamp()))+0.05)",
                      [deadline],
                    );
                    return result;
                  }
                  return db.query(sql, args);
                },
                release: () => db.release(),
              };
            },
          };
          await maintenance(new Store(wrapper, config));
          assert.ok(crossed);
          assert.equal(
            (
              await pool.query("SELECT 1 FROM messages WHERE id=$1", [
                m.messageId,
              ])
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query("SELECT 1 FROM events WHERE message_id=$1", [
                m.messageId,
              ])
            ).rowCount,
            1,
          );
          await maintenance(store);
          assert.equal(
            (
              await pool.query("SELECT 1 FROM messages WHERE id=$1", [
                m.messageId,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query("SELECT 1 FROM events WHERE message_id=$1", [
                m.messageId,
              ])
            ).rowCount,
            0,
          );
          await store.connection({ connectionId }, true);
        },
      );
      await t.test(
        "dispatch changes require a live administrative credential and are audited",
        async () => {
          const send = (key, payload = content) =>
            app.inject({
              method: "POST",
              url: "/api/v1/send/raw",
              headers: {
                authorization: "Bearer " + a.key.secret,
                "idempotency-key": key,
              },
              payload,
            });
          const existing = await send("dispatch-existing");
          assert.equal(existing.statusCode, 202, existing.body);
          await setDispatch(false);
          const counts = async () =>
            (
              await pool.query(
                "SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM reservations) AS reservations, (SELECT count(*) FROM outbox) AS outbox, (SELECT count(*) FROM idempotency) AS idempotency",
              )
            ).rows[0];
          const before = await counts();
          const paused = await send("dispatch-new");
          assert.equal(paused.statusCode, 503, paused.body);
          assert.equal(paused.json().error, "dispatch_paused");
          const repeated = await send("dispatch-existing");
          assert.equal(repeated.statusCode, 202, repeated.body);
          assert.deepEqual(repeated.json(), existing.json());
          assert.equal(
            (
              await send("dispatch-existing", {
                ...content,
                subject: "Changed",
              })
            ).statusCode,
            409,
          );
          const templatePaused = await app.inject({
            method: "POST",
            url: "/api/v1/send",
            headers: {
              authorization: "Bearer " + a.key.secret,
              "idempotency-key": "dispatch-template-new",
            },
            payload: {
              templateId: randomUUID(),
              to: content.to,
              variables: {},
            },
          });
          assert.equal(templatePaused.statusCode, 503, templatePaused.body);
          assert.equal(templatePaused.json().error, "dispatch_paused");
          assert.deepEqual(await counts(), before);
          const denied = await app.inject({
            method: "PUT",
            url: "/api/v1/admin/dispatch",
            headers: { authorization: "Bearer " + a.key.secret },
            payload: { enabled: true },
          });
          assert.equal(denied.statusCode, 401);
          assert.equal(
            (
              await pool.query(
                "SELECT dispatch_enabled FROM control WHERE id=true",
              )
            ).rows[0].dispatch_enabled,
            false,
          );
          for (const enabled of [true, false]) {
            const action = enabled ? "dispatch.enable" : "dispatch.disable";
            const auditBefore = (
              await pool.query(
                "SELECT 1 FROM audit WHERE actor_id=$1 AND action=$2",
                [admin.id, action],
              )
            ).rowCount;
            const response = await app.inject({
              method: "PUT",
              url: "/api/v1/admin/dispatch",
              headers: { authorization: "Bearer " + boot.secret },
              payload: { enabled },
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.deepEqual(response.json(), { ok: true });
            assert.equal(
              (
                await pool.query(
                  "SELECT dispatch_enabled FROM control WHERE id=true",
                )
              ).rows[0].dispatch_enabled,
              enabled,
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM audit WHERE actor_id=$1 AND action=$2",
                  [admin.id, action],
                )
              ).rowCount,
              auditBefore + 1,
            );
            if (enabled) {
              const admitted = await send("dispatch-new");
              assert.equal(admitted.statusCode, 202, admitted.body);
              const after = await counts();
              for (const field of Object.keys(before))
                assert.equal(BigInt(after[field]), BigInt(before[field]) + 1n);
            }
          }
          const invalid = await app.inject({
            method: "PUT",
            url: "/api/v1/admin/dispatch",
            headers: { authorization: "Bearer " + boot.secret },
            payload: { enabled: "true" },
          });
          assert.equal(invalid.statusCode, 400);
        },
      );
      await t.test(
        "restore dispatch gate, expiry, purge and catalog drift are fail-closed",
        async () => {
          await setDispatch(true);
          const m = await store.admit(a.actor, content, "restore-paused", true);
          await setDispatch(false);
          assert.equal(await claim(store, m.id), null);
          await pool.query(
            "UPDATE messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [m.id],
          );
          await maintenance(store);
          const row = (
            await pool.query(
              "SELECT state,content_cipher FROM messages WHERE id=$1",
              [m.id],
            )
          ).rows[0];
          assert.equal(row.state, "expired");
          assert.equal(row.content_cipher, null);
          await pool.query("CREATE TABLE verde2.unexpected(id integer)");
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_schema_drift",
          );
          await pool.query("DROP TABLE verde2.unexpected");
          await migrate(pool);
          await pool.query("CREATE SCHEMA pgx_data");
          await pool.query("CREATE VIEW pgx_data.marker AS SELECT 1 AS value");
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_unknown_schema",
          );
          await pool.query("DROP SCHEMA pgx_data CASCADE");
          await migrate(pool);
          await pool.query(
            "CREATE TYPE public.synthetic_enum AS ENUM ('first')",
          );
          const enumBefore = await transaction(pool, schemaFingerprint);
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_schema_drift",
          );
          await pool.query(
            "ALTER TYPE public.synthetic_enum ADD VALUE 'second'",
          );
          assert.notEqual(
            await transaction(pool, schemaFingerprint),
            enumBefore,
          );
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_schema_drift",
          );
          assert.deepEqual(
            (
              await pool.query(
                "SELECT enum_range(NULL::public.synthetic_enum)::text AS values",
              )
            ).rows[0],
            { values: "{first,second}" },
          );
          await pool.query("DROP TYPE public.synthetic_enum");
          await migrate(pool);
          await pool.query(
            "CREATE DOMAIN verde2.synthetic_domain AS integer CONSTRAINT positive CHECK (VALUE>0)",
          );
          const domainBefore = await transaction(pool, schemaFingerprint);
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_schema_drift",
          );
          await pool.query(
            "ALTER DOMAIN verde2.synthetic_domain DROP CONSTRAINT positive",
          );
          await pool.query(
            "ALTER DOMAIN verde2.synthetic_domain ADD CONSTRAINT positive CHECK (VALUE>10)",
          );
          assert.notEqual(
            await transaction(pool, schemaFingerprint),
            domainBefore,
          );
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_schema_drift",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT (11::verde2.synthetic_domain)::integer AS value",
              )
            ).rows[0].value,
            11,
          );
          await assert.rejects(
            pool.query("SELECT 1::verde2.synthetic_domain"),
            (e) => e.code === "23514",
          );
          await pool.query("DROP DOMAIN verde2.synthetic_domain");
          await migrate(pool);
          await pool.query(
            "CREATE AGGREGATE public.synthetic_sum(integer) (SFUNC=pg_catalog.int4pl,STYPE=integer,INITCOND='0')",
          );
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_unknown_objects",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT public.synthetic_sum(value) AS total FROM (VALUES (1),(2)) fixture(value)",
              )
            ).rows[0].total,
            3,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='synthetic_sum'",
              )
            ).rows[0].prokind,
            "a",
          );
          await pool.query("DROP AGGREGATE public.synthetic_sum(integer)");
          await migrate(pool);
        },
      );
      await t.test(
        "restored held terminal spool is removed on expiry without regressing known state",
        async () => {
          await setDispatch(true);
          const states = [
            "accepted_remote",
            "failed_permanent",
            "expired",
            "rejected_submission",
          ];
          const rows = [];
          for (const [index, state] of states.entries()) {
            const m = await store.admit(
              a.actor,
              content,
              "terminal-spool-" + index,
              true,
            );
            const lifetime = (
              await pool.query(
                "SELECT extract(epoch FROM expires_at-created_at)::int AS seconds FROM messages WHERE id=$1",
                [m.id],
              )
            ).rows[0].seconds;
            assert.ok(
              lifetime <= 85801 && lifetime >= 85799,
              "ten-minute margin before 24-hour active limit",
            );
            const queueId = "heldTerminal" + index;
            await pool.query(
              "UPDATE messages SET state=$2,queue_id=$3,instance_id=$4,expires_at=clock_timestamp()-interval '1 second',terminal_at=clock_timestamp() WHERE id=$1",
              [m.id, state, queueId, config.instanceId],
            );
            rows.push({ id: m.id, state, queueId });
          }
          const releasable = [];
          for (const [index, state] of [
            "accepted_local",
            "deferred",
          ].entries()) {
            const m = await store.admit(
              a.actor,
              content,
              "release-deadline-" + index,
              true,
            );
            const queueId = "heldReleasable" + index;
            const deadline = (
              await pool.query(
                "UPDATE messages SET state=$2,queue_id=$3,instance_id=$4,expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1 RETURNING expires_at",
                [m.id, state, queueId, config.instanceId],
              )
            ).rows[0].expires_at;
            releasable.push({
              id: m.id,
              queueId,
              expiresAt: deadline.toISOString(),
            });
          }
          await setDispatch(false);
          const internal = await buildApp({ store, config, internal: true });
          try {
            const response = await internal.inject({
              method: "POST",
              url: "/internal/v1/queue-check",
              headers: { authorization: "Bearer " + config.internalToken },
              payload: {
                instanceId: config.instanceId,
                queueIds: [
                  ...rows.map((row) => row.queueId),
                  ...releasable.map((row) => row.queueId),
                  "unknownQueue",
                ],
              },
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.deepEqual(
              response
                .json()
                .remove.map((row) => row.queueId)
                .sort(),
              rows.map((row) => row.queueId).sort(),
            );
            assert.deepEqual(response.json().release, []);
            await setDispatch(true);
            const checkRelease = () =>
              internal.inject({
                method: "POST",
                url: "/internal/v1/queue-check",
                headers: { authorization: "Bearer " + config.internalToken },
                payload: {
                  instanceId: config.instanceId,
                  queueIds: [
                    ...rows.map((row) => row.queueId),
                    ...releasable.map((row) => row.queueId),
                    "unknownQueue",
                  ],
                },
              });
            const ready = await checkRelease();
            assert.equal(ready.statusCode, 200, ready.body);
            assert.deepEqual(
              ready
                .json()
                .release.sort((a, b) => a.queueId.localeCompare(b.queueId)),
              releasable.map(({ queueId, expiresAt }) => ({
                queueId,
                expiresAt,
              })),
            );
            for (const item of ready.json().release) {
              assert.match(
                item.expiresAt,
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
              );
              assert.ok(Date.parse(item.expiresAt) > Date.now());
            }
            await pool.query(
              "UPDATE messages SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [releasable[0].id],
            );
            const expiredRelease = await checkRelease();
            assert.equal(expiredRelease.statusCode, 200, expiredRelease.body);
            assert.deepEqual(expiredRelease.json().release, [
              {
                queueId: releasable[1].queueId,
                expiresAt: releasable[1].expiresAt,
              },
            ]);
            assert.ok(
              expiredRelease
                .json()
                .remove.some(
                  (item) =>
                    item.queueId === releasable[0].queueId &&
                    item.reason === "expired",
                ),
            );
            await setDispatch(false);
            for (const row of rows) {
              await store.event({
                eventId: "clean-" + row.queueId,
                instanceId: config.instanceId,
                queueId: row.queueId,
                type: "expired",
              });
              assert.equal(
                (await store.message(a.actor, row.id)).state,
                row.state,
              );
            }
            await maintenance(store);
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM messages WHERE id=ANY($1::uuid[]) AND content_cipher IS NOT NULL",
                  [rows.map((row) => row.id)],
                )
              ).rows[0].n,
              0,
            );
          } finally {
            await internal.close();
          }
        },
      );
      await t.test(
        "both full legacy fingerprints block adoption and same-name structural drift is unknown",
        async () => {
          await qualifyLegacy(pool, false, async (variant) => {
            await assert.rejects(
              migrate(pool),
              (e) =>
                e.code ===
                "migration_blocked_" + variant + "_explicit_adoption_required",
            );
            if (variant === "single")
              await pool.query(
                "INSERT INTO public.api_keys(key_hash,name) VALUES('synthetic_unowned_hash','synthetic unowned')",
              );
            else
              await pool.query(
                "INSERT INTO public.tenants(slug,name) VALUES('synthetic-unowned','synthetic unowned')",
              );
            await assert.rejects(
              migrate(pool),
              (e) =>
                e.code ===
                "migration_blocked_" + variant + "_explicit_adoption_required",
            );
            const table = variant === "single" ? "api_keys" : "tenants";
            assert.equal(
              (
                await pool.query(
                  "SELECT count(*)::int AS n FROM public." + table,
                )
              ).rows[0].n,
              1,
            );
            await pool.query(
              "ALTER TABLE public.api_keys ADD COLUMN unexpected text",
            );
            await assert.rejects(
              migrate(pool),
              (e) =>
                e.code ===
                "migration_blocked_unknown_explicit_adoption_required",
            );
          });
          // qualifyLegacy leaves an empty public schema: type-only databases are not empty.
          await pool.query(
            'CREATE COLLATION public.synthetic_collation FROM pg_catalog."C"',
          );
          await assert.rejects(
            migrate(pool),
            (e) => e.code === "migration_unknown_objects",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public' AND c.collname='synthetic_collation'",
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT 1 FROM pg_namespace WHERE nspname='verde2'",
              )
            ).rowCount,
            0,
          );
          await pool.query("DROP COLLATION public.synthetic_collation");
          for (const [create, read, drop, expected] of [
            [
              "CREATE TYPE public.synthetic_enum AS ENUM ('preserved')",
              "SELECT 'preserved'::public.synthetic_enum::text AS value",
              "DROP TYPE public.synthetic_enum",
              "preserved",
            ],
            [
              "CREATE DOMAIN public.synthetic_domain AS integer DEFAULT 7 CHECK (VALUE>0)",
              "SELECT (7::public.synthetic_domain)::integer AS value",
              "DROP DOMAIN public.synthetic_domain",
              7,
            ],
          ]) {
            await pool.query(create);
            await assert.rejects(
              migrate(pool),
              (e) => e.code === "migration_unknown_objects",
            );
            assert.equal((await pool.query(read)).rows[0].value, expected);
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM pg_namespace WHERE nspname='verde2'",
                )
              ).rowCount,
              0,
            );
            await pool.query(drop);
          }
          await migrate(pool);
        },
      );
    } finally {
      await app?.close();
      await pool.end();
    }
  },
);
