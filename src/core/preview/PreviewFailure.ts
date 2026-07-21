export interface PreviewFailureOptions {
  maxLength?: number;
  redact?: (message: string) => string;
}

/**
 * Converts an operational failure into a bounded, single-line value that is
 * safe to persist in preview records or include in diagnostic messages.
 */
export function boundedPreviewFailure(error: unknown, options: PreviewFailureOptions = {}): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = options.redact ? options.redact(message) : message;
  return redacted.replace(/[\r\n]+/g, ' ').slice(0, options.maxLength ?? 512);
}
