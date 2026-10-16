function getAuthConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !anonKey) {
    const error = new Error('Supabase Auth sunucu ayarları tanımlı değil.');
    error.status = 500;
    throw error;
  }
  return { supabaseUrl, anonKey };
}

async function verifySupabaseAccessToken(accessToken) {
  if (!accessToken) {
    const error = new Error('Oturum doğrulanamadı.');
    error.status = 401;
    throw error;
  }
  const { supabaseUrl, anonKey } = getAuthConfig();
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    }
  });
  const user = await response.json().catch(() => null);
  if (!response.ok || !user?.id) {
    const error = new Error('Supabase oturumu geçersiz veya süresi dolmuş.');
    error.status = response.status === 401 ? 401 : 503;
    throw error;
  }
  return user;
}

module.exports = { getAuthConfig, verifySupabaseAccessToken };