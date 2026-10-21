// src/middleware/errorHandler.js — Global Express error handler

export function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] ERROR:`, err.stack);

  // Body-parser errors (malformed JSON, payload too large) carry a 4xx
  // `status`; anything else unexpected is a 500 whose raw message (Prisma
  // query details, stack-ish text) must not reach clients in production.
  const statusCode = err.statusCode || err.status || 500;
  const message = statusCode >= 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(statusCode).json({
    success: false,
    message,
    data: null,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}
