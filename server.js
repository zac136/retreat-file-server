const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const crypto = require('crypto');
const puppeteer = require('puppeteer');

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
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
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

// ─── Helper: get/set signatures in separate metafield ─────────────────────

async function getSignatures() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "retreat", key: "signatures") {
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

async function setSignatures(sigMap) {
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
      key: 'signatures',
      value: JSON.stringify(sigMap),
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

    // Generate signature token for manual bookings (so admin can send signing link)
    if (booking.source === 'manual' && !booking.signatureToken) {
      booking.signatureToken = crypto.randomBytes(16).toString('hex');
    }

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

    res.json({ success: true, bookingId: booking.id, signatureToken: booking.signatureToken || null });
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
    
    // Merge signatures from separate metafield
    let sigMap = {};
    try {
      sigMap = await getSignatures();
    } catch (e) {
      console.error('Failed to load signatures:', e.message);
    }

    // Restore images and signatures into bookings
    const bookings = (data.bookings || []).map(b => {
      let updated = b;
      if (b.civilIdImageUrl === 'STORED_IN_IMAGES' && imagesMap[b.id]) {
        updated = { ...updated, civilIdImageUrl: imagesMap[b.id] };
      }
      if (b.signatureDataURL === 'STORED_IN_SIGNATURES' && sigMap[b.id]) {
        updated = { ...updated, signatureDataURL: sigMap[b.id] };
      }
      return updated;
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

// ─── Signature System: Get booking info by token (for customer signing page) ──

app.get('/sign/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { data } = await getBookingsData();
    const booking = (data.bookings || []).find(b => b.signatureToken === token);
    
    if (!booking) {
      return res.status(404).json({ error: 'رابط التوقيع غير صالح أو منتهي الصلاحية' });
    }

    if (booking.signatureDataURL) {
      return res.json({ 
        success: true, 
        alreadySigned: true, 
        booking: {
          name: booking.name,
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          price: booking.price,
          guests: booking.guests
        }
      });
    }

    // Return booking info (limited - no sensitive data)
    res.json({ 
      success: true, 
      alreadySigned: false,
      booking: {
        id: booking.id,
        name: booking.name,
        phone: booking.phone,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        price: booking.price,
        guests: booking.guests,
        package: booking.package,
        deposit: booking.deposit || '100 د.ك',
        securityDeposit: booking.securityDeposit || '100 د.ك'
      }
    });
  } catch (error) {
    console.error('Get signing info error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Signature System: Submit signature ──────────────────────────────────────

app.post('/sign/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { signatureDataURL } = req.body;
    
    if (!token) return res.status(400).json({ error: 'Token required' });
    if (!signatureDataURL) return res.status(400).json({ error: 'Signature data required' });

    const { data: existingData } = await getBookingsData();
    const idx = (existingData.bookings || []).findIndex(b => b.signatureToken === token);
    
    if (idx === -1) {
      return res.status(404).json({ error: 'رابط التوقيع غير صالح أو منتهي الصلاحية' });
    }

    if (existingData.bookings[idx].signatureDataURL) {
      return res.status(400).json({ error: 'تم التوقيع على هذا العقد مسبقاً' });
    }

    // Save the signature in separate metafield to avoid size limits
    const bookingId = existingData.bookings[idx].id;
    try {
      const sigMap = await getSignatures();
      sigMap[bookingId] = signatureDataURL;
      // Keep only last 30 signatures
      const keys = Object.keys(sigMap);
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach(k => delete sigMap[k]);
      }
      await setSignatures(sigMap);
    } catch (sigErr) {
      console.error('Failed to save signature to separate metafield:', sigErr.message);
      return res.status(500).json({ error: 'Failed to save signature image' });
    }

    // Mark booking as signed (store reference, not the actual image)
    existingData.bookings[idx].signatureDataURL = 'STORED_IN_SIGNATURES';
    existingData.bookings[idx].signedAt = new Date().toISOString();

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Failed to update booking record:', result.metafieldsSet.userErrors);
    }

    console.log(`✅ Signature saved for booking ${bookingId} via token`);
    res.json({ success: true, message: 'تم حفظ التوقيع بنجاح' });

    // Send signed contract PDF to admin email (async, don't block response)
    const bookingForPDF = { ...existingData.bookings[idx], signedAt: new Date().toISOString() };
    sendSignedContractEmail(bookingForPDF, signatureDataURL).catch(err => {
      console.error('Failed to send contract PDF after signing:', err.message);
    });
  } catch (error) {
    console.error('Submit signature error:', error);
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

// ─── Signing page (serves HTML for customer to sign) ─────────────────────────

app.get('/sign-page/:token', (req, res) => {
  const { token } = req.params;
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>توقيع العقد - شاليه ريتريت</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Tajawal', Arial, sans-serif; background: #f6f3ee; color: #2d2d2d; min-height: 100vh; }
.container { max-width: 600px; margin: 0 auto; padding: 20px 16px; }
.logo-section { text-align: center; padding: 24px 0 16px; }
.logo-section img { width: 140px; margin-bottom: 8px; }
.logo-section h1 { font-size: 20px; color: #1a3a4a; font-weight: 700; }
.logo-section p { color: #9a8f82; font-size: 13px; }
.card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; }
.card h2 { font-size: 16px; color: #1a3a4a; margin-bottom: 12px; border-bottom: 2px solid #c9a961; padding-bottom: 8px; }
.info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0ebe4; font-size: 14px; }
.info-row:last-child { border-bottom: none; }
.info-row .label { color: #7a7060; }
.info-row .value { color: #1a3a4a; font-weight: 600; }
.terms-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; }
.terms-card h2 { font-size: 16px; color: #1a3a4a; margin-bottom: 12px; border-bottom: 2px solid #c9a961; padding-bottom: 8px; }
.terms-card ol { padding-right: 20px; font-size: 12px; line-height: 1.6; color: #4a4540; }
.terms-card li { margin-bottom: 4px; }
.sig-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; text-align: center; }
.sig-card h2 { font-size: 16px; color: #1a3a4a; margin-bottom: 4px; }
.sig-card p { color: #9a8f82; font-size: 13px; margin-bottom: 12px; }
canvas { border: 2px dashed #c9a961; border-radius: 8px; background: #fefcf9; touch-action: none; width: 100%; max-width: 500px; }
.btn-row { display: flex; gap: 10px; margin-top: 12px; justify-content: center; }
.btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-family: 'Tajawal', sans-serif; cursor: pointer; font-weight: 600; }
.btn-primary { background: #c9a961; color: #fff; }
.btn-primary:disabled { background: #d4c9a8; cursor: not-allowed; }
.btn-secondary { background: #e8e2d8; color: #5a5045; }
.success-msg { text-align: center; padding: 40px 20px; }
.success-msg .icon { font-size: 60px; margin-bottom: 16px; }
.success-msg h2 { color: #1a3a4a; margin-bottom: 8px; }
.success-msg p { color: #7a7060; font-size: 14px; }
.already-signed { text-align: center; padding: 40px 20px; }
.already-signed .icon { font-size: 50px; margin-bottom: 12px; }
.error-msg { text-align: center; padding: 40px 20px; color: #c0392b; }
.loading { text-align: center; padding: 60px 20px; color: #9a8f82; }
.loading .spinner { width: 40px; height: 40px; border: 3px solid #e8e2d8; border-top: 3px solid #c9a961; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
.ack-box { background: #fdf8f0; border: 1px solid #c9a961; border-radius: 8px; padding: 10px 14px; margin: 12px 0; font-size: 12px; color: #5a5045; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <div class="logo-section">
    <img src="https://files.manuscdn.com/user_upload_by_module/session_file/310519663530851339/roNCVxbVgYKQtCRp.png" alt="Retreat Logo">
    <h1>توقيع عقد الإيجار</h1>
    <p>شاليه ريتريت - الخيران، المرحلة الخامسة</p>
  </div>
  <div id="content"><div class="loading"><div class="spinner"></div><p>جاري تحميل بيانات الحجز...</p></div></div>
</div>
<script>
const TOKEN = '${token}';
const SERVER = window.location.origin;

const TERMS = [
  'تعتمد بيانات الحجز المدخلة من المستأجر، وأي بيانات غير صحيحة أو مضللة تخول للمؤجر إلغاء الحجز أو رفض الدخول دون تعويض. التأجير للعوائل فقط.',
  'وقت الدخول بعد الساعة 2:00 مساءً، ووقت الخروج بحد أقصى الساعة 2:00 مساءً، ويترتب على التأخر عن الخروج مبلغ 25 د.ك عن كل ساعة ويخصم من التأمين.',
  'يلتزم المستأجر بدفع كامل مبلغ الإيجار إضافة إلى مبلغ تأمين قدره 100 د.ك، ويعاد التأمين خلال 48 ساعة بعد المعاينة، مع أحقية المؤجر بخصم أي أضرار أو تنظيف إضافي.',
  'الحد الأقصى المسموح به داخل الشاليه هو 8 أشخاص وعاملتين فقط، ويمنع إدخال أي أشخاص غير مذكورين في بيانات الحجز.',
  'يلتزم المستأجر بالمحافظة على نظافة الشاليه ومرافقه ومحتوياته، ويحق للمؤجر خصم رسوم تنظيف عند تركه بحالة غير مناسبة.',
  'المستأجر مسؤول مسؤولية كاملة عن أي أضرار أو تلفيات أو فقدان خلال مدة الإيجار، وفي حال تجاوز قيمة الأضرار مبلغ التأمين يلتزم المستأجر بسداد الفرق.',
  'يلتزم المستأجر بالمحافظة على الهدوء وعدم إزعاج الجيران، ويمنع استخدام مكبرات الصوت أو أي تصرف بسبب شكاوى.',
  'يكون استخدام المسبح على مسؤولية المستأجر بالكامل، مع ضرورة مراقبة الأطفال، ويخلي المستأجر مسؤولية المؤجر عن أي حوادث ناتجة عن سوء الاستخدام أو الإهمال.',
  'يمنع منعاً باتاً التدخين داخل الشاليه، وإدخال الحيوانات، وإقامة الحفلات أو التجمعات، واللعب بالممتلكات أو ممارسة أي نشاط مخالف للقانون أو الآداب العامة.',
  'في حال حدوث أي عطل يلتزم المستأجر بإبلاغ المؤجر فوراً، ولا يجوز له إجراء أي إصلاح أو تعديل دون موافقة مسبقة من المؤجر.',
  'سياسة الإلغاء: أكثر من أسبوعين استرجاع كامل المبلغ، وقبل أسبوعين خصم 30%، وقبل أسبوع خصم 50%، وأقل من أسبوع أو عدم الحضور لا يوجد استرجاع.',
  'يحق للمؤجر رفض الدخول أو إنهاء الحجز فوراً عند مخالفة الشروط أو تجاوز العدد المسموح أو الإزعاج أو عدم دفع كامل المبلغ، كما يمنع تأجير الشاليه من الباطن أو التنازل عنه للغير.'
];

async function loadBooking() {
  try {
    const resp = await fetch(SERVER + '/sign/' + TOKEN);
    const data = await resp.json();
    
    if (!data.success) {
      document.getElementById('content').innerHTML = '<div class="error-msg"><h2>❌</h2><p>' + (data.error || 'رابط غير صالح') + '</p></div>';
      return;
    }

    if (data.alreadySigned) {
      const b = data.booking;
      document.getElementById('content').innerHTML = '<div class="already-signed"><div class="icon">✅</div><h2>تم التوقيع مسبقاً</h2><p>تم توقيع عقد الحجز الخاص بـ <strong>' + b.name + '</strong> بنجاح.</p><p style="margin-top:8px;color:#c9a961;">شكراً لك - شاليه ريتريت</p></div>';
      return;
    }

    const b = data.booking;
    let html = '';
    
    // Booking info card
    html += '<div class="card"><h2>📋 بيانات الحجز</h2>';
    html += '<div class="info-row"><span class="label">الاسم:</span><span class="value">' + b.name + '</span></div>';
    html += '<div class="info-row"><span class="label">تاريخ الدخول:</span><span class="value">' + b.checkIn + '</span></div>';
    html += '<div class="info-row"><span class="label">تاريخ الخروج:</span><span class="value">' + b.checkOut + '</span></div>';
    html += '<div class="info-row"><span class="label">مبلغ الإيجار:</span><span class="value">' + b.price + '</span></div>';
    html += '<div class="info-row"><span class="label">مبلغ التأمين:</span><span class="value">' + (b.securityDeposit || '100 د.ك') + '</span></div>';
    html += '<div class="info-row"><span class="label">مبلغ العربون:</span><span class="value">' + (b.deposit || '100 د.ك') + '</span></div>';
    html += '<div class="info-row"><span class="label">عدد الأشخاص:</span><span class="value">' + (b.guests || '—') + '</span></div>';
    html += '</div>';

    // Terms card
    html += '<div class="terms-card"><h2>📜 الشروط والأحكام</h2><ol>';
    TERMS.forEach(t => { html += '<li>' + t + '</li>'; });
    html += '</ol>';
    html += '<div class="ack-box">يقر المستأجر بأنه قرأ هذه الشروط والأحكام وفهمها ووافق عليها ويلتزم بجميع ما ورد فيها.</div>';
    html += '</div>';

    // Signature card
    html += '<div class="sig-card"><h2>✍️ التوقيع</h2><p>ارسم توقيعك في المربع أدناه</p>';
    html += '<canvas id="sig-canvas" width="460" height="180"></canvas>';
    html += '<div class="btn-row"><button class="btn btn-primary" id="submit-btn" onclick="submitSignature()" disabled>✅ تأكيد التوقيع</button>';
    html += '<button class="btn btn-secondary" onclick="clearCanvas()">🗑️ مسح</button></div></div>';

    document.getElementById('content').innerHTML = html;
    initCanvas();
  } catch (err) {
    document.getElementById('content').innerHTML = '<div class="error-msg"><h2>❌</h2><p>خطأ في الاتصال بالسيرفر</p></div>';
  }
}

let canvas, ctx, drawing = false, hasDrawn = false;

function initCanvas() {
  canvas = document.getElementById('sig-canvas');
  ctx = canvas.getContext('2d');
  
  // Set canvas size based on container
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * 2;
  canvas.height = 360;
  canvas.style.height = '180px';
  ctx.scale(2, 2);
  ctx.strokeStyle = '#1a3a4a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Mouse events
  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('mouseup', stopDraw);
  canvas.addEventListener('mouseleave', stopDraw);
  
  // Touch events
  canvas.addEventListener('touchstart', function(e) { e.preventDefault(); startDraw(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchmove', function(e) { e.preventDefault(); draw(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchend', function(e) { e.preventDefault(); stopDraw(); }, { passive: false });
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left), y: (e.clientY - rect.top) };
}

function startDraw(e) {
  drawing = true;
  const pos = getPos(e);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}

function draw(e) {
  if (!drawing) return;
  hasDrawn = true;
  document.getElementById('submit-btn').disabled = false;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
}

function stopDraw() { drawing = false; }

function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  hasDrawn = false;
  document.getElementById('submit-btn').disabled = true;
}

async function submitSignature() {
  if (!hasDrawn) return;
  
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'جاري الحفظ...';
  
  try {
    const dataURL = canvas.toDataURL('image/png');
    const resp = await fetch(SERVER + '/sign/' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signatureDataURL: dataURL })
    });
    const result = await resp.json();
    
    if (result.success) {
      document.getElementById('content').innerHTML = '<div class="success-msg"><div class="icon">✅</div><h2>تم التوقيع بنجاح!</h2><p>شكراً لك، تم حفظ توقيعك على عقد الإيجار.</p><p style="margin-top:12px;color:#c9a961;font-weight:600;">شاليه ريتريت - نتمنى لك إقامة ممتعة 🏖️</p></div>';
    } else {
      btn.disabled = false;
      btn.textContent = '✅ تأكيد التوقيع';
      alert(result.error || 'حدث خطأ');
    }
  } catch (err) {
    btn.disabled = false;
    btn.textContent = '✅ تأكيد التوقيع';
    alert('خطأ في الاتصال بالسيرفر');
  }
}

loadBooking();
</script>
</body>
</html>`);
});

// ─── PDF Contract Generation ──────────────────────────────────────────────────

const CONTRACT_TERMS = [
  'تعتمد بيانات الحجز المدخلة من المستأجر، وأي بيانات غير صحيحة أو مضللة تخول للمؤجر إلغاء الحجز أو رفض الدخول دون تعويض. التأجير للعوائل فقط.',
  'وقت الدخول بعد الساعة 2:00 مساءً، ووقت الخروج بحد أقصى الساعة 2:00 مساءً، ويترتب على التأخر عن الخروج مبلغ 25 د.ك عن كل ساعة ويخصم من التأمين.',
  'يلتزم المستأجر بدفع كامل مبلغ الإيجار إضافة إلى مبلغ تأمين قدره 100 د.ك، ويعاد التأمين خلال 48 ساعة بعد المعاينة، مع أحقية المؤجر بخصم أي أضرار أو تنظيف إضافي.',
  'الحد الأقصى المسموح به داخل الشاليه هو 8 أشخاص وعاملتين فقط، ويمنع إدخال أي أشخاص غير مذكورين في بيانات الحجز.',
  'يلتزم المستأجر بالمحافظة على نظافة الشاليه ومرافقه ومحتوياته، ويحق للمؤجر خصم رسوم تنظيف عند تركه بحالة غير مناسبة.',
  'المستأجر مسؤول مسؤولية كاملة عن أي أضرار أو تلفيات أو فقدان خلال مدة الإيجار، وفي حال تجاوز قيمة الأضرار مبلغ التأمين يلتزم المستأجر بسداد الفرق.',
  'يلتزم المستأجر بالمحافظة على الهدوء وعدم إزعاج الجيران، ويمنع استخدام مكبرات الصوت أو أي تصرف يسبب شكاوى.',
  'يكون استخدام المسبح على مسؤولية المستأجر بالكامل، مع ضرورة مراقبة الأطفال، ويخلي المستأجر مسؤولية المؤجر عن أي حوادث ناتجة عن سوء الاستخدام أو الإهمال.',
  'يمنع منعاً باتاً التدخين داخل الشاليه، وإدخال الحيوانات، وإقامة الحفلات أو التجمعات، والعبث بالممتلكات أو ممارسة أي نشاط مخالف للقانون أو الآداب العامة.',
  'في حال حدوث أي عطل يلتزم المستأجر بإبلاغ المؤجر فوراً، ولا يجوز له إجراء أي إصلاح أو تعديل دون موافقة مسبقة من المؤجر.',
  'سياسة الإلغاء: أكثر من أسبوعين استرجاع كامل المبلغ، وقبل أسبوعين خصم 30%، وقبل أسبوع خصم 50%، وأقل من أسبوع أو عدم الحضور لا يوجد استرجاع.',
  'يحق للمؤجر رفض الدخول أو إنهاء الحجز فوراً عند مخالفة الشروط أو تجاوز العدد المسموح أو الإزعاج أو عدم دفع كامل المبلغ، كما يمنع تأجير الشاليه من الباطن أو التنازل عنه للغير.'
];

async function generateContractPDF(booking, signatureDataURL) {
  const b = booking;
  const signedDate = b.signedAt 
    ? new Date(b.signedAt).toLocaleString('ar-KW', { dateStyle: 'long', timeStyle: 'short' })
    : new Date().toLocaleString('ar-KW', { dateStyle: 'long', timeStyle: 'short' });

  const termsHtml = CONTRACT_TERMS.map((t, i) => 
    `<div style="margin-bottom:4px;font-size:10px;color:#4a4540;line-height:1.5;"><strong style="color:#c9a961;">${i+1}.</strong> ${t}</div>`
  ).join('');

  const sigImg = (signatureDataURL && signatureDataURL.startsWith('data:'))
    ? `<img src="${signatureDataURL}" style="max-width:220px;max-height:90px;" />`
    : '<span style="color:#999;">لا يوجد توقيع</span>';

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap');
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Tajawal',sans-serif; background:#fff; color:#1a3a4a; padding:30px 40px; direction:rtl; }
  .header { text-align:center; margin-bottom:10px; }
  .header h1 { font-size:28px; color:#1a3a4a; letter-spacing:4px; margin-bottom:2px; font-weight:800; }
  .header .sub { font-size:12px; color:#7a7060; margin-bottom:2px; }
  .header .loc { font-size:10px; color:#aaa; }
  .gold-line { height:2px; background:linear-gradient(90deg,transparent,#c9a961,transparent); margin:12px 0; }
  .title { text-align:center; font-size:18px; font-weight:700; color:#c9a961; margin-bottom:16px; }
  .section-title { font-size:13px; font-weight:700; color:#1a3a4a; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #e8dcc8; }
  .details-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
  .details-table tr:nth-child(even) { background:#fdf8f0; }
  .details-table td { padding:6px 10px; font-size:11px; border-bottom:1px solid #f0ebe0; }
  .details-table td:first-child { font-weight:700; color:#7a7060; width:35%; }
  .details-table td:last-child { color:#1a3a4a; }
  .terms-box { background:#fdf8f0; border:1px solid #e8dcc8; border-radius:8px; padding:12px 14px; margin-bottom:12px; }
  .ack-box { background:#f5efe5; border:1px solid #c9a961; border-radius:6px; padding:10px 14px; text-align:center; font-size:11px; font-weight:700; color:#5a5045; margin-bottom:14px; }
  .sig-section { margin-bottom:10px; }
  .sig-section .sig-label { font-size:11px; color:#7a7060; margin-bottom:4px; }
  .sig-section .sig-date { font-size:9px; color:#aaa; margin-top:4px; }
  .footer { text-align:center; font-size:8px; color:#aaa; border-top:1px solid #e8dcc8; padding-top:8px; margin-top:10px; }
</style>
</head>
<body>
  <div class="header">
    <h1>RETREAT</h1>
    <div class="sub">Private Beach House</div>
    <div class="loc">الخيران - المرحلة الخامسة - الكويت</div>
  </div>
  <div class="gold-line"></div>
  <div class="title">عقد إيجار / اتفاقية حجز</div>

  <div class="section-title">بيانات الحجز</div>
  <table class="details-table">
    <tr><td>اسم المستأجر</td><td>${b.name || '-'}</td></tr>
    <tr><td>رقم الهاتف</td><td style="direction:ltr;text-align:right;">${b.phone || '-'}</td></tr>
    <tr><td>البريد الإلكتروني</td><td style="direction:ltr;text-align:right;">${b.email || '-'}</td></tr>
    <tr><td>الرقم المدني</td><td style="direction:ltr;text-align:right;">${b.civilId || '-'}</td></tr>
    <tr><td>تاريخ الدخول</td><td>${b.checkIn || '-'}</td></tr>
    <tr><td>تاريخ الخروج</td><td>${b.checkOut || '-'}</td></tr>
    <tr><td>الباقة</td><td>${b.packageName || b.package || '-'}</td></tr>
    <tr><td>مبلغ الإيجار</td><td>${b.price || '-'} د.ك</td></tr>
    <tr><td>مبلغ التأمين</td><td>${b.securityDeposit || '100'} د.ك</td></tr>
    <tr><td>عدد الضيوف</td><td>${b.guests || '-'}</td></tr>
  </table>

  <div class="section-title">الشروط والأحكام</div>
  <div class="terms-box">${termsHtml}</div>

  <div class="ack-box">يقر المستأجر بأنه قد قرأ وفهم ووافق على جميع الشروط والأحكام المذكورة أعلاه.</div>

  <div class="section-title">التوقيع الرقمي</div>
  <div class="sig-section">
    ${sigImg}
    <div class="sig-date">تاريخ التوقيع: ${signedDate}</div>
  </div>

  <div class="footer">
    <div class="gold-line"></div>
    شاليه ريتريت - الخيران، المرحلة الخامسة، الكويت | retreatbh.com
  </div>
</body>
</html>`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });
    return Buffer.from(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Send signed contract PDF via email ─────────────────────────────────────

async function sendSignedContractEmail(booking, signatureDataURL) {
  try {
    const pdfBuffer = await generateContractPDF(booking, signatureDataURL);
    const adminEmail = 'retreat.kuwait@gmail.com';
    
    const htmlBody = `
      <div dir="rtl" style="font-family:Tajawal,Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="text-align:center;margin-bottom:20px;">
          <h2 style="color:#1a3a4a;margin-bottom:4px;">عقد موقّع - شاليه ريتريت</h2>
          <p style="color:#c9a961;font-size:14px;">تم توقيع العقد من قبل العميل</p>
        </div>
        <div style="background:#fdf8f0;border:1px solid #e8dcc8;padding:16px;border-radius:8px;margin-bottom:16px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">اسم المستأجر:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${booking.name || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">رقم الهاتف:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${booking.phone || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الدخول:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;border-bottom:1px solid #ede8e1;">${booking.checkIn || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;">تاريخ الخروج:</td><td style="padding:8px;font-weight:600;color:#1a3a4a;">${booking.checkOut || '-'}</td></tr>
          </table>
        </div>
        <p style="text-align:center;color:#2e7d32;font-weight:600;">✅ العقد الموقّع مرفق كملف PDF</p>
      </div>
    `;
    
    await sendEmailHTTP({
      from: 'Retreat Beach House <onboarding@resend.dev>',
      to: adminEmail,
      subject: '✍️ عقد موقّع - ' + (booking.name || 'عميل') + ' | ' + (booking.checkIn || ''),
      html: htmlBody,
      attachments: [{
        filename: 'contract-' + (booking.name || 'customer').replace(/\s+/g, '-') + '.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf'
      }]
    });
    
    console.log('✅ Signed contract PDF sent to admin for booking', booking.id);
  } catch (err) {
    console.error('Failed to send signed contract PDF:', err.message);
  }
}

// ─── Email notification ─────────────────────────────────────────────────────

// Email sending via Resend HTTP API (Render blocks SMTP ports on free tier)
// Resend free tier: 100 emails/day, 3000/month - perfect for booking notifications
// If RESEND_API_KEY is not set, falls back to storing notification in metafield
// Resend free tier: 100 emails/day, 3000/month - perfect for booking notifications
// If RESEND_API_KEY is not set, falls back to storing notification in metafield

async function sendEmailHTTP({ to, from, subject, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  
  if (!apiKey) {
    console.log('RESEND_API_KEY not set, skipping email send');
    return { skipped: true, reason: 'No RESEND_API_KEY' };
  }
  
  const payload = {
    from: from || 'Retreat Beach House <onboarding@resend.dev>',
    to: Array.isArray(to) ? to : [to],
    subject: subject,
    html: html
  };
  
  // Add attachments if any
  if (attachments && attachments.length > 0) {
    payload.attachments = attachments.map(att => ({
      filename: att.filename,
      content: att.content instanceof Buffer ? att.content.toString('base64') : att.content,
      content_type: att.contentType || 'application/octet-stream'
    }));
  }
  
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(`Resend API error: ${response.status} - ${JSON.stringify(data)}`);
  }
  
  console.log('Email sent via Resend:', data.id);
  return data;
}

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

  // Generate and attach signed contract PDF if signature exists
  try {
    let sigDataForPDF = null;
    if (b.signatureDataURL === 'STORED_IN_SIGNATURES') {
      // Retrieve actual signature from separate storage
      const sigMap = await getSignatures();
      sigDataForPDF = sigMap[b.id] || null;
    } else if (b.signatureDataURL && b.signatureDataURL.startsWith('data:')) {
      sigDataForPDF = b.signatureDataURL;
    }
    if (sigDataForPDF) {
      const pdfBuffer = await generateContractPDF(b, sigDataForPDF);
      attachments.push({
        filename: `contract-${b.name || 'customer'}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      });
      console.log('\u2705 Contract PDF attached to booking email');
    }
  } catch (pdfErr) {
    console.error('Failed to generate contract PDF for booking email:', pdfErr.message);
  }

  const result = await sendEmailHTTP({
    from: 'Retreat Beach House <onboarding@resend.dev>',
    to: adminEmail,
    subject: '🏖️ حجز جديد - ' + (b.name || 'عميل') + ' | ' + (b.checkIn || ''),
    html: htmlBody,
    attachments: attachments.length > 0 ? attachments : undefined
  });
  
  return result;
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
