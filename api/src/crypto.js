import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export const opaque = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const fingerprint = (value, pepper) =>
  createHmac("sha256", pepper).update(value).digest("hex");
export function constantEqual(a, b) {
  const x = Buffer.from(a || "");
  const y = Buffer.from(b || "");
  return x.length === y.length && timingSafeEqual(x, y);
}
export function encrypt(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data]
    .map((x) => x.toString("base64"))
    .join(".");
}
export function decrypt(value, key, context) {
  const [iv, tag, data] = value.split(".").map((x) => Buffer.from(x, "base64"));
  const cipher = createDecipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(data), cipher.final()]).toString(),
  );
}
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
