// src/routes/auth.js — All auth and onboarding endpoints

import { Router }         from 'express';
import { authLimiter, refreshLimiter } from '../middleware/rateLimiter.js';
import { verifyToken }    from '../middleware/auth.js';
import { success, error } from '../utils/response.js';
import {
  isValidEmail,
  isValidPassword,
  isStrongPassword,
} from '../utils/helpers.js';
import * as authService   from '../services/authService.js';
import { parseRoutineTaskIds } from '../services/routineTaskService.js';
import { revokeSession }  from '../services/sessionService.js';
import { handleEmailChange } from './emailChange.js';

// Same rules everywhere a password is set (register, reset, change).
function passwordRulesError(res, password) {
  const { valid, errors } = isStrongPassword(password);
  if (valid) return null;
  return res.status(400).json({
    success: false,
    message: 'Password does not meet requirements',
    errors,
    error:   { code: 'WEAK_PASSWORD', message: 'Password does not meet requirements' },
  });
}

const router = Router();

// ── POST /api/auth/send-otp ───────────────────────────────
// OTP for email + password registration only
// Google and Apple users skip this entirely. The response is the same
// whether or not the email already has an account (that address gets a
// "you already have an account" email instead of a code).

router.post('/send-otp', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email)
      return error(res, 'Email is required', 400);

    if (!isValidEmail(email))
      return error(res, 'Invalid email format', 400);

    await authService.sendOtp(email);

    return success(res, null,
      'Verification code sent to your email. It expires in 10 minutes.');

  } catch (err) {
    if (err.message === 'OTP_COOLDOWN')
      return error(res, 'Please wait a minute before requesting another code.', 429, 'OTP_COOLDOWN');
    next(err);
  }
});

// ── POST /api/auth/verify-otp ──────────────────────────────

router.post('/verify-otp', authLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email)
      return error(res, 'Email is required', 400);

    if (!isValidEmail(email))
      return error(res, 'Invalid email format', 400);

    if (!otp || typeof otp !== 'string')
      return error(res, 'Verification code is required', 400);

    if (!/^\d{6}$/.test(otp.trim()))
      return error(res, 'Verification code must be exactly 6 digits', 400);

    await authService.verifyOtp(email, otp);

    return success(res, null, 'Email verified. You may now create your account.');

  } catch (err) {
    if (err.message === 'INVALID_OTP')
      return error(res,
        'Invalid or expired verification code. Please request a new one.', 400);
    next(err);
  }
});

// ── POST /api/auth/register ───────────────────────────────
// Creates account with email + password
// Saves all onboarding answers in same call
// Body: { name, email, password, onboarding[], referral_code?, routine_task_ids? } (or camelCase)

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, onboarding = [] } = req.body;
    const referral_code = req.body.referral_code ?? req.body.referralCode;
    const routineTaskIds = parseRoutineTaskIds(req.body.routine_task_ids ?? req.body.routineTaskIds);
    if (!routineTaskIds)
      return error(res, 'routine_task_ids must be a list of task ids', 400);

    // Validate required fields
    if (!name?.trim())
      return error(res, 'Hunter name is required', 400);
    if (!email)
      return error(res, 'Hunters ID (email) is required', 400);
    if (!isValidEmail(email))
      return error(res, 'Invalid email format', 400);
    if (!password)
      return error(res, 'Secret Key (password) is required', 400);
    if (!isValidPassword(password))
      return error(res, 'Secret Key must be at least 8 characters', 400);
    const weak = passwordRulesError(res, password);
    if (weak) return weak;

    // Validate onboarding array if provided
    if (onboarding.length > 0) {
      for (const a of onboarding) {
        if (!a.questionId || a.answer === undefined || a.answer === null) {
          return error(res, 'Each onboarding answer needs questionId and answer', 400);
        }
        if (a.questionId < 1 || a.questionId > 10) {
          return error(res, `Invalid questionId ${a.questionId} — must be 1 to 10`, 400);
        }
      }
    }

    const result = await authService.registerWithEmail(
      name, email, password, onboarding, referral_code, routineTaskIds
    );

    return success(res, {
      user:          result.user,
      access_token:  result.accessToken,
      refresh_token: result.refreshToken,
      isNew:         true,
    }, 'Account created. Welcome, Hunter.', 201);

  } catch (err) {
    if (err.message === 'EMAIL_NOT_VERIFIED')
      return error(res,
        'Please verify your email first. Use send-otp then verify-otp.', 403);
    if (err.message === 'EMAIL_EXISTS')
      return error(res, 'An account with this email already exists', 409);
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────
// Login with email + password
// No onboarding — existing users go straight to home
// Body: { email, password }

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return error(res, 'Email and password are required', 400);
    if (!isValidEmail(email))
      return error(res, 'Invalid email format', 400);

    const result = await authService.loginWithEmail(email, password);

    return success(res, {
      user:          result.user,
      access_token:  result.accessToken,
      refresh_token: result.refreshToken,
      isNew:         result.isNew,
    }, 'Login successful');

  } catch (err) {
    if (err.message === 'INVALID_CREDENTIALS')
      return error(res, 'Invalid email or password', 401);
    if (err.message === 'LOGIN_LOCKED')
      return error(res, 'Too many failed attempts. Try again in 15 minutes or reset your password.', 429, 'LOGIN_LOCKED');
    if (err.message === 'ACCOUNT_BANNED')
      return error(res, 'Your account has been suspended', 403);
    next(err);
  }
});

// ── POST /api/auth/google ─────────────────────────────────
// New users — creates account + saves onboarding in one call
// Existing users — logs in, ignores onboarding array
// Body: { idToken, onboarding[], referral_code?, routine_task_ids? } (or camelCase)

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { idToken, onboarding = [] } = req.body;
    const referral_code = req.body.referral_code ?? req.body.referralCode;
    const routineTaskIds = parseRoutineTaskIds(req.body.routine_task_ids ?? req.body.routineTaskIds);
    if (!routineTaskIds)
      return error(res, 'routine_task_ids must be a list of task ids', 400);

    if (!idToken)
      return error(res, 'Google ID token is required', 400);

    if (onboarding.length > 0) {
      for (const a of onboarding) {
        if (!a.questionId || a.answer === undefined || a.answer === null)
          return error(res, 'Each onboarding answer needs questionId and answer', 400);
        if (a.questionId < 1 || a.questionId > 10)
          return error(res, `Invalid questionId ${a.questionId}`, 400);
      }
    }

    const result = await authService.loginWithGoogle(idToken, onboarding, referral_code, routineTaskIds);

    return success(res, {
      user:          result.user,
      access_token:  result.accessToken,
      refresh_token: result.refreshToken,
      isNew:         result.isNew,
      linked:        result.linked || false,
    }, result.isNew ? 'Account created. Welcome, Hunter.' : 'Login successful');

  } catch (err) {
    if (err.message === 'ACCOUNT_BANNED')
      return error(res, 'Your account has been suspended', 403);
    if (err.message === 'EMAIL_LINK_UNVERIFIED')
      return error(res, 'An account with this email already exists. Log in with your email and password first, then you can use this sign-in.', 409, 'EMAIL_LINK_UNVERIFIED');
    if (err.message === 'INVALID_GOOGLE_TOKEN')
      return error(res, 'Invalid or expired Google token', 401);
    if (err.message === 'GOOGLE_NOT_CONFIGURED')
      return error(res, 'Google sign-in is not configured on this server', 503);
    next(err);
  }
});

// ── POST /api/auth/apple ──────────────────────────────────
// New users — creates account + saves onboarding in one call
// Existing users — logs in, ignores onboarding array
// Body: { idToken, nonce?, onboarding[], referral_code?, routine_task_ids? } (or camelCase)

router.post('/apple', authLimiter, async (req, res, next) => {
  try {
    const { idToken, nonce, onboarding = [] } = req.body;
    const referral_code = req.body.referral_code ?? req.body.referralCode;
    const routineTaskIds = parseRoutineTaskIds(req.body.routine_task_ids ?? req.body.routineTaskIds);
    if (!routineTaskIds)
      return error(res, 'routine_task_ids must be a list of task ids', 400);

    if (!idToken)
      return error(res, 'Apple ID token is required', 400);

    if (onboarding.length > 0) {
      for (const a of onboarding) {
        if (!a.questionId || a.answer === undefined || a.answer === null)
          return error(res, 'Each onboarding answer needs questionId and answer', 400);
        if (a.questionId < 1 || a.questionId > 10)
          return error(res, `Invalid questionId ${a.questionId}`, 400);
      }
    }

    const result = await authService.loginWithApple(idToken, nonce, onboarding, referral_code, routineTaskIds);

    return success(res, {
      user:          result.user,
      access_token:  result.accessToken,
      refresh_token: result.refreshToken,
      isNew:         result.isNew,
      linked:        result.linked || false,
    }, result.isNew ? 'Account created. Welcome, Hunter.' : 'Login successful');

  } catch (err) {
    if (err.message === 'ACCOUNT_BANNED')
      return error(res, 'Your account has been suspended', 403);
    if (err.message === 'EMAIL_LINK_UNVERIFIED')
      return error(res, 'An account with this email already exists. Log in with your email and password first, then you can use this sign-in.', 409, 'EMAIL_LINK_UNVERIFIED');
    if (err.message === 'INVALID_APPLE_TOKEN')
      return error(res, 'Invalid or expired Apple token', 401);
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────
// Get new access token using refresh token
// Body: { refreshToken }

router.post('/refresh', refreshLimiter, async (req, res, next) => {
  try {
    const refreshToken = req.body?.refreshToken ?? req.body?.refresh_token;

    if (!refreshToken || typeof refreshToken !== 'string')
      return error(res, 'Refresh token is required', 400);

    const result = await authService.refreshAccessToken(refreshToken);

    return success(res, {
      access_token:  result.accessToken,
      refresh_token: result.refreshToken,
    }, 'Token refreshed');

  } catch (err) {
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404, 'ACCOUNT_NOT_FOUND');
    if (err.name === 'TokenExpiredError')
      return error(res, 'Refresh token expired — please login again', 401);
    if (err.name === 'JsonWebTokenError' || err.message === 'TOKEN_REVOKED')
      return error(res, 'Invalid refresh token — please login again', 401);
    if (err.message === 'ACCOUNT_BANNED')
      return error(res, 'Your account has been suspended', 403);
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────
// Ends this device's session: the refresh token's whole rotation family is
// revoked, so a copy of it stops working too. Always succeeds.
// Body: { refreshToken }

router.post('/logout', refreshLimiter, async (req, res, next) => {
  try {
    const refreshToken = req.body?.refreshToken ?? req.body?.refresh_token;
    if (typeof refreshToken === 'string' && refreshToken) await revokeSession(refreshToken);
    return success(res, null, 'Logged out');
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/change-password ────────────────────────
// Signed in. Checks the current password, sets the new one (same rules as
// reset), signs out every other device, and returns new tokens for this one.
// Body: { currentPassword, newPassword, confirmPassword }

router.post('/change-password', authLimiter, verifyToken, async (req, res, next) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!currentPassword || !newPassword)
      return error(res, 'Current and new password are required', 400);
    if (typeof newPassword !== 'string' || typeof currentPassword !== 'string')
      return error(res, 'Passwords must be text', 400);
    const weak = passwordRulesError(res, newPassword);
    if (weak) return weak;
    if (confirmPassword !== undefined && confirmPassword !== newPassword)
      return error(res, 'Passwords do not match', 400, 'PASSWORD_MISMATCH');

    const tokens = await authService.changePassword(req.user.id, currentPassword, newPassword);
    return success(res, {
      access_token:  tokens.accessToken,
      refresh_token: tokens.refreshToken,
    }, 'Password changed. Other devices have been signed out.');
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404, 'ACCOUNT_NOT_FOUND');
    if (err.message === 'NO_PASSWORD')
      return error(res, 'This account signs in with Google or Apple and has no password.', 400, 'NO_PASSWORD');
    if (err.message === 'INVALID_CURRENT_PASSWORD')
      return error(res, 'Current password is incorrect', 401, 'INVALID_CURRENT_PASSWORD');
    if (err.message === 'SAME_PASSWORD')
      return error(res, 'New password must be different from your current one', 400, 'SAME_PASSWORD');
    next(err);
  }
});

// ── POST /api/auth/forgot-password ───────────────────────
// Sends a reset link if the email belongs to a password account (or a
// "sign in with Google/Apple" note for social accounts). The response is
// the same whether or not the account exists, so this can't be used to
// check which emails are registered.
// Body: { email }

router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;

    if (!email)
      return error(res, 'Email is required', 400);
    if (!isValidEmail(email))
      return error(res, 'Invalid email format', 400);

    await authService.forgotPassword(email);

    return success(res, null,
      'If an account exists for this email, we have sent instructions to reset your Secret Key. Check your spam folder if it does not arrive within 2 minutes.');

  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/reset-password ────────────────────────
// Reset password using token from email link
// Body: { token, newPassword, confirmPassword }
// Accepts token from body or query params

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { newPassword, confirmPassword } = req.body;
    const token = req.body?.token || req.query?.token;

    // Validate token
    if (!token)
      return error(res, 'Reset token is required', 400);

    // Validate new password exists
    if (!newPassword)
      return error(res, 'New password is required', 400);

    // Validate password strength — matches all 4 rules on Screen 3
    const weak = passwordRulesError(res, newPassword);
    if (weak) return weak;

    // Validate confirm password matches
    if (confirmPassword !== undefined && confirmPassword !== newPassword)
      return error(res, 'Passwords do not match', 400);

    await authService.resetPassword(token, newPassword);

    return success(res, null, 'Password updated successfully. You can now log in.');

  } catch (err) {
    if (err.message === 'INVALID_OR_EXPIRED_TOKEN')
      return error(res, 'Reset link is invalid or has expired. Please request a new one.', 400);
    next(err);
  }
});

// ── POST /api/auth/complete-onboarding ────────────────────
// For an already-authenticated user whose onboarding isn't done
// yet (e.g. a Google/Apple account created from the Login screen,
// before the onboarding wizard ran). Saves the wizard answers onto
// the existing account — does not create a user or issue new tokens.
// Header: Authorization: Bearer <access_token>
// Body: { onboarding[], routine_task_ids?, referral_code? } (or camelCase)
// referral_code: typed in the wizard; attributes this account to the
// inviter if nobody has yet. Unknown codes are ignored, never an error.

router.post('/complete-onboarding', verifyToken, async (req, res, next) => {
  try {
    const { onboarding = [] } = req.body;
    const routineTaskIds = parseRoutineTaskIds(req.body.routine_task_ids ?? req.body.routineTaskIds);
    if (!routineTaskIds)
      return error(res, 'routine_task_ids must be a list of task ids', 400);

    if (!Array.isArray(onboarding) || onboarding.length === 0)
      return error(res, 'Onboarding answers are required', 400);

    for (const a of onboarding) {
      if (!a.questionId || a.answer === undefined || a.answer === null)
        return error(res, 'Each onboarding answer needs questionId and answer', 400);
      if (a.questionId < 1 || a.questionId > 10)
        return error(res, `Invalid questionId ${a.questionId} — must be 1 to 10`, 400);
    }

    const referral_code = req.body.referral_code ?? req.body.referralCode;
    const user = await authService.completeOnboarding(req.user.id, onboarding, routineTaskIds, referral_code);

    return success(res, { user }, 'Onboarding complete. Welcome, Hunter.');

  } catch (err) {
    if (err.message === 'ONBOARDING_ALREADY_DONE')
      return error(res, 'Onboarding has already been completed for this account', 409);
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404);
    if (err.message === 'INVALID_ONBOARDING_ANSWER')
      return error(res, 'Each onboarding answer needs questionId and answer', 400);
    if (err.message === 'INVALID_QUESTION_ID')
      return error(res, 'Invalid questionId — must be 1 to 10', 400);
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────
// Get current authenticated user
// Header: Authorization: Bearer <access_token>

router.get('/me', verifyToken, async (req, res, next) => {
  try {
    const user = await authService.getCurrentUser(req.user.id);
    if (!user) return error(res, 'User not found', 404);
    return success(res, { user }, 'User fetched');
  } catch (err) {
    next(err);
  }
});

// ── PATCH/PUT /api/auth/profile ───────────────────────────
// Edit profile: name, gender, birthday/date_of_birth, height, weight, avatar_id.
// Automatically calculates BMI and daily_protein_goal.
// Header: Authorization: Bearer <access_token>
// Body: { name?, gender?, birthday?, height?, weight?, avatar_id? }

const handleUpdateProfile = async (req, res, next) => {
  try {
    const user = await authService.updateUserProfile(req.user.id, req.body);
    return success(res, { user }, 'Profile updated successfully');
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404);
    if (err.message === 'INVALID_NAME')
      return error(res, 'Name cannot be empty', 400);
    if (err.message === 'NAME_TOO_LONG')
      return error(res, 'Name cannot exceed 100 characters', 400);
    if (err.message === 'INVALID_GENDER')
      return error(res, 'Gender must be one of: MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY', 400);
    if (err.message === 'INVALID_BIRTHDAY' || err.message === 'INVALID_AGE')
      return error(res, 'Invalid birthday format or date', 400);
    if (err.message === 'BIRTHDAY_IN_FUTURE')
      return error(res, 'Birthday cannot be in the future', 400);
    if (err.message === 'INVALID_HEIGHT')
      return error(res, 'Height must be a valid number in cm (50-300)', 400);
    if (err.message === 'INVALID_WEIGHT')
      return error(res, 'Weight must be a valid number in kg (20-500)', 400);
    if (err.message === 'INVALID_AVATAR')
      return error(res, 'Invalid avatar ID', 400);
    if (err.message === 'INVALID_EMAIL')
      return error(res, 'Invalid email format', 400);
    if (err.message === 'EMAIL_EXISTS')
      return error(res, 'An account with this email already exists', 409);
    if (err.message === 'EMAIL_CHANGE_REQUIRES_VERIFICATION')
      return error(res, 'Change your email from Settings — the new address needs a verification code.', 400, 'EMAIL_CHANGE_REQUIRES_VERIFICATION');
    next(err);
  }
};

router.patch('/profile', verifyToken, handleUpdateProfile);
router.put('/profile', verifyToken, handleUpdateProfile);

// ── PATCH /api/auth/email ─────────────────────────────────
// Two-step verified email change — see routes/emailChange.js.
router.patch('/email', verifyToken, handleEmailChange);

export default router;


