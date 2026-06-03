const { normalizeGstNo } = require('../utils/gstUtils');

function providerConfigured() {
  return !!(process.env.GST_API_PROFILE_URL || process.env.GST_API_RETURNS_URL || process.env.GST_API_BASE_URL);
}

function gstinChecksumValid(gstin) {
  const value = normalizeGstNo(gstin).toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const body = value.slice(0, 14);
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const code = chars.indexOf(body[i]);
    if (code < 0) return false;
    const product = code * factor;
    sum += Math.floor(product / 36) + (product % 36);
    factor = factor === 2 ? 1 : 2;
  }
  const checkCode = (36 - (sum % 36)) % 36;
  return chars[checkCode] === value[14];
}

function fillUrl(template, gstin) {
  return String(template || '')
    .replace(/\{gstin\}/gi, encodeURIComponent(gstin))
    .replace(/\{GSTIN\}/g, encodeURIComponent(gstin));
}

function getProfileUrl(gstin) {
  if (process.env.GST_API_PROFILE_URL) return fillUrl(process.env.GST_API_PROFILE_URL, gstin);
  if (process.env.GST_API_BASE_URL) return `${process.env.GST_API_BASE_URL.replace(/\/+$/, '')}/gstin/${encodeURIComponent(gstin)}`;
  return '';
}

function getReturnsUrl(gstin) {
  if (process.env.GST_API_RETURNS_URL) return fillUrl(process.env.GST_API_RETURNS_URL, gstin);
  if (process.env.GST_API_BASE_URL) return `${process.env.GST_API_BASE_URL.replace(/\/+$/, '')}/gstin/${encodeURIComponent(gstin)}/returns`;
  return '';
}

function apiHeaders() {
  const headers = { Accept: 'application/json' };
  if (process.env.GST_API_TOKEN) headers.Authorization = `Bearer ${process.env.GST_API_TOKEN}`;
  if (process.env.GST_API_KEY) headers['x-api-key'] = process.env.GST_API_KEY;
  if (process.env.GST_API_CLIENT_ID) headers['x-client-id'] = process.env.GST_API_CLIENT_ID;
  if (process.env.GST_API_CLIENT_SECRET) headers['x-client-secret'] = process.env.GST_API_CLIENT_SECRET;
  return headers;
}

async function fetchJson(url) {
  if (!url) {
    const err = new Error('GST API provider not configured');
    err.code = 'GST_PROVIDER_NOT_CONFIGURED';
    throw err;
  }
  const response = await fetch(url, { headers: apiHeaders() });
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`GST API request failed (${response.status})`);
    err.statusCode = response.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  if (/Request Rejected|<html/i.test(text)) {
    const err = new Error('GST portal rejected direct server API call. Configure official GST/GSP API endpoint.');
    err.code = 'GST_PROVIDER_REJECTED';
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    err.message = 'GST API returned non-JSON response';
    err.body = text.slice(0, 500);
    throw err;
  }
}

function pick(obj, keys) {
  for (const key of keys) {
    const parts = key.split('.');
    let cur = obj;
    for (const part of parts) cur = cur && cur[part];
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
}

function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ymd = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  return null;
}

function normalizeProfile(raw, gstin) {
  const data = raw?.data || raw?.result || raw?.taxpayer || raw?.records?.[0] || raw || {};
  return {
    gstin,
    legal_name: pick(data, ['lgnm', 'legal_name', 'legalName', 'tradeNam.legal_name', 'data.lgnm']),
    trade_name: pick(data, ['tradeNam', 'trade_name', 'tradeName', 'business_name']),
    taxpayer_type: pick(data, ['dty', 'taxpayer_type', 'taxpayerType']),
    status: pick(data, ['sts', 'status', 'gst_status', 'registration_status']),
    registration_date: parseDate(pick(data, ['rgdt', 'registration_date', 'registrationDate'])),
    cancellation_date: parseDate(pick(data, ['cxdt', 'cancellation_date', 'cancellationDate'])),
    constitution: pick(data, ['ctb', 'constitution', 'business_constitution']),
    source: process.env.GST_API_SOURCE || 'configured_gst_api',
    raw,
  };
}

function returnTypeFrom(value) {
  const s = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (s.includes('GSTR1') || s.includes('GSTR-1')) return 'GSTR-1';
  if (s.includes('GSTR3B') || s.includes('GSTR-3B')) return 'GSTR-3B';
  return null;
}

function periodFrom(value) {
  const s = String(value || '').trim();
  const mmyyyy = s.match(/^(\d{2})(\d{4})$/);
  if (mmyyyy) return { tax_month: Number(mmyyyy[1]), tax_year: Number(mmyyyy[2]) };
  const yyyymm = s.match(/^(\d{4})[-/]?(\d{2})$/);
  if (yyyymm) return { tax_year: Number(yyyymm[1]), tax_month: Number(yyyymm[2]) };
  return {};
}

function normalizeReturnRows(raw) {
  const rows = raw?.data?.EFiledlist || raw?.data?.returns || raw?.EFiledlist || raw?.returns || raw?.records || raw?.result || [];
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const returnType = returnTypeFrom(row.rtntype || row.return_type || row.form || row.formName);
    const period = periodFrom(row.ret_prd || row.period || row.tax_period || row.taxPeriod);
    return {
      return_type: returnType,
      tax_year: Number(row.tax_year || period.tax_year || 0) || null,
      tax_month: Number(row.tax_month || period.tax_month || 0) || null,
      status: row.status || row.filing_status || row.valid || (row.dof ? 'Filed' : null),
      filed_date: parseDate(row.dof || row.filed_date || row.date_of_filing || row.filingDate),
      arn: row.arn || row.ack_no || row.acknowledgement_no || row.ack_num || null,
      raw: row,
    };
  }).filter(r => r.return_type && r.tax_year && r.tax_month);
}

async function fetchGSTINProfile(gstin) {
  const normalized = normalizeGstNo(gstin).toUpperCase();
  if (!gstinChecksumValid(normalized)) {
    const err = new Error('Invalid GSTIN format/checksum');
    err.statusCode = 400;
    throw err;
  }
  const raw = await fetchJson(getProfileUrl(normalized));
  return normalizeProfile(raw, normalized);
}

async function fetchGSTReturnStatus(gstin) {
  const normalized = normalizeGstNo(gstin).toUpperCase();
  if (!gstinChecksumValid(normalized)) {
    const err = new Error('Invalid GSTIN format/checksum');
    err.statusCode = 400;
    throw err;
  }
  const raw = await fetchJson(getReturnsUrl(normalized));
  return { gstin: normalized, source: process.env.GST_API_SOURCE || 'configured_gst_api', returns: normalizeReturnRows(raw), raw };
}

module.exports = {
  providerConfigured,
  gstinChecksumValid,
  fetchGSTINProfile,
  fetchGSTReturnStatus,
};
