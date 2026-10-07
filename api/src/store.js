import { randomUUID } from "node:crypto";
import { transaction } from "./db/postgres.js";
import {
  fingerprint,
  encrypt,
  decrypt,
  canonical,
  hash,
  opaque,
  constantEqual,
} from "./crypto.js";
import { requireThat } from "./errors.js";
import { address, compose, render } from "./mail.js";
export const scopes = [
  "send:template",
  "send:raw",
  "logs:read",
  "stats:read",
  "templates:manage",
];
export class Store {
  constructor(pool, config) {
    this.pool = pool;
    this.config = config;
  }
  digest(value) {
    return fingerprint(value, this.config.pepper);
  }
  async lock(db) {
    await db.query("SELECT pg_advisory_xact_lock(741102402)");
  }
  async credential(token, kind = "http") {
    const row = (
      await this.pool.query(
        "SELECT c.* FROM credentials c LEFT JOIN tenants t ON t.id=c.tenant_id WHERE c.secret_hash=$1 AND c.kind=$2 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND (c.kind='admin' OR t.active)",
        [this.digest(token), kind],
      )
    ).rows[0];
    requireThat(row, 401, "unauthorized");
    return row;
  }
  async revalidate(db, id, kind) {
    const row = (
      await db.query(
        "SELECT c.* FROM credentials c LEFT JOIN tenants t ON t.id=c.tenant_id WHERE c.id=$1 AND c.kind=$2 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND (c.kind='admin' OR t.active) FOR UPDATE OF c",
        [id, kind],
      )
    ).rows[0];
    requireThat(row, 403, "credential_inactive");
    return row;
  }
  async audit(db, actor, action, id) {
    await db.query(
      "INSERT INTO audit(actor_id,action,resource_id) VALUES($1,$2,$3)",
      [actor, action, id],
    );
  }
  async admin(actor, fn) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      await this.revalidate(db, actor.id, "admin");
      return fn(db);
    });
  }
  async createTenant(actor, data) {
    return this.admin(actor, async (db) => {
      const id = randomUUID();
      await db.query(
        "INSERT INTO tenants(id,slug,name,application,environment,per_minute,per_day) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          data.slug,
          data.name,
          data.application,
          data.environment,
          data.perMinute ?? 60,
          data.perDay ?? 1000,
        ],
      );
      await this.audit(db, actor.id, "tenant.create", id);
      return { id };
    });
  }
  async updateTenant(actor, id, data) {
    return this.admin(actor, async (db) => {
      const result = await db.query(
        "UPDATE tenants SET active=COALESCE($2,active),per_minute=COALESCE($3,per_minute),per_day=COALESCE($4,per_day) WHERE id=$1 RETURNING id",
        [id, data.active ?? null, data.perMinute ?? null, data.perDay ?? null],
      );
      requireThat(result.rowCount, 404, "not_found");
      await this.audit(db, actor.id, "tenant.update", id);
      return { id };
    });
  }
  async issue(actor, tenantId, data) {
    return this.admin(actor, (db) =>
      this.issueCredential(db, actor.id, tenantId, data),
    );
  }
  async issueCredential(db, actorId, tenantId, data) {
    const id = randomUUID();
    const secret = opaque();
    const kind = data.kind;
    const granted =
      kind === "http"
        ? [...new Set(["send:template", ...(data.scopes || [])])]
        : [];
    requireThat(granted.every((s) => scopes.includes(s)));
    const username = kind === "smtp" ? "smtp_" + id.replaceAll("-", "") : null;
    const purpose = kind === "smtp" ? data.purpose : null;
    requireThat(kind !== "smtp" || ["worker", "keycloak"].includes(purpose));
    const expiresAt = new Date(data.expiresAt);
    requireThat(
      expiresAt > new Date() &&
        expiresAt <= new Date(Date.now() + 366 * 86400000),
      400,
      "invalid_expiration",
    );
    if (kind !== "admin")
      requireThat(
        (
          await db.query("SELECT id FROM tenants WHERE id=$1 AND active", [
            tenantId,
          ])
        ).rowCount,
        404,
        "not_found",
      );
    await db.query(
      "INSERT INTO credentials(id,tenant_id,kind,purpose,username,secret_hash,secret_cipher,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        id,
        kind === "admin" ? null : tenantId,
        kind,
        purpose,
        username,
        this.digest(secret),
        purpose === "worker"
          ? encrypt(secret, this.config.contentKey, "credential:" + id)
          : null,
        granted,
        expiresAt,
      ],
    );
    await this.audit(db, actorId, "credential.create", id);
    return { id, secret, username, scopes: granted, expiresAt };
  }
  async revoke(actor, id) {
    return this.admin(actor, async (db) => {
      requireThat(
        (
          await db.query(
            "UPDATE credentials SET revoked_at=clock_timestamp(),secret_cipher=NULL WHERE id=$1 RETURNING id",
            [id],
          )
        ).rowCount,
        404,
        "not_found",
      );
      await this.audit(db, actor.id, "credential.revoke", id);
      return { id };
    });
  }
  async sender(actor, tenantId, data, remove = false) {
    return this.admin(actor, async (db) => {
      const email = address(data.address);
      requireThat(
        email.split("@")[1] === this.config.emailDomain,
        400,
        "unsigned_sender_domain",
      );
      if (remove)
        await db.query(
          "DELETE FROM senders WHERE tenant_id=$1 AND address=$2",
          [tenantId, email],
        );
      else
        await db.query(
          "INSERT INTO senders(tenant_id,address,reply_to) VALUES($1,$2,$3) ON CONFLICT(tenant_id,address) DO UPDATE SET reply_to=EXCLUDED.reply_to",
          [tenantId, email, data.replyTo ?? false],
        );
      await this.audit(
        db,
        actor.id,
        remove ? "sender.delete" : "sender.put",
        tenantId,
      );
      return { ok: true };
    });
  }
  async authorizedSender(db, tenantId, from, replyTo) {
    requireThat(
      (
        await db.query(
          "SELECT 1 FROM senders WHERE tenant_id=$1 AND address=$2",
          [tenantId, address(from)],
        )
      ).rowCount,
      403,
      "sender_not_authorized",
    );
    if (replyTo)
      requireThat(
        (
          await db.query(
            "SELECT 1 FROM senders WHERE tenant_id=$1 AND address=$2 AND reply_to",
            [tenantId, address(replyTo)],
          )
        ).rowCount,
        403,
        "reply_to_not_authorized",
      );
  }
  async template(actor, data, id) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      await this.revalidate(db, actor.id, "http");
      const templateId = id || randomUUID();
      render(
        data,
        Object.fromEntries(
          (data.variables || []).map((v) => [v.name, "validation"]),
        ),
      );
      await this.authorizedSender(db, actor.tenant_id, data.from, data.replyTo);
      const cipher = encrypt(
        data,
        this.config.contentKey,
        "template:" + actor.tenant_id + ":" + templateId,
      );
      if (id)
        requireThat(
          (
            await db.query(
              "UPDATE templates SET slug=$3,definition_cipher=$4,version=version+1 WHERE id=$1 AND tenant_id=$2 RETURNING id",
              [id, actor.tenant_id, data.slug, cipher],
            )
          ).rowCount,
          404,
          "not_found",
        );
      else
        await db.query(
          "INSERT INTO templates(id,tenant_id,slug,definition_cipher) VALUES($1,$2,$3,$4)",
          [templateId, actor.tenant_id, data.slug, cipher],
        );
      return { id: templateId };
    });
  }
  async templates(actor) {
    return (
      await this.pool.query(
        "SELECT id,slug,active,version,created_at FROM templates WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
        [actor.tenant_id],
      )
    ).rows;
  }
  async getTemplate(db, tenantId, id) {
    const t = (
      await db.query(
        "SELECT * FROM templates WHERE tenant_id=$1 AND id=$2 AND active",
        [tenantId, id],
      )
    ).rows[0];
    requireThat(t, 404, "template_not_found");
    return decrypt(
      t.definition_cipher,
      this.config.contentKey,
      "template:" + tenantId + ":" + id,
    );
  }
  async preview(actor, id, variables) {
    const data = await this.getTemplate(this.pool, actor.tenant_id, id);
    return render(data, variables);
  }
  async deleteTemplate(actor, id) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      await this.revalidate(db, actor.id, "http");
      requireThat(
        (
          await db.query(
            "UPDATE templates SET active=false WHERE tenant_id=$1 AND id=$2 RETURNING id",
            [actor.tenant_id, id],
          )
        ).rowCount,
        404,
        "not_found",
      );
      return { ok: true };
    });
  }
  async quota(db, tenantId) {
    const t = (
      await db.query(
        "SELECT per_minute,per_day FROM tenants WHERE id=$1 AND active FOR UPDATE",
        [tenantId],
      )
    ).rows[0];
    requireThat(t, 403, "tenant_inactive");
    const counts = (
      await db.query(
        "SELECT count(*) FILTER(WHERE tenant_id=$1 AND created_at>=date_trunc('minute',clock_timestamp()))::int AS minute,count(*) FILTER(WHERE tenant_id=$1)::int AS day,count(*)::int AS total FROM reservations WHERE state<>'released' AND created_at>=date_trunc('day',clock_timestamp())",
        [tenantId],
      )
    ).rows[0];
    const control = (
      await db.query(
        "SELECT service_daily FROM control WHERE id=true FOR UPDATE",
      )
    ).rows[0];
    requireThat(
      counts.minute < t.per_minute &&
        counts.day < t.per_day &&
        counts.total < control.service_daily,
      429,
      "quota_exceeded",
    );
  }
  async suppressed(db, tenantId, recipient) {
    requireThat(
      !(
        await db.query(
          "SELECT 1 FROM suppressions WHERE tenant_id=$1 AND recipient_hash=$2",
          [tenantId, this.digest(address(recipient))],
        )
      ).rowCount,
      422,
      "recipient_suppressed",
    );
  }
  binding(tenantId, credentialId, leaseId, from, to, contentHash) {
    return hash(
      canonical({ tenantId, credentialId, leaseId, from, to, contentHash }),
    );
  }
  async admit(actor, data, key, raw = false) {
    const requestHash = hash(
      canonical({ route: raw ? "raw" : "template", data }),
    );
    const keyHash = this.digest(key);
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      const live = await this.revalidate(db, actor.id, "http");
      requireThat(
        live.scopes.includes(raw ? "send:raw" : "send:template"),
        403,
        "scope_required",
      );
      const previous = (
        await db.query(
          "SELECT i.request_hash,m.id,m.state FROM idempotency i JOIN messages m ON m.id=i.message_id AND m.tenant_id=i.tenant_id WHERE i.tenant_id=$1 AND i.key_hash=$2 AND i.expires_at>clock_timestamp()",
          [actor.tenant_id, keyHash],
        )
      ).rows[0];
      if (previous) {
        requireThat(
          previous.request_hash === requestHash,
          409,
          "idempotency_conflict",
        );
        return { id: previous.id, state: previous.state };
      }
      requireThat(
        (await db.query("SELECT dispatch_enabled FROM control WHERE id=true"))
          .rows[0]?.dispatch_enabled,
        503,
        "dispatch_paused",
      );
      await db.query(
        "DELETE FROM idempotency WHERE tenant_id=$1 AND key_hash=$2 AND expires_at<=clock_timestamp()",
        [actor.tenant_id, keyHash],
      );
      const content = raw
        ? data
        : render(
            await this.getTemplate(db, actor.tenant_id, data.templateId),
            data.variables,
          );
      const to = address(data.to);
      await this.authorizedSender(
        db,
        actor.tenant_id,
        content.from,
        content.replyTo,
      );
      await this.suppressed(db, actor.tenant_id, to);
      const id = randomUUID();
      const messageId = "<" + id + "@" + this.config.emailDomain + ">";
      const built = await compose(content, to, messageId);
      await this.quota(db, actor.tenant_id);
      const envelopeFrom = "b+" + id + "@" + this.config.bounceDomain;
      await db.query(
        "INSERT INTO messages(id,tenant_id,credential_id,template_id,source,content_cipher,content_hash,recipient_hash,message_id,envelope_from) VALUES($1,$2,$3,$4,'http',$5,$6,$7,$8,$9)",
        [
          id,
          actor.tenant_id,
          actor.id,
          raw ? null : data.templateId,
          encrypt(
            {
              raw: built.raw,
              to,
              from: content.from,
              replyTo: content.replyTo,
            },
            this.config.contentKey,
            "message:" + actor.tenant_id + ":" + id,
          ),
          built.contentHash,
          this.digest(to),
          messageId,
          envelopeFrom,
        ],
      );
      await db.query(
        "INSERT INTO reservations(id,tenant_id,message_id,binding_hash) VALUES($1,$2,$3,$4)",
        [
          randomUUID(),
          actor.tenant_id,
          id,
          this.binding(
            actor.tenant_id,
            actor.id,
            null,
            envelopeFrom,
            to,
            built.contentHash,
          ),
        ],
      );
      await db.query(
        "INSERT INTO idempotency(tenant_id,key_hash,request_hash,message_id) VALUES($1,$2,$3,$4)",
        [actor.tenant_id, keyHash, requestHash, id],
      );
      await db.query("INSERT INTO outbox(message_id) VALUES($1)", [id]);
      return { id, state: "queued" };
    });
  }
  async message(actor, id) {
    const row = (
      await this.pool.query(
        "SELECT id,state,created_at,expires_at,terminal_at FROM messages WHERE tenant_id=$1 AND id=$2",
        [actor.tenant_id, id],
      )
    ).rows[0];
    requireThat(row, 404, "not_found");
    row.events = (
      await this.pool.query(
        "SELECT type,enhanced_status,created_at FROM events WHERE tenant_id=$1 AND message_id=$2 ORDER BY id",
        [actor.tenant_id, id],
      )
    ).rows;
    return row;
  }
  async logs(actor) {
    return (
      await this.pool.query(
        "SELECT id,state,created_at,terminal_at FROM messages WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",
        [actor.tenant_id],
      )
    ).rows;
  }
  async stats(actor) {
    return (
      await this.pool.query(
        "SELECT state,count(*)::int AS count FROM messages WHERE tenant_id=$1 AND created_at>clock_timestamp()-interval '30 days' GROUP BY state",
        [actor.tenant_id],
      )
    ).rows;
  }
  async suppression(actor, tenantId, data, remove = false) {
    return this.admin(actor, async (db) => {
      const recipient = this.digest(address(data.recipient));
      if (remove)
        await db.query(
          "DELETE FROM suppressions WHERE tenant_id=$1 AND recipient_hash=$2",
          [tenantId, recipient],
        );
      else
        await db.query(
          "INSERT INTO suppressions(tenant_id,recipient_hash,reason) VALUES($1,$2,'operator') ON CONFLICT DO NOTHING",
          [tenantId, recipient],
        );
      await this.audit(
        db,
        actor.id,
        remove ? "suppression.delete" : "suppression.put",
        tenantId,
      );
      return { ok: true };
    });
  }
  async smtpAuth(data) {
    const row = (
      await this.pool.query(
        "SELECT c.id,c.tenant_id,c.purpose,c.secret_hash FROM credentials c JOIN tenants t ON t.id=c.tenant_id WHERE c.username=$1 AND c.kind='smtp' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND t.active",
        [data.username],
      )
    ).rows[0];
    requireThat(
      row && constantEqual(row.secret_hash, this.digest(data.password)),
      403,
      "smtp_denied",
    );
    return { ok: true, credentialId: row.id, purpose: row.purpose };
  }
  async smtpCredential(db, username) {
    const row = (
      await db.query(
        "SELECT c.* FROM credentials c JOIN tenants t ON t.id=c.tenant_id WHERE c.username=$1 AND c.kind='smtp' AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND t.active FOR UPDATE OF c",
        [username],
      )
    ).rows[0];
    requireThat(row, 403, "smtp_denied");
    return row;
  }
  async connection(data, close = false) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      await db.query(
        "DELETE FROM smtp_connections WHERE expires_at<clock_timestamp()",
      );
      if (close) {
        await db.query("DELETE FROM smtp_connections WHERE id=$1", [
          data.connectionId,
        ]);
        return { ok: true };
      }
      const credential = data.username
        ? await this.smtpCredential(db, data.username)
        : null;
      const existing = (
        await db.query("SELECT * FROM smtp_connections WHERE id=$1", [
          data.connectionId,
        ])
      ).rows[0];
      const total = (
        await db.query("SELECT count(*)::int AS count FROM smtp_connections")
      ).rows[0].count;
      requireThat(existing || total < 10, 429, "connection_limit");
      if (credential) {
        const count = (
          await db.query(
            "SELECT count(*)::int AS count FROM smtp_connections WHERE credential_id=$1 AND id<>$2",
            [credential.id, data.connectionId],
          )
        ).rows[0].count;
        requireThat(count < 5, 429, "credential_connection_limit");
      }
      await db.query(
        "INSERT INTO smtp_connections(id,credential_id) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET credential_id=COALESCE(EXCLUDED.credential_id,smtp_connections.credential_id),expires_at=clock_timestamp()+interval '10 minutes'",
        [data.connectionId, credential?.id ?? null],
      );
      return { ok: true };
    });
  }
  async reserve(data) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      requireThat(
        (await db.query("SELECT dispatch_enabled FROM control WHERE id=true"))
          .rows[0].dispatch_enabled,
        503,
        "dispatch_paused",
      );
      const c = await this.smtpCredential(db, data.username);
      const to = address(data.recipient);
      const from = address(data.headerFrom);
      requireThat(
        (
          await db.query(
            "SELECT 1 FROM smtp_connections WHERE id=$1 AND credential_id=$2 AND expires_at>clock_timestamp()",
            [data.connectionId, c.id],
          )
        ).rowCount,
        403,
        "connection_expired",
      );
      await this.authorizedSender(db, c.tenant_id, from, data.replyTo);
      await this.suppressed(db, c.tenant_id, to);
      requireThat(data.mimeBytes <= 1048576 - 16384, 413, "mime_too_large");
      requireThat(
        data.instanceId === this.config.instanceId,
        403,
        "instance_mismatch",
      );
      const replay = (
        await db.query(
          "SELECT m.*,m.expires_at>clock_timestamp() AS unexpired,m.lease_until>clock_timestamp() AS live_lease,r.id AS reservation_id,r.binding_hash,r.state AS reservation_state FROM messages m JOIN reservations r ON r.message_id=m.id AND r.tenant_id=m.tenant_id WHERE m.instance_id=$1 AND m.queue_id=$2 FOR UPDATE OF m,r",
          [data.instanceId, data.queueId],
        )
      ).rows[0];
      if (replay) {
        requireThat(
          replay.unexpired &&
            replay.state === "in_flight" &&
            replay.reservation_state === "held",
          403,
          "reservation_expired",
        );
        if (c.purpose === "worker")
          requireThat(
            replay.live_lease && replay.lease_id === data.workerLease,
            403,
            "lease_expired",
          );
        requireThat(
          replay.tenant_id === c.tenant_id &&
            replay.binding_hash ===
              this.binding(
                c.tenant_id,
                c.id,
                data.workerLease || null,
                data.envelopeFrom,
                to,
                data.contentHash,
              ) &&
            ["held", "uncertain"].includes(replay.reservation_state),
          403,
          "reservation_replay_mismatch",
        );
        if (c.purpose === "worker")
          await this.revalidate(db, replay.credential_id, "http");
        return {
          ok: true,
          reservationId: replay.reservation_id,
          messageId: replay.id,
          expiresAt: replay.expires_at,
          envelopeFrom: replay.envelope_from,
          ...(c.purpose === "keycloak"
            ? { smtpMessageId: replay.message_id }
            : {}),
        };
      }
      if (c.purpose === "worker") {
        requireThat(data.workerLease, 403, "lease_required");
        const m = (
          await db.query(
            "SELECT m.*,r.id AS reservation_id FROM messages m JOIN reservations r ON r.message_id=m.id AND r.tenant_id=m.tenant_id WHERE m.tenant_id=$1 AND m.lease_id=$2 AND m.state='in_flight' AND m.lease_until>clock_timestamp() AND m.expires_at>clock_timestamp() AND r.state='held' FOR UPDATE OF m,r",
            [c.tenant_id, data.workerLease],
          )
        ).rows[0];
        requireThat(m, 403, "lease_invalid");
        await this.revalidate(db, m.credential_id, "http");
        requireThat(
          m.content_hash === data.contentHash &&
            m.message_id === data.messageId &&
            m.envelope_from === data.envelopeFrom &&
            m.recipient_hash === this.digest(to),
          403,
          "binding_mismatch",
        );
        const payload = decrypt(
          m.content_cipher,
          this.config.contentKey,
          "message:" + m.tenant_id + ":" + m.id,
        );
        requireThat(
          payload.from === from &&
            (payload.replyTo || null) === (data.replyTo || null),
          403,
          "binding_mismatch",
        );
        const attempt = (
          await db.query(
            "SELECT smtp_credential_id FROM attempts WHERE lease_id=$1",
            [data.workerLease],
          )
        ).rows[0];
        requireThat(
          attempt?.smtp_credential_id === c.id,
          403,
          "binding_mismatch",
        );
        requireThat(!m.queue_id, 403, "lease_already_submitted");
        await db.query(
          "UPDATE messages SET queue_id=$2,instance_id=$3 WHERE id=$1",
          [m.id, data.queueId, data.instanceId],
        );
        await db.query(
          "UPDATE reservations SET lease_id=$2,binding_hash=$3 WHERE id=$1",
          [
            m.reservation_id,
            data.workerLease,
            this.binding(
              c.tenant_id,
              c.id,
              data.workerLease,
              data.envelopeFrom,
              to,
              data.contentHash,
            ),
          ],
        );
        return {
          ok: true,
          reservationId: m.reservation_id,
          messageId: m.id,
          expiresAt: m.expires_at,
          envelopeFrom: m.envelope_from,
        };
      }
      requireThat(!data.workerLease, 403, "unexpected_lease");
      requireThat(
        address(data.envelopeFrom) === from,
        403,
        "envelope_not_authorized",
      );
      await this.quota(db, c.tenant_id);
      const id = randomUUID();
      const reservationId = randomUUID();
      const smtpMessageId = "<" + id + "@" + this.config.emailDomain + ">";
      const envelopeFrom = "b+" + id + "@" + this.config.bounceDomain;
      const inserted = await db.query(
        "INSERT INTO messages(id,tenant_id,credential_id,source,state,content_hash,recipient_hash,message_id,envelope_from,queue_id,instance_id) VALUES($1,$2,$3,'smtp','in_flight',$4,$5,$6,$7,$8,$9) RETURNING expires_at",
        [
          id,
          c.tenant_id,
          c.id,
          data.contentHash,
          this.digest(to),
          smtpMessageId,
          envelopeFrom,
          data.queueId,
          data.instanceId,
        ],
      );
      await db.query(
        "INSERT INTO reservations(id,tenant_id,message_id,binding_hash) VALUES($1,$2,$3,$4)",
        [
          reservationId,
          c.tenant_id,
          id,
          this.binding(
            c.tenant_id,
            c.id,
            null,
            data.envelopeFrom,
            to,
            data.contentHash,
          ),
        ],
      );
      return {
        ok: true,
        reservationId,
        messageId: id,
        expiresAt: inserted.rows[0].expires_at,
        envelopeFrom,
        smtpMessageId,
      };
    });
  }
  async release(data) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      const r = (
        await db.query(
          "SELECT r.*,m.source,m.state AS message_state,m.queue_id,m.instance_id,m.lease_id AS message_lease FROM reservations r JOIN messages m ON m.id=r.message_id WHERE r.id=$1 FOR UPDATE OF r,m",
          [data.reservationId],
        )
      ).rows[0];
      if (!r) return { ok: true };
      if (
        r.instance_id !== data.instanceId ||
        r.queue_id !== data.queueId ||
        (r.lease_id || null) !== (data.workerLease || null) ||
        (r.message_lease || null) !== (data.workerLease || null)
      )
        return { ok: true };
      requireThat(
        data.provenNotAccepted === true,
        409,
        "acceptance_not_proven",
      );
      if (r.state === "held" && r.message_state === "in_flight") {
        await this.rejectBeforeAcceptance(db, r.message_id, r.source, 451);
      }
      return { ok: true };
    });
  }
  async rejectBeforeAcceptance(db, id, source, responseCode) {
    const retry = source === "http" && responseCode < 500;
    await db.query(
      "UPDATE attempts SET finished_at=clock_timestamp(),outcome=$2 WHERE message_id=$1 AND lease_id=(SELECT lease_id FROM messages WHERE id=$1) AND finished_at IS NULL",
      [id, retry ? "rejected_temporary" : "rejected_permanent"],
    );
    await db.query(
      "UPDATE messages SET state=$2,terminal_at=CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,lease_id=NULL,lease_until=NULL,submission_started_at=NULL,queue_id=CASE WHEN $3 THEN NULL ELSE queue_id END,instance_id=CASE WHEN $3 THEN NULL ELSE instance_id END WHERE id=$1",
      [
        id,
        retry
          ? "queued"
          : source === "smtp"
            ? "rejected_submission"
            : "failed_permanent",
        retry,
      ],
    );
    await db.query(
      "UPDATE reservations SET state=$2,lease_id=NULL WHERE message_id=$1 AND state IN ('held','uncertain')",
      [id, retry ? "held" : "released"],
    );
    if (retry)
      await db.query(
        "UPDATE outbox SET available_at=clock_timestamp()+interval '60 seconds' WHERE message_id=$1",
        [id],
      );
  }
  async releaseByQueue(data) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      requireThat(
        data.instanceId === this.config.instanceId &&
          data.provenNotAccepted === true,
        403,
        "invalid_rejection_proof",
      );
      const m = (
        await db.query(
          "SELECT m.*,r.state AS reservation_state FROM messages m JOIN reservations r ON r.message_id=m.id WHERE instance_id=$1 AND queue_id=$2 FOR UPDATE OF m,r",
          [data.instanceId, data.queueId],
        )
      ).rows[0];
      if (!m) return { ok: true };
      if (
        !["held", "uncertain"].includes(m.reservation_state) ||
        !["in_flight", "outcome_unknown"].includes(m.state)
      )
        return { ok: true };
      const event = await db.query(
        "INSERT INTO events(event_key,tenant_id,message_id,type) VALUES($1,$2,$3,'rejected_prequeue') ON CONFLICT DO NOTHING RETURNING id",
        [data.instanceId + ":reject:" + data.eventId, m.tenant_id, m.id],
      );
      if (event.rowCount)
        await this.rejectBeforeAcceptance(
          db,
          m.id,
          m.source,
          data.responseCode,
        );
      return { ok: true };
    });
  }
  async event(data) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      requireThat(
        data.instanceId === this.config.instanceId,
        403,
        "instance_mismatch",
      );
      const m = (
        await db.query(
          "SELECT * FROM messages WHERE instance_id=$1 AND queue_id=$2 FOR UPDATE",
          [data.instanceId, data.queueId],
        )
      ).rows[0];
      if (!m) return { ok: true, ignored: true };
      if (data.messageId)
        requireThat(data.messageId === m.message_id, 403, "message_mismatch");
      const type = data.type;
      requireThat(
        [
          "accepted_local",
          "accepted_remote",
          "deferred",
          "failed_permanent",
          "expired",
        ].includes(type),
      );
      requireThat(
        !data.enhancedStatus ||
          /^[245]\.\d{1,3}\.\d{1,3}$/.test(data.enhancedStatus),
      );
      if (type === "accepted_remote")
        requireThat(
          data.enhancedStatus?.startsWith("2."),
          400,
          "invalid_status",
        );
      if (type === "failed_permanent")
        requireThat(
          data.enhancedStatus?.startsWith("5."),
          400,
          "invalid_status",
        );
      const inserted = await db.query(
        "INSERT INTO events(event_key,tenant_id,message_id,type,enhanced_status) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [
          data.instanceId + ":" + data.eventId,
          m.tenant_id,
          m.id,
          type,
          data.enhancedStatus ?? null,
        ],
      );
      if (!inserted.rowCount) return { ok: true, duplicate: true };
      const terminal = [
        "accepted_remote",
        "failed_permanent",
        "expired",
        "rejected_submission",
      ];
      const allowed =
        (m.state === "expired" && type === "accepted_remote") ||
        (!terminal.includes(m.state) &&
          !(m.state === "deferred" && type === "accepted_local"));
      if (allowed) {
        await db.query(
          "UPDATE attempts SET finished_at=COALESCE(finished_at,clock_timestamp()),outcome=$2 WHERE message_id=$1 AND lease_id=$3",
          [m.id, type, m.lease_id],
        );
        await db.query(
          "UPDATE messages SET state=$2,terminal_at=CASE WHEN $3 THEN clock_timestamp() ELSE terminal_at END WHERE id=$1",
          [m.id, type, terminal.includes(type)],
        );
        await db.query(
          "UPDATE reservations SET state='consumed' WHERE message_id=$1 AND state IN ('held','uncertain')",
          [m.id],
        );
      }
      if (
        allowed &&
        type === "failed_permanent" &&
        ["5.1.1", "5.1.3", "5.1.6"].includes(data.enhancedStatus)
      )
        await db.query(
          "INSERT INTO suppressions(tenant_id,recipient_hash,reason) VALUES($1,$2,'verified_invalid_address') ON CONFLICT DO NOTHING",
          [m.tenant_id, m.recipient_hash],
        );
      return { ok: true };
    });
  }
  async dsn(data) {
    return transaction(this.pool, async (db) => {
      await this.lock(db);
      requireThat(
        data.instanceId === this.config.instanceId,
        403,
        "instance_mismatch",
      );
      const m = (
        await db.query("SELECT id,tenant_id FROM messages WHERE id=$1", [
          data.messageId,
        ])
      ).rows[0];
      if (!m)
        return {
          ok: true,
          ignored: true,
          qualified: false,
          stateChanged: false,
        };
      await db.query(
        "INSERT INTO events(event_key,tenant_id,message_id,type) VALUES($1,$2,$3,'dsn_unverified') ON CONFLICT DO NOTHING",
        [data.instanceId + ":dsn:" + data.eventId, m.tenant_id, m.id],
      );
      return { ok: true, qualified: false, stateChanged: false };
    });
  }
}
