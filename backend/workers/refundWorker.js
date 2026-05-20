// workers/refundWorker.js — Buy Safe BullMQ auto-refund queue
// Supports Upstash (cloud) and local Redis
// Set REDIS_URL in .env — Upstash URLs start with rediss:// (TLS)

const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

// ─── Redis Connection ─────────────────────────────────────────────────────────
// Upstash uses rediss:// (with TLS). Local Redis uses redis://
// BullMQ requires maxRetriesPerRequest: null — do not remove this.
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const isTLS     = REDIS_URL.startsWith('rediss://');

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,   // required by BullMQ
  enableReadyCheck:     false,  // required by BullMQ
  tls: isTLS ? {} : undefined,  // Upstash requires TLS
});

connection.on('connect', () => console.log('✅ BullMQ Redis connected'));
connection.on('error',   (err) => console.error('❌ BullMQ Redis error:', err.message));

// ─── Queue ────────────────────────────────────────────────────────────────────
const QUEUE_NAME = 'auto-refund';

const refundQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 }, // retry: 1min, 2min, 4min
    removeOnComplete: { count: 500 },
    removeOnFail:     false,   // keep failed jobs for manual review
  },
});

// ─── Schedule an auto-refund ──────────────────────────────────────────────────
async function scheduleAutoRefund(orderId, delayMs = 24 * 60 * 60 * 1000) {
  const job = await refundQueue.add(
    'refund',
    { orderId },
    {
      delay:  delayMs,
      jobId: `refund-${orderId}`,  // idempotent — one job per order
    }
  );
  console.log(`⏰ Auto-refund scheduled for order ${orderId} in ${delayMs / 3_600_000}h (job: ${job.id})`);
  return job;
}

// ─── Cancel an auto-refund ────────────────────────────────────────────────────
async function cancelAutoRefund(jobId) {
  const job = await refundQueue.getJob(jobId);
  if (job) {
    await job.remove();
    console.log(`🚫 Auto-refund job ${jobId} cancelled`);
  } else {
    console.warn(`cancelAutoRefund: job ${jobId} not found — may have already fired`);
  }
}

// ─── Worker ───────────────────────────────────────────────────────────────────
// Lazy-require to avoid circular dependency (orderController → refundWorker → orderController)
let _triggerRefund;
function getTriggerRefund() {
  if (!_triggerRefund) {
    _triggerRefund = require('../controllers/orderController').triggerRefund;
  }
  return _triggerRefund;
}

const refundWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { orderId } = job.data;
    console.log(`🔄 Processing auto-refund for order ${orderId} (attempt ${job.attemptsMade + 1})`);
    await getTriggerRefund()(orderId);
    console.log(`✅ Auto-refund complete for order ${orderId}`);
  },
  {
    connection,
    concurrency: 5,
  }
);

refundWorker.on('completed', (job) => console.log(`✅ Refund job ${job.id} completed`));
refundWorker.on('failed',    (job, err) => console.error(`❌ Refund job ${job?.id} failed:`, err.message));
refundWorker.on('stalled',   (jobId) => console.warn(`⚠️  Refund job ${jobId} stalled — will retry`));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  await refundWorker.close();
  await connection.quit();
  process.exit(0);
});

module.exports = { refundQueue, scheduleAutoRefund, cancelAutoRefund };