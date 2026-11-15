const { createSign } = require('node:crypto');

const scope = 'https://www.googleapis.com/auth/spreadsheets';
const b64url = (value) => Buffer.from(value).toString('base64url');
const quoteSheet = (name) => `'${String(name).replace(/'/g, "''")}'`;
const columnName = (index) => {
  let name = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
};
const normalize = (value) => String(value || '').replace(/[\s_()\-·]/g, '').toLowerCase();

function findColumn(headers, aliases) {
  const normalized = headers.map(normalize);
  for (const alias of aliases) {
    const index = normalized.indexOf(normalize(alias));
    if (index >= 0) return index;
  }
  return -1;
}

async function googleToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  if (!credentials.client_email || !credentials.private_key || !credentials.token_uri) throw new Error('Google Sheets service account is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: credentials.private_key_id }))}.${b64url(JSON.stringify({ iss: credentials.client_email, scope, aud: credentials.token_uri, iat: now, exp: now + 3600 }))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key).toString('base64url')}`;
  const response = await fetch(credentials.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error('Google authorization failed.');
  return body.access_token;
}

async function sheetRequest(token, path, options = {}) {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '')}/${path}`, { ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || 'Google Sheets request failed.');
  return body;
}

async function requireAdmin(authorization) {
  if (!authorization?.startsWith('Bearer ')) throw new Error('Authentication is required.');
  const token = authorization.slice(7);
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key) throw new Error('Supabase server configuration is missing.');
  const userResponse = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, authorization } });
  const user = await userResponse.json();
  if (!userResponse.ok || !user.id) throw new Error('Invalid session.');
  const profileResponse = await fetch(`${base}/rest/v1/profiles?select=role&id=eq.${encodeURIComponent(user.id)}`, { headers: { apikey: key, authorization } });
  const profiles = await profileResponse.json();
  if (!profileResponse.ok || profiles?.[0]?.role !== 'admin') throw new Error('Administrator access is required.');
  return { token, base, key };
}

async function loadCompanies(companyIds, auth) {
  if (!Array.isArray(companyIds) || !companyIds.length || companyIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error('Invalid company selection.');
  const ids = companyIds.join(',');
  const response = await fetch(`${auth.base}/rest/v1/companies?select=id,company_name,business_registration_number,confirmed_address,category_major,category_minor,workflow_status&id=in.(${ids})`, { headers: { apikey: auth.key, authorization: `Bearer ${auth.token}` } });
  const companies = await response.json();
  if (!response.ok) throw new Error('Could not load companies.');
  return companies;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed.' });
  try {
    const auth = await requireAdmin(req.headers.authorization);
    const companies = await loadCompanies(req.body?.companyIds, auth);
    const token = await googleToken();
    const sheet = quoteSheet(process.env.GOOGLE_SHEETS_TAB_NAME);
    const values = await sheetRequest(token, `values/${encodeURIComponent(`${sheet}!A1:ZZ`)}`);
    const rows = values.values || [];
    const headers = rows[0] || [];
    const columns = {
      company: findColumn(headers, ['기업명', '경영체명', '회사명', '상호명']),
      business: findColumn(headers, ['사업자등록번호', '사업자번호']),
      address: findColumn(headers, ['확정 주소', '주소', '상세주소', '사업장 주소', '경영체 주소']),
      major: findColumn(headers, ['대구분', '분야']),
      minor: findColumn(headers, ['소구분']),
      status: findColumn(headers, ['진행상태', '상태', '운영상태'])
    };
    if (columns.company < 0) return res.status(422).json({ message: '대상 시트에서 기업명 열을 찾지 못했습니다. 현재 시트의 열 제목을 확인해 주세요.' });
    let created = 0;
    let updated = 0;
    for (const company of companies) {
      const existingIndex = rows.slice(1).findIndex((row) => (columns.business >= 0 && company.business_registration_number && String(row[columns.business] || '').replace(/[^0-9]/g, '') === String(company.business_registration_number).replace(/[^0-9]/g, '')) || String(row[columns.company] || '').trim() === String(company.company_name || '').trim());
      const row = existingIndex >= 0 ? [...rows[existingIndex + 1]] : Array(headers.length).fill('');
      if (columns.company >= 0) row[columns.company] = company.company_name || '';
      if (columns.business >= 0) row[columns.business] = company.business_registration_number || '';
      if (columns.address >= 0) row[columns.address] = company.confirmed_address || '';
      if (columns.major >= 0) row[columns.major] = company.category_major || '';
      if (columns.minor >= 0) row[columns.minor] = company.category_minor || '';
      if (columns.status >= 0) row[columns.status] = company.workflow_status || '';
      if (existingIndex >= 0) {
        const rowNumber = existingIndex + 2;
        await sheetRequest(token, `values/${encodeURIComponent(`${sheet}!A${rowNumber}:${columnName(Math.max(headers.length, row.length) - 1)}${rowNumber}`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: JSON.stringify({ range: `${sheet}!A${rowNumber}`, majorDimension: 'ROWS', values: [row] }) });
        updated += 1;
      } else {
        await sheetRequest(token, `values/${encodeURIComponent(`${sheet}!A:ZZ`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { method: 'POST', body: JSON.stringify({ majorDimension: 'ROWS', values: [row] }) });
        rows.push(row);
        created += 1;
      }
    }
    return res.status(200).json({ ok: true, created, updated, sheet: process.env.GOOGLE_SHEETS_TAB_NAME });
  } catch (error) {
    console.error('Google Sheets sync failed:', error.message);
    return res.status(500).json({ message: 'Google Sheets 동기화에 실패했습니다. 시트 공유 권한과 열 제목을 확인해 주세요.' });
  }
};
