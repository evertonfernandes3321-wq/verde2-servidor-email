import { requireThat } from "../errors.js";
export function loadConfig(env = process.env) {
  for (const key of [
    "DATABASE_URL",
    "REDIS_URL",
    "CONTENT_KEY",
    "CREDENTIAL_PEPPER",
    "INTERNAL_TOKEN",
    "SMTP_HOST",
    "SMTP_CA_FILE",
    "EMAIL_DOMAIN",
    "BOUNCE_DOMAIN",
    "MAIL_INSTANCE_ID",
  ])
    requireThat(env[key], 500, "configuration_" + key);
  const contentKey = Buffer.from(env.CONTENT_KEY, "base64");
  requireThat(
    contentKey.length === 32 &&
      contentKey.toString("base64") === env.CONTENT_KEY,
    500,
    "configuration_CONTENT_KEY",
  );
  for (const key of ["CREDENTIAL_PEPPER", "INTERNAL_TOKEN"])
    requireThat(
      /^[A-Za-z0-9_-]{32,128}$/.test(env[key]),
      500,
      "configuration_" + key,
    );
  for (const [key, protocols] of [
    ["DATABASE_URL", ["postgres:", "postgresql:"]],
    ["REDIS_URL", ["redis:", "rediss:"]],
  ]) {
    let url;
    try {
      url = new URL(env[key]);
    } catch {
      requireThat(false, 500, "configuration_" + key);
    }
    requireThat(
      protocols.includes(url.protocol) &&
        url.hostname &&
        url.username &&
        url.password,
      500,
      "configuration_" + key,
    );
  }
  const domain =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  requireThat(
    domain.test(env.EMAIL_DOMAIN) &&
      domain.test(env.BOUNCE_DOMAIN) &&
      domain.test(env.SMTP_HOST),
    500,
    "configuration_domain",
  );
  requireThat(
    env.BOUNCE_DOMAIN !== env.EMAIL_DOMAIN,
    500,
    "configuration_bounce_domain",
  );
  requireThat(
    /^[a-zA-Z0-9_-]{1,80}$/.test(env.MAIL_INSTANCE_ID),
    500,
    "configuration_instance",
  );
  const number = (name, fallback, max) => {
    const n = Number(env[name] || fallback);
    requireThat(
      Number.isInteger(n) && n > 0 && n <= max,
      500,
      "configuration_" + name,
    );
    return n;
  };
  requireThat(
    !env.SMTP_PORT || env.SMTP_PORT === "587",
    500,
    "configuration_SMTP_PORT",
  );
  const proxies = env.TRUSTED_PROXIES?.split(",");
  requireThat(
    !proxies ||
      proxies.every(
        (p) =>
          /^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:[1-9]|[12]\d|3[0-2]))?$/.test(p) &&
          !p.startsWith("0."),
      ),
    500,
    "configuration_TRUSTED_PROXIES",
  );
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    contentKey,
    pepper: env.CREDENTIAL_PEPPER,
    internalToken: env.INTERNAL_TOKEN,
    smtpHost: env.SMTP_HOST,
    smtpPort: 587,
    smtpCaFile: env.SMTP_CA_FILE,
    emailDomain: env.EMAIL_DOMAIN,
    bounceDomain: env.BOUNCE_DOMAIN,
    instanceId: env.MAIL_INSTANCE_ID,
    port: number("PORT", 3000, 65535),
    internalPort: number("INTERNAL_PORT", 3001, 65535),
    serviceDaily: number("SERVICE_DAILY_QUOTA", 2000, 1000000),
    httpRateLimit: number("HTTP_RATE_LIMIT", 300, 100000),
    concurrency: number("WORKER_CONCURRENCY", 2, 2),
    internalCert: env.INTERNAL_TLS_CERT_FILE,
    internalKey: env.INTERNAL_TLS_KEY_FILE,
    trustProxy: proxies || false,
  };
}
