// models/userModel.js — Buy Safe
// Auth: Google OAuth2 + Apple Sign-In (no passwords stored)
// Username: permanent once set, like a handle
// Trust Score: activity (40pts) + ratings (40pts) + standing (20pts) = 100

const mongoose = require('mongoose');

const TrustScoreSchema = new mongoose.Schema({
  value: { type: Number, default: 0, min: 0, max: 100 },

  // ── Activity component (max 40 pts) ──────────────────────────────────────
  activity: {
    totalOrders:     { type: Number, default: 0 },
    completedOrders: { type: Number, default: 0 },
    refundedOrders:  { type: Number, default: 0 }, // auto-refunds (bad signal)
    disputedOrders:  { type: Number, default: 0 }, // rejections filed against them
    score:           { type: Number, default: 0, min: 0, max: 40 },
  },

  // ── Rating component (max 40 pts) ────────────────────────────────────────
  ratings: {
    totalRatings: { type: Number, default: 0 },
    sumOfRatings: { type: Number, default: 0 }, // sum of 1–5 stars
    average:      { type: Number, default: 0 },
    score:        { type: Number, default: 0, min: 0, max: 40 },
  },

  // ── Standing component (max 20 pts) ──────────────────────────────────────
  standing: {
    emailVerified:   { type: Boolean, default: false },
    profileComplete: { type: Boolean, default: false },
    violations:      { type: Number,  default: 0 },    // admin-issued strikes
    score:           { type: Number,  default: 0, min: 0, max: 20 },
  },

  lastCalculated: Date,
}, { _id: false });

const UserSchema = new mongoose.Schema({
  // ── Permanent username (set once during onboarding, never changeable) ──────
  username: {
    type:      String,
    unique:    true,
    sparse:    true,
    lowercase: true,
    trim:      true,
    index:     true,
    match:     [/^[a-z0-9_.]{3,30}$/, 'Username: 3–30 chars, letters/numbers/dots/underscores only.'],
  },
  usernameSetAt: Date,

  displayName: { type: String, trim: true, maxlength: 80 },
  avatarUrl:   { type: String },
  bio:         { type: String, trim: true, maxlength: 160 },

  // ── OAuth (can link both Google + Apple to same account) ──────────────────
  googleId: { type: String, unique: true, sparse: true, index: true },
  appleId:  { type: String, unique: true, sparse: true, index: true },

  email:         { type: String, lowercase: true, index: true },
  emailVerified: { type: Boolean, default: false },

  // ── Trust ─────────────────────────────────────────────────────────────────
  trustScore: { type: TrustScoreSchema, default: () => ({}) },

  // ── Paystack payout (MoMo or bank) ────────────────────────────────────────
  paystackRecipientCode: { type: String },   // Paystack recipient_code
  paystackCustomerCode:  { type: String },   // for charging
  payoutAccount: {                           // display info (never store raw number)
    networkCode:   String,   // 'MTN' | 'VOD' | 'ATL'
    networkLabel:  String,   // 'MTN Mobile Money' etc.
    maskedNumber:  String,   // '024****567'
    accountName:   String,   // resolved name from Paystack e.g. 'KWAME ASANTE'
    recipientCode: String,   // mirror of paystackRecipientCode
    linkedAt:      Date,
  },

  // ── Misc ──────────────────────────────────────────────────────────────────
  fcmToken:           { type: String },
  onboardingComplete: { type: Boolean, default: false },
  isSuspended:        { type: Boolean, default: false },
  lastLoginAt:        { type: Date },
}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// TRUST SCORE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
UserSchema.methods.recalculateTrustScore = function () {
  const { activity, ratings, standing } = this.trustScore;

  // Activity Score (0–40)
  // Completion rate × 30 + volume bonus (max 10) − penalties
  let activityScore = 0;
  if (activity.totalOrders > 0) {
    const completionRate = activity.completedOrders / activity.totalOrders;
    const completionPts  = completionRate * 30;
    const volumeBonus    = Math.min(Math.floor(activity.completedOrders / 2), 10);
    const penalty        = (activity.refundedOrders * 5) + (activity.disputedOrders * 2);
    activityScore = Math.max(0, Math.min(40, completionPts + volumeBonus - penalty));
  }
  this.trustScore.activity.score = Math.round(activityScore);

  // Rating Score (0–40)
  // Requires ≥3 ratings to count fully; <3 gets 50% credit (prevents gaming)
  let ratingScore = 0;
  if (ratings.totalRatings > 0) {
    const avg = ratings.sumOfRatings / ratings.totalRatings;
    this.trustScore.ratings.average = Math.round(avg * 10) / 10;
    const fullScore = ((avg - 1) / 4) * 40;
    ratingScore = ratings.totalRatings >= 3 ? fullScore : fullScore * 0.5;
  }
  this.trustScore.ratings.score = Math.round(Math.max(0, Math.min(40, ratingScore)));

  // Standing Score (0–20)
  let standingScore = 0;
  if (standing.emailVerified)   standingScore += 10;
  if (standing.profileComplete) standingScore += 10;
  standingScore -= standing.violations * 5;
  this.trustScore.standing.score = Math.max(0, Math.min(20, standingScore));

  // Composite
  this.trustScore.value = Math.round(
    this.trustScore.activity.score +
    this.trustScore.ratings.score  +
    this.trustScore.standing.score
  );
  this.trustScore.lastCalculated = new Date();
};

UserSchema.methods.refreshStanding = function () {
  this.trustScore.standing.emailVerified   = this.emailVerified;
  this.trustScore.standing.profileComplete = !!(this.displayName && this.avatarUrl);
  this.recalculateTrustScore();
};

UserSchema.methods.toPublicProfile = function () {
  return {
    id:          this._id,
    username:    this.username,
    displayName: this.displayName,
    avatarUrl:   this.avatarUrl,
    bio:         this.bio,
    trustScore:  this.trustScore.value,
    trustBreakdown: {
      activity: this.trustScore.activity.score,
      ratings:  this.trustScore.ratings.score,
      standing: this.trustScore.standing.score,
    },
    ratingAverage: this.trustScore.ratings.average,
    totalRatings:  this.trustScore.ratings.totalRatings,
    memberSince:   this.createdAt,
    isVerified:    this.emailVerified,
  };
};

module.exports = mongoose.model('User', UserSchema);