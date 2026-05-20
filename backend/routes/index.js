// routes/index.js — Buy Safe
const router       = require('express').Router();
const authCtrl     = require('../controllers/authController');
const orderCtrl    = require('../controllers/orderController');
const reviewCtrl   = require('../controllers/reviewController');
const payoutCtrl   = require('../controllers/payoutController');
const { protect, requireOnboarding } = require('../middleware/auth');
const { paystackIpWhitelist }        = require('../middleware/webhookSecurity');
const v = require('../middleware/validation');

const transact = [protect, requireOnboarding]; // shorthand for transactional routes

// ── Auth ──────────────────────────────────────────────────────────────────────
router.post('/auth/google',          v.validateGoogleAuth,    authCtrl.googleAuth);
//router.post('/auth/apple',           v.validateAppleAuth,     authCtrl.appleAuth);
router.post('/auth/set-username',    protect, v.validateSetUsername, authCtrl.setUsername);
router.get ('/auth/check-username',  authCtrl.checkUsername);
router.get ('/auth/me',              protect, authCtrl.getMe);
router.patch('/auth/profile',        protect, v.validateUpdateProfile, authCtrl.updateProfile);
router.post('/auth/fcm-token',       protect, authCtrl.updateFcmToken);

// ── Orders ────────────────────────────────────────────────────────────────────
router.get ('/orders',                    ...transact, orderCtrl.listOrders);
router.post('/orders',                    ...transact, v.validateCreateOrder, orderCtrl.createOrder);
router.get ('/orders/:id',                ...transact, orderCtrl.getOrder);
router.post('/orders/:id/pay',            ...transact, orderCtrl.initializePayment);
router.post('/orders/:id/ship',           ...transact, orderCtrl.markShipped);
router.post('/orders/:id/release',        ...transact, orderCtrl.releaseFunds);
router.post('/orders/:id/reject',         ...transact, v.validateReject, orderCtrl.rejectOrder);
router.post('/orders/:id/confirm-return', ...transact, orderCtrl.confirmReturn);

// ── Reviews ───────────────────────────────────────────────────────────────────
router.post('/orders/:id/review',         ...transact, v.validateReview, reviewCtrl.submitReview);
router.get ('/users/:username/reviews',   reviewCtrl.getUserReviews);
router.get ('/users/:username',           protect, orderCtrl.getUserProfile);

// ── Payout account (MoMo setup) ───────────────────────────────────────────────
router.get ('/payout/networks',       protect, payoutCtrl.getNetworks);
router.post('/payout/verify',         protect, v.validateVerifyAccount, payoutCtrl.verifyAccount);
router.post('/payout/setup',          protect, v.validateSetupPayout,   payoutCtrl.setupPayout);
router.get ('/payout/account',        protect, payoutCtrl.getPayoutAccount);
router.delete('/payout/account',      protect, payoutCtrl.removePayoutAccount);

// ── Paystack Webhook (raw body set in server.js) ──────────────────────────────
router.post('/paystack/webhook', paystackIpWhitelist, orderCtrl.handleWebhook);


module.exports = router;