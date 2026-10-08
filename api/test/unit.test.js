import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { render, compose, mimeHash, address } from "../src/mail.js";
import { encrypt, decrypt, canonical, opaque } from "../src/crypto.js";
import { loadConfig } from "../src/config/index.js";
import { generateOpenApi } from "../scripts/openapi.js";
import { createPool } from "../src/db/postgres.js";
import { createRedis } from "../src/db/redis.js";
test("async database and Redis errors emit only fixed sanitized labels without connecting", async (t) => {
  const lines = [];
  t.mock.method(console, "error", (value) => lines.push(value));
  const pool = createPool({
    databaseUrl: "postgresql://synthetic:unused@invalid.test/db",
  });
  const redis = createRedis({
    redisUrl: "redis://default:unused@invalid.test:6379",
  });
  try {
    pool.emit(
      "error",
      new Error(
        "password=SYNTHETIC_SECRET recipient=person@example.test body=RESET_LINK",
      ),
    );
    redis.emit(
      "error",
      new Error(
        "password=SYNTHETIC_SECRET recipient=person@example.test body=RESET_LINK",
      ),
    );
    assert.deepEqual(lines, [
      "database_connection_error",
      "redis_connection_error",
    ]);
    assert.equal(redis.status, "wait");
    assert.equal(pool.totalCount, 0);
  } finally {
    redis.disconnect();
    await pool.end();
  }
});
test("imports do not connect, listen or send", async () => {
  for (const file of [
    "index",
    "internal",
    "worker",
    "bootstrap",
    "maintenance",
    "db/migrate",
  ])
    await import("../src/" + file + ".js");
});
test("AES-GCM rejects altered ciphertext and cross-tenant context", () => {
  const key = randomBytes(32);
  const cipher = encrypt({ text: "synthetic secret" }, key, "tenant-a");
  assert.deepEqual(decrypt(cipher, key, "tenant-a"), {
    text: "synthetic secret",
  });
  assert.throws(() => decrypt(cipher, key, "tenant-b"));
  assert.throws(() => decrypt(cipher.slice(0, -4) + "AAAA", key, "tenant-a"));
  assert.ok(!cipher.includes("synthetic"));
});
test("canonical request hashing independent of property order", () =>
  assert.equal(
    canonical({ b: 2, a: { d: 4, c: 3 } }),
    canonical({ a: { c: 3, d: 4 }, b: 2 }),
  ));
test("strict template required variables, HTML escaping and no dynamic includes", () => {
  const t = {
    from: "sender@example.test",
    subject: "Hello {{name}}",
    html: "<p>{{name}}</p>",
    variables: [{ name: "name", required: true }],
  };
  assert.equal(render(t, { name: "<script>" }).html, "<p>&lt;script&gt;</p>");
  assert.throws(() => render(t, {}));
  assert.throws(() => render(t, { name: "x", other: "x" }));
  for (const subject of [
    "{{> url}}",
    "{{{name}}}",
    "{{#if name}}x{{/if}}",
    '{{lookup name "x"}}',
    "{{constructor}}",
  ])
    assert.throws(() => render({ ...t, subject }, { name: "x" }));
});

test("template boundaries reject AST objects before inspecting or compiling them", () => {
  let inspected = false;
  const ast = {
    type: "Program",
    get body() {
      inspected = true;
      return [];
    },
  };
  for (const field of ["subject", "text", "html"]) {
    for (const source of [ast, [], false, 0]) {
      assert.throws(
        () =>
          render({
            from: "sender@example.test",
            subject: "Hello",
            text: "Body",
            [field]: source,
          }),
        (error) =>
          error.statusCode === 400 && error.code === "invalid_template",
      );
    }
  }
  assert.equal(inspected, false);
});
test("mail rejects injection and recipients lists", async () => {
  assert.throws(() => address("a@example.test,b@example.test"));
  assert.throws(() => address("a@example.test\r\nBcc: b@example.test"));
  await assert.rejects(
    compose(
      { from: "a@example.test", subject: "x\r\nBcc: x", text: "x" },
      "b@example.test",
      "<id@example.test>",
    ),
  );
});
test("immutable MIME hash canonicalizes folding and ignores only infrastructure headers", async () => {
  const built = await compose(
    { from: "a@example.test", subject: "Synthetic", text: "controlled text" },
    "b@example.test",
    "<stable@example.test>",
  );
  const raw = Buffer.from(built.raw, "base64");
  assert.equal(mimeHash(raw), built.contentHash);
  assert.equal(
    mimeHash(
      Buffer.concat([
        Buffer.from("Received: controlled\r\nX-Verde2-Lease: abc\r\n"),
        raw,
      ]),
    ),
    built.contentHash,
  );
  assert.notEqual(
    mimeHash(
      Buffer.from(raw.toString().replace("controlled text", "changed text")),
    ),
    built.contentHash,
  );
});
test("configuration fails without mandatory secrets and rejects TLS port fallback", () => {
  assert.throws(() => loadConfig({}));
  const env = {
    DATABASE_URL: "postgresql://user:password@postgres.test/test",
    REDIS_URL: "redis://default:password@redis.test:6379",
    CONTENT_KEY: randomBytes(32).toString("base64"),
    CREDENTIAL_PEPPER: opaque(),
    INTERNAL_TOKEN: opaque(),
    SMTP_HOST: "smtp.example.test",
    SMTP_CA_FILE: "/ca.pem",
    EMAIL_DOMAIN: "example.test",
    BOUNCE_DOMAIN: "bounce.example.test",
    MAIL_INSTANCE_ID: "test",
  };
  assert.equal(loadConfig(env).smtpPort, 587);
  assert.throws(() => loadConfig({ ...env, SMTP_PORT: "25" }));
  assert.throws(() => loadConfig({ ...env, TRUSTED_PROXIES: "true" }));
  assert.throws(() => loadConfig({ ...env, CONTENT_KEY: "short" }));
});
test("HTTP hooks return 401 safely and internals do not exist publicly", async () => {
  const app = await buildApp({ store: {}, config: {} });
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/logs" });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "unauthorized");
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/internal/v1/auth",
          payload: { username: "x", password: "x" },
        })
      ).statusCode,
      404,
    );
    assert.equal((await app.inject("/health/live")).statusCode, 200);
  } finally {
    await app.close();
  }
});
test("application send-only scope never grants logs/admin/raw and error redaction", async () => {
  const token = opaque();
  const app = await buildApp({
    store: {
      credential: async (_token, kind) => {
        if (kind === "admin")
          throw new Error("postgres password=synthetic to=secret@example.test");
        return { scopes: ["send:template"] };
      },
    },
    config: {},
  });
  try {
    for (const url of ["/api/v1/logs", "/api/v1/stats"])
      assert.equal(
        (
          await app.inject({
            url,
            headers: { authorization: "Bearer " + token },
          })
        ).statusCode,
        403,
      );
    const response = await app.inject({
      url: "/api/v1/admin/tenants",
      headers: { authorization: "Bearer " + token },
    });
    assert.equal(response.statusCode, 500);
    assert.ok(!response.body.includes("password"));
    assert.ok(!response.body.includes("@"));
  } finally {
    await app.close();
  }
});
test("HTTP parser rejects oversized bodies, malformed JSON and unsupported media without store access", async () => {
  let storeCalls = 0;
  const deniedStore = () => {
    storeCalls++;
    throw new Error("store_must_not_run");
  };
  const app = await buildApp({
    store: { credential: deniedStore, admit: deniedStore },
    config: {},
  });
  try {
    for (const [payload, contentType, status, code] of [
      [
        JSON.stringify({
          secret: "SYNTHETIC_CONTENT_CANARY" + "x".repeat(1100000),
        }),
        "application/json",
        413,
        "payload_too_large",
      ],
      [
        '{"secret":"SYNTHETIC_CONTENT_CANARY",',
        "application/json",
        400,
        "invalid_request",
      ],
      ["", "application/json", 400, "invalid_request"],
      [
        "SYNTHETIC_CONTENT_CANARY",
        "application/octet-stream",
        415,
        "unsupported_media_type",
      ],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/send/raw",
        headers: {
          authorization: "Bearer " + opaque(),
          "idempotency-key": "parser-rejection",
          "content-type": contentType,
        },
        payload,
      });
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.json().error, code);
      assert.deepEqual(Object.keys(response.json()).sort(), [
        "error",
        "requestId",
      ]);
      assert.ok(!response.body.includes("SYNTHETIC_CONTENT_CANARY"));
    }
    assert.equal(storeCalls, 0);
  } finally {
    await app.close();
  }
});
test("OpenAPI matches implementation-generated routes and defines success schemas", async () => {
  const doc = await generateOpenApi();
  const release =
    doc.paths["/internal/v1/queue-check"].post.responses[200].content[
      "application/json"
    ].schema.properties.release;
  assert.equal(release.items.type, "object");
  assert.deepEqual(release.items.required, ["queueId", "expiresAt"]);
  assert.equal(release.items.properties.expiresAt.format, "date-time");
  assert.deepEqual(
    JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ),
    doc,
  );
  for (const methods of Object.values(doc.paths))
    for (const operation of Object.values(methods)) {
      const response = Object.entries(operation.responses).find(([code]) =>
        code.startsWith("2"),
      )[1];
      assert.ok(response.content["application/json"].schema.type);
      assert.ok(operation.security);
    }
});
