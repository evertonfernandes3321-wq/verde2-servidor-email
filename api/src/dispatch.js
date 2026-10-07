import { randomUUID } from "node:crypto";
import { transaction } from "./db/postgres.js";
import { decrypt } from "./crypto.js";
import { requireThat } from "./errors.js";
export async function claim(store, id) {
  return transaction(store.pool, async (db) => {
    await store.lock(db);
    const control = (
      await db.query("SELECT dispatch_enabled FROM control WHERE id=true")
    ).rows[0];
    if (!control.dispatch_enabled) return null;
    const m = (
      await db.query(
        "SELECT * FROM messages WHERE id=$1 AND state='queued' AND expires_at>clock_timestamp() FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!m) return null;
    try {
      await store.revalidate(db, m.credential_id, "http");
    } catch (error) {
      if (error.statusCode !== 403) throw error;
      await db.query(
        "UPDATE messages SET state='failed_permanent',terminal_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await db.query(
        "UPDATE reservations SET state='released' WHERE message_id=$1",
        [id],
      );
      return null;
    }
    const c = (
      await db.query(
        "SELECT * FROM credentials WHERE tenant_id=$1 AND kind='smtp' AND purpose='worker' AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [m.tenant_id],
      )
    ).rows[0];
    if (!c) return null;
    const payload = decrypt(
      m.content_cipher,
      store.config.contentKey,
      "message:" + m.tenant_id + ":" + m.id,
    );
    await store.authorizedSender(
      db,
      m.tenant_id,
      payload.from,
      payload.replyTo,
    );
    await store.suppressed(db, m.tenant_id, payload.to);
    const lease = randomUUID();
    await db.query(
      "UPDATE messages SET state='in_flight',lease_id=$2,lease_until=clock_timestamp()+interval '5 minutes' WHERE id=$1",
      [id, lease],
    );
    await db.query(
      "INSERT INTO attempts(id,tenant_id,message_id,smtp_credential_id,lease_id) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), m.tenant_id, id, c.id, lease],
    );
    return {
      ...m,
      payload,
      lease,
      smtp: {
        id: c.id,
        username: c.username,
        password: decrypt(
          c.secret_cipher,
          store.config.contentKey,
          "credential:" + c.id,
        ),
      },
    };
  });
}
export async function beginSubmission(store, job) {
  return transaction(store.pool, async (db) => {
    await store.lock(db);
    await store.revalidate(db, job.credential_id, "http");
    await store.revalidate(db, job.smtp.id, "smtp");
    requireThat(
      (await db.query("SELECT dispatch_enabled FROM control WHERE id=true"))
        .rows[0].dispatch_enabled,
      503,
      "dispatch_paused",
    );
    const result = await db.query(
      "UPDATE messages SET submission_started_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND lease_id=$3 AND state='in_flight' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp() RETURNING id",
      [job.id, job.tenant_id, job.lease],
    );
    requireThat(result.rowCount, 409, "stale_lease");
  });
}
export async function finish(store, job, outcome) {
  return transaction(store.pool, async (db) => {
    await store.lock(db);
    const m = (
      await db.query(
        "SELECT state,queue_id FROM messages WHERE id=$1 AND tenant_id=$2 AND lease_id=$3 FOR UPDATE",
        [job.id, job.tenant_id, job.lease],
      )
    ).rows[0];
    if (!m) return;
    if (m.state !== "in_flight") {
      await db.query(
        "UPDATE attempts SET finished_at=COALESCE(finished_at,clock_timestamp()),outcome=$2 WHERE lease_id=$1",
        [job.lease, m.state],
      );
      return;
    }
    const state =
      outcome === "accepted_local" ? "accepted_local" : "outcome_unknown";
    await db.query("UPDATE messages SET state=$2 WHERE id=$1", [job.id, state]);
    await db.query(
      "UPDATE reservations SET state=$2 WHERE tenant_id=$1 AND message_id=$3 AND state='held'",
      [
        job.tenant_id,
        state === "accepted_local" ? "consumed" : "uncertain",
        job.id,
      ],
    );
    await db.query(
      "UPDATE attempts SET finished_at=clock_timestamp(),outcome=$2 WHERE lease_id=$1",
      [job.lease, state],
    );
  });
}
export async function deliver(store, id, transportFactory) {
  const job = await claim(store, id);
  if (!job) return;
  let transport;
  try {
    transport = await transportFactory(job.smtp);
    await beginSubmission(store, job);
  } catch {
    // No transport invocation occurred; crash recovery may safely release this lease.
    await transaction(store.pool, async (db) => {
      await store.lock(db);
      await db.query(
        "UPDATE attempts SET finished_at=clock_timestamp(),outcome='setup_failed' WHERE lease_id=$1 AND EXISTS(SELECT 1 FROM messages WHERE id=$2 AND lease_id=$1 AND state='in_flight' AND submission_started_at IS NULL)",
        [job.lease, job.id],
      );
      await db.query(
        "UPDATE messages SET state='queued',lease_id=NULL,lease_until=NULL WHERE id=$1 AND tenant_id=$2 AND lease_id=$3 AND state='in_flight' AND submission_started_at IS NULL",
        [job.id, job.tenant_id, job.lease],
      );
    });
    transport?.close();
    return;
  }
  try {
    const raw = Buffer.concat([
      Buffer.from("X-Verde2-Lease: " + job.lease + "\r\n"),
      Buffer.from(job.payload.raw, "base64"),
    ]);
    await transport.sendMail({
      envelope: { from: job.envelope_from, to: [job.payload.to] },
      raw,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch (error) {
    if (
      Number.isInteger(error.responseCode) &&
      error.responseCode >= 400 &&
      error.responseCode <= 599
    ) {
      await transaction(store.pool, async (db) => {
        await store.lock(db);
        const m = (
          await db.query(
            "SELECT state FROM messages WHERE id=$1 AND tenant_id=$2 AND lease_id=$3 FOR UPDATE",
            [job.id, job.tenant_id, job.lease],
          )
        ).rows[0];
        if (m?.state !== "in_flight") return;
        const permanent = error.responseCode >= 500;
        await db.query(
          "UPDATE messages SET state=$2,terminal_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,lease_id=NULL,lease_until=NULL,submission_started_at=NULL,queue_id=NULL,instance_id=NULL WHERE id=$1",
          [job.id, permanent ? "failed_permanent" : "queued", permanent],
        );
        await db.query(
          "UPDATE attempts SET finished_at=clock_timestamp(),outcome=$2 WHERE lease_id=$1",
          [job.lease, permanent ? "rejected_permanent" : "rejected_temporary"],
        );
        if (permanent)
          await db.query(
            "UPDATE reservations SET state='released' WHERE message_id=$1 AND state='held'",
            [job.id],
          );
        else
          await db.query(
            "UPDATE outbox SET available_at=clock_timestamp()+interval '60 seconds' WHERE message_id=$1",
            [job.id],
          );
      });
    } else await finish(store, job, "outcome_unknown");
    return;
  } finally {
    transport.close();
  }
  // A database failure here deliberately leaves in_flight/submission_started_at for recovery.
  await finish(store, job, "accepted_local");
}
export async function publishOutbox(store, queue) {
  const rows = (
    await store.pool.query(
      "SELECT o.message_id FROM outbox o JOIN messages m ON m.id=o.message_id WHERE m.state='queued' AND m.expires_at>clock_timestamp() AND o.available_at<=clock_timestamp() ORDER BY o.available_at LIMIT 500",
    )
  ).rows;
  const publishedIds = [];
  for (const row of rows) {
    // Re-publish all SQL queued messages, regardless of published_at; Redis is disposable.
    await queue.add(
      "message",
      { id: row.message_id },
      { jobId: row.message_id, removeOnComplete: true, removeOnFail: true },
    );
    publishedIds.push(row.message_id);
  }
  // If enqueue fails mid-batch, the next scan safely republishes its completed prefix.
  if (publishedIds.length)
    await store.pool.query(
      "UPDATE outbox SET published_at=clock_timestamp() WHERE message_id=ANY($1::uuid[])",
      [publishedIds],
    );
  return rows.length;
}
export async function recover(store) {
  return transaction(store.pool, async (db) => {
    await store.lock(db);
    await db.query(
      "UPDATE attempts a SET finished_at=clock_timestamp(),outcome=CASE WHEN m.submission_started_at IS NULL THEN 'abandoned_before_submission' ELSE 'outcome_unknown' END FROM messages m WHERE m.id=a.message_id AND m.lease_id=a.lease_id AND m.state='in_flight' AND m.lease_until<clock_timestamp() AND a.finished_at IS NULL",
    );
    await db.query(
      "UPDATE messages SET state='outcome_unknown' WHERE state='in_flight' AND (lease_until<clock_timestamp() OR (source='smtp' AND created_at<clock_timestamp()-interval '10 minutes')) AND (submission_started_at IS NOT NULL OR source='smtp')",
    );
    await db.query(
      "UPDATE reservations r SET state='uncertain' FROM messages m WHERE m.id=r.message_id AND m.state='outcome_unknown' AND r.state='held'",
    );
    await db.query(
      "UPDATE messages SET state='queued',lease_id=NULL,lease_until=NULL WHERE state='in_flight' AND lease_until<clock_timestamp() AND submission_started_at IS NULL AND source='http'",
    );
    await db.query(
      "UPDATE messages SET state='expired',terminal_at=clock_timestamp() WHERE state='queued' AND expires_at<=clock_timestamp()",
    );
    await db.query(
      "UPDATE reservations r SET state='released' FROM messages m WHERE m.id=r.message_id AND m.state='expired' AND m.submission_started_at IS NULL AND r.state='held'",
    );
  });
}
