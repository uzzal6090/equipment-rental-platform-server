class AppError extends Error {
  constructor(message, statusCode = 500, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || "INTERNAL_SERVER_ERROR";
    Error.captureStackTrace(this, this.constructor);
  }
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const code = err.code || "INTERNAL_SERVER_ERROR";

  let message = err.message || "Internal server error";

  // Body-parser body-too-large errors: clear, safe client-facing message.
  if (err.type === "entity.too.large" || statusCode === 413) {
    message = "Request body too large";
  }

  if (process.env.NODE_ENV === "production" && statusCode === 500) {
    message = "Internal server error";
  }

  const response = {
    success: false,
    error: {
      message,
      code: err.type === "entity.too.large" || statusCode === 413 ? "PAYLOAD_TOO_LARGE" : code,
    },
  };

  // Keep detailed diagnostics server-side only: never in client responses.
  if (statusCode >= 500) {
    console.error("API error:", err);
  }

  res.status(statusCode).json(response);
}

export { AppError, asyncHandler, errorHandler };
