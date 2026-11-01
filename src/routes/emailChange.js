// src/routes/emailChange.js — Shared handler for PATCH /api/users/me/email
// (and its older aliases /api/users/email, /api/auth/email).
//
// Two calls, so an address is only ever put on an account once proven:
//   { email, currentPassword? }  → 202, a code is emailed to `email`
//                                   (error.code EMAIL_VERIFICATION_SENT)
//   { email, otp }               → 200 { user }, email changed + verified
// currentPassword is required for accounts that have a password.

import { success, error } from '../utils/response.js';
import * as authService from '../services/authService.js';

const EMAIL_CHANGE_ERRORS = {
  USER_NOT_FOUND:            [404, 'User not found'],
  EMAIL_REQUIRED:            [400, 'Email is required'],
  INVALID_EMAIL:             [400, 'Invalid email format'],
  EMAIL_UNCHANGED:           [400, 'That is already your email'],
  EMAIL_EXISTS:              [409, 'An account with this email already exists'],
  CURRENT_PASSWORD_REQUIRED: [400, 'Enter your current password to change your email'],
  INVALID_CURRENT_PASSWORD:  [401, 'Current password is incorrect'],
  OTP_COOLDOWN:              [429, 'Please wait a minute before requesting another code'],
  EMAIL_SEND_FAILED:         [502, 'Could not send the verification email. Please try again.'],
  OTP_INVALID:               [400, 'Invalid verification code'],
  OTP_EXPIRED:               [410, 'This code has expired. Request a new one.'],
  OTP_TOO_MANY_ATTEMPTS:     [423, 'Too many wrong codes. Request a new one.'],
};

export async function handleEmailChange(req, res, next) {
  try {
    const { email, otp, currentPassword } = req.body || {};
    if (otp !== undefined && otp !== null && otp !== '') {
      if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim()))
        return error(res, 'Verification code must be exactly 6 digits', 400, 'OTP_INVALID');
      const user = await authService.confirmEmailChange(req.user.id, email, otp);
      return success(res, { user }, 'Email updated successfully');
    }
    const result = await authService.requestEmailChange(req.user.id, email, currentPassword);
    return res.status(202).json({
      success: true,
      message: `We sent a 6-digit code to ${result.email}. Enter it to confirm your new email.`,
      data:    { pending: true, email: result.email },
      error:   { code: 'EMAIL_VERIFICATION_SENT', message: 'Verification code sent' },
    });
  } catch (err) {
    const known = EMAIL_CHANGE_ERRORS[err.message];
    if (known) return error(res, known[1], known[0], err.message);
    next(err);
  }
}
