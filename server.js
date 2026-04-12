const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { URLSearchParams } = require('url');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// Helper: upload buffer to S3 using native https with getBuffer() for correct Content-Length
function uploadBufferToS3(targetUrl, parameters, fileBuffer, filename, mimeType) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    parameters.forEach(p => fd.append(p.name, p.value));
    fd.append('file', fileBuffer, { filename, contentType: mimeType, knownLength: fileBuffer.length });

    // Use getBuffer() to get the complete body with correct Content-Length
    fd.getBuffer((err, buffer) => {
      if (err) return reject(err);

      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;

      const headers = fd.getHeaders();
      headers['Content-Length'] = buffer.length;

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode });
          } else {
            resolve({ ok: false, status: res.statusCode, text: () => Promise.resolve(body) });
          }
        });
      });
      req.on('error', reject);
      req.write(buffer);
      req.end();
    });
  });
}

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// CORS - allow Shopify store and any origin
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

const SHOPIFY_STORE = process.env.SHOPIFY_SHOP || 'retreat-beach-house';
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '902780ff14e9ff166032ae60998ec881';
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_TOKEN;
const SHOP_ID = 'gid://shopify/Shop/73972482215';

// ─── OAuth Token Management ───────────────────────────────────────────────────

let _token = null;
let _tokenExpiresAt = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;

  const response = await fetch(
    `https://${SHOPIFY_STORE}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed: ${response.status} - ${text.substring(0, 200)}`);
  }

  const data = await response.json();
  if (!data.access_token) throw new Error('No access_token in response');

  _token = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in || 86399) * 1000;
  console.log('Got new Shopify token, expires in', data.expires_in, 'seconds');
  return _token;
}

async function shopifyGraphQL(query, variables = {}) {
  const token = await getToken();
  const response = await fetch(
    `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!response.ok) throw new Error(`GraphQL request failed: ${response.status}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

// ─── Helper: get/set bookings metafield ───────────────────────────────────────

async function getBookingsData() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "retreat", key: "bookings") {
          id
          value
        }
      }
    }
  `);
  const metafield = data?.shop?.metafield;
  let parsed = { bookings: [], bookedDates: [] };
  if (metafield?.value) {
    try { parsed = JSON.parse(metafield.value); } catch(e) {}
  }
  return { data: parsed, metafieldId: metafield?.id };
}

async function setBookingsData(payload) {
  return shopifyGraphQL(`
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: SHOP_ID,
      namespace: 'retreat',
      key: 'bookings',
      value: JSON.stringify(payload),
      type: 'json'
    }]
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Retreat File Server is running', store: SHOPIFY_STORE });
});

// ─── Upload file - store as base64 data URL (simple, no S3 issues) ───────────

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const file = req.file;
    const filename = (req.body.filename || file.originalname || 'upload.jpg').replace(/[/\\]/g, '_');
    console.log(`Storing file as base64: ${filename} (${file.size} bytes)`);

    // Convert to base64 data URL - stored directly in booking data
    const base64 = file.buffer.toString('base64');
    const dataUrl = `data:${file.mimetype};base64,${base64}`;

    res.json({ success: true, url: dataUrl, filename });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Save new booking ─────────────────────────────────────────────────────────

app.post('/save-booking', async (req, res) => {
  try {
    const booking = req.body;
    if (!booking) return res.status(400).json({ error: 'No booking data provided' });

    const { data: existingData } = await getBookingsData();
    existingData.bookings = existingData.bookings || [];
    existingData.bookedDates = existingData.bookedDates || [];

    if (!booking.id) booking.id = Date.now().toString();
    booking.status = booking.status || 'confirmed';
    booking.createdAt = booking.createdAt || new Date().toISOString();

    existingData.bookings.unshift(booking);
    if (booking.checkIn && booking.checkOut) {
      existingData.bookedDates.push({ start: booking.checkIn, end: booking.checkOut, bookingId: booking.id });
    }

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save booking', details: result.metafieldsSet.userErrors });
    }

    res.json({ success: true, bookingId: booking.id });
  } catch (error) {
    console.error('Save booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get all bookings ─────────────────────────────────────────────────────────

app.get('/get-bookings', async (req, res) => {
  try {
    const { data } = await getBookingsData();
    res.json({ success: true, bookings: data.bookings || [], bookedDates: data.bookedDates || [], blockedDates: data.blockedDates || [] });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Update booking ───────────────────────────────────────────────────────────

app.put('/update-booking/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const { data: existingData } = await getBookingsData();
    existingData.bookings = existingData.bookings || [];

    const idx = existingData.bookings.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

    existingData.bookings[idx] = { ...existingData.bookings[idx], ...updates, id };

    // Rebuild bookedDates
    existingData.bookedDates = existingData.bookings
      .filter(b => b.status !== 'cancelled' && b.checkIn && b.checkOut)
      .map(b => ({ start: b.checkIn, end: b.checkOut, bookingId: b.id }));

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to update booking' });
    }

    res.json({ success: true, booking: existingData.bookings[idx] });
  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Cancel booking ───────────────────────────────────────────────────────────

app.delete('/cancel-booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingData } = await getBookingsData();
    existingData.bookings = existingData.bookings || [];

    const idx = existingData.bookings.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

    existingData.bookings[idx].status = 'cancelled';
    existingData.bookings[idx].cancelledAt = new Date().toISOString();
    existingData.bookedDates = (existingData.bookedDates || []).filter(d => d.bookingId !== id);

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to cancel booking' });
    }

    res.json({ success: true, message: 'Booking cancelled' });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Delete booking permanently ───────────────────────────────────────────────

app.delete('/delete-booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingData } = await getBookingsData();
    existingData.bookings = existingData.bookings || [];

    const before = existingData.bookings.length;
    existingData.bookings = existingData.bookings.filter(b => b.id !== id);
    existingData.bookedDates = (existingData.bookedDates || []).filter(d => d.bookingId !== id);

    if (existingData.bookings.length === before) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to delete booking' });
    }

    res.json({ success: true, message: 'Booking deleted permanently' });
  } catch (error) {
    console.error('Delete booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get/Set blocked dates ───────────────────────────────────────────────────

app.get('/get-blocked-dates', async (req, res) => {
  try {
    const { data } = await getBookingsData();
    res.json({ success: true, blockedDates: data.blockedDates || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/set-blocked-dates', async (req, res) => {
  try {
    const { blockedDates } = req.body;
    if (!Array.isArray(blockedDates)) return res.status(400).json({ error: 'blockedDates must be an array' });
    const { data: existingData } = await getBookingsData();
    existingData.blockedDates = blockedDates;
    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save blocked dates', details: result.metafieldsSet.userErrors });
    }
    res.json({ success: true, count: blockedDates.length });
  } catch (error) {
    console.error('Set blocked dates error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Send booking email notification ─────────────────────────────────────────

const nodemailer = require('nodemailer');

// Gmail SMTP transporter - uses App Password
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'retreat.kuwait@gmail.com',
    pass: process.env.EMAIL_PASS || '' // Gmail App Password - set in Render env vars
  }
});

app.post('/send-booking-email', async (req, res) => {
  try {
    const { to, booking } = req.body;
    if (!booking) return res.status(400).json({ error: 'No booking data' });

    const adminEmail = to || 'retreat.kuwait@gmail.com';
    const b = booking;

    const htmlBody = `
      <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#1a3a4a;margin-bottom:4px;">حجز جديد - شاليه ريتريت</h2>
          <p style="color:#c9a961;font-size:14px;">تم استلام حجز جديد عبر الموقع</p>
        </div>
        <div style="background:#fdf8f0;border:1px solid #e8dcc8;padding:16px;border-radius:8px;margin-bottom:16px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">اسم المستأجر:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.name || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">رقم الهاتف:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.phone || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">البريد الإلكتروني:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.email || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">الرقم المدني:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.civilId || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الدخول:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.checkIn || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الخروج:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.checkOut || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">الباقة:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${b.packageName || '—'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">مبلغ الإيجار:</td><td style="padding:8px;font-weight:600;color:#c9a961;border-bottom:1px solid #ede8e1;">${b.price || '—'} د.ك</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;">عدد الأشخاص:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;">${b.guests || '—'}</td></tr>
          </table>
        </div>
        ${b.notes ? '<div style="background:#fff8ee;border:1px solid #c9a961;padding:12px;border-radius:8px;margin-bottom:16px;"><strong>ملاحظات:</strong> ' + b.notes + '</div>' : ''}
        <div style="text-align:center;color:#9a8f82;font-size:12px;margin-top:20px;">
          <p>يمكنك مراجعة الحجز من <a href="https://retreat-beach-house.myshopify.com/pages/booking-management" style="color:#c9a961;">لوحة الإدارة</a></p>
        </div>
      </div>
    `;

    const mailOptions = {
      from: '"شاليه ريتريت" <' + (process.env.EMAIL_USER || 'retreat.kuwait@gmail.com') + '>',
      to: adminEmail,
      subject: '🏖️ حجز جديد - ' + (b.name || 'عميل') + ' | ' + (b.checkIn || ''),
      html: htmlBody
    };

    await emailTransporter.sendMail(mailOptions);
    console.log('Email sent to', adminEmail);
    res.json({ success: true, message: 'Email sent' });

  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Retreat File Server running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}.myshopify.com`);
});
