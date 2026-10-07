export class Fault extends Error {
  constructor(status, code) {
    super(code);
    this.statusCode = status;
    this.code = code;
  }
}
export function requireThat(value, status = 400, code = "invalid_request") {
  if (!value) throw new Fault(status, code);
}
