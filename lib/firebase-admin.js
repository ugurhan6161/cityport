const admin = require('firebase-admin');

function getServiceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = encoded || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const fields = {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY
  };
  if (Object.values(fields).every(Boolean)) {
    return { type: 'service_account', ...fields, private_key: fields.private_key.replace(/\\n/g, '\n') };
  }
  if (!raw) {
    const error = new Error('Firebase servis hesabı tanımlı değil.');
    error.code = 'config/missing-service-account';
    throw error;
  }

  try {
    const value = encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw.trim().replace(/^\uFEFF/, '');
    let serviceAccount = JSON.parse(value);
    if (typeof serviceAccount === 'string') serviceAccount = JSON.parse(serviceAccount);
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      const error = new Error('Firebase servis hesabı alanları eksik.');
      error.code = 'config/incomplete-service-account';
      throw error;
    }
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    return serviceAccount;
  } catch (error) {
    if (error.code?.startsWith('config/')) throw error;
    const configError = new Error('Firebase servis hesabı JSON olarak okunamadı.');
    configError.code = 'config/invalid-service-account';
    configError.cause = error;
    throw configError;
  }
}

function getFirebaseAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(getServiceAccount())
    });
  }
  return admin;
}

module.exports = { getFirebaseAdmin };
