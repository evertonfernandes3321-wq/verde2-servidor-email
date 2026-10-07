import Fastify, { LogController } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Fault, requireThat } from "./errors.js";
import { constantEqual } from "./crypto.js";
import * as s from "./contracts.js";
export async function buildApp({
  store,
  config,
  internal = false,
  https,
  logger = false,
  collect,
}) {
  const app = Fastify({
    logger,
    https,
    trustProxy: config.trustProxy ?? false,
    bodyLimit: 1100000,
    logController: new LogController({ disableRequestLogging: true }),
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
      },
    },
  });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: internal ? 30000 : config.httpRateLimit || 300,
    timeWindow: 60000,
  });
  app.setErrorHandler((error, request, reply) => {
    const parserError = {
      FST_ERR_CTP_BODY_TOO_LARGE: [413, "payload_too_large"],
      FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, "unsupported_media_type"],
      FST_ERR_CTP_INVALID_JSON_BODY: [400, "invalid_request"],
      FST_ERR_CTP_EMPTY_JSON_BODY: [400, "invalid_request"],
      FST_ERR_CTP_INVALID_CONTENT_LENGTH: [400, "invalid_request"],
    }[error.code];
    const status =
      error instanceof Fault
        ? error.statusCode
        : error.validation
          ? 400
          : error.statusCode === 429
            ? 429
            : (parserError?.[0] ?? 500);
    const code =
      error instanceof Fault
        ? error.code
        : error.validation
          ? "invalid_request"
          : status === 429
            ? "rate_limited"
            : (parserError?.[1] ?? "internal_error");
    reply.code(status).send({ error: code, requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: "not_found", requestId: request.id }),
  );
  const add = (
    method,
    url,
    {
      body,
      params,
      scope,
      admin = false,
      status = 200,
      description = "",
      response,
    } = {},
    handler,
  ) => {
    response ??= s.successSchema(method, url);
    const schema = {
      ...(body ? { body } : {}),
      ...(params ? { params } : {}),
      response: {
        400: s.errorResponse,
        401: s.errorResponse,
        403: s.errorResponse,
        404: s.errorResponse,
        409: s.errorResponse,
        413: s.errorResponse,
        415: s.errorResponse,
        422: s.errorResponse,
        429: s.errorResponse,
        500: s.errorResponse,
        503: s.errorResponse,
        ...(response ? { [status]: response } : {}),
      },
    };
    const sending = url === "/api/v1/send" || url === "/api/v1/send/raw";
    if (sending)
      schema.headers = {
        type: "object",
        required: ["idempotency-key"],
        properties: {
          "idempotency-key": {
            type: "string",
            minLength: 1,
            maxLength: 128,
            pattern: "^[A-Za-z0-9._:-]+$",
          },
        },
      };
    collect?.push({
      method,
      url,
      body,
      params,
      scope,
      admin,
      status,
      description,
      response,
      sending,
      internal,
    });
    app.route({
      method,
      url,
      schema,
      preHandler: async (request) => {
        const authorization = request.headers.authorization || "";
        requireThat(
          /^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization),
          401,
          "unauthorized",
        );
        const token = authorization.slice(7);
        if (internal) {
          requireThat(
            constantEqual(token, config.internalToken),
            401,
            "unauthorized",
          );
          return;
        }
        request.actor = await store.credential(token, admin ? "admin" : "http");
        if (scope)
          requireThat(
            request.actor.scopes.includes(scope),
            403,
            "scope_required",
          );
      },
      handler: async (request, reply) => {
        reply.code(status);
        return handler(request);
      },
    });
  };
  app.get("/health/live", async () => ({ ok: true }));
  app.get("/health/ready", async () => {
    await store.pool.query("SELECT 1");
    return { ok: true };
  });
  if (internal) {
    add(
      "POST",
      "/internal/v1/auth",
      { body: s.object({ username: s.string(128), password: s.string(256) }) },
      (r) => store.smtpAuth(r.body),
    );
    add(
      "POST",
      "/internal/v1/dsn-address",
      { body: s.object({ recipient: s.email }) },
      async (r) => {
        const suffix = "@" + config.bounceDomain;
        requireThat(
          r.body.recipient.endsWith(suffix),
          403,
          "dsn_recipient_denied",
        );
        const id = r.body.recipient.slice(2, -suffix.length);
        requireThat(
          r.body.recipient.startsWith("b+") && /^[a-f0-9-]{36}$/.test(id),
          403,
          "dsn_recipient_denied",
        );
        requireThat(
          (
            await store.pool.query(
              "SELECT 1 FROM messages WHERE id=$1 AND envelope_from=$2",
              [id, r.body.recipient],
            )
          ).rowCount,
          403,
          "dsn_recipient_denied",
        );
        return { ok: true };
      },
    );
    for (const operation of ["open", "close"])
      add(
        "POST",
        "/internal/v1/connections/" + operation,
        { body: s.connection },
        (r) => store.connection(r.body, operation === "close"),
      );
    add("POST", "/internal/v1/reserve", { body: s.reserve }, (r) =>
      store.reserve(r.body),
    );
    add(
      "POST",
      "/internal/v1/release",
      {
        body: s.object(
          {
            reservationId: s.uuid,
            instanceId: s.string(80),
            queueId: { ...s.string(80), pattern: "^[A-Za-z0-9]+$" },
            workerLease: { anyOf: [s.uuid, { type: "null" }] },
            provenNotAccepted: { const: true },
            reason: { enum: ["prequeue_abort"] },
          },
          [
            "reservationId",
            "instanceId",
            "queueId",
            "workerLease",
            "provenNotAccepted",
          ],
        ),
      },
      (r) => store.release(r.body),
    );
    for (const name of ["commit", "event"])
      add("POST", "/internal/v1/" + name, { body: s.event }, (r) =>
        store.event(r.body),
      );
    add(
      "POST",
      "/internal/v1/release-by-queue",
      {
        body: s.object({
          instanceId: s.string(80),
          queueId: { ...s.string(80), pattern: "^[A-Za-z0-9]+$" },
          eventId: s.string(200),
          reason: { const: "milter_rejected" },
          provenNotAccepted: { const: true },
          responseCode: { type: "integer", minimum: 400, maximum: 599 },
        }),
      },
      (r) => store.releaseByQueue(r.body),
    );
    add(
      "POST",
      "/internal/v1/dsn",
      {
        body: s.object({
          eventId: s.string(200),
          messageId: s.uuid,
          qualified: { const: false },
          statuses: { type: "array", maxItems: 20, items: s.string(30) },
          instanceId: s.string(80),
        }),
      },
      (r) => store.dsn(r.body),
    );
    add(
      "POST",
      "/internal/v1/readiness",
      { body: s.object({ instanceId: s.string(80) }) },
      async (r) => {
        requireThat(
          r.body.instanceId === config.instanceId,
          403,
          "instance_mismatch",
        );
        requireThat(
          (
            await store.pool.query(
              "SELECT dispatch_enabled FROM control WHERE id=true",
            )
          ).rows[0]?.dispatch_enabled,
          503,
          "dispatch_paused",
        );
        return { ok: true };
      },
    );
    add(
      "POST",
      "/internal/v1/queue-check",
      {
        body: s.object({
          instanceId: s.string(80),
          queueIds: {
            type: "array",
            maxItems: 10000,
            items: { ...s.string(80), pattern: "^[A-Za-z0-9]+$" },
          },
        }),
      },
      async (r) => {
        requireThat(
          r.body.instanceId === config.instanceId,
          403,
          "instance_mismatch",
        );
        const rows = (
          await store.pool.query(
            'SELECT queue_id AS "queueId" FROM messages WHERE instance_id=$1 AND queue_id=ANY($2::text[]) AND expires_at<=clock_timestamp()',
            [r.body.instanceId, r.body.queueIds],
          )
        ).rows;
        return {
          ok: true,
          remove: rows.map((row) => ({ ...row, reason: "expired" })),
          release: (
            await store.pool.query(
              "SELECT queue_id,expires_at FROM messages WHERE instance_id=$1 AND queue_id=ANY($2::text[]) AND expires_at>clock_timestamp() AND state IN ('accepted_local','deferred') AND (SELECT dispatch_enabled FROM control WHERE id=true)",
              [r.body.instanceId, r.body.queueIds],
            )
          ).rows.map((row) => ({
            queueId: row.queue_id,
            expiresAt: row.expires_at.toISOString(),
          })),
        };
      },
    );
  } else {
    add(
      "POST",
      "/api/v1/send",
      {
        body: s.send,
        scope: "send:template",
        status: 202,
        response: s.messageResponse,
        description:
          "Persisted and accepted for processing, not delivered. Idempotency window 30 days. While dispatch is paused, new admissions return 503 dispatch_paused without persistence. An existing matching idempotency key returns its message; a conflicting payload returns 409.",
      },
      (r) => store.admit(r.actor, r.body, r.headers["idempotency-key"]),
    );
    add(
      "POST",
      "/api/v1/send/raw",
      {
        body: s.raw,
        scope: "send:raw",
        status: 202,
        response: s.messageResponse,
        description:
          "Persisted and accepted for processing, not delivered. Idempotency window 30 days. While dispatch is paused, new admissions return 503 dispatch_paused without persistence. An existing matching idempotency key returns its message; a conflicting payload returns 409.",
      },
      (r) => store.admit(r.actor, r.body, r.headers["idempotency-key"], true),
    );
    add(
      "GET",
      "/api/v1/messages/:id",
      { params: s.object({ id: s.uuid }), scope: "logs:read" },
      (r) => store.message(r.actor, r.params.id),
    );
    add("GET", "/api/v1/templates", { scope: "templates:manage" }, (r) =>
      store.templates(r.actor),
    );
    add(
      "POST",
      "/api/v1/templates",
      { body: s.template, scope: "templates:manage", status: 201 },
      (r) => store.template(r.actor, r.body),
    );
    add(
      "PUT",
      "/api/v1/templates/:id",
      {
        params: s.object({ id: s.uuid }),
        body: s.template,
        scope: "templates:manage",
      },
      (r) => store.template(r.actor, r.body, r.params.id),
    );
    add(
      "DELETE",
      "/api/v1/templates/:id",
      { params: s.object({ id: s.uuid }), scope: "templates:manage" },
      (r) => store.deleteTemplate(r.actor, r.params.id),
    );
    add(
      "POST",
      "/api/v1/templates/:id/preview",
      {
        params: s.object({ id: s.uuid }),
        body: s.preview,
        scope: "templates:manage",
      },
      (r) => store.preview(r.actor, r.params.id, r.body.variables),
    );
    add("GET", "/api/v1/logs", { scope: "logs:read" }, (r) =>
      store.logs(r.actor),
    );
    add("GET", "/api/v1/stats", { scope: "stats:read" }, (r) =>
      store.stats(r.actor),
    );
    add(
      "POST",
      "/api/v1/admin/tenants",
      { admin: true, body: s.tenant, status: 201 },
      (r) => store.createTenant(r.actor, r.body),
    );
    add(
      "PATCH",
      "/api/v1/admin/tenants/:id",
      { admin: true, params: s.object({ id: s.uuid }), body: s.tenantUpdate },
      (r) => store.updateTenant(r.actor, r.params.id, r.body),
    );
    add("GET", "/api/v1/admin/tenants", { admin: true }, async (r) =>
      store.admin(
        r.actor,
        async (db) =>
          (
            await db.query(
              "SELECT id,slug,name,application,environment,active,per_minute,per_day FROM tenants ORDER BY created_at DESC LIMIT 100",
            )
          ).rows,
      ),
    );
    add(
      "POST",
      "/api/v1/admin/tenants/:id/credentials",
      {
        admin: true,
        params: s.object({ id: s.uuid }),
        body: s.issue,
        status: 201,
      },
      (r) => store.issue(r.actor, r.params.id, r.body),
    );
    for (const [resource, selection, table] of [
      [
        "credentials",
        "id,kind,purpose,username,scopes,expires_at,revoked_at,created_at",
        "credentials",
      ],
      ["senders", "address,reply_to", "senders"],
      ["suppressions", "recipient_hash,reason,created_at", "suppressions"],
    ])
      add(
        "GET",
        "/api/v1/admin/tenants/:id/" + resource,
        { admin: true, params: s.object({ id: s.uuid }) },
        (r) =>
          store.admin(
            r.actor,
            async (db) =>
              (
                await db.query(
                  "SELECT " +
                    selection +
                    " FROM " +
                    table +
                    " WHERE tenant_id=$1 LIMIT 100",
                  [r.params.id],
                )
              ).rows,
          ),
      );
    add("GET", "/api/v1/admin/quotas", { admin: true }, (r) =>
      store.admin(
        r.actor,
        async (db) =>
          (await db.query("SELECT service_daily FROM control WHERE id=true"))
            .rows[0],
      ),
    );
    add(
      "POST",
      "/api/v1/admin/credentials",
      {
        admin: true,
        body: s.object({ expiresAt: { type: "string", format: "date-time" } }),
        status: 201,
      },
      (r) => store.issue(r.actor, null, { kind: "admin", ...r.body }),
    );
    add(
      "DELETE",
      "/api/v1/admin/credentials/:id",
      { admin: true, params: s.object({ id: s.uuid }) },
      (r) => store.revoke(r.actor, r.params.id),
    );
    for (const method of ["PUT", "DELETE"]) {
      add(
        method,
        "/api/v1/admin/tenants/:id/senders",
        { admin: true, params: s.object({ id: s.uuid }), body: s.sender },
        (r) => store.sender(r.actor, r.params.id, r.body, method === "DELETE"),
      );
      add(
        method,
        "/api/v1/admin/tenants/:id/suppressions",
        {
          admin: true,
          params: s.object({ id: s.uuid }),
          body: s.object({ recipient: s.email }),
        },
        (r) =>
          store.suppression(r.actor, r.params.id, r.body, method === "DELETE"),
      );
    }
    add(
      "PUT",
      "/api/v1/admin/quotas",
      {
        admin: true,
        body: s.object({
          serviceDaily: { type: "integer", minimum: 1, maximum: 1000000 },
        }),
      },
      (r) =>
        store.admin(r.actor, async (db) => {
          await db.query("UPDATE control SET service_daily=$1 WHERE id=true", [
            r.body.serviceDaily,
          ]);
          await store.audit(db, r.actor.id, "service.quota", null);
          return { ok: true };
        }),
    );
    add(
      "PUT",
      "/api/v1/admin/dispatch",
      {
        admin: true,
        body: s.object({ enabled: { type: "boolean" } }),
        description:
          "Explicit operator control. New installations and restores remain paused until the administrator enables dispatch after reconciliation.",
      },
      (r) =>
        store.admin(r.actor, async (db) => {
          await db.query(
            "UPDATE control SET dispatch_enabled=$1 WHERE id=true",
            [r.body.enabled],
          );
          await store.audit(
            db,
            r.actor.id,
            r.body.enabled ? "dispatch.enable" : "dispatch.disable",
            null,
          );
          return { ok: true };
        }),
    );
    add("GET", "/api/v1/admin/audit", { admin: true }, (r) =>
      store.admin(
        r.actor,
        async (db) =>
          (
            await db.query(
              "SELECT actor_id,action,resource_id,created_at FROM audit ORDER BY id DESC LIMIT 100",
            )
          ).rows,
      ),
    );
  }
  return app;
}
