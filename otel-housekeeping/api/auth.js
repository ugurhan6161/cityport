const { getAuthConfig } = require('../lib/supabase-auth');

const authRoutes = {
  login: { path: 'token?grant_type=password', fields: ['email', 'password'] },
  register: { path: 'signup', fields: ['email', 'password', 'data'] },
  refresh: { path: 'token?grant_type=refresh_token', fields: ['refresh_token'] }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const action = String(req.body?.action || '');
    const route = authRoutes[action];
    if (!route) return res.status(400).json({ error: 'Geçersiz oturum işlemi.' });
    const body = Object.fromEntries(route.fields
      .filter(field => req.body?.[field] !== undefined)
      .map(field => [field, req.body[field]]));
    if (route.fields.some(field => !body[field])) {
      return res.status(400).json({ error: 'E-posta ve şifre bilgileri gereklidir.' });
    }
    const { supabaseUrl, anonKey } = getAuthConfig();
    const response = await fetch(`${supabaseUrl}/auth/v1/${route.path}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = {
        invalid_credentials: 'E-posta veya şifre hatalı.',
        email_not_confirmed: 'Giriş yapmadan önce e-posta adresinizi doğrulayın.',
        user_already_exists: 'Bu e-posta adresi zaten kayıtlı.',
        weak_password: 'Şifre en az 6 karakter olmalı.'
      };
      return res.status(response.status).json({
        error: messages[result.code] || messages[result.error_code] || result.msg || result.message || 'Supabase Auth işlemi başarısız.',
        code: result.code || result.error_code
      });
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error('Supabase Auth isteği başarısız:', error);
    return res.status(Number(error.status) || 503).json({ error: error.message || 'Supabase Auth kullanılamıyor.' });
  }
};