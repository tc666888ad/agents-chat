export class RtError extends Error {
  constructor(readonly code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE' | 'UNAUTHORIZED', message: string) {
    super(message);
  }
}
