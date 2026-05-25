async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('Email API not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL || 'Gee Bharat <noreply@geebharat.com>',
      to,
      subject,
      html,
      text,
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let message = 'Email send failed';
    try { message = JSON.parse(raw).message || message; } catch {}
    throw new Error(message);
  }
  return response.json().catch(() => ({}));
}

module.exports = { sendEmail };
