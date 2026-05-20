// controllers/authController.js — Buy Safe
// Google: verify ID token with google-auth-library
// Apple: verify identity token with apple-signin-auth
// On first login → return { needsUsername: true } → frontend shows username picker
// On username set → mark onboardingComplete, recalculate trust standing

const jwt            = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
//const appleSignin    = require('apple-signin-auth');
const User           = require('../models/userModel');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── JWT helpers ───────────────────────────────────────────────────────────────
function issueJwt(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

function authResponse(user) {
  const needsUsername = !user.onboardingComplete;
  return {
    success:       true,
    token:         issueJwt(user._id),
    needsUsername,
    user: {
      id:                 user._id,
      username:           user.username || null,
      displayName:        user.displayName,
      avatarUrl:          user.avatarUrl,
      email:              user.email,
      emailVerified:      user.emailVerified,
      trustScore:         user.trustScore.value,
      onboardingComplete: user.onboardingComplete,
      hasPayoutAccount:   !!user.paystackRecipientCode,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google
// Body: { idToken }  — from Google Sign-In SDK on device
// ─────────────────────────────────────────────────────────────────────────────
exports.googleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ success: false, message: 'idToken required.' });

    // Verify with Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: [
        process.env.GOOGLE_CLIENT_ID,          // Android / web
        process.env.GOOGLE_IOS_CLIENT_ID,      // iOS (different client)
      ].filter(Boolean),
    });
    const payload = ticket.getPayload();

    // Upsert: find by googleId, fall back to email (handles account linking)
    let user = await User.findOne({ googleId: payload.sub });

    if (!user && payload.email) {
      // Check if an Apple-linked account exists with same email → link it
      user = await User.findOne({ email: payload.email });
    }

    if (!user) {
      user = new User({
        googleId:      payload.sub,
        email:         payload.email,
        emailVerified: payload.email_verified ?? false,
        displayName:   payload.name,
        avatarUrl:     payload.picture,
      });
    } else {
      // Link google ID if not already set (e.g. was Apple-only before)
      if (!user.googleId) user.googleId = payload.sub;
      user.displayName   = user.displayName || payload.name;
      user.avatarUrl     = user.avatarUrl   || payload.picture;
      user.emailVerified = user.emailVerified || (payload.email_verified ?? false);
    }

    user.lastLoginAt = new Date();
    user.refreshStanding();
    await user.save();

    res.json(authResponse(user));
  } catch (err) {
    if (err.message?.includes('Invalid token')) {
      return res.status(401).json({ success: false, message: 'Google token verification failed.' });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/apple
// Body: { identityToken, authorizationCode, fullName? }
// Apple only sends fullName on the FIRST login — store it then, never again.
// ─────────────────────────────────────────────────────────────────────────────
exports.appleAuth = async (req, res, next) => {
  try {
    const { identityToken, authorizationCode, fullName } = req.body;
    if (!identityToken) return res.status(400).json({ success: false, message: 'identityToken required.' });

    const applePayload = await appleSignin.verifyIdToken(identityToken, {
      audience:         process.env.APPLE_CLIENT_ID, // your app's bundle ID
      ignoreExpiration: false,
    });

    let user = await User.findOne({ appleId: applePayload.sub });

    if (!user && applePayload.email) {
      user = await User.findOne({ email: applePayload.email });
    }

    if (!user) {
      // Apple may return an anonymized relay email — store whatever we get
      const name = fullName
        ? `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim()
        : null;

      user = new User({
        appleId:       applePayload.sub,
        email:         applePayload.email,
        emailVerified: applePayload.email_verified === 'true' || applePayload.email_verified === true,
        displayName:   name || null,
      });
    } else {
      if (!user.appleId) user.appleId = applePayload.sub;
      // Only backfill displayName if not already set (Apple doesn't resend fullName)
      if (!user.displayName && fullName) {
        user.displayName = `${fullName.givenName || ''} ${fullName.familyName || ''}`.trim() || null;
      }
      user.emailVerified = user.emailVerified || applePayload.email_verified === 'true';
    }

    user.lastLoginAt = new Date();
    user.refreshStanding();
    await user.save();

    res.json(authResponse(user));
  } catch (err) {
    if (err.message?.includes('expired') || err.message?.includes('invalid')) {
      return res.status(401).json({ success: false, message: 'Apple token verification failed.' });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/set-username
// Called once after first OAuth login. Username is permanent — cannot be changed.
// Body: { username }
// ─────────────────────────────────────────────────────────────────────────────
exports.setUsername = async (req, res, next) => {
  try {
    const { username } = req.body;
    const user = req.user;

    if (user.username) {
      return res.status(409).json({
        success: false,
        message: 'Username is already set and cannot be changed.',
      });
    }

    // Check availability (case-insensitive — already lowercased by schema)
    const taken = await User.findOne({ username: username.toLowerCase() });
    if (taken) {
      return res.status(409).json({
        success: false,
        message: `@${username} is already taken. Try a different username.`,
      });
    }

    user.username      = username.toLowerCase();
    user.usernameSetAt = new Date();
    user.onboardingComplete = true;
    user.refreshStanding();
    await user.save();

    res.json({
      success:  true,
      username: user.username,
      message:  `Welcome to Buy Safe, @${user.username}!`,
      user:     authResponse(user).user,
    });
  } catch (err) {
    // Duplicate key race condition
    if (err.code === 11000 && err.keyPattern?.username) {
      return res.status(409).json({ success: false, message: 'That username was just taken. Try another.' });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/check-username?username=kwame
// Check availability before the user submits
// ─────────────────────────────────────────────────────────────────────────────
exports.checkUsername = async (req, res, next) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'username query param required.' });

    const valid = /^[a-z0-9_.]{3,30}$/.test(username.toLowerCase());
    if (!valid) return res.json({ available: false, reason: 'Invalid format. Use 3–30 chars: letters, numbers, dots, underscores.' });

    const taken = await User.findOne({ username: username.toLowerCase() });
    res.json({ available: !taken, username: username.toLowerCase() });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
exports.getMe = (req, res) => {
  res.json({ success: true, user: req.user.toPublicProfile() });
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/auth/profile
// Update bio, displayName, avatarUrl (not username — that's permanent)
// ─────────────────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    const { displayName, bio, avatarUrl } = req.body;
    const user = req.user;

    if (displayName !== undefined) user.displayName = displayName;
    if (bio         !== undefined) user.bio         = bio;
    if (avatarUrl   !== undefined) user.avatarUrl   = avatarUrl;

    user.refreshStanding(); // profileComplete may have changed
    await user.save();
    res.json({ success: true, user: user.toPublicProfile() });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/fcm-token
// ─────────────────────────────────────────────────────────────────────────────
exports.updateFcmToken = async (req, res, next) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ success: false, message: 'fcmToken required.' });
    req.user.fcmToken = fcmToken;
    await req.user.save();
    res.json({ success: true });
  } catch (err) { next(err); }
};