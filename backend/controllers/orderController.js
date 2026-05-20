// controllers/orderController.js — Buy Safe escrow lifecycle (GHS / Paystack)
const crypto   = require('crypto');
const axios    = require('axios');
const mongoose = require('mongoose');
const Order    = require('../models/orderModel');
const User     = require('../models/userModel');
const { scheduleAutoRefund, cancelAutoRefund } = require('../workers/refundWorker');
const { sendPush } = require('../config/firebase');

const PS        = 'https://api.paystack.co';
const psHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// ── Fee calculator (GHS pesewas) ──────────────────────────────────────────────
// Paystack Ghana: 1.95% + GHS 0.30 (capped at GHS 19.95)
function calcFees(itemPesewas) {
  const platformFee  = Math.round(itemPesewas * 0.015);           // Buy Safe 1.5%
  const psPercent    = Math.round(itemPesewas * 0.0195);
  const psFlat       = 30;                                         // GHS 0.30 in pesewas
  const paystackFee  = Math.min(psPercent + psFlat, 1995);         // cap GHS 19.95
  const totalCharged = itemPesewas + platformFee + paystackFee;
  return { itemPrice: itemPesewas, platformFee, paystackFee, totalCharged };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE ORDER  — initiator sets up the escrow
// POST /api/orders
// ─────────────────────────────────────────────────────────────────────────────
exports.createOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { itemName, itemDescription, itemPriceGHS, receiverUsername } = req.body;
    const initiator = req.user;

    const receiver = await User.findOne({ username: receiverUsername.toLowerCase() }).session(session);
    if (!receiver)
      return res.status(404).json({ success: false, message: `No Buy Safe user found with username @${receiverUsername}.` });
    if (receiver._id.equals(initiator._id))
      return res.status(400).json({ success: false, message: 'You cannot create an escrow with yourself.' });
    if (receiver.isSuspended)
      return res.status(400).json({ success: false, message: 'This account is currently suspended.' });

    const itemPesewas = Math.round(itemPriceGHS * 100);
    const fees        = calcFees(itemPesewas);
    const reference   = `BS-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const [order] = await Order.create([{
      initiator:   initiator._id,
      receiver:    receiver._id,
      itemName,
      itemDescription,
      itemPrice:   itemPesewas,
      fees,
      currency:    'GHS',
      paystackReference: reference,
      history: [{ state: 'PENDING', actor: initiator._id, note: 'Escrow created' }],
    }], { session });

    await session.commitTransaction();

    // Notify receiver
    if (receiver.fcmToken) {
      sendPush(receiver.fcmToken, {
        title: '🔒 New Escrow Request — Buy Safe',
        body:  `@${initiator.username} wants to sell you "${itemName}" for GHS ${itemPriceGHS.toFixed(2)}. Tap to pay into escrow.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }

    res.status(201).json({
      success: true,
      data: {
        orderId:          order._id,
        paystackReference: reference,
        itemPriceGHS:     (fees.itemPrice    / 100).toFixed(2),
        platformFeeGHS:   (fees.platformFee  / 100).toFixed(2),
        paystackFeeGHS:   (fees.paystackFee  / 100).toFixed(2),
        totalChargedGHS:  (fees.totalCharged / 100).toFixed(2),
        receiverUsername: receiver.username,
        status: 'PENDING',
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
// INITIALIZE PAYMENT  — receiver pays into escrow
// POST /api/orders/:id/pay
// ─────────────────────────────────────────────────────────────────────────────
exports.initializePayment = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('initiator receiver');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.receiver._id.equals(req.user._id))
      return res.status(403).json({ success: false, message: 'Only the receiver can pay into this escrow.' });
    if (order.status !== 'PENDING')
      return res.status(422).json({ success: false, message: `Order is ${order.status} — payment window has closed.` });

    const { data } = await axios.post(`${PS}/transaction/initialize`, {
      email:     req.user.email,
      amount:    order.fees.totalCharged,
      currency:  'GHS',
      reference: order.paystackReference,
      metadata: {
        orderId:     order._id.toString(),
        receiverId:  req.user._id.toString(),
        initiatorId: order.initiator._id.toString(),
        custom_fields: [
          { display_name: 'Item',     variable_name: 'item_name', value: order.itemName },
          { display_name: 'Platform', variable_name: 'platform',  value: 'Buy Safe'     },
        ],
      },
      callback_url: `${process.env.APP_SCHEME}://payment-success`,
    }, { headers: psHeaders() });

    res.json({ success: true, authorizationUrl: data.data.authorization_url, accessCode: data.data.access_code });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// PAYSTACK WEBHOOK  — charge.success / transfer.success / transfer.failed
// POST /api/paystack/webhook
// Raw body preserved in server.js; IP whitelist + signature verified here
// ─────────────────────────────────────────────────────────────────────────────
exports.handleWebhook = async (req, res, next) => {
  const sig  = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body).digest('hex');

  if (!sig || hash !== sig) {
    console.warn('⚠️  Buy Safe webhook: signature mismatch');
    return res.status(401).send('Invalid signature');
  }

  res.sendStatus(200); // ACK immediately — Paystack retries if no 200 within 5s

  let event;
  try { event = JSON.parse(req.body.toString()); } catch { return; }

  try {
    if (event.event === 'charge.success')   await onChargeSuccess(event.data);
    if (event.event === 'transfer.success') await onTransferSuccess(event.data);
    if (event.event === 'transfer.failed')  await onTransferFailed(event.data);
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }
};

async function onChargeSuccess(data) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findOne({ paystackReference: data.reference }).session(session);
    if (!order || order.status !== 'PENDING') { await session.abortTransaction(); return; } // idempotent

    order.transition('ESCROWED', null, 'Payment confirmed — funds locked');
    await order.save({ session });
    await session.commitTransaction();

    const initiator = await User.findById(order.initiator);
    if (initiator?.fcmToken) {
      sendPush(initiator.fcmToken, {
        title: '✅ Funds Locked — Buy Safe',
        body:  `Payment for "${order.itemName}" is secured in escrow. Proceed with delivery.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }
  } catch (err) {
    await session.abortTransaction(); throw err;
  } finally { session.endSession(); }
}

async function onTransferSuccess(data) {
  const order = await Order.findOne({ paystackTransferCode: data.transfer_code });
  if (order && order.status === 'SHIPPED') {
    order.transition('COMPLETED', null, 'Payout confirmed by Paystack');
    await order.save();
  }
}

async function onTransferFailed(data) {
  console.error(`🚨 Transfer failed: ${data.transfer_code} — flag for manual review`);
  // TODO: alert ops, flag order for manual payout retry
}

// ─────────────────────────────────────────────────────────────────────────────
// MARK SHIPPED  — initiator confirms dispatch
// POST /api/orders/:id/ship
// ─────────────────────────────────────────────────────────────────────────────
exports.markShipped = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('receiver');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.initiator.equals(req.user._id))
      return res.status(403).json({ success: false, message: 'Only the initiator can mark as shipped.' });

    order.transition('SHIPPED', req.user._id, 'Initiator marked as dispatched');
    await order.save();

    if (order.receiver?.fcmToken) {
      sendPush(order.receiver.fcmToken, {
        title: '📦 Item Shipped — Buy Safe',
        body:  `"${order.itemName}" is on its way. Confirm receipt or reject when it arrives.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }

    res.json({ success: true, message: 'Marked as shipped. Receiver has been notified.' });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// RELEASE FUNDS  — receiver confirms receipt → payout to initiator
// POST /api/orders/:id/release
//
// Requires initiator to have a linked MoMo payout account.
// Payout = itemPrice only (platform keeps platformFee; paystackFee absorbed on charge).
// ─────────────────────────────────────────────────────────────────────────────
exports.releaseFunds = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(req.params.id)
      .populate('initiator receiver')
      .session(session);

    if (!order)
      return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.receiver._id.equals(req.user._id))
      return res.status(403).json({ success: false, message: 'Only the receiver can release funds.' });
    if (order.status !== 'SHIPPED')
      return res.status(422).json({ success: false, message: `Order must be SHIPPED to release. Currently: ${order.status}.` });

    const initiator = order.initiator;

    // ── Guard: initiator must have a payout account ───────────────────────
    if (!initiator.paystackRecipientCode) {
      await session.abortTransaction();
      return res.status(422).json({
        success: false,
        message: `@${initiator.username} hasn't set up a MoMo payout account yet. Ask them to add it in their profile before you release funds.`,
        code:    'NO_PAYOUT_ACCOUNT',
      });
    }

    const payoutPesewas = order.fees.itemPrice; // base price only

    // ── Trigger Paystack transfer ──────────────────────────────────────────
    const { data } = await axios.post(`${PS}/transfer`, {
      source:    'balance',
      amount:    payoutPesewas,
      currency:  'GHS',
      recipient: initiator.paystackRecipientCode,
      reason:    `Buy Safe payout: ${order.itemName} (order ${order._id})`,
      reference: `PAY-${order.paystackReference}`,
    }, { headers: psHeaders() });

    order.paystackTransferCode = data.data.transfer_code;
    order.transition('COMPLETED', req.user._id, 'Receiver confirmed receipt — payout initiated');

    // ── Update trust scores for both parties ──────────────────────────────
    await Promise.all([
      User.findByIdAndUpdate(initiator._id, {
        $inc: { 'trustScore.activity.totalOrders': 1, 'trustScore.activity.completedOrders': 1 },
      }).session(session),
      User.findByIdAndUpdate(order.receiver._id, {
        $inc: { 'trustScore.activity.totalOrders': 1, 'trustScore.activity.completedOrders': 1 },
      }).session(session),
    ]);

    await order.save({ session });
    await session.commitTransaction();

    // Notify initiator
    if (initiator.fcmToken) {
      sendPush(initiator.fcmToken, {
        title: '💸 Payout Sent — Buy Safe',
        body:  `GHS ${(payoutPesewas / 100).toFixed(2)} for "${order.itemName}" is on its way to your MoMo.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }

    res.json({
      success: true,
      message: `Funds released. GHS ${(payoutPesewas / 100).toFixed(2)} is being sent to @${initiator.username}'s MoMo account.`,
      payoutAccount: initiator.payoutAccount
        ? { networkLabel: initiator.payoutAccount.networkLabel, maskedNumber: initiator.payoutAccount.maskedNumber }
        : null,
    });
  } catch (err) {
    await session.abortTransaction();
    // Paystack transfer failure (e.g. insufficient balance on platform)
    if (err.response?.data?.message) {
      return res.status(502).json({
        success: false,
        message: `Payout failed: ${err.response.data.message}. Please contact Buy Safe support.`,
      });
    }
    next(err);
  } finally {
    session.endSession();
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// REJECT ORDER  — receiver rejects delivery
// POST /api/orders/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(req.params.id).populate('initiator').session(session);
    if (!order)
      return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.receiver.equals(req.user._id))
      return res.status(403).json({ success: false, message: 'Only the receiver can reject.' });
    if (order.status !== 'SHIPPED')
      return res.status(422).json({ success: false, message: 'Order must be SHIPPED to reject.' });

    order.transition('REJECTED', req.user._id,
      `Receiver rejected delivery${req.body.reason ? ': ' + req.body.reason : ''}`);
    order.rejectedAt            = new Date();
    order.returnConfirmDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h

    const job = await scheduleAutoRefund(order._id.toString(), 24 * 60 * 60 * 1000);
    order.autoRefundJobId = job.id.toString();

    // Dispute counts against both — trust score recalculated on resolution
    await Promise.all([
      User.findByIdAndUpdate(order.initiator._id, {
        $inc: { 'trustScore.activity.totalOrders': 1, 'trustScore.activity.disputedOrders': 1 },
      }).session(session),
      User.findByIdAndUpdate(order.receiver, {
        $inc: { 'trustScore.activity.totalOrders': 1, 'trustScore.activity.disputedOrders': 1 },
      }).session(session),
    ]);

    await order.save({ session });
    await session.commitTransaction();

    if (order.initiator?.fcmToken) {
      sendPush(order.initiator.fcmToken, {
        title: '⚠️ Delivery Rejected — Buy Safe',
        body:  `@${req.user.username} rejected "${order.itemName}". Confirm you have the item back within 24 hours or a refund will be issued automatically.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }

    res.json({
      success: true,
      message: 'Order rejected. Initiator has 24 hours to confirm item return.',
      returnConfirmDeadline: order.returnConfirmDeadline,
    });
  } catch (err) {
    await session.abortTransaction(); next(err);
  } finally { session.endSession(); }
};

// ─────────────────────────────────────────────────────────────────────────────
// CONFIRM RETURN  — initiator confirms item came back
// POST /api/orders/:id/confirm-return
// ─────────────────────────────────────────────────────────────────────────────
exports.confirmReturn = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(req.params.id).session(session);
    if (!order)
      return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.initiator.equals(req.user._id))
      return res.status(403).json({ success: false, message: 'Only the initiator can confirm item return.' });
    if (order.status !== 'REJECTED')
      return res.status(422).json({ success: false, message: 'Order is not in REJECTED state.' });

    if (order.autoRefundJobId) await cancelAutoRefund(order.autoRefundJobId);

    order.returnConfirmedAt = new Date();
    order.history.push({ state: 'COMPLETED', actor: req.user._id, note: 'Initiator confirmed item returned. No payout.' });
    order.status = 'COMPLETED';
    await order.save({ session });
    await session.commitTransaction();

    res.json({ success: true, message: 'Return confirmed. Auto-refund cancelled. Escrow closed.' });
  } catch (err) {
    await session.abortTransaction(); next(err);
  } finally { session.endSession(); }
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-REFUND  — called by BullMQ worker after 24h deadline
// Internal — not an HTTP route
// ─────────────────────────────────────────────────────────────────────────────
exports.triggerRefund = async (orderId) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(orderId).populate('receiver').session(session);
    if (!order || order.status !== 'REJECTED') { await session.abortTransaction(); return; }

    const { data } = await axios.post(`${PS}/refund`, {
      transaction:   order.paystackReference,
      amount:        order.fees.itemPrice,   // base price only — fees non-refundable
      customer_note: 'Buy Safe: Refund issued because the item was not returned within 24 hours.',
      merchant_note: `Auto-refund: order ${order._id}`,
    }, { headers: psHeaders() });

    order.paystackRefundId = data.data.id;
    order.transition('REFUNDED', null, 'Auto-refund issued after 24h deadline');
    await order.save({ session });

    await User.findByIdAndUpdate(order.initiator, {
      $inc: { 'trustScore.activity.refundedOrders': 1 },
    }).session(session);

    await session.commitTransaction();
    console.log(`✅ Auto-refund issued for order ${orderId}`);

    if (order.receiver?.fcmToken) {
      sendPush(order.receiver.fcmToken, {
        title: '💸 Refund Issued — Buy Safe',
        body:  `Your refund of GHS ${(order.fees.itemPrice / 100).toFixed(2)} for "${order.itemName}" is on its way.`,
        data:  { orderId: order._id.toString(), screen: 'OrderDetail' },
      }).catch(console.warn);
    }
  } catch (err) {
    await session.abortTransaction(); throw err;
  } finally { session.endSession(); }
};

// ─────────────────────────────────────────────────────────────────────────────
// LIST ORDERS
// GET /api/orders?role=initiator|receiver&status=...&page=1
// ─────────────────────────────────────────────────────────────────────────────
exports.listOrders = async (req, res, next) => {
  try {
    const { role = 'all', status, page = 1, limit = 15 } = req.query;
    const filter = {};

    if (role === 'initiator')    filter.initiator = req.user._id;
    else if (role === 'receiver') filter.receiver  = req.user._id;
    else filter.$or = [{ initiator: req.user._id }, { receiver: req.user._id }];

    if (status) filter.status = status.toUpperCase();

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('initiator', 'username displayName avatarUrl trustScore payoutAccount')
        .populate('receiver',  'username displayName avatarUrl trustScore')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(Number(limit)),
      Order.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: { page: Number(page), limit: Number(limit), total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET SINGLE ORDER
// GET /api/orders/:id
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrder = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('initiator', 'username displayName avatarUrl trustScore payoutAccount paystackRecipientCode')
      .populate('receiver',  'username displayName avatarUrl trustScore');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });

    const isParty = order.initiator._id.equals(req.user._id) || order.receiver._id.equals(req.user._id);
    if (!isParty) return res.status(403).json({ success: false, message: 'Access denied.' });

    // Tell the receiver whether the initiator has a payout account set up
    const initiatorHasPayoutAccount = !!order.initiator.paystackRecipientCode;

    res.json({ success: true, data: { ...order.toObject(), initiatorHasPayoutAccount } });
  } catch (err) { next(err); }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET USER PROFILE (public)
// GET /api/users/:username
// ─────────────────────────────────────────────────────────────────────────────
exports.getUserProfile = async (req, res, next) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, data: user.toPublicProfile() });
  } catch (err) { next(err); }
};