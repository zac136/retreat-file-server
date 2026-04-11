const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { URLSearchParams } = require('url');

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

// ─── Upload file to Shopify Files API ─────────────────────────────────────────

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const file = req.file;
    const filename = req.body.filename || file.originalname || 'upload.jpg';
    const folder = req.body.folder || 'retreat-bookings';
    console.log(`Uploading: ${filename} (${file.size} bytes)`);

    const token = await getToken();

    // Step 1: Staged upload
    const stagedRes = await fetch(
      `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-01/graphql.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          query: `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
              stagedTargets { url resourceUrl parameters { name value } }
              userErrors { field message }
            }
          }`,
          variables: {
            input: [{
              filename: `${folder}/${filename}`,
              mimeType: file.mimetype,
              resource: 'FILE',
              fileSize: String(file.size)
            }]
          }
        })
      }
    );
    const stagedData = await stagedRes.json();
    if (stagedData.errors) return res.status(500).json({ error: 'Staged upload error', details: stagedData.errors });

    const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) return res.status(500).json({ error: 'No staged target returned' });

    // Step 2: Upload to S3
    const formData = new FormData();
    target.parameters.forEach(p => formData.append(p.name, p.value));
    formData.append('file', file.buffer, { filename, contentType: file.mimetype });

    const uploadRes = await fetch(target.url, { method: 'POST', body: formData });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(500).json({ error: 'S3 upload failed', details: errText.substring(0, 200) });
    }

    // Step 3: Create file in Shopify
    const createRes = await fetch(
      `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2025-01/graphql.json`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({
          query: `mutation fileCreate($files: [FileCreateInput!]!) {
            fileCreate(files: $files) {
              files {
                id fileStatus
                ... on MediaImage { image { url } }
                ... on GenericFile { url }
              }
              userErrors { field message }
            }
          }`,
          variables: {
            files: [{
              originalSource: target.resourceUrl,
              contentType: file.mimetype.startsWith('image/') ? 'IMAGE' : 'FILE'
            }]
          }
        })
      }
    );
    const createData = await createRes.json();
    if (createData.errors) return res.status(500).json({ error: 'File create error', details: createData.errors });

    const createdFile = createData.data?.fileCreate?.files?.[0];
    const fileUrl = createdFile?.image?.url || createdFile?.url || target.resourceUrl;
    console.log(`File uploaded: ${fileUrl}`);
    res.json({ success: true, url: fileUrl, resourceUrl: target.resourceUrl, fileId: createdFile?.id });

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
    res.json({ success: true, bookings: data.bookings || [], bookedDates: data.bookedDates || [] });
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

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Retreat File Server running on port ${PORT}`);
  console.log(`Store: ${SHOPIFY_STORE}.myshopify.com`);
});
