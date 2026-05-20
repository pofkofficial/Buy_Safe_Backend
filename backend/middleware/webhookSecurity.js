// middleware/webhookSecurity.js — IP whitelisting for Paystack webhook
const PAYSTACK_IPS = new Set([
  // Paystack's documented static IP ranges (verify current list at https://paystack.com/docs/payments/webhooks)
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
]);

/**
 * Middleware: only allow requests from Paystack's IP range.
 * Sits behind a trusted reverse proxy (nginx/ELB) — ensure
 * `app.set('trust proxy', 1)` is configured if behind a load balancer.
 */
exports.paystackIpWhitelist = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const cleanIp = ip.replace('::ffff:', ''); // handle IPv4-mapped IPv6

  if (process.env.NODE_ENV === 'development') {
    // Allow localhost in dev
    if (cleanIp === '127.0.0.1' || cleanIp === '::1') return next();
  }

  if (!PAYSTACK_IPS.has(cleanIp)) {
    console.warn(`🚫 Webhook rejected from unauthorized IP: ${cleanIp}`);
    return res.status(403).json({ message: 'Forbidden' });
  }

  next();
};