import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildApp } from "../src/app.js";
export async function generateOpenApi() {
  const routes = [];
  const store = {};
  const config = {};
  for (const internal of [false, true]) {
    const app = await buildApp({ store, config, internal, collect: routes });
    await app.close();
  }
  const paths = {};
  for (const route of routes) {
    const url = route.url.replace(/:([A-Za-z]+)/g, "{$1}");
    const parameters = Object.entries(route.params?.properties || {}).map(
      ([name, schema]) => ({ name, in: "path", required: true, schema }),
    );
    if (route.sending)
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        schema: { type: "string", minLength: 1, maxLength: 128 },
      });
    const responses = {};
    for (const status of [
      400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503,
    ])
      responses[status] = {
        description: "Sanitized error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      };
    responses[route.status] = {
      description:
        route.status === 202
          ? "Persisted and accepted for processing. Not delivery confirmation."
          : "Success",
      content: {
        "application/json": { schema: route.response || { type: "object" } },
      },
    };
    paths[url] ??= {};
    paths[url][route.method.toLowerCase()] = {
      operationId:
        route.method.toLowerCase() + url.replace(/[^a-zA-Z0-9]/g, "_"),
      description:
        route.description ||
        (route.internal
          ? "Private service control; authenticated internal credential. "
          : route.admin
            ? "Audited global administration; opaque administrative credential. "
            : "Tenant derived from credential. ") +
          (route.scope ? "Required scope: " + route.scope + "." : ""),
      tags: [
        route.internal ? "internal" : route.admin ? "admin" : "application",
      ],
      security: [
        {
          [route.internal ? "Internal" : route.admin ? "Admin" : "Application"]:
            [],
        },
      ],
      parameters,
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: route.body } },
            },
          }
        : {}),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Verde2 transactional email",
      version: "2.0.0",
      description:
        "One tenant per application/environment. Bearer credentials are opaque and expiring. API default scope send:template. SMTP credentials separate. No attachments; one recipient. Templates support escaped declared simple variables only. Internal endpoints are only available on the private TLS listener. Idempotency lasts 30 days.",
    },
    paths,
    components: {
      securitySchemes: Object.fromEntries(
        ["Application", "Admin", "Internal"].map((name) => [
          name,
          { type: "http", scheme: "bearer" },
        ]),
      ),
      schemas: {
        Error: {
          type: "object",
          additionalProperties: false,
          required: ["error", "requestId"],
          properties: {
            error: { type: "string" },
            requestId: { type: "string" },
          },
        },
      },
    },
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await writeFile(
    new URL("../openapi.json", import.meta.url),
    JSON.stringify(await generateOpenApi(), null, 2) + "\n",
  );
