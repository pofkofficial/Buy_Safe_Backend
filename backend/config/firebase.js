// config/firebase.js — Firebase Admin SDK for push notifications
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Replace \n in env var (common issue with multiline PEM in .env)
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

/**
 * Send a push notification via FCM.
 * @param {string} token - Device FCM token
 * @param {{ title: string, body: string, data?: Record<string, string> }} payload
 */
async function sendPushNotification(token, { title, body, data = {} }) {
  const message = {
    token,
    notification: { title, body },
    data,                         // key-value string pairs for deep linking
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
  };

  const response = await admin.messaging().send(message);
  console.log(`📱 FCM notification sent: ${response}`);
  return response;
}

module.exports = { sendPushNotification };