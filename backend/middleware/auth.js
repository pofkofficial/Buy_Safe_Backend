// middleware/auth.js — Buy Safe
const jwt  = require('jsonwebtoken');
const User = require('../models/userModel');

// Standard JWT guard
exports.protect = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }
  try {
    const { id } = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const user = await User.findById(id);
    if (!user) return res.status(401).json({ success: false, message: 'Account not found.' });
    if (user.isSuspended) return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token.' });
  }
};

// Requires onboarding (username set) — applied to all transactional routes
exports.requireOnboarding = (req, res, next) => {
  if (!req.user.onboardingComplete) {
    return res.status(403).json({
      success: false,
      message: 'Please set your username to continue.',
      code:    'NEEDS_USERNAME',
    });
  }
  next();
};