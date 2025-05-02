import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import multer from 'multer';
import FormData from 'form-data';
import 'dotenv/config';

async function waitForFileReady(fileId: string, maxAttempts = 10, interval = 2000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN!
        },
        body: JSON.stringify({
          query: `
            query getFile($id: ID!) {
              node(id: $id) {
                ... on MediaImage {
                  id
                  fileStatus
                  image {
                    url
                  }
                }
                ... on GenericFile {
                  id
                  fileStatus
                  url
                }
              }
            }
          `,
          variables: {
            id: fileId
          }
        })
      }
    );

    const result = await response.json();
    const fileNode = result.data?.node;

    if (!fileNode) {
      throw new Error('File not found');
    }

    if (fileNode.fileStatus === 'READY') {
      return fileNode.image?.url || fileNode.url;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error('The file did not become ready in the allotted time.');
}


const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL,
  methods: ['POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const upload = multer({
  storage: multer.memoryStorage()
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'The file was not uploaded' });
      return;
    }

    const stagedUploadResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN!
        },
        body: JSON.stringify({
          query: `
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
          `,
          variables: {
            input: [
              {
                filename: file.originalname,
                mimeType: file.mimetype,
                resource: "FILE",
                fileSize: file.size.toString(),
                httpMethod: 'POST',
              }
            ]
          }
        })
      }
    );

    const stagedUploadJson = await stagedUploadResponse.json();
    const target = stagedUploadJson.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      console.error('Error at stagedUploadsCreate stage:', stagedUploadJson);
      res.status(500).json({ error: 'Failed to get download URL:' });
      return;
    }

    const formData = new FormData();
    for (const param of target.parameters) {
      formData.append(param.name, param.value);
    }
    formData.append('file', file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    });

    const headers = {
      ...formData.getHeaders(),
    };

    const uploadResult = await fetch(target.url, {
      method: 'POST',
      body: formData as any,
      headers
    });

    const uploadResultText = await uploadResult.text();

    if (!uploadResult.ok) {
      const err = await uploadResult.text();
      console.error('Loading error S3:', err);
      res.status(500).json({ error: 'Loading error S3' });
      return;
    }

    const fileCreateResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN!
        },
        body: JSON.stringify({
          query: `
            mutation fileCreate($files: [FileCreateInput!]!) {
              fileCreate(files: $files) {
                files {
                  ... on MediaImage {
                    id
                    image {
                      url
                    }
                  }
                  ... on GenericFile {
                    id
                    url
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          variables: {
            files: [
              {
                alt: file.originalname,
                contentType: 'IMAGE',
                originalSource: target.resourceUrl
              }
            ]
          }
        })
      }
    );

    const fileCreateJson = await fileCreateResponse.json();
    const fileFirst = fileCreateJson.data?.fileCreate?.files?.[0];

    if (!fileFirst?.id) {
      console.error('Error creating file in Shopify:', fileCreateJson);
      res.status(500).json({ error: 'Failed to create file in Shopify' });
      return;
    }

    try {
      const createdFile = await waitForFileReady(fileFirst.id);
      res.json({ url: createdFile });
    } catch (error) {
      console.error('Error waiting for file:', error);
      res.status(500).json({ error: 'The file was not ready in the allotted time' });
    }

  } catch (error) {
    console.error('Loading error', error);
    res.status(500).json({ error: 'Loading error image' });
    return;
  }
});

app.post('/shopify-admin-proxy', async (req, res) => {
  try {
    const response = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN!,
        },
        body: JSON.stringify(req.body),
      }
    );

    if (!response.ok) throw new Error('Shopify API error');

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`);
});

