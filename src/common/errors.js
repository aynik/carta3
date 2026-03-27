export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
}
