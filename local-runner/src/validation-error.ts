/** Caller supplied a bad value; HTTP maps this to 400, MCP to a tool error. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
