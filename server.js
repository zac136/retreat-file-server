const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// CORS - allow Shopify store
app.use(cors({
  origin: [
    'https://retreat-beach-house.myshopify.com',
    'https://www.retreat-beach-house.com',
    /\.myshopify\.com$/,
    /\.manus\.computer$/,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

const SHOPIFY_STORE = 'retreat-beach-house.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

// ─── Helper: get/set bookings metafield ───────────────────────────────────────

async function getBookingsData() {
  const getQuery = `
    query {
      shop {
        metafield(namespace: "retreat", key: "bookings") {
          id
          value
        }
      }
    }
  `;
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN
    },
    body: JSON.stringify({ query: getQuery })
  });
  const data = await res.json();
  const metafield = data.data?.shop?.metafield;
  let parsed = { bookings: [], bookedDates: [] };
  if (metafield?.value) {
    try { parsed = JSON.parse(metafield.value); } catch(e) {}
  }
  return { data: parsed, metafieldId: metafield?.id };
}

async function setBookingsData(payload) {
  const setQuery = `
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key value }
        userErrors { field message }
      }
    }
  `;
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN
    },
    body: JSON.stringify({
      query: setQuery,
      variables: {
        metafields: [{
          ownerId: `gid://shopify/Shop/1`,
          namespace: 'retreat',
          key: 'bookings',
          value: JSON.stringify(payload),
          type: 'json'
        }]
      }
    })
  });
  return res.json();
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Retreat File Server is running' });
});

// ─── Upload file to Shopify Files API ─────────────────────────────────────────

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const file = req.file;
    const filename = req.body.filename || file.originalname || 'upload.jpg';
    const folder = req.body.folder || 'retreat-bookings';

    console.log(`Uploading: ${filename} (${file.size} bytes)`);

    const stagedQuery = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters { name value }
          }
          userErrors { field message }
        }
      }
    `;

    const stagedResponse = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({
        query: stagedQuery,
        variables: {
          input: [{
            filename: `${folder}/${filename}`,
            mimeType: file.mimetype,
            resource: 'FILE',
            fileSize: String(file.size)
          }]
        }
      })
    });

    const stagedData = await stagedResponse.json();
    if (stagedData.errors) {
      return res.status(500).json({ error: 'Failed to get upload URL', details: stagedData.errors });
    }

    const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      return res.status(500).json({ error: 'No staged target returned' });
    }

    const formData = new FormData();
    target.parameters.forEach(param => {
      formData.append(param.name, param.value);
    });
    formData.append('file', file.buffer, {
      filename: filename,
      contentType: file.mimetype
    });

    const uploadResponse = await fetch(target.url, {
      method: 'POST',
      body: formData
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.error('Upload to staged URL failed:', errText);
      return res.status(500).json({ error: 'Failed to upload to staged URL' });
    }

    const createQuery = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage { image { url } }
            ... on GenericFile { url }
          }
          userErrors { field message }
        }
      }
    `;

    const createResponse = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({
        query: createQuery,
        variables: {
          files: [{
            originalSource: target.resourceUrl,
            contentType: file.mimetype.startsWith('image/') ? 'IMAGE' : 'FILE'
          }]
        }
      })
    });

    const createData = await createResponse.json();
    if (createData.errors) {
      return res.status(500).json({ error: 'Failed to create file', details: createData.errors });
    }

    const createdFile = createData.data?.fileCreate?.files?.[0];
    const fileUrl = createdFile?.image?.url || createdFile?.url || target.resourceUrl;

    console.log(`File uploaded successfully: ${fileUrl}`);
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

    // Assign unique id if missing
    if (!booking.id) booking.id = Date.now().toString();
    booking.status = booking.status || 'confirmed';
    booking.createdAt = booking.createdAt || new Date().toISOString();

    existingData.bookings.unshift(booking);

    if (booking.checkIn && booking.checkOut) {
      existingData.bookedDates.push({ start: booking.checkIn, end: booking.checkOut, bookingId: booking.id });
    }

    const setData = await setBookingsData(existingData);
    if (setData.errors || setData.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Metafield error:', setData.errors || setData.data?.metafieldsSet?.userErrors);
      return res.status(500).json({ error: 'Failed to save booking' });
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

    // Merge updates
    existingData.bookings[idx] = { ...existingData.bookings[idx], ...updates, id };

    // Rebuild bookedDates
    existingData.bookedDates = existingData.bookings
      .filter(b => b.status !== 'cancelled' && b.checkIn && b.checkOut)
      .map(b => ({ start: b.checkIn, end: b.checkOut, bookingId: b.id }));

    const setData = await setBookingsData(existingData);
    if (setData.errors || setData.data?.metafieldsSet?.userErrors?.length > 0) {
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

    // Remove from bookedDates
    existingData.bookedDates = (existingData.bookedDates || []).filter(d => d.bookingId !== id);

    const setData = await setBookingsData(existingData);
    if (setData.errors || setData.data?.metafieldsSet?.userErrors?.length > 0) {
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

    const setData = await setBookingsData(existingData);
    if (setData.errors || setData.data?.metafieldsSet?.userErrors?.length > 0) {
      return res.status(500).json({ error: 'Failed to delete booking' });
    }

    res.json({ success: true, message: 'Booking deleted permanently' });

  } catch (error) {
    console.error('Delete booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Get shop ID helper ───────────────────────────────────────────────────────

async function getShopId() {
  const response = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/shop.json`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
  });
  const data = await response.json();
  return data.shop?.id;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Retreat File Server running on port ${PORT}`);
});
