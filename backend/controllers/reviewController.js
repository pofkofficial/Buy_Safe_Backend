// controllers/reviewController.js — Buy Safe peer reviews
// Either party can review the other after an order is COMPLETED or REFUNDED.
// Submitting a review triggers a full trust score recalculation for the reviewee.

const mongoose = require('mongoose');
const Review   = require('../models/reviewModel');
const Order    = require('../models/orderModel');
const User     = require('../models/userModel');

const REVIEWABLE_STATES = ['COMPLETED', 'REFUNDED'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/orders/:id/review
// Body: { rating: 1–5, comment?: string }
// ─────────────────────────────────────────────────────────────────────────────
exports.submitReview = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { rating, comment } = req.body;
    const reviewerId = req.user._id;

    const order = await Order.findById(req.params.id).session(session);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    // Only parties involved can review
    const isInitiator = order.initiator.equals(reviewerId);
    const isReceiver  = order.receiver.equals(reviewerId);
    if (!isInitiator && !isReceiver) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'You are not a party to this order.' });
    }

    // Order must be resolved
    if (!REVIEWABLE_STATES.includes(order.status)) {
      await session.abortTransaction();
      return res.status(422).json({
        success: false,
        message: `Reviews can only be submitted once an order is ${REVIEWABLE_STATES.join(' or ')}.`,
      });
    }

    // Reviewee is the other party
    const revieweeId = isInitiator ? order.receiver : order.initiator;

    // Check for duplicate review
    const existing = await Review.findOne({ order: order._id, reviewer: reviewerId }).session(session);
    if (existing) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: 'You have already reviewed this order.' });
    }

    // Save review
    const [review] = await Review.create([{
      order:       order._id,
      reviewer:    reviewerId,
      reviewee:    revieweeId,
      rating,
      comment,
      orderStatus: order.status,
    }], { session });

    // Update reviewee's rating totals
    const reviewee = await User.findById(revieweeId).session(session);
    reviewee.trustScore.ratings.totalRatings += 1;
    reviewee.trustScore.ratings.sumOfRatings += rating;
    reviewee.recalculateTrustScore();
    await reviewee.save({ session });

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      message: 'Review submitted.',
      data: {
        reviewId:       review._id,
        rating,
        revieweeScore:  reviewee.trustScore.value,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/:username/reviews
// Public: get reviews for any user (paginated)
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserReviews = async (req, res, next) => {
  try {
    const { username } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const [reviews, total] = await Promise.all([
      Review.find({ reviewee: user._id })
        .populate('reviewer', 'username displayName avatarUrl')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Review.countDocuments({ reviewee: user._id }),
    ]);

    res.json({
      success: true,
      data: {
        user:     user.toPublicProfile(),
        reviews,
        pagination: { page: Number(page), total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) { next(err); }
};