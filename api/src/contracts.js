export const string = (maxLength = 255) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
export const uuid = { type: "string", format: "uuid" };
export const email = { ...string(254), format: "email" };
export const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const variables = {
  type: "object",
  maxProperties: 50,
  additionalProperties: {
    anyOf: [{ type: "string", maxLength: 10000 }, { type: "number" }],
  },
  propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
};
const content = {
  from: email,
  replyTo: email,
  subject: string(998),
  text: string(1000000),
  html: string(1000000),
};
export const template = object(
  {
    ...content,
    slug: { ...string(80), pattern: "^[a-z0-9][a-z0-9-]*$" },
    variables: {
      type: "array",
      maxItems: 50,
      items: object(
        {
          name: { ...string(64), pattern: "^[A-Za-z][A-Za-z0-9_]*$" },
          required: { type: "boolean" },
          default: string(10000),
        },
        ["name"],
      ),
    },
  },
  ["from", "subject", "slug"],
);
export const raw = object({ ...content, to: email }, ["to", "from", "subject"]);
export const send = object({ to: email, templateId: uuid, variables }, [
  "to",
  "templateId",
]);
export const preview = object({ variables }, []);
export const issue = object(
  {
    kind: { enum: ["http", "smtp"] },
    purpose: { enum: ["keycloak", "worker"] },
    scopes: {
      type: "array",
      uniqueItems: true,
      maxItems: 5,
      items: {
        enum: [
          "send:template",
          "send:raw",
          "logs:read",
          "stats:read",
          "templates:manage",
        ],
      },
    },
    expiresAt: { type: "string", format: "date-time" },
  },
  ["kind", "expiresAt"],
);
export const tenant = object(
  {
    slug: { ...string(80), pattern: "^[a-z0-9][a-z0-9-]*$" },
    name: string(120),
    application: string(80),
    environment: string(40),
    perMinute: { type: "integer", minimum: 1, maximum: 100000 },
    perDay: { type: "integer", minimum: 1, maximum: 1000000 },
  },
  ["slug", "name", "application", "environment"],
);
export const tenantUpdate = object(
  {
    active: { type: "boolean" },
    perMinute: { type: "integer", minimum: 1, maximum: 100000 },
    perDay: { type: "integer", minimum: 1, maximum: 1000000 },
  },
  [],
);
export const sender = object({ address: email, replyTo: { type: "boolean" } }, [
  "address",
]);
export const event = object(
  {
    eventId: string(200),
    instanceId: string(80),
    queueId: { ...string(80), pattern: "^[A-Za-z0-9]+$" },
    messageId: string(255),
    type: {
      enum: [
        "accepted_local",
        "accepted_remote",
        "deferred",
        "failed_permanent",
        "expired",
      ],
    },
    enhancedStatus: {
      type: "string",
      pattern: "^[245]\\.[0-9]{1,3}\\.[0-9]{1,3}$",
    },
  },
  ["eventId", "instanceId", "queueId", "type"],
);
export const reserve = object(
  {
    username: string(128),
    connectionId: uuid,
    envelopeFrom: email,
    recipient: email,
    headerFrom: email,
    replyTo: { anyOf: [email, { type: "null" }] },
    messageId: string(255),
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    mimeBytes: { type: "integer", minimum: 1, maximum: 1048576 },
    workerLease: { anyOf: [uuid, { type: "null" }] },
    queueId: { ...string(80), pattern: "^[A-Za-z0-9]+$" },
    instanceId: string(80),
  },
  [
    "username",
    "connectionId",
    "envelopeFrom",
    "recipient",
    "headerFrom",
    "messageId",
    "contentHash",
    "mimeBytes",
    "queueId",
    "instanceId",
  ],
);
export const connection = object(
  { connectionId: uuid, username: string(128) },
  ["connectionId"],
);
export const messageResponse = object({ id: uuid, state: string(30) }, [
  "id",
  "state",
]);
export const errorResponse = object({
  error: string(80),
  requestId: string(100),
});
export function successSchema(method, url) {
  const ok = object({ ok: { const: true } }, ["ok"]);
  const id = object({ id: uuid });
  const date = { type: "string", format: "date-time" };
  const nullableDate = { anyOf: [date, { type: "null" }] };
  const state = {
    enum: [
      "queued",
      "in_flight",
      "accepted_local",
      "deferred",
      "accepted_remote",
      "failed_permanent",
      "rejected_submission",
      "expired",
      "outcome_unknown",
    ],
  };
  const row = object({
    id: uuid,
    state,
    created_at: date,
    terminal_at: nullableDate,
  });
  const eventRow = object({
    type: string(40),
    enhanced_status: { anyOf: [string(20), { type: "null" }] },
    created_at: date,
  });
  const array = (items) => ({ type: "array", items });
  if (url.startsWith("/internal/")) {
    if (url.endsWith("/reserve"))
      return object(
        {
          ok: { const: true },
          reservationId: uuid,
          messageId: uuid,
          expiresAt: date,
          envelopeFrom: email,
          smtpMessageId: string(255),
        },
        ["ok", "reservationId", "messageId", "expiresAt", "envelopeFrom"],
      );
    if (url.endsWith("/auth"))
      return object({
        ok: { const: true },
        credentialId: uuid,
        purpose: { enum: ["keycloak", "worker"] },
      });
    if (url.endsWith("/dsn"))
      return object(
        {
          ok: { const: true },
          qualified: { const: false },
          stateChanged: { const: false },
          ignored: { type: "boolean" },
        },
        ["ok", "qualified", "stateChanged"],
      );
    if (url.endsWith("/queue-check"))
      return object({
        ok: { const: true },
        release: array(
          object({
            queueId: string(80),
            expiresAt: { type: "string", format: "date-time" },
          }),
        ),
        remove: array(
          object({ queueId: string(80), reason: { const: "expired" } }),
        ),
      });
    if (url.endsWith("/event") || url.endsWith("/commit"))
      return object(
        {
          ok: { const: true },
          ignored: { type: "boolean" },
          duplicate: { type: "boolean" },
        },
        ["ok"],
      );
    return ok;
  }
  if (url === "/api/v1/send" || url === "/api/v1/send/raw")
    return messageResponse;
  if (url === "/api/v1/messages/:id")
    return object({
      ...row.properties,
      expires_at: date,
      events: array(eventRow),
    });
  if (url === "/api/v1/logs") return array(row);
  if (url === "/api/v1/stats")
    return array(object({ state, count: { type: "integer", minimum: 0 } }));
  if (url.endsWith("/preview"))
    return object(
      {
        from: email,
        replyTo: email,
        subject: string(998),
        text: string(1000000),
        html: string(1000000),
      },
      ["from", "subject"],
    );
  if (url === "/api/v1/templates" && method === "GET")
    return array(
      object({
        id: uuid,
        slug: string(80),
        active: { type: "boolean" },
        version: { type: "integer" },
        created_at: date,
      }),
    );
  if (url.includes("/templates")) return method === "DELETE" ? ok : id;
  if (url.endsWith("/credentials") && method === "POST")
    return object({
      id: uuid,
      secret: string(128),
      username: { anyOf: [string(128), { type: "null" }] },
      scopes: array(string(40)),
      expiresAt: date,
    });
  if (url.endsWith("/credentials") && method === "GET")
    return array(
      object({
        id: uuid,
        kind: { enum: ["http", "smtp"] },
        purpose: {
          anyOf: [{ enum: ["keycloak", "worker"] }, { type: "null" }],
        },
        username: { anyOf: [string(128), { type: "null" }] },
        scopes: array(string(40)),
        expires_at: date,
        revoked_at: nullableDate,
        created_at: date,
      }),
    );
  if (url.endsWith("/senders") && method === "GET")
    return array(object({ address: email, reply_to: { type: "boolean" } }));
  if (url.endsWith("/suppressions") && method === "GET")
    return array(
      object({
        recipient_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        reason: string(80),
        created_at: date,
      }),
    );
  if (url.endsWith("/quotas") && method === "GET")
    return object({ service_daily: { type: "integer", minimum: 1 } });
  if (url === "/api/v1/admin/tenants" && method === "GET")
    return array(
      object({
        id: uuid,
        slug: string(80),
        name: string(120),
        application: string(80),
        environment: string(40),
        active: { type: "boolean" },
        per_minute: { type: "integer" },
        per_day: { type: "integer" },
      }),
    );
  if (url === "/api/v1/admin/audit")
    return array(
      object({
        actor_id: { anyOf: [uuid, { type: "null" }] },
        action: string(80),
        resource_id: { anyOf: [uuid, { type: "null" }] },
        created_at: date,
      }),
    );
  if (
    url.endsWith("/senders") ||
    url.endsWith("/dispatch") ||
    url.endsWith("/suppressions") ||
    url.endsWith("/quotas")
  )
    return ok;
  return id;
}
