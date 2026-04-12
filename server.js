const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// CORS - allow Shopify store and any origin
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

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

// ─── Helper: get/set civil ID images in separate metafield ─────────────────

async function getCivilIdImages() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "retreat", key: "civil_id_images") {
          id
          value
        }
      }
    }
  `);
  const metafield = data?.shop?.metafield;
  let parsed = {};
  if (metafield?.value) {
    try { parsed = JSON.parse(metafield.value); } catch(e) {}
  }
  return parsed;
}

async function setCivilIdImages(imagesMap) {
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
      key: 'civil_id_images',
      value: JSON.stringify(imagesMap),
      type: 'json'
    }]
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Retreat File Server is running', store: SHOPIFY_STORE });
});

// ─── Upload file - store as base64 data URL ──────────────────────────────────

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const file = req.file;
    const filename = (req.body.filename || file.originalname || 'upload.jpg').replace(/[/\\]/g, '_');
    console.log(`Storing file as base64: ${filename} (${file.size} bytes)`);

    // Convert to base64 data URL
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

    // Handle civil ID image - store in separate metafield to avoid size issues
    let civilIdImage = booking.civilIdImageUrl || '';
    if (civilIdImage && civilIdImage.startsWith('data:') && civilIdImage.length > 1000) {
      // Save image to separate metafield
      try {
        const imagesMap = await getCivilIdImages();
        imagesMap[booking.id] = civilIdImage;
        
        // Keep only last 20 images to avoid metafield size limit
        const keys = Object.keys(imagesMap);
        if (keys.length > 20) {
          const toRemove = keys.slice(0, keys.length - 20);
          toRemove.forEach(k => delete imagesMap[k]);
        }
        
        await setCivilIdImages(imagesMap);
        console.log(`✅ Civil ID image saved for booking ${booking.id} (${civilIdImage.length} chars)`);
        
        // Store a reference in the booking
        booking.civilIdImageUrl = 'STORED_IN_IMAGES';
      } catch (imgErr) {
        console.error('Failed to save civil ID image separately:', imgErr.message);
        // Fallback: keep the base64 in the booking itself
        // (will work if total data is under 5MB)
      }
    }

    existingData.bookings.unshift(booking);
    if (booking.checkIn && booking.checkOut) {
      existingData.bookedDates.push({ start: booking.checkIn, end: booking.checkOut, bookingId: booking.id });
    }

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save booking', details: result.metafieldsSet.userErrors });
    }

    // Send email notification automatically after successful save
    try {
      await sendBookingEmail(booking, civilIdImage);
      console.log('Auto email sent for booking', booking.id);
    } catch (emailErr) {
      console.error('Auto email failed:', emailErr.message);
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
    
    // Merge civil ID images from separate metafield
    let imagesMap = {};
    try {
      imagesMap = await getCivilIdImages();
    } catch (e) {
      console.error('Failed to load civil ID images:', e.message);
    }
    
    // Restore images into bookings
    const bookings = (data.bookings || []).map(b => {
      if (b.civilIdImageUrl === 'STORED_IN_IMAGES' && imagesMap[b.id]) {
        return { ...b, civilIdImageUrl: imagesMap[b.id] };
      }
      return b;
    });
    
    res.json({ success: true, bookings, bookedDates: data.bookedDates || [], blockedDates: data.blockedDates || [] });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get civil ID image for a specific booking ──────────────────────────────

app.get('/get-civil-id/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const imagesMap = await getCivilIdImages();
    
    if (imagesMap[bookingId]) {
      res.json({ success: true, imageUrl: imagesMap[bookingId] });
    } else {
      res.status(404).json({ error: 'Image not found' });
    }
  } catch (error) {
    console.error('Get civil ID error:', error);
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

    // Handle civil ID image update
    let civilIdImage = updates.civilIdImageUrl || '';
    if (civilIdImage && civilIdImage.startsWith('data:') && civilIdImage.length > 1000) {
      try {
        const imagesMap = await getCivilIdImages();
        imagesMap[id] = civilIdImage;
        const keys = Object.keys(imagesMap);
        if (keys.length > 20) {
          const toRemove = keys.slice(0, keys.length - 20);
          toRemove.forEach(k => delete imagesMap[k]);
        }
        await setCivilIdImages(imagesMap);
        updates.civilIdImageUrl = 'STORED_IN_IMAGES';
      } catch (imgErr) {
        console.error('Failed to save civil ID image:', imgErr.message);
      }
    }

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
    existingData.bookedDates = (existingData.bookedDates || [])
      .filter(d => d.bookingId !== id);

    if (existingData.bookings.length === before) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Also remove civil ID image
    try {
      const imagesMap = await getCivilIdImages();
      if (imagesMap[id]) {
        delete imagesMap[id];
        await setCivilIdImages(imagesMap);
      }
    } catch (e) {}

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

// ─── Email notification ─────────────────────────────────────────────────────

const nodemailer = require('nodemailer');

// Gmail SMTP transporter - uses App Password
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'retreat.kuwait@gmail.com',
    pass: process.env.EMAIL_PASS || ''
  }
});

// Shared email sending function
async function sendBookingEmail(booking, civilIdImage) {
  const b = booking;
  const adminEmail = 'retreat.kuwait@gmail.com';

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

  // Prepare attachments
  const attachments = [];
  
  // Attach civil ID image if available (any size)
  if (civilIdImage && civilIdImage.startsWith('data:')) {
    const matches = civilIdImage.match(/^data:([^;]+);base64,(.+)$/);
    if (matches) {
      const ext = matches[1].includes('png') ? 'png' : 'jpg';
      attachments.push({
        filename: `civil-id-${b.name || 'customer'}.${ext}`,
        content: Buffer.from(matches[2], 'base64'),
        contentType: matches[1]
      });
    }
  }

  // Attach signature if available
  if (b.signatureDataURL && b.signatureDataURL.startsWith('data:')) {
    const sigMatches = b.signatureDataURL.match(/^data:([^;]+);base64,(.+)$/);
    if (sigMatches) {
      attachments.push({
        filename: `signature-${b.name || 'customer'}.png`,
        content: Buffer.from(sigMatches[2], 'base64'),
        contentType: sigMatches[1]
      });
    }
  }

  const mailOptions = {
    from: '"شاليه ريتريت" <' + (process.env.EMAIL_USER || 'retreat.kuwait@gmail.com') + '>',
    to: adminEmail,
    subject: '🏖️ حجز جديد - ' + (b.name || 'عميل') + ' | ' + (b.checkIn || ''),
    html: htmlBody,
    attachments: attachments.length > 0 ? attachments : undefined
  };

  const info = await emailTransporter.sendMail(mailOptions);
  console.log('Email sent:', info.messageId);
  return info;
}

// Manual email endpoint (kept for backward compatibility)
app.post('/send-booking-email', async (req, res) => {
  try {
    const { to, booking, civilIdImage } = req.body;
    if (!booking) return res.status(400).json({ error: 'No booking data' });

    await sendBookingEmail(booking, civilIdImage || '');
    res.json({ success: true, message: 'Email sent' });

  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ─── Theme file management (for updating Liquid templates) ──────────────────

app.get('/get-theme-file', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key parameter required' });
    
    // Get active theme ID
    const themesData = await shopifyGraphQL(`
      query {
        themes(first: 10, roles: [MAIN]) {
          nodes {
            id
            name
            role
          }
        }
      }
    `);
    
    const mainTheme = themesData?.themes?.nodes?.[0];
    if (!mainTheme) return res.status(404).json({ error: 'No main theme found' });
    
    // Get the file content
    const fileData = await shopifyGraphQL(`
      query($themeId: ID!, $filenames: [String!]!) {
        theme(id: $themeId) {
          files(filenames: $filenames, first: 1) {
            nodes {
              filename
              size
              body {
                ... on OnlineStoreThemeFileBodyText {
                  content
                }
              }
            }
          }
        }
      }
    `, { themeId: mainTheme.id, filenames: [key] });
    
    const file = fileData?.theme?.files?.nodes?.[0];
    if (!file) return res.status(404).json({ error: 'File not found' });
    
    res.json({ success: true, filename: file.filename, content: file.body?.content || '', size: file.size });
  } catch (error) {
    console.error('Get theme file error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/update-theme-file', async (req, res) => {
  try {
    const { key, content } = req.body;
    if (!key || !content) return res.status(400).json({ error: 'key and content required' });
    
    // Get active theme ID
    const themesData = await shopifyGraphQL(`
      query {
        themes(first: 10, roles: [MAIN]) {
          nodes {
            id
            name
            role
          }
        }
      }
    `);
    
    const mainTheme = themesData?.themes?.nodes?.[0];
    if (!mainTheme) return res.status(404).json({ error: 'No main theme found' });
    
    // Update the file
    const result = await shopifyGraphQL(`
      mutation themeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          upsertedThemeFiles {
            filename
          }
          userErrors {
            field
            message
          }
        }
      }
    `, {
      themeId: mainTheme.id,
      files: [{
        filename: key,
        body: {
          type: "TEXT",
          value: content
        }
      }]
    });
    
    if (result?.themeFilesUpsert?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to update theme file', details: result.themeFilesUpsert.userErrors });
    }
    
    res.json({ success: true, filename: key });
  } catch (error) {
    console.error('Update theme file error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Retreat File Server running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}.myshopify.com`);
  console.log(`Email: ${process.env.EMAIL_USER || 'NOT SET'}`);
});
