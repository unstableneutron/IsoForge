import { DomainError } from './domain';
import type { ApiErrorBody } from './types';

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof DomainError) {
    const body: ApiErrorBody = { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } };
    return json(body, error.status);
  }
  console.error(error);
  return json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } } satisfies ApiErrorBody, 500);
}

export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415);
  }
  try {
    return await request.json() as T;
  } catch {
    throw new DomainError('INVALID_JSON', 'Request body is not valid JSON');
  }
}
