export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
  get status(): number {
    return STATUS[this.code];
  }
}

export const unauthenticated = (m = '請先登入') => new AppError('UNAUTHENTICATED', m);
export const forbidden = (m = '沒有權限執行此操作') => new AppError('FORBIDDEN', m);
export const notFound = (what = '資料') => new AppError('NOT_FOUND', `找不到${what}`);
export const validation = (m: string, details?: unknown) => new AppError('VALIDATION', m, details);
export const conflict = (m: string, details?: unknown) => new AppError('CONFLICT', m, details);
export const precondition = (m: string, details?: unknown) => new AppError('PRECONDITION_FAILED', m, details);
