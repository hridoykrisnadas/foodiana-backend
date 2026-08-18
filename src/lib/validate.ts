import type { z } from 'zod';
import { badRequest } from './errors.js';

/** Parse a request body/query with zod, turning failures into a 400 ApiError. */
export function parseBody<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    throw badRequest(
      'Request validation failed',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
  return result.data;
}
