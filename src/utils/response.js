// src/utils/response.js — Standard API response helpers

export function success(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

// code (optional): a machine-readable reason the app can branch on, sent
// as error.code alongside the usual top-level message. details (optional):
// extra fields for error, e.g. { reason } on ACCOUNT_SUSPENDED.
export function error(res, message = 'Something went wrong', statusCode = 400, code = null, details = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    ...(code ? { error: { code, message, ...(details ?? {}) } } : {}),
  });
}

// A banned account, on any request or sign-in: the app signs out at once and
// shows its "Account suspended" screen with the admin's reason.
export function accountSuspended(res, reason = null) {
  return error(res, 'Your account has been suspended', 403, 'ACCOUNT_SUSPENDED', { reason: reason || null });
}
