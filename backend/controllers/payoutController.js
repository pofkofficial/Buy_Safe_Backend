// controllers/payoutController.js — Buy Safe
// Handles everything related to seller payout setup:
//   1. List supported MoMo networks and banks (Ghana)
//   2. Verify an account before saving (Paystack account resolution)
//   3. Create a Paystack Transfer Recipient and store on user profile
//   4. View / delete saved payout account

const axios = require('axios');
const User  = require('../models/userModel');

const PS_BASE   = 'https://api.paystack.co';
const psHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// ── Ghana MoMo networks supported by Paystack ─────────────────────────────────
// type: 'mobile_money' for all MoMo; currency always GHS
const GHANA_MOMO_NETWORKS = [
  { code: 'MTN',      label: 'MTN Mobile Money',       placeholder: '024XXXXXXX' },
  { code: 'VOD',      label: 'Vodafone Cash',           placeholder: '020XXXXXXX' },
  { code: 'ATL',      label: 'AirtelTigo Money',        placeholder: '027XXXXXXX' },
];

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payout/networks
// Returns list of supported Ghana MoMo networks (for the frontend dropdown)
// ─────────────────────────────────────────────────────────────────────────────
exports.getNetworks = (_req, res) => {
  res.json({ success: true, data: GHANA_MOMO_NETWORKS });
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payout/verify
// Verify MoMo number with Paystack before the user saves it.
// Body: { accountNumber, bankCode (network code e.g. "MTN") }
// Paystack resolves the account name — we show it to the user for confirmation.
// ─────────────────────────────────────────────────────────────────────────────
exports.verifyAccount = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.body;

    // Paystack account resolution endpoint
    const { data } = await axios.get(`${PS_BASE}/bank/resolve`, {
      params: {
        account_number: accountNumber,
        bank_code:      bankCode,
        account_type:   'mobile_money',
        country:        'ghana',
        currency:       'GHS',
      },
      headers: psHeaders(),
    });

    res.json({
      success:     true,
      accountName: data.data.account_name,   // e.g. "KWAME ASANTE"
      accountNumber: data.data.account_number,
    });
  } catch (err) {
    // Paystack returns 422 for unresolvable accounts
    if (err.response?.status === 422 || err.response?.status === 400) {
      return res.status(422).json({
        success: false,
        message: 'Could not verify this number. Check the number and network, then try again.',
      });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payout/setup
// Create a Paystack Transfer Recipient for the user's MoMo number.
// Body: { accountNumber, networkCode, accountName (from verify step) }
//
// Flow:
//   1. Call POST /transferrecipient → get recipient_code
//   2. Store recipient_code + masked number on User document
// ─────────────────────────────────────────────────────────────────────────────
exports.setupPayout = async (req, res, next) => {
  try {
    const { accountNumber, networkCode, accountName } = req.body;
    const user = req.user;

    const network = GHANA_MOMO_NETWORKS.find(n => n.code === networkCode);
    if (!network) {
      return res.status(400).json({ success: false, message: 'Unsupported network.' });
    }

    // If user already has a recipient, delete the old one first
    if (user.paystackRecipientCode) {
      await axios.delete(`${PS_BASE}/transferrecipient/${user.paystackRecipientCode}`, {
        headers: psHeaders(),
      }).catch(() => {}); // non-fatal if already deleted on Paystack side
    }

    // Create new recipient
    const { data } = await axios.post(`${PS_BASE}/transferrecipient`, {
      type:           'mobile_money',
      name:           accountName,
      account_number: accountNumber,
      bank_code:      networkCode,     // Paystack uses bank_code for MoMo network
      currency:       'GHS',
      description:    `Buy Safe payout — @${user.username}`,
    }, { headers: psHeaders() });

    const recipientCode = data.data.recipient_code;

    // Mask number for display: 024XXXXXXX → 024***XXX
    const masked = accountNumber.slice(0, 3) + '****' + accountNumber.slice(-3);

    // Save to user profile
    user.paystackRecipientCode    = recipientCode;
    user.payoutAccount = {
      networkCode,
      networkLabel: network.label,
      maskedNumber: masked,
      accountName,
      recipientCode,
      linkedAt: new Date(),
    };
    await user.save();

    // Refresh standing (profile more complete now)
    user.refreshStanding();
    await user.save();

    res.json({
      success: true,
      message: `${network.label} account linked successfully.`,
      payoutAccount: {
        networkLabel: network.label,
        maskedNumber: masked,
        accountName,
      },
    });
  } catch (err) {
    if (err.response?.data?.message) {
      return res.status(422).json({ success: false, message: err.response.data.message });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payout/account
// Get current user's saved payout account (masked)
// ─────────────────────────────────────────────────────────────────────────────
exports.getPayoutAccount = (req, res) => {
  const u = req.user;
  if (!u.paystackRecipientCode || !u.payoutAccount) {
    return res.json({ success: true, data: null });
  }
  res.json({
    success: true,
    data: {
      networkLabel: u.payoutAccount.networkLabel,
      maskedNumber: u.payoutAccount.maskedNumber,
      accountName:  u.payoutAccount.accountName,
      linkedAt:     u.payoutAccount.linkedAt,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/payout/account
// Remove saved payout account
// ─────────────────────────────────────────────────────────────────────────────
exports.removePayoutAccount = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.paystackRecipientCode) {
      return res.status(404).json({ success: false, message: 'No payout account linked.' });
    }

    // Delete on Paystack (best effort)
    await axios.delete(`${PS_BASE}/transferrecipient/${user.paystackRecipientCode}`, {
      headers: psHeaders(),
    }).catch(() => {});

    user.paystackRecipientCode = undefined;
    user.payoutAccount         = undefined;
    await user.save();

    res.json({ success: true, message: 'Payout account removed.' });
  } catch (err) {
    next(err);
  }
};
