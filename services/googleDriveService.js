// Minimal Google OAuth2 + Drive REST client — deliberately not the full
// `googleapis` SDK, to keep this dependency-free (plain fetch calls to
// Google's documented REST endpoints). Only ever requests the narrow
// `drive.file` scope: the app can only see/manage files it creates itself,
// never browse the rest of a connected account's Drive.
const DRIVE_FOLDER_NAME = 'GeeBharat Client Updates';
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function getAuthUrl(state, redirectUri, loginHint) {
  const params = new URLSearchParams({
    client_id: requireEnv('GOOGLE_DRIVE_CLIENT_ID'),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent',      // forces a refresh_token even on repeat connects
    state,
  });
  // Pre-fills/suggests the organisation's own registered email on Google's
  // account picker, so an employee doesn't end up connecting their personal
  // Gmail by mistake. This is a UX nudge only — the callback independently
  // verifies the account actually used before saving anything.
  if (loginHint) params.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code, redirectUri) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: requireEnv('GOOGLE_DRIVE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_DRIVE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: requireEnv('GOOGLE_DRIVE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_DRIVE_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token refresh failed');
  return data.access_token;
}

async function getConnectedEmail(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Could not read Google account email');
  return data.email;
}

// Finds (or creates, on first connect) the single app folder inside the
// connected account's own Drive. Being created via `drive.file` scope, this
// folder — and everything the app later uploads inside it — is private to
// that Google account by default; nothing is shared automatically.
async function ensureAppFolder(accessToken) {
  const q = encodeURIComponent(`name='${DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error(listData.error?.message || 'Could not search Google Drive');
  if (listData.files?.length) return listData.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error(createData.error?.message || 'Could not create Google Drive folder');
  return createData.id;
}

// Simple multipart upload (metadata + file bytes in one request) — fine for
// our 5MB attachment cap; a resumable upload isn't needed at this size.
async function uploadFile(accessToken, folderId, buffer, filename, mimeType) {
  const boundary = 'gbdrive_' + Date.now().toString(36);
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Google Drive upload failed');
  return data; // { id, webViewLink, webContentLink }
}

// Best-effort — used on disconnect so the grant also disappears from the
// user's "Third-party apps with account access" list, not just our DB row.
async function revokeToken(token) {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch { /* non-fatal — disconnect still proceeds */ }
}

// The uploaded file is private to the connected Google account (drive.file
// scope, no public sharing) — so a viewer/downloader must NOT be sent to
// Google's own webViewLink (that requires being signed into that exact
// Google account in the browser). Instead the server fetches the file
// itself, using its own stored access token, and hands the bytes to
// whichever GeeBharat employee asked — no Google login required on their end.
async function getFileMetadata(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Could not read file metadata');
  return data; // { name, mimeType, size }
}

async function downloadFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Could not download file');
  }
  return res; // caller streams res.body
}

module.exports = {
  DRIVE_FOLDER_NAME,
  getAuthUrl,
  getFileMetadata,
  downloadFile,
  exchangeCodeForTokens,
  refreshAccessToken,
  getConnectedEmail,
  ensureAppFolder,
  uploadFile,
  revokeToken,
};
