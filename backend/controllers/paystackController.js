// controllers/paystackController.js
const crypto = require('crypto');
const axios = require('axios');
const mongoose = require('mongoose');
const Order = require('../models/orderModel');
const User = require('../models/userModel');
const { scheduleAutoRefund, cancelAutoRefund } = require('../workers/refundWorker');
const { sendPushNotification } = require('../config/firebase');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const paystackHeaders = () => ({
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  'Content-Type': 'application/json',
});

/**
 * Calculate fee breakdown.
 * Platform fee: 1.5% of item price.
 * Paystack fee: 1.5% + ₦100 (capped at ₦2000), per their docs (amounts in kobo).
 */
function calculateFees(itemPriceKobo) {
  const platformFee = Math.round(itemPriceKobo * 0.015);
  const paystackPercent = Math.round(itemPriceKobo * 0.015);
  const paystackFlat = 10000; // ₦100 in kobo
  const paystackFee = Math.min(paystackPercent + paystackFlat, 200000); // cap ₦2000
  const totalCharged = itemPriceKobo + platformFee + paystackFee;
  return { itemPrice: itemPriceKobo, platformFee, paystackFee, totalCharged };
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * POST /api/orders — Create a new escrow order
 */
exports.createOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { itemName, itemDescription, itemPriceNGN, buyerUsername } = req.body;
    const sellerId = req.user._id;

    // Resolve buyer by username (PSSID lookup)
    const buyer = await User.findOne({ username: buyerUsername }).session(session);
    if (!buyer) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Buyer not found.' });
    }

    if (buyer._id.equals(sellerId)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Cannot create order with yourself.' });
    }

    const itemPriceKobo = Math.round(itemPriceNGN * 100);
    const fees = calculateFees(itemPriceKobo);

    // Generate unique Paystack reference
    const paystackReference = `ESC-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const [order] = await Order.create([{
      seller: sellerId,
      buyer: buyer._id,
      itemName,
      itemDescription,
      itemPrice: itemPriceKobo,
      fees,
      paystackReference,
      history: [{ state: 'PENDING', actor: sellerId, note: 'Order created by seller' }],
    }], { session });

    await session.commitTransaction();

    // Notify buyer via FCM (outside transaction — non-critical)
    if (buyer.fcmToken) {
      sendPushNotification(buyer.fcmToken, {
        title: '💰 New Escrow Request',
        body: `${req.user.displayName} wants to sell you "${itemName}" for ₦${itemPriceNGN.toLocaleString()}`,
        data: { orderId: order._id.toString(), type: 'NEW_ORDER' },
      }).catch(err => console.warn('FCM send failed:', err.message));
    }

    res.status(201).json({
      success: true,
      data: {
        orderId: order._id,
        paystackReference,
        totalChargedNGN: fees.totalCharged / 100,
        paymentUrl: `https://paystack.com/pay/${paystackReference}`, // or use inline JS
      },
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * POST /api/paystack/initialize-payment — Get Paystack checkout URL for buyer
 */
exports.initializePayment = async (req, res, next) => {
  try {
    const { orderId } = req.body;
    const buyerId = req.user._id;

    const order = await Order.findById(orderId).populate('buyer seller');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.buyer._id.equals(buyerId)) return res.status(403).json({ success: false, message: 'Forbidden.' });
    if (order.status !== 'PENDING') return res.status(422).json({ success: false, message: `Order is ${order.status}, not PENDING.` });

    const { data } = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email: req.user.email,
      amount: order.fees.totalCharged,
      reference: order.paystackReference,
      metadata: {
        orderId: order._id.toString(),
        buyerId: buyerId.toString(),
        sellerId: order.seller._id.toString(),
        custom_fields: [
          { display_name: 'Item', variable_name: 'item_name', value: order.itemName },
        ],
      },
      callback_url: `${process.env.APP_BASE_URL}/payment-success`,
    }, { headers: paystackHeaders() });

    res.json({ success: true, authorizationUrl: data.data.authorization_url });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/paystack/webhook — Verified Paystack event handler
 * NOTE: This route receives raw body (configured in server.js)
 */
exports.handleWebhook = async (req, res, next) => {
  // ── 1. Signature Verification ────────────────────────────────────────────
  const signature = req.headers['x-paystack-signature'];
  if (!signature) return res.status(401).send('No signature');

  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body) // raw Buffer
    .digest('hex');

  if (hash !== signature) {
    console.warn('⚠️  Paystack webhook signature mismatch — possible spoofing attempt');
    return res.status(401).send('Invalid signature');
  }

  // ── 2. Always ACK quickly (Paystack retries if no 200 within 5s) ─────────
  res.sendStatus(200);

  // ── 3. Process Event Asynchronously ──────────────────────────────────────
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return console.error('Webhook: Failed to parse JSON body');
  }

  console.log(`📨 Paystack event: ${event.event}`);

  try {
    if (event.event === 'charge.success') {
      await handleChargeSuccess(event.data);
    } else if (event.event === 'transfer.success') {
      await handleTransferSuccess(event.data);
    } else if (event.event === 'transfer.failed') {
      await handleTransferFailed(event.data);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
};

async function handleChargeSuccess(data) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findOne({ paystackReference: data.reference }).session(session);
    if (!order) throw new Error(`Order not found for ref: ${data.reference}`);
    if (order.status !== 'PENDING') {
      // Idempotency: already processed
      await session.abortTransaction();
      return;
    }

    order.transition('ESCROWED', null, 'Payment confirmed via Paystack webhook');
    await order.save({ session });
    await session.commitTransaction();

    // Notify seller
    const seller = await User.findById(order.seller);
    if (seller?.fcmToken) {
      sendPushNotification(seller.fcmToken, {
        title: '✅ Funds Locked in Escrow',
        body: `Payment for "${order.itemName}" received. Ship the item now.`,
        data: { orderId: order._id.toString(), type: 'ESCROWED' },
      }).catch(console.warn);
    }
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

async function handleTransferSuccess(data) {
  // Mark order COMPLETED if transfer_code matches
  const order = await Order.findOne({ paystackTransferCode: data.transfer_code });
  if (!order) return;
  if (order.status === 'SHIPPED') {
    order.transition('COMPLETED', null, 'Seller payout confirmed');
    await order.save();
  }
}

async function handleTransferFailed(data) {
  console.error(`Transfer failed for code: ${data.transfer_code}. Manual review required.`);
  // TODO: Alert ops team, flag order for manual resolution
}

/**
 * POST /api/orders/:id/release — Buyer releases funds to seller
 */
exports.releaseFunds = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(req.params.id)
      .populate('seller buyer')
      .session(session);

    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.buyer._id.equals(req.user._id)) return res.status(403).json({ success: false, message: 'Only the buyer can release funds.' });

    order.transition('COMPLETED', req.user._id, 'Buyer confirmed receipt');

    // Get seller's Paystack recipient code (stored on User profile)
    const seller = order.seller;
    if (!seller.paystackRecipientCode) {
      await session.abortTransaction();
      return res.status(422).json({ success: false, message: 'Seller has not set up a payout account.' });
    }

    // Initiate transfer (payout = item price + platform fee goes to Escrow-Lite)
    const payoutKobo = order.fees.itemPrice; // Seller gets base price only; platform keeps platform fee
    const { data } = await axios.post(`${PAYSTACK_BASE}/transfer`, {
      source: 'balance',
      amount: payoutKobo,
      recipient: seller.paystackRecipientCode,
      reason: `Escrow payout: ${order.itemName}`,
      reference: `PAYOUT-${order.paystackReference}`,
    }, { headers: paystackHeaders() });

    order.paystackTransferCode = data.data.transfer_code;
    await order.save({ session });
    await session.commitTransaction();

    res.json({ success: true, message: 'Funds released. Seller payout initiated.' });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * POST /api/orders/:id/reject — Buyer rejects delivery
 */
exports.rejectOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(req.params.id).populate('seller buyer').session(session);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.buyer._id.equals(req.user._id)) return res.status(403).json({ success: false, message: 'Only the buyer can reject.' });

    order.transition('REJECTED', req.user._id, 'Buyer rejected delivery');
    order.rejectedAt = new Date();
    order.returnConfirmDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h

    // Schedule auto-refund job
    const job = await scheduleAutoRefund(order._id.toString(), 24 * 60 * 60 * 1000);
    order.autoRefundJobId = job.id.toString();

    await order.save({ session });
    await session.commitTransaction();

    // Notify seller
    const seller = order.seller;
    if (seller?.fcmToken) {
      sendPushNotification(seller.fcmToken, {
        title: '⚠️ Buyer Rejected Delivery',
        body: `"${order.itemName}" was rejected. Confirm item return within 24 hours or a refund will be issued automatically.`,
        data: { orderId: order._id.toString(), type: 'REJECTED' },
      }).catch(console.warn);
    }

    res.json({
      success: true,
      message: 'Order rejected. Seller has 24 hours to confirm item return.',
      returnConfirmDeadline: order.returnConfirmDeadline,
    });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * POST /api/orders/:id/confirm-return — Seller confirms they received item back
 */
exports.confirmReturn = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(req.params.id).populate('buyer').session(session);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (!order.seller.equals(req.user._id)) return res.status(403).json({ success: false, message: 'Only the seller can confirm return.' });
    if (order.status !== 'REJECTED') return res.status(422).json({ success: false, message: 'Order is not in REJECTED state.' });

    // Cancel the scheduled auto-refund
    if (order.autoRefundJobId) {
      await cancelAutoRefund(order.autoRefundJobId);
    }

    order.returnConfirmedAt = new Date();
    // Re-list as COMPLETED without payout (seller confirmed return; funds stay on platform for manual ops review or fee deduction)
    order.history.push({ state: 'COMPLETED', actor: req.user._id, note: 'Seller confirmed item returned. No payout.' });
    order.status = 'COMPLETED';

    await order.save({ session });
    await session.commitTransaction();

    res.json({ success: true, message: 'Return confirmed. Auto-refund cancelled.' });
  } catch (err) {
    await session.abortTransaction();
    next(err);
  } finally {
    session.endSession();
  }
};

/**
 * Internal: Trigger refund to buyer (called by BullMQ worker or manually)
 */
exports.triggerRefund = async (orderId) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const order = await Order.findById(orderId).populate('buyer').session(session);
    if (!order) throw new Error(`Refund: Order ${orderId} not found`);
    if (order.status !== 'REJECTED') {
      await session.abortTransaction();
      console.log(`Refund skipped — order ${orderId} is ${order.status}`);
      return;
    }

    // Issue Paystack refund (base item price only; fees non-refundable)
    const { data } = await axios.post(`${PAYSTACK_BASE}/refund`, {
      transaction: order.paystackReference,
      amount: order.fees.itemPrice, // kobo — only refund base price
      customer_note: 'Escrow-Lite: Seller did not confirm item return within 24 hours.',
      merchant_note: `Auto-refund triggered for order ${order._id}`,
    }, { headers: paystackHeaders() });

    order.paystackRefundId = data.data.id;
    order.transition('REFUNDED', null, 'Auto-refund triggered after 24-hour deadline');
    await order.save({ session });
    await session.commitTransaction();

    console.log(`✅ Auto-refund issued for order ${orderId}`);

    // Notify buyer
    const buyer = order.buyer;
    if (buyer?.fcmToken) {
      sendPushNotification(buyer.fcmToken, {
        title: '💸 Refund Issued',
        body: `Your refund of ₦${(order.fees.itemPrice / 100).toLocaleString()} for "${order.itemName}" has been initiated.`,
        data: { orderId: order._id.toString(), type: 'REFUNDED' },
      }).catch(console.warn);
    }
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
};