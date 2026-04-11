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
    /\.myshopify\.com$/
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

const SHOPIFY_STORE = 'retreat-beach-house.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Retreat File Server is running' });
});

// Upload file to Shopify Files API
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const file = req.file;
    const filename = req.body.filename || file.originalname || 'upload.jpg';
    const folder = req.body.folder || 'retreat-bookings';

    console.log(`Uploading: ${filename} (${file.size} bytes)`);

    // Step 1: Get staged upload URL from Shopify
    const stagedQuery = `
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
      console.error('Staged upload error:', stagedData.errors);
      return res.status(500).json({ error: 'Failed to get upload URL', details: stagedData.errors });
    }

    const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      return res.status(500).json({ error: 'No staged target returned' });
    }

    // Step 2: Upload file to the staged URL
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

    // Step 3: Create file in Shopify Files
    const createQuery = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage {
              image {
                url
              }
            }
            ... on GenericFile {
              url
            }
          }
          userErrors {
            field
            message
          }
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
      console.error('File create error:', createData.errors);
      return res.status(500).json({ error: 'Failed to create file', details: createData.errors });
    }

    const createdFile = createData.data?.fileCreate?.files?.[0];
    const fileUrl = createdFile?.image?.url || createdFile?.url || target.resourceUrl;

    console.log(`File uploaded successfully: ${fileUrl}`);
    
    res.json({ 
      success: true, 
      url: fileUrl,
      resourceUrl: target.resourceUrl,
      fileId: createdFile?.id
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save booking data to Shopify metafield
app.post('/save-booking', async (req, res) => {
  try {
    const booking = req.body;
    
    if (!booking) {
      return res.status(400).json({ error: 'No booking data provided' });
    }

    // Get existing bookings from metafield
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

    const getResponse = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_TOKEN
      },
      body: JSON.stringify({ query: getQuery })
    });

    const getData = await getResponse.json();
    
    let existingData = { bookings: [], bookedDates: [] };
    const existingMetafield = getData.data?.shop?.metafield;
    
    if (existingMetafield?.value) {
      try {
        existingData = JSON.parse(existingMetafield.value);
      } catch(e) {}
    }

    // Add new booking
    existingData.bookings = existingData.bookings || [];
    existingData.bookings.unshift(booking);

    // Add booked dates
    if (booking.checkIn && booking.checkOut) {
      existingData.bookedDates = existingData.bookedDates || [];
      existingData.bookedDates.push({
        start: booking.checkIn,
        end: booking.checkOut
      });
    }

    // Save updated data
    const setQuery = `
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const setResponse = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/graphql.json`, {
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
            value: JSON.stringify(existingData),
            type: 'json'
          }]
        }
      })
    });

    const setData = await setResponse.json();
    
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

// Get shop ID helper
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
