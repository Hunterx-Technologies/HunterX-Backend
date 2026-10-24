// src/utils/response.js — Standard API response helpers

export function success(res, data = null, message = 'Success', statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

// code (optional): a machine-readable reason the app can branch on, sent
// as error.code alongside the usual top-level message.
export function error(res, message = 'Something went wrong', statusCode = 400, code = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    data: null,
    ...(code ? { error: { code, message } } : {}),
  });
}
