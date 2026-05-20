// models/orderModel.js — Buy Safe Order with strict state machine (GHS)
const mongoose = require('mongoose');

const ORDER_STATES = ['PENDING', 'ESCROWED', 'SHIPPED', 'REJECTED', 'REFUNDED', 'COMPLETED'];

const FeeBreakdownSchema = new mongoose.Schema({
  itemPrice:    { type: Number, required: true },  // pesewas (GHS × 100)
  platformFee:  { type: Number, required: true },  // Buy Safe 1.5% — non-refundable
  paystackFee:  { type: Number, required: true },  // gateway fee — non-refundable
  totalCharged: { type: Number, required: true },  // what payer actually sends
}, { _id: false });

const AuditEventSchema = new mongoose.Schema({
  state:     { type: String, enum: ORDER_STATES, required: true },
  actor:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note:      String,
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const OrderSchema = new mongoose.Schema({
  // ── Parties (no fixed roles — initiator starts, receiver pays) ────────────
  initiator: {              // person who created the escrow (selling something)
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  receiver: {               // person who pays into escrow (buying something)
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },

  // ── Item Details ──────────────────────────────────────────────────────────
  itemName: {
    type:      String,
    required:  true,
    trim:      true,
    maxlength: [120, 'Item name too long'],
  },
  itemDescription: {
    type:      String,
    trim:      true,
    maxlength: [500, 'Description too long'],
  },
  itemPrice: {             // in pesewas
    type:    Number,
    required: true,
    min:     [100, 'Minimum order is GHS 1.00'],
  },

  fees: { type: FeeBreakdownSchema },

  // ── Currency ──────────────────────────────────────────────────────────────
  currency: { type: String, default: 'GHS', enum: ['GHS'] },

  // ── State Machine ─────────────────────────────────────────────────────────
  status: {
    type:    String,
    enum:    { values: ORDER_STATES, message: '`{VALUE}` is not a valid order state.' },
    default: 'PENDING',
    index:   true,
  },

  // ── Paystack References ───────────────────────────────────────────────────
  paystackReference:    { type: String, unique: true, sparse: true, index: true },
  paystackTransferCode: String,
  paystackRefundId:     String,

  // ── Rejection / Return Flow ───────────────────────────────────────────────
  rejectedAt:           Date,
  returnConfirmDeadline: Date,   // rejectedAt + 24h
  returnConfirmedAt:    Date,
  autoRefundJobId:      String,

  // ── Audit Trail ───────────────────────────────────────────────────────────
  history: [AuditEventSchema],
}, { timestamps: true, strict: true });

// ── Compound indexes ──────────────────────────────────────────────────────────
OrderSchema.index({ initiator: 1, status: 1 });
OrderSchema.index({ receiver: 1, status: 1 });

// ── State transition guard ────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  PENDING:   ['ESCROWED'],
  ESCROWED:  ['SHIPPED'],
  SHIPPED:   ['REJECTED', 'COMPLETED'],
  REJECTED:  ['REFUNDED', 'COMPLETED'],
  REFUNDED:  [],
  COMPLETED: [],
};

OrderSchema.methods.transition = function (newState, actorId, note = '') {
  const allowed = VALID_TRANSITIONS[this.status] || [];
  if (!allowed.includes(newState)) {
    const err = new Error(`Illegal transition: ${this.status} → ${newState}`);
    err.status = 422;
    throw err;
  }
  this.history.push({ state: newState, actor: actorId, note });
  this.status = newState;
};

OrderSchema.virtual('isAutoRefundEligible').get(function () {
  return (
    this.status === 'REJECTED' &&
    this.returnConfirmDeadline &&
    new Date() > this.returnConfirmDeadline &&
    !this.returnConfirmedAt
  );
});

// ── Helpers ───────────────────────────────────────────────────────────────────
OrderSchema.methods.formatPrice = function (pesewas) {
  return `GHS ${(pesewas / 100).toFixed(2)}`;
};

module.exports = mongoose.model('Order', OrderSchema);