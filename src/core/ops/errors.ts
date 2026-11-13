/** An expected failure with a stable code; the server maps it to a status and shows the message as-is. */
export class OpError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'EXISTS'
      | 'RISK_NOT_ACKNOWLEDGED'
      | 'NOT_SUPPORTED'
      | 'INVALID'
      | 'CLI_FAILED'
      | 'POLICY'
      | 'CONFLICT',
    message: string,
    readonly status = code === 'NOT_FOUND' ? 404 : code === 'EXISTS' || code === 'CONFLICT' ? 409 : code === 'POLICY' ? 403 : 400,
  ) {
    super(message);
  }
}
