// models/reviewModel.js — Buy Safe peer reviews
// One review per party per order. Both sides can review each other.

const mongoose = require('mongoose');

const ReviewSchema = new mongoose.Schema({
  order:    { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true, index: true },
  reviewee: { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true, index: true },

  // 1–5 stars
  rating: {
    type:     Number,
    required: true,
    min:      [1, 'Minimum rating is 1'],
    max:      [5, 'Maximum rating is 5'],
    validate: { validator: Number.isInteger, message: 'Rating must be a whole number.' },
  },

  comment: {
    type:      String,
    trim:      true,
    maxlength: [300, 'Review comment cannot exceed 300 characters.'],
  },

  // Prevent review before order is resolved
  orderStatus: { type: String }, // snapshot of order.status at time of review
}, {
  timestamps: true,
});

// One review per reviewer per order
ReviewSchema.index({ order: 1, reviewer: 1 }, { unique: true });

module.exports = mongoose.model('Review', ReviewSchema);