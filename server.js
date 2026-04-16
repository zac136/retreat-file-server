const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const crypto = require('crypto');
const FormData = require('form-data');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

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
  let parsed = { bookings: [], bookedDates: [], blockedDates: [], trash: [], custom_prices: [], seasonal_prices: null };
  if (metafield?.value) {
    try { parsed = JSON.parse(metafield.value); } catch(e) {}
  }
  return { data: parsed, metafieldId: metafield?.id };
}

async function setBookingsData(payload) {
  // Ensure trash array exists
  if (!payload.trash) payload.trash = [];
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

    // Handle civil ID image - upload to Shopify CDN for unlimited size
    let civilIdImage = booking.civilIdImageUrl || '';
    if (civilIdImage && civilIdImage.startsWith('data:') && civilIdImage.length > 100) {
      try {
        const matches = civilIdImage.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const mimetype = matches[1];
          const fileBuffer = Buffer.from(matches[2], 'base64');
          const ext = mimetype.split('/')[1] || 'jpg';
          const filename = `civil-id-${booking.id}-${Date.now()}.${ext}`;
          console.log(`[save-booking] Uploading civil ID to Shopify CDN (${fileBuffer.length} bytes)...`);
          const cdnUrl = await uploadToShopifyCDN(fileBuffer, filename, mimetype);
          console.log(`[save-booking] ✅ Civil ID uploaded to CDN: ${cdnUrl}`);
          
          // Store CDN URL in booking and metafield
          booking.civilIdImageUrl = cdnUrl;
          try {
            const imagesMap = await getCivilIdImages();
            // Clean old base64 entries
            for (const key of Object.keys(imagesMap)) {
              if (imagesMap[key] && imagesMap[key].startsWith('data:')) delete imagesMap[key];
            }
            imagesMap[booking.id] = cdnUrl;
            await setCivilIdImages(imagesMap);
          } catch (metaErr) {
            console.error('[save-booking] Metafield warning:', metaErr.message);
          }
        }
      } catch (imgErr) {
        console.error('[save-booking] Failed to upload civil ID to CDN:', imgErr.message);
        // Keep the base64 as fallback but truncate for booking storage
        booking.civilIdImageUrl = '';
      }
    }

    // Save contractHTML for email, then remove from booking before storing in metafield
    const contractHTML = booking.contractHTML || '';
    delete booking.contractHTML;

    existingData.bookings.unshift(booking);
    if (booking.checkIn && booking.checkOut) {
      existingData.bookedDates.push({ start: booking.checkIn, end: booking.checkOut, bookingId: booking.id });
    }

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save booking', details: result.metafieldsSet.userErrors });
    }

    // Send email notification automatically after successful save
    // Temporarily add contractHTML back for email generation
    try {
      const bookingForEmail = { ...booking, contractHTML };
      await sendBookingEmail(bookingForEmail, civilIdImage);
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
    const allBookings = (data.bookings || []).map(b => {
      let updated = b;
      // Handle civil ID: STORED_IN_IMAGES (legacy) or check metafield for CDN URL
      if (b.civilIdImageUrl === 'STORED_IN_IMAGES' && imagesMap[b.id]) {
        updated = { ...updated, civilIdImageUrl: imagesMap[b.id] };
      } else if (!b.civilIdImageUrl && imagesMap[b.id]) {
        // Fallback: check metafield even if booking doesn't have the flag
        updated = { ...updated, civilIdImageUrl: imagesMap[b.id] };
      }
      if (b.signatureDataURL === 'STORED_IN_SIGNATURES' && sigMap[b.id]) {
        updated = { ...updated, signatureDataURL: sigMap[b.id] };
      }
      return updated;
    });
    // Filter out trashed bookings from active list
    const bookings = allBookings.filter(b => b.status !== 'trashed');
    // Filter out bookedDates for trashed bookings
    const trashedIds = allBookings.filter(b => b.status === 'trashed').map(b => String(b.id));
    const bookedDates = (data.bookedDates || []).filter(d => !trashedIds.includes(String(d.bookingId)));
    
    const defaults = {
      s1: { 'thu-sat': 300, 'sun-wed': 300, 'sun-sat': 500 },
      s2: { 'thu-sat': 350, 'sun-wed': 350, 'sun-sat': 600 },
      s3: { 'thu-sat': 400, 'sun-wed': 400, 'sun-sat': 700 }
    };
    res.json({ success: true, bookings, bookedDates, blockedDates: data.blockedDates || [], trash: data.trash || [], custom_prices: data.custom_prices || [], seasonal_prices: data.seasonal_prices || defaults });
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get civil ID image for a specific booking ──────────────────────────────

app.get('/get-civil-id/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    // Check metafield first
    const imagesMap = await getCivilIdImages();
    if (imagesMap[bookingId]) {
      return res.json({ success: true, imageUrl: imagesMap[bookingId] });
    }
    
    // Fallback: check booking's civilIdImageUrl directly (CDN URL)
    try {
      const { data } = await getBookingsData();
      const booking = (data.bookings || []).find(b => String(b.id) === String(bookingId));
      if (booking && booking.civilIdImageUrl && booking.civilIdImageUrl !== 'STORED_IN_IMAGES' && booking.civilIdImageUrl.startsWith('http')) {
        return res.json({ success: true, imageUrl: booking.civilIdImageUrl });
      }
    } catch (e) {
      console.error('[get-civil-id] Booking lookup error:', e.message);
    }
    
    res.status(404).json({ error: 'Image not found' });
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

    // Handle civil ID image update - upload to Shopify CDN
    let civilIdImage = updates.civilIdImageUrl || '';
    if (civilIdImage && civilIdImage.startsWith('data:') && civilIdImage.length > 100) {
      try {
        const matches = civilIdImage.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const mimetype = matches[1];
          const fileBuffer = Buffer.from(matches[2], 'base64');
          const ext = mimetype.split('/')[1] || 'jpg';
          const filename = `civil-id-${id}-${Date.now()}.${ext}`;
          console.log(`[update-booking] Uploading civil ID to CDN (${fileBuffer.length} bytes)...`);
          const cdnUrl = await uploadToShopifyCDN(fileBuffer, filename, mimetype);
          console.log(`[update-booking] ✅ Civil ID CDN: ${cdnUrl}`);
          updates.civilIdImageUrl = cdnUrl;
          try {
            const imagesMap = await getCivilIdImages();
            for (const key of Object.keys(imagesMap)) {
              if (imagesMap[key] && imagesMap[key].startsWith('data:')) delete imagesMap[key];
            }
            imagesMap[id] = cdnUrl;
            await setCivilIdImages(imagesMap);
          } catch (metaErr) {
            console.error('[update-booking] Metafield warning:', metaErr.message);
          }
        }
      } catch (imgErr) {
        console.error('[update-booking] Failed to upload civil ID:', imgErr.message);
        updates.civilIdImageUrl = '';
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

// ─── Delete booking (move to trash instead of permanent delete) ──────────────

app.delete('/delete-booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingData } = await getBookingsData();
    existingData.bookings = existingData.bookings || [];
    existingData.trash = existingData.trash || [];

    const idx = existingData.bookings.findIndex(b => b.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Booking not found' });

    // Move to trash instead of permanent delete
    const deletedBooking = existingData.bookings[idx];
    deletedBooking.deletedAt = new Date().toISOString();
    existingData.trash.unshift(deletedBooking);

    // Keep only last 50 items in trash
    if (existingData.trash.length > 50) {
      existingData.trash = existingData.trash.slice(0, 50);
    }

    // Remove from active bookings
    existingData.bookings.splice(idx, 1);
    existingData.bookedDates = (existingData.bookedDates || [])
      .filter(d => d.bookingId !== id);

    // Also remove from blockedDates if exists (objects with bookingId)
    existingData.blockedDates = (existingData.blockedDates || [])
      .filter(d => {
        // Remove objects with matching bookingId
        if (typeof d === 'object' && d.bookingId) return d.bookingId !== id;
        // Remove string dates that fall within the deleted booking's date range
        if (typeof d === 'string' && deletedBooking.checkIn && deletedBooking.checkOut) {
          // Parse D/M/YYYY format
          const parseDMY = (s) => {
            const parts = s.split('/');
            if (parts.length === 3) return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
            return new Date(NaN);
          };
          const startDate = parseDMY(deletedBooking.checkIn);
          const endDate = parseDMY(deletedBooking.checkOut);
          const dateToCheck = parseDMY(d);
          if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && !isNaN(dateToCheck.getTime())) {
            // If this date falls within the booking range, remove it
            if (dateToCheck >= startDate && dateToCheck <= endDate) return false;
          }
        }
        return true;
      });

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to delete booking' });
    }

    console.log(`Booking ${id} (${deletedBooking.name}) moved to trash`);
    res.json({ success: true, message: 'تم نقل الحجز إلى سلة المحذوفات' });
  } catch (error) {
    console.error('Delete booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get trash (deleted bookings) ────────────────────────────────────────────

app.get('/get-trash', async (req, res) => {
  try {
    const { data } = await getBookingsData();
    const trash = data.trash || [];
    
    // Auto-clean: remove items older than 30 days
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const activeTrash = trash.filter(item => {
      const deletedAt = new Date(item.deletedAt).getTime();
      return deletedAt > thirtyDaysAgo;
    });
    
    // If some items were cleaned, save back
    if (activeTrash.length < trash.length) {
      const { data: existingData } = await getBookingsData();
      existingData.trash = activeTrash;
      await setBookingsData(existingData);
      console.log(`Auto-cleaned ${trash.length - activeTrash.length} expired trash items`);
    }
    
    res.json({ success: true, trash: activeTrash });
  } catch (error) {
    console.error('Get trash error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Restore booking from trash ──────────────────────────────────────────────

app.post('/restore-booking/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingData } = await getBookingsData();
    existingData.trash = existingData.trash || [];
    existingData.bookings = existingData.bookings || [];
    existingData.bookedDates = existingData.bookedDates || [];

    const trashIdx = existingData.trash.findIndex(b => b.id === id);
    if (trashIdx === -1) return res.status(404).json({ error: 'الحجز غير موجود في سلة المحذوفات' });

    // Restore from trash
    const restoredBooking = existingData.trash[trashIdx];
    delete restoredBooking.deletedAt;
    restoredBooking.status = restoredBooking.status === 'cancelled' ? 'cancelled' : 'confirmed';

    // Add back to bookings
    existingData.bookings.unshift(restoredBooking);
    existingData.trash.splice(trashIdx, 1);

    // Re-add to bookedDates if confirmed
    if (restoredBooking.status === 'confirmed' && restoredBooking.checkIn && restoredBooking.checkOut) {
      existingData.bookedDates.push({
        start: restoredBooking.checkIn,
        end: restoredBooking.checkOut,
        bookingId: restoredBooking.id
      });
    }

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'فشل في استرجاع الحجز' });
    }

    console.log(`Booking ${id} (${restoredBooking.name}) restored from trash`);
    res.json({ success: true, message: 'تم استرجاع الحجز بنجاح', booking: restoredBooking });
  } catch (error) {
    console.error('Restore booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Permanently delete from trash ───────────────────────────────────────────

app.delete('/permanent-delete/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existingData } = await getBookingsData();
    existingData.trash = existingData.trash || [];

    const before = existingData.trash.length;
    existingData.trash = existingData.trash.filter(b => b.id !== id);

    if (existingData.trash.length === before) {
      return res.status(404).json({ error: 'الحجز غير موجود في سلة المحذوفات' });
    }

    // Also remove civil ID image
    try {
      const imagesMap = await getCivilIdImages();
      if (imagesMap[id]) {
        delete imagesMap[id];
        await setCivilIdImages(imagesMap);
      }
    } catch (e) {}

    // Also remove signature
    try {
      const sigMap = await getSignatures();
      if (sigMap[id]) {
        delete sigMap[id];
        await setSignatures(sigMap);
      }
    } catch (e) {}

    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'فشل في الحذف النهائي' });
    }

    console.log(`Booking ${id} permanently deleted from trash`);
    res.json({ success: true, message: 'تم الحذف النهائي' });
  } catch (error) {
    console.error('Permanent delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Empty entire trash ──────────────────────────────────────────────────────

app.delete('/empty-trash', async (req, res) => {
  try {
    const { data: existingData } = await getBookingsData();
    const trashCount = (existingData.trash || []).length;
    
    // Clean up images and signatures for trashed items
    const trashIds = (existingData.trash || []).map(b => b.id);
    try {
      const imagesMap = await getCivilIdImages();
      let changed = false;
      trashIds.forEach(id => {
        if (imagesMap[id]) { delete imagesMap[id]; changed = true; }
      });
      if (changed) await setCivilIdImages(imagesMap);
    } catch (e) {}
    
    try {
      const sigMap = await getSignatures();
      let changed = false;
      trashIds.forEach(id => {
        if (sigMap[id]) { delete sigMap[id]; changed = true; }
      });
      if (changed) await setSignatures(sigMap);
    } catch (e) {}

    existingData.trash = [];
    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'فشل في تفريغ سلة المحذوفات' });
    }

    console.log(`Trash emptied (${trashCount} items)`);
    res.json({ success: true, message: 'تم تفريغ سلة المحذوفات (' + trashCount + ' حجز)' });
  } catch (error) {
    console.error('Empty trash error:', error);
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

// ─── Clean orphan blocked dates (blocked dates with no matching booking) ─────

app.post('/clean-blocked-dates', async (req, res) => {
  try {
    const { data: existingData } = await getBookingsData();
    const bookingIds = new Set((existingData.bookings || []).map(b => b.id));
    const before = (existingData.blockedDates || []).length;
    
    // Keep only blocked dates that either:
    // 1. Have no bookingId (manually blocked)
    // 2. Have a bookingId that exists in active bookings
    existingData.blockedDates = (existingData.blockedDates || []).filter(d => {
      if (!d.bookingId) return true; // manually blocked - keep
      return bookingIds.has(d.bookingId); // only keep if booking exists
    });
    
    const removed = before - existingData.blockedDates.length;
    
    if (removed > 0) {
      const result = await setBookingsData(existingData);
      if (result?.metafieldsSet?.userErrors?.length > 0) {
        return res.status(500).json({ error: 'Failed to clean blocked dates' });
      }
    }
    
    console.log(`Cleaned ${removed} orphan blocked dates`);
    res.json({ success: true, removed, remaining: existingData.blockedDates.length });
  } catch (error) {
    console.error('Clean blocked dates error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Custom Prices (get/set) ──────────────────────────────────────────────────

app.get('/get-custom-prices', async (req, res) => {
  try {
    const { data } = await getBookingsData();
    res.json({ success: true, custom_prices: data.custom_prices || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/set-custom-prices', async (req, res) => {
  try {
    const { custom_prices } = req.body;
    if (!Array.isArray(custom_prices)) return res.status(400).json({ error: 'custom_prices must be an array' });
    const { data: existingData } = await getBookingsData();
    existingData.custom_prices = custom_prices;
    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save custom prices', details: result.metafieldsSet.userErrors });
    }
    res.json({ success: true, count: custom_prices.length });
  } catch (error) {
    console.error('Set custom prices error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Seasonal/Default Prices (get/set) ────────────────────────────────────────

app.get('/get-seasonal-prices', async (req, res) => {
  try {
    const { data } = await getBookingsData();
    const defaults = {
      s1: { 'thu-sat': 300, 'sun-wed': 300, 'sun-sat': 500 },
      s2: { 'thu-sat': 350, 'sun-wed': 350, 'sun-sat': 600 },
      s3: { 'thu-sat': 400, 'sun-wed': 400, 'sun-sat': 700 }
    };
    res.json({ success: true, seasonal_prices: data.seasonal_prices || defaults });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/set-seasonal-prices', async (req, res) => {
  try {
    const { seasonal_prices } = req.body;
    if (!seasonal_prices || typeof seasonal_prices !== 'object') return res.status(400).json({ error: 'seasonal_prices must be an object' });
    const { data: existingData } = await getBookingsData();
    existingData.seasonal_prices = seasonal_prices;
    const result = await setBookingsData(existingData);
    if (result?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to save seasonal prices', details: result.metafieldsSet.userErrors });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Set seasonal prices error:', error);
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
.logo-section h1 { font-size: 20px; color: #000000; font-weight: 700; }
.logo-section p { color: #9a8f82; font-size: 13px; }
.card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; }
.card h2 { font-size: 16px; color: #000000; margin-bottom: 12px; border-bottom: 2px solid #c9a961; padding-bottom: 8px; }
.info-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0ebe4; font-size: 14px; }
.info-row:last-child { border-bottom: none; }
.info-row .label { color: #7a7060; }
.info-row .value { color: #000000; font-weight: 600; }
.terms-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; }
.terms-card h2 { font-size: 16px; color: #000000; margin-bottom: 12px; border-bottom: 2px solid #c9a961; padding-bottom: 8px; }
.terms-card ol { padding-right: 20px; font-size: 12px; line-height: 1.6; color: #4a4540; }
.terms-card li { margin-bottom: 4px; }
.sig-card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); border: 1px solid #e8e2d8; text-align: center; }
.sig-card h2 { font-size: 16px; color: #000000; margin-bottom: 4px; }
.sig-card p { color: #9a8f82; font-size: 13px; margin-bottom: 12px; }
canvas { border: 2px dashed #c9a961; border-radius: 8px; background: #fefcf9; touch-action: none; width: 100%; max-width: 500px; }
.btn-row { display: flex; gap: 10px; margin-top: 12px; justify-content: center; }
.btn { padding: 12px 28px; border: none; border-radius: 8px; font-size: 15px; font-family: 'Tajawal', sans-serif; cursor: pointer; font-weight: 600; }
.btn-primary { background: #c9a961; color: #fff; }
.btn-primary:disabled { background: #d4c9a8; cursor: not-allowed; }
.btn-secondary { background: #e8e2d8; color: #5a5045; }
.success-msg { text-align: center; padding: 40px 20px; }
.success-msg .icon { font-size: 60px; margin-bottom: 16px; }
.success-msg h2 { color: #000000; margin-bottom: 8px; }
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
  ctx.strokeStyle = '#000000';
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
      document.getElementById('content').innerHTML = '<div class="success-msg"><div class="icon">✅</div><h2>تم التوقيع بنجاح!</h2><p>شكراً لك، تم حفظ توقيعك على عقد الإيجار.</p><p style="margin-top:12px;color:#000000;font-weight:600;">شاليه ريتريت - نتمنى لك إقامة ممتعة 🏖️</p></div>';
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
  const now = new Date();
  const todayDate = now.getDate() + '/' + (now.getMonth() + 1) + '/' + now.getFullYear();
  const LOGO_DATA_URI = 'data:image/png;base64,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';
  const OWNER_SIG_URI = 'data:image/png;base64,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';
  const sigImg = (signatureDataURL && signatureDataURL.startsWith('data:'))
    ? `<img src="${signatureDataURL}" alt="توقيع المستأجر" />`
    : '';

  const terms = [
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
    'يحق للمؤجر رفض الدخول أو إنهاء الحجز فوراً عند مخالفة الشروط أو تجاوز العدد المسموح أو الإزعاج أو عدم دفع كامل المبلغ، كما يمنع تأجير الشاليه من الباطن أو التنازل عنه للغير.',
  ];

  const termsHtml = terms.map((t, i) => `<li>${t}</li>`).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8">
<title>عقد إيجار - شاليه ريتريت</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html { background: #f5f0eb; }
body { font-family: "Tajawal", Arial, sans-serif; direction: rtl; padding: 0 6px; color: #2d2d2d; max-width: 800px; margin: 0 auto; font-size: 12px; line-height: 1.3; background: #f5f0eb; }
.header { text-align: center; margin-bottom: 2px; }
.header img { max-width: 60px; margin: 0 auto 2px; display: block; }
.contract-title { text-align: center; font-size: 15px; font-weight: 700; margin-bottom: 1px; }
.contract-subtitle { text-align: center; font-size: 11px; color: #7a7060; margin-bottom: 0; }
.contract-address { text-align: center; font-size: 10px; color: #9a8f82; margin-bottom: 2px; }
.date-line { text-align: left; font-size: 12px; color: #c9a961; font-weight: 700; margin-bottom: 3px; }
.info-table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
.info-table td { padding: 4px 8px; font-size: 12px; border: 1px solid #ede8e1; }
.info-table .label { color: #9a8f82; font-weight: 700; white-space: nowrap; }
.info-table .value { font-weight: 500; color: #000; }
.terms ol { list-style: none; counter-reset: terms; padding: 0; }
.terms li { counter-increment: terms; font-size: 11.5px; line-height: 1.4; color: #4a4a4a; padding: 1px 0; }
.terms li::before { content: counter(terms) ". "; font-weight: 700; color: #c9a961; font-size: 11.5px; }
.acknowledgment { background: #fff8ee; border: 1px solid #c9a961; padding: 3px 8px; margin: 3px 0; font-size: 10px; line-height: 1.3; color: #4a4a4a; text-align: center; border-radius: 4px; }
.signatures { display: flex; justify-content: space-between; margin-top: 4px; gap: 10px; }
.sig-block { flex: 1; text-align: center; padding: 4px; border: 1px solid #e8e0d5; border-radius: 4px; }
.sig-block h5 { font-size: 12px; margin-bottom: 1px; color: #2d2d2d; }
.sig-block p { font-size: 11px; color: #7a7060; margin-bottom: 1px; }
.sig-block img { max-width: 90px; max-height: 40px; margin: 2px auto; display: block; }
@media print { body { padding: 0 6px; } @page { margin: 3mm; size: A4; } }
</style>
</head>
<body>
  <div class="header">
    <img src="${LOGO_DATA_URI}" alt="Retreat Logo" />
  </div>
  <div class="contract-title">الشروط والأحكام</div>
  <div class="contract-subtitle">شاليه ريتريت</div>
  <div class="contract-address">الخيران، المرحلة الخامسة، شاليه رقم 3423</div>
  <div class="date-line">${todayDate}</div>
  <table class="info-table">
    <tr><td class="label">تاريخ الدخول:</td><td class="value">${b.checkIn || '-'}</td><td class="label">تاريخ الخروج:</td><td class="value">${b.checkOut || '-'}</td></tr>
    <tr><td class="label">مبلغ الإيجار:</td><td class="value">${b.price || '-'}</td><td class="label">اسم المستأجر:</td><td class="value">${b.name || '-'}</td></tr>
    <tr><td class="label">مبلغ التأمين:</td><td class="value">100 د.ك</td><td class="label">الرقم المدني:</td><td class="value">${b.civilId || '-'}</td></tr>
    <tr><td class="label">العربون:</td><td class="value">100 د.ك</td><td class="label">رقم الهاتف:</td><td class="value">${b.phone || '-'}</td></tr>
    <tr><td class="label">عدد الأشخاص:</td><td class="value">${b.guests || '-'}</td><td></td><td></td></tr>
  </table>
  <div class="terms"><ol>${termsHtml}</ol></div>
  <div class="acknowledgment">يقر المستأجر بأنه قرأ هذه الشروط والأحكام وفهمها ووافق عليها ويلتزم بجميع ما ورد فيها.</div>
  <div class="signatures">
    <div class="sig-block"><h5>المؤجر</h5><p>الاسم: زكريا الرفاعي</p><img src="${OWNER_SIG_URI}" alt="توقيع المؤجر" /></div>
    <div class="sig-block"><h5>المستأجر</h5><p>الاسم: ${b.name || '-'}</p><p>رقم الهاتف: ${b.phone || '-'}</p><p>الرقم المدني: ${b.civilId || '-'}</p>${sigImg}</div>
  </div>
</body>
</html>`;

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
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
          <h2 style="color:#000000;margin-bottom:4px;">عقد موقّع - شاليه ريتريت</h2>
          <p style="color:#c9a961;font-size:14px;">تم توقيع العقد من قبل العميل</p>
        </div>
        <div style="background:#fdf8f0;border:1px solid #e8dcc8;padding:16px;border-radius:8px;margin-bottom:16px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">اسم المستأجر:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${booking.name || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">رقم الهاتف:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${booking.phone || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الدخول:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${booking.checkIn || '-'}</td></tr>
            <tr><td style="padding:8px;color:#9a8f82;">تاريخ الخروج:</td><td style="padding:8px;font-weight:600;color:#000000;">${booking.checkOut || '-'}</td></tr>
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
        <h2 style="color:#000000;margin-bottom:4px;">حجز جديد - شاليه ريتريت</h2>
        <p style="color:#c9a961;font-size:14px;">تم استلام حجز جديد عبر الموقع</p>
      </div>
      <div style="background:#fdf8f0;border:1px solid #e8dcc8;padding:16px;border-radius:8px;margin-bottom:16px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">اسم المستأجر:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.name || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">رقم الهاتف:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.phone || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">البريد الإلكتروني:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.email || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">الرقم المدني:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.civilId || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الدخول:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.checkIn || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">تاريخ الخروج:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.checkOut || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">الباقة:</td><td style="padding:8px;font-weight:600;color:#000000;border-bottom:1px solid #ede8e1;">${b.packageName || '—'}</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;border-bottom:1px solid #ede8e1;">مبلغ الإيجار:</td><td style="padding:8px;font-weight:600;color:#c9a961;border-bottom:1px solid #ede8e1;">${b.price || '—'} د.ك</td></tr>
          <tr><td style="padding:8px;color:#9a8f82;">عدد الأشخاص:</td><td style="padding:8px;font-weight:600;color:#000000;">${b.guests || '—'}</td></tr>
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

  // Attach contract as HTML file (sent from client) or try Puppeteer PDF as fallback
  try {
    if (b.contractHTML && b.contractHTML.length > 100) {
      // Client sent the contract HTML - attach it directly as HTML file
      const htmlBuffer = Buffer.from(b.contractHTML, 'utf-8');
      attachments.push({
        filename: `contract-${b.name || 'customer'}.html`,
        content: htmlBuffer,
        contentType: 'text/html'
      });
      console.log('✅ Contract HTML attached to booking email (from client)');
    } else {
      // Fallback: try to generate PDF with Puppeteer (may fail on some hosts)
      let sigDataForPDF = null;
      if (b.signatureDataURL === 'STORED_IN_SIGNATURES') {
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
        console.log('✅ Contract PDF attached to booking email (Puppeteer)');
      }
    }
  } catch (pdfErr) {
    console.error('Failed to attach contract to booking email:', pdfErr.message);
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

// ─── Attachments metafield helpers ────────────────────────────────────────────

async function getAttachments() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "retreat", key: "attachments") {
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

async function setAttachments(attMap) {
  const jsonValue = JSON.stringify(attMap);
  console.log(`[setAttachments] Saving metafield, size: ${jsonValue.length} bytes`);
  const result = await shopifyGraphQL(`
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
      key: 'attachments',
      value: jsonValue,
      type: 'json'
    }]
  });
  const userErrors = result?.metafieldsSet?.userErrors;
  if (userErrors?.length) {
    console.error('[setAttachments] Shopify userErrors:', JSON.stringify(userErrors));
    throw new Error('Failed to save attachments: ' + JSON.stringify(userErrors));
  }
  console.log('[setAttachments] Saved successfully');
  return result;
}

// ─── Upload file to Shopify via Staged Uploads ─────────────────────────────
async function uploadToShopifyCDN(fileBuffer, filename, mimetype) {
  // Step 1: Create staged upload target
  const stagedResult = await shopifyGraphQL(`
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    input: [{
      resource: "FILE",
      filename: filename,
      mimeType: mimetype,
      httpMethod: "POST",
      fileSize: String(fileBuffer.length)
    }]
  });

  const target = stagedResult?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    const errors = stagedResult?.stagedUploadsCreate?.userErrors;
    throw new Error('Failed to create staged upload: ' + JSON.stringify(errors));
  }

  // Step 2: Upload file to staged URL
  const formData = new FormData();
  for (const param of target.parameters) {
    formData.append(param.name, param.value);
  }
  formData.append('file', fileBuffer, { filename, contentType: mimetype });

  const uploadResp = await fetch(target.url, {
    method: 'POST',
    body: formData,
    headers: formData.getHeaders()
  });

  if (!uploadResp.ok) {
    throw new Error(`Staged upload failed: ${uploadResp.status}`);
  }

  // Step 3: Create file in Shopify
  const fileResult = await shopifyGraphQL(`
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          alt
          ... on GenericFile {
            url
          }
          ... on MediaImage {
            image {
              url
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    files: [{
      alt: filename,
      contentType: mimetype.startsWith('image/') ? "IMAGE" : "FILE",
      originalSource: target.resourceUrl
    }]
  });

  const createdFile = fileResult?.fileCreate?.files?.[0];
  if (!createdFile) {
    const errors = fileResult?.fileCreate?.userErrors;
    throw new Error('Failed to create file: ' + JSON.stringify(errors));
  }

  // Get the URL - might need to poll for processing
  let fileUrl = createdFile.url || createdFile.image?.url;
  
  // Poll for CDN URL if not immediately available (staged URLs are temporary)
  const fileId = createdFile.id;
  if (!fileUrl || fileUrl.includes('staged-uploads')) {
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const checkResult = await shopifyGraphQL(`
        query($id: ID!) {
          node(id: $id) {
            ... on GenericFile {
              url
            }
            ... on MediaImage {
              image { url }
            }
          }
        }
      `, { id: fileId });
      const polledUrl = checkResult?.node?.url || checkResult?.node?.image?.url;
      if (polledUrl && !polledUrl.includes('staged-uploads')) {
        fileUrl = polledUrl;
        break;
      }
      if (polledUrl && !fileUrl) fileUrl = polledUrl;
    }
  }

  console.log(`[uploadToShopifyCDN] Final URL: ${fileUrl}`);
  return fileUrl || target.resourceUrl;
}

// Upload attachment for a booking (supports multiple files)
app.post('/upload-attachment/:bookingId', upload.array('files', 10), async (req, res) => {
  try {
    // Support both single file (legacy) and multiple files
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) return res.status(400).json({ error: 'No files provided' });
    
    const bookingId = req.params.bookingId;
    console.log(`Uploading ${files.length} attachment(s) for booking ${bookingId}`);

    // Get existing attachments
    const attMap = await getAttachments();
    if (!attMap[bookingId]) attMap[bookingId] = [];

    const uploaded = [];
    for (const file of files) {
      const filename = (file.originalname || 'attachment').replace(/[/\\]/g, '_');
      console.log(`  Uploading: ${filename} (${file.size} bytes)`);
      
      try {
        // Upload to Shopify CDN
        console.log(`  [CDN] Starting upload for ${filename}...`);
        const cdnUrl = await uploadToShopifyCDN(file.buffer, filename, file.mimetype);
        console.log(`  [CDN] Success: ${cdnUrl}`);
        
        const att = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
          filename: filename,
          mimetype: file.mimetype,
          size: file.size,
          dataUrl: cdnUrl,  // Store CDN URL instead of base64
          uploadedAt: new Date().toISOString()
        };
        attMap[bookingId].push(att);
        uploaded.push(att);
      } catch (uploadErr) {
        console.error(`  [CDN] Failed to upload ${filename}:`, uploadErr.message);
        console.error(`  [CDN] Full error:`, uploadErr.stack || uploadErr);
        // Fallback: store as base64 for small files only
        if (file.size < 200000) { // < 200KB
          const base64 = file.buffer.toString('base64');
          const dataUrl = `data:${file.mimetype};base64,${base64}`;
          const att = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            filename: filename,
            mimetype: file.mimetype,
            size: file.size,
            dataUrl: dataUrl,
            uploadedAt: new Date().toISOString()
          };
          attMap[bookingId].push(att);
          uploaded.push(att);
        } else {
          uploaded.push({ filename, error: uploadErr.message });
        }
      }
    }

    try {
      await setAttachments(attMap);
      console.log(`[upload-attachment] Successfully saved ${uploaded.length} file(s) for booking ${bookingId}`);
    } catch (saveErr) {
      console.error(`[upload-attachment] Failed to save metafield:`, saveErr.message);
      return res.status(500).json({ error: 'Upload succeeded but failed to save: ' + saveErr.message });
    }
    res.json({ 
      success: true, 
      attachments: attMap[bookingId].map(a => ({ 
        id: a.id, filename: a.filename, mimetype: a.mimetype, 
        size: a.size, uploadedAt: a.uploadedAt 
      })),
      uploaded: uploaded.length
    });
  } catch (error) {
    console.error('Upload attachment error:', error);
    res.status(500).json({ error: error.message });
  }
});


// Get attachments for a booking
app.get('/get-attachments/:bookingId', async (req, res) => {
  try {
    const attMap = await getAttachments();
    const atts = attMap[req.params.bookingId] || [];
    res.json({ success: true, attachments: atts });
  } catch (error) {
    console.error('Get attachments error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete attachment
app.delete('/delete-attachment/:bookingId/:attachmentId', async (req, res) => {
  try {
    const attMap = await getAttachments();
    const bookingId = req.params.bookingId;
    const attachmentId = req.params.attachmentId;
    if (attMap[bookingId]) {
      attMap[bookingId] = attMap[bookingId].filter(a => a.id !== attachmentId);
      await setAttachments(attMap);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete attachment error:', error);
    res.status(500).json({ error: error.message });
  }
});


// ─── Cleanup: remove base64 data from attachments metafield ──────────────────
app.post('/cleanup-attachments', async (req, res) => {
  try {
    const attMap = await getAttachments();
    let cleaned = 0;
    let removed = 0;
    
    for (const [bookingId, atts] of Object.entries(attMap)) {
      if (!Array.isArray(atts)) continue;
      for (let i = atts.length - 1; i >= 0; i--) {
        const att = atts[i];
        if (att.dataUrl && att.dataUrl.startsWith('data:')) {
          // Remove base64 data - either replace with CDN URL if provided, or remove
          const cdnUrl = req.body?.replacements?.[att.id];
          if (cdnUrl) {
            att.dataUrl = cdnUrl;
            cleaned++;
          } else {
            // Remove the attachment entirely if no CDN replacement
            atts.splice(i, 1);
            removed++;
          }
        }
      }
    }
    
    const jsonValue = JSON.stringify(attMap);
    console.log(`[cleanup] Cleaned ${cleaned}, removed ${removed}. New size: ${jsonValue.length} chars`);
    
    await setAttachments(attMap);
    res.json({ success: true, cleaned, removed, newSize: jsonValue.length });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Invoice Storage (Shopify Metafield) ──────────────────────────────────────

async function getInvoices() {
  const data = await shopifyGraphQL(`
    query {
      shop {
        metafield(namespace: "retreat", key: "invoices") {
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

async function setInvoices(invoiceMap) {
  const jsonValue = JSON.stringify(invoiceMap);
  console.log(`[setInvoices] Saving metafield, size: ${jsonValue.length} bytes`);
  const result = await shopifyGraphQL(`
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
      key: 'invoices',
      value: jsonValue,
      type: 'json'
    }]
  });
  const userErrors = result?.metafieldsSet?.userErrors;
  if (userErrors?.length) {
    console.error('[setInvoices] Shopify userErrors:', JSON.stringify(userErrors));
    throw new Error('Failed to save invoices: ' + JSON.stringify(userErrors));
  }
  console.log('[setInvoices] Saved successfully');
  return result;
}

// Get all invoices
app.get('/get-invoices', async (req, res) => {
  try {
    const invoices = await getInvoices();
    res.json({ success: true, invoices });
  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save all invoices
app.post('/save-invoices', async (req, res) => {
  try {
    const { invoices } = req.body;
    if (!invoices || typeof invoices !== 'object') {
      return res.status(400).json({ error: 'Invalid invoices data' });
    }
    await setInvoices(invoices);
    console.log(`[save-invoices] Saved ${Object.keys(invoices).length} booking invoices`);
    res.json({ success: true, count: Object.keys(invoices).length });
  } catch (error) {
    console.error('Save invoices error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

// ─── Upload Civil ID manually ──────────────────────────────────────────────
app.post('/upload-civil-id/:bookingId', upload.single('file'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    let fileBuffer, filename, mimetype;
    
    // Support both multipart file upload and JSON base64
    if (req.file) {
      fileBuffer = req.file.buffer;
      filename = `civil-id-${bookingId}-${Date.now()}.${req.file.mimetype.split('/')[1] || 'jpg'}`;
      mimetype = req.file.mimetype;
      console.log(`[upload-civil-id] Uploading civil ID for booking ${bookingId} via file, size: ${req.file.size}`);
    } else if (req.body && req.body.imageData) {
      // Convert base64 data URL to buffer
      const dataUrl = req.body.imageData;
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) return res.status(400).json({ error: 'Invalid image data' });
      mimetype = matches[1];
      fileBuffer = Buffer.from(matches[2], 'base64');
      filename = `civil-id-${bookingId}-${Date.now()}.${mimetype.split('/')[1] || 'jpg'}`;
      console.log(`[upload-civil-id] Uploading civil ID for booking ${bookingId} via JSON base64, size: ${fileBuffer.length}`);
    } else {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    // Upload to Shopify CDN instead of metafield
    console.log(`[upload-civil-id] Uploading to Shopify CDN...`);
    const cdnUrl = await uploadToShopifyCDN(fileBuffer, filename, mimetype);
    console.log(`[upload-civil-id] CDN URL: ${cdnUrl}`);
    
    // Also save CDN URL in civil_id_images metafield (just the URL string, not base64)
    try {
      const imagesMap = await getCivilIdImages();
      // Clean old base64 data - only keep CDN URLs
      for (const key of Object.keys(imagesMap)) {
        if (imagesMap[key] && imagesMap[key].startsWith('data:')) {
          delete imagesMap[key];
        }
      }
      imagesMap[bookingId] = cdnUrl;
      await setCivilIdImages(imagesMap);
    } catch (metaErr) {
      console.error('[upload-civil-id] Metafield save warning:', metaErr.message);
      // Not critical - CDN URL is the source of truth now
    }
    
    // Update the booking's civilIdImageUrl to the CDN URL directly
    try {
      const { data } = await getBookingsData();
      const bookings = data.bookings || [];
      const idx = bookings.findIndex(b => String(b.id) === String(bookingId));
      if (idx !== -1) {
        bookings[idx].civilIdImageUrl = cdnUrl;
        data.bookings = bookings;
        await setBookingsData(data);
      }
    } catch (bookingErr) {
      console.error('[upload-civil-id] Booking update warning:', bookingErr.message);
    }
    
    console.log(`[upload-civil-id] Successfully saved civil ID for booking ${bookingId}`);
    res.json({ success: true, message: 'Civil ID uploaded successfully', cdnUrl });
  } catch (error) {
    console.error('[upload-civil-id] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Generate Receipt as PNG image on server ─────────────────────────────────
app.get('/generate-receipt-image/:bookingId/:invoiceIdx', async (req, res) => {
  try {
    const { bookingId, invoiceIdx } = req.params;
    const idx = parseInt(invoiceIdx);
    
    // Get invoice data
    const invoiceMap = await getInvoices();
    const invoices = invoiceMap[bookingId] || [];
    if (!invoices[idx]) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const inv = invoices[idx];
    
    // Get booking data
    const { data } = await getBookingsData();
    const booking = (data.bookings || []).find(b => String(b.id) === String(bookingId));
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const typeName = inv.type === 'deposit' ? '\u0625\u064a\u0635\u0627\u0644 \u0627\u0633\u062a\u0644\u0627\u0645 \u0639\u0631\u0628\u0648\u0646' : '\u0625\u064a\u0635\u0627\u0644 \u0627\u0633\u062a\u0644\u0627\u0645 \u0645\u0628\u0644\u063a \u0627\u0644\u0625\u064a\u062c\u0627\u0631';
    const ci = booking.checkIn || booking.checkin || '';
    const co = booking.checkOut || booking.checkout || '';
    const guestName = booking.name || booking.guest_name || '';
    const logo = 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663530851339/roNCVxbVgYKQtCRp.png';
    
    // Generate receipt number and date from createdAt
    const createdDate = inv.createdAt ? new Date(inv.createdAt) : new Date();
    const receiptDate = createdDate.toLocaleDateString('en-GB'); // DD/MM/YYYY
    const receiptYear = createdDate.getFullYear();
    // Generate a stable receipt number from booking ID + invoice index
    const hashNum = (parseInt(String(bookingId).slice(-6)) + idx * 1000) % 10000;
    const receiptNumber = inv.number || `RBH-${receiptYear}-${String(hashNum).padStart(4, '0')}`;
    const receiptDateStr = inv.date || receiptDate;
    
    const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Tajawal', Arial, sans-serif; background: #FDF8F0; width: 500px; padding: 40px 30px; }
    .header { text-align: center; margin-bottom: 10px; }
    .header img { max-width: 90px; margin-bottom: 6px; }
    .header h3 { font-size: 16px; color: #333; font-weight: 700; margin-bottom: 2px; }
    .header .subtitle { color: #999; font-size: 11px; margin-top: 2px; }
    .gold-line { height: 2px; background: linear-gradient(to left, transparent, #C9A84C, transparent); margin: 16px 0; }
    .receipt-title { text-align: center; font-size: 22px; color: #C9A84C; font-weight: 700; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    td { padding: 12px 8px; font-size: 14px; }
    tr { border-bottom: 1px solid #E8E0D0; }
    tr:last-child { border-bottom: none; }
    .label { text-align: right; font-weight: 700; color: #333; width: 40%; }
    .value { text-align: left; color: #555; }
    .footer { text-align: center; color: #bbb; font-size: 10px; margin-top: 20px; line-height: 1.8; }
  </style>
</head>
<body>
  <div class="header">
    <img src="${logo}" crossorigin="anonymous" />
    <h3>Retreat Private Beach House</h3>
    <p class="subtitle">\u0627\u0644\u062e\u064a\u0631\u0627\u0646\u060c \u0627\u0644\u0645\u0631\u062d\u0644\u0629 \u0627\u0644\u062e\u0627\u0645\u0633\u0629\u060c \u0634\u0627\u0644\u064a\u0647 \u0631\u0642\u0645 3423</p>
  </div>
  <div class="gold-line"></div>
  <div class="receipt-title">${typeName}</div>
  <table>
    <tr><td class="label">\u0631\u0642\u0645 \u0627\u0644\u0625\u064a\u0635\u0627\u0644</td><td class="value">${receiptNumber}</td></tr>
    <tr><td class="label">\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0625\u064a\u0635\u0627\u0644</td><td class="value">${receiptDateStr}</td></tr>
    <tr><td class="label">\u0646\u0648\u0639 \u0627\u0644\u0625\u064a\u0635\u0627\u0644</td><td class="value">${typeName}</td></tr>
    <tr><td class="label">\u0627\u0644\u0627\u0633\u0645</td><td class="value">${guestName}</td></tr>
    <tr><td class="label">\u0627\u0644\u0645\u0628\u0644\u063a</td><td class="value">${inv.amount} \u062f.\u0643</td></tr>
    <tr><td class="label">\u062a\u0648\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u062c\u0632</td><td class="value">${co} \u2192 ${ci}</td></tr>
    ${inv.notes ? '<tr><td class="label">\u0645\u0644\u0627\u062d\u0638\u0627\u062a</td><td class="value">' + inv.notes + '</td></tr>' : ''}
  </table>
  <p class="footer">\u0647\u0630\u0627 \u0625\u064a\u0635\u0627\u0644 \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0635\u0627\u062f\u0631\u0629 \u0645\u0646 \u0646\u0638\u0627\u0645 Retreat<br>Retreat Private Beach House \u2014 Kuwait</p>
</body>
</html>`;
    
    // Generate PNG using Puppeteer
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 500, height: 600, deviceScaleFactor: 2 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    
    // Wait for font to load
    await page.evaluate(() => document.fonts.ready);
    
    const bodyElement = await page.$('body');
    const pngBuffer = await bodyElement.screenshot({ type: 'png' });
    await browser.close();
    
    // Upload to Shopify CDN
    const nm = guestName.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_') || 'customer';
    const safeNm = nm.replace(/[^a-zA-Z0-9_-]/g, '') || 'customer';
    const safeDate = (inv.date || new Date().toLocaleDateString('en-GB')).replace(/\//g, '-');
    const typeFile = inv.type === 'deposit' ? 'receipt_deposit' : 'receipt_rent';
    const fileName = `${typeFile}_${safeNm}_${safeDate}.png`;
    const displayName = `${typeFile}_${nm}_${safeDate}.png`;
    
    let cdnUrl;
    try {
      cdnUrl = await uploadToShopifyCDN(pngBuffer, fileName, 'image/png');
      console.log(`[receipt-image] Uploaded to CDN: ${cdnUrl}`);
      
      // Also save as attachment
      try {
        const attMap = await getAttachments();
        if (!attMap[bookingId]) attMap[bookingId] = [];
        attMap[bookingId].push({
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
          filename: fileName,
          mimetype: 'image/png',
          size: pngBuffer.length,
          dataUrl: cdnUrl,
          uploadedAt: new Date().toISOString()
        });
        await setAttachments(attMap);
      } catch (attErr) {
        console.error('[receipt-image] Attachment save warning:', attErr.message);
      }
    } catch (uploadErr) {
      console.error('[receipt-image] CDN upload failed:', uploadErr.message);
    }
    
    // Return the image
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
    res.setHeader('X-CDN-URL', cdnUrl || '');
    res.send(pngBuffer);
  } catch (error) {
    console.error('[receipt-image] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve receipt override JS
// Serve html2canvas from our server to bypass Shopify CSP
app.get('/html2canvas.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = require('path');
  res.sendFile(path.join(__dirname, 'html2canvas.min.js'));
});

app.get('/receipt-override.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const path = require('path');
  const fs = require('fs');
  try {
    const js = fs.readFileSync(path.join(__dirname, 'receipt-override.js'), 'utf8');
    res.send(js);
  } catch (err) {
    console.error('Error reading receipt-override.js:', err.message);
    res.status(500).send('// Error loading receipt override');
  }
});

// receipt-override.js is now served from a separate file


app.listen(PORT, () => {
  console.log(`Retreat File Server running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}.myshopify.com`);
  console.log(`Email: ${process.env.EMAIL_USER || 'NOT SET'}`);
});
