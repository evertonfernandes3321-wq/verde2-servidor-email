import Handlebars from "handlebars";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { hash } from "./crypto.js";
import { requireThat, Fault } from "./errors.js";
export function address(value) {
  requireThat(
    typeof value === "string" &&
      value.length <= 254 &&
      /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(
        value,
      ),
  );
  return value.toLowerCase();
}
export function render(definition, variables = {}) {
  const names = new Set((definition.variables || []).map((v) => v.name));
  requireThat(
    Object.keys(variables).every((k) => names.has(k)),
    400,
    "invalid_variables",
  );
  const data = Object.create(null);
  for (const variable of definition.variables || []) {
    const value = variables[variable.name] ?? variable.default;
    requireThat(
      !variable.required || value !== undefined,
      400,
      "missing_variable",
    );
    requireThat(
      value === undefined ||
        typeof value === "string" ||
        typeof value === "number",
      400,
      "invalid_variable",
    );
    if (value !== undefined) data[variable.name] = value;
  }
  const run = (source, html = false) => {
    if (!source) return undefined;
    try {
      const ast = Handlebars.parse(source);
      const visit = (node) => {
        if (!node || typeof node !== "object") return;
        requireThat(
          ![
            "PartialStatement",
            "PartialBlockStatement",
            "BlockStatement",
            "SubExpression",
          ].includes(node.type),
          400,
          "unsupported_template",
        );
        if (node.type === "MustacheStatement")
          requireThat(
            node.escaped &&
              !node.params.length &&
              !node.hash &&
              names.has(node.path.original),
            400,
            "unsupported_template",
          );
        for (const v of Object.values(node))
          if (Array.isArray(v)) v.forEach(visit);
          else if (v && typeof v === "object") visit(v);
      };
      visit(ast);
      return Handlebars.compile(source, { strict: true, noEscape: !html })(
        data,
        {
          allowProtoMethodsByDefault: false,
          allowProtoPropertiesByDefault: false,
        },
      );
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(400, "template_render_failed");
    }
  };
  return {
    from: address(definition.from),
    replyTo: definition.replyTo ? address(definition.replyTo) : undefined,
    subject: run(definition.subject),
    text: run(definition.text),
    html: run(definition.html, true),
  };
}
export function mimeHash(raw) {
  const input = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = input.toString("binary").replace(/\r?\n/g, "\r\n");
  const split = text.indexOf("\r\n\r\n");
  requireThat(split >= 0);
  const lines = text.slice(0, split).split(/\r\n(?![ \t])/);
  const headers = lines
    .map((line) => {
      const i = line.indexOf(":");
      requireThat(i > 0);
      return [
        line.slice(0, i).toLowerCase(),
        line
          .slice(i + 1)
          .replace(/\r\n[ \t]+/g, " ")
          .trim(),
      ];
    })
    .filter(
      ([name]) =>
        ![
          "received",
          "return-path",
          "dkim-signature",
          "x-verde2-lease",
        ].includes(name),
    );
  return hash(
    Buffer.concat([
      Buffer.from(JSON.stringify(headers), "utf8"),
      Buffer.from("\r\n\r\n"),
      Buffer.from(text.slice(split + 4), "binary"),
    ]),
  );
}
export async function compose(content, to, messageId) {
  requireThat(
    typeof content.subject === "string" &&
      content.subject.length > 0 &&
      content.subject.length <= 998 &&
      !/[\r\n]/.test(content.subject),
  );
  requireThat(content.text || content.html, 400, "empty_message");
  const raw = await new MailComposer({
    from: address(content.from),
    to: address(to),
    replyTo: content.replyTo ? address(content.replyTo) : undefined,
    subject: content.subject,
    text: content.text,
    html: content.html,
    messageId,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
  requireThat(raw.length <= 1048576 - 16384, 413, "mime_too_large");
  return { raw: raw.toString("base64"), contentHash: mimeHash(raw) };
}
