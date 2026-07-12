import { err } from "../env.ts";

export class ApiError extends Error {
  readonly status: number;

  constructor(
    status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return await request.json<T>();
  } catch (cause) {
    throw new ApiError(400, "invalid JSON body", { cause });
  }
}

export async function clientInput<T>(
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "invalid request";
    throw new ApiError(400, message, { cause });
  }
}

export function apiErrorResponse(error: unknown, request: Request, url: URL): Response {
  if (error instanceof ApiError) return err(error.message, error.status);
  console.error({
    event: "api.unhandled_error",
    method: request.method,
    path: url.pathname,
    error: error instanceof Error ? error.message : String(error),
  });
  return err("internal error", 500);
}
