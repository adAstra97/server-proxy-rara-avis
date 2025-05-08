import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import multer from 'multer';
import FormData from 'form-data';
import 'dotenv/config';

async function waitForFileReady(fileId: string, maxAttempts = 30, interval = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
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
                ... on Video {
                  id
                  fileStatus
                  preview {
                    image {
                      url
                    }
                  }
                  sources {
                    url
                    format
                    mimeType
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
          id: fileId,
        },
      }),
    })

    const result = await response.json()
    console.log("File status check result:", JSON.stringify(result, null, 2))

    const fileNode = result.data?.node

    if (!fileNode) {
      throw new Error("File not found")
    }

    if (fileNode.fileStatus === "READY") {
      // Return the appropriate URL based on file type
      if (fileNode.image?.url) {
        return fileNode.image.url // For images
      } else if (fileNode.sources && fileNode.sources.length > 0) {
        return fileNode.sources[0].url // For videos, return the first source URL
      } else if (fileNode.url) {
        return fileNode.url // For generic files
      }
      throw new Error("Could not find URL for file")
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error("The file did not become ready in the allotted time.")
}

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["POST"],
    allowedHeaders: ["Content-Type"],
  }),
)

app.use(express.json({ limit: "250mb" }))
app.use(express.urlencoded({ limit: "250mb", extended: true }))

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 250 * 1024 * 1024, // 250MB max file size
  },
})

app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    const file = req.file
    const fileType = req.body.fileType // 'image' or 'video'

    if (!file) {
      res.status(400).json({ error: "The file was not uploaded" })
      return
    }

    console.log(
      `Processing ${fileType} file: ${file.originalname}, size: ${file.size} bytes, mimetype: ${file.mimetype}`,
    )

    // Validate file size
    const maxSize = fileType === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024
    if (file.size > maxSize) {
      res.status(400).json({
        error: `File too large. ${fileType === "image" ? "Images" : "Videos"} must be under ${fileType === "image" ? "10MB" : "50MB"}.`,
      })
      return
    }

    // For videos, we'll use a different approach - upload as a generic file
    if (fileType === "video") {
      try {
        // Upload as a generic file
        const genericFileResponse = await fetch(
          `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
            },
            body: JSON.stringify({
              query: `
                mutation fileCreate($files: [FileCreateInput!]!) {
                  fileCreate(files: $files) {
                    files {
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
                    contentType: "FILE",
                    fileSize: file.size.toString(),
                    originalSource: file.buffer.toString("base64"),
                    filename: file.originalname,
                    mimeType: file.mimetype,
                  },
                ],
              },
            }),
          },
        )

        const genericFileJson = await genericFileResponse.json()
        console.log("Generic file create response:", JSON.stringify(genericFileJson, null, 2))

        if (genericFileJson.data?.fileCreate?.files?.[0]?.url) {
          res.json({ url: genericFileJson.data.fileCreate.files[0].url })
          return
        } else if (genericFileJson.data?.fileCreate?.userErrors?.length > 0) {
          console.error("Error creating generic file:", genericFileJson.data.fileCreate.userErrors)
        }
      } catch (error) {
        console.error("Error with direct file upload:", error)
      }
    }

    // Step 1: Create a staged upload
    console.log("Creating staged upload...")
    const stagedUploadResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
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
                resource: fileType === 'video' ? 'VIDEO' : 'FILE',
                fileSize: file.size.toString(),
                httpMethod: "POST",
              },
            ],
          },
        }),
      },
    )

    const stagedUploadJson = await stagedUploadResponse.json()
    console.log("Staged upload response:", JSON.stringify(stagedUploadJson, null, 2))

    const target = stagedUploadJson.data?.stagedUploadsCreate?.stagedTargets?.[0]

    if (!target) {
      console.error("Error at stagedUploadsCreate stage:", stagedUploadJson)
      res.status(500).json({ error: "Failed to get download URL" })
      return
    }

    // Step 2: Upload the file to the staged URL
    console.log("Uploading file to staged URL...")
    const formData = new FormData()
    for (const param of target.parameters) {
      formData.append(param.name, param.value)
    }
    formData.append("file", file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
    })

    const headers = {
      ...formData.getHeaders(),
    }

    const uploadResult = await fetch(target.url, {
      method: "POST",
      body: formData as any,
      headers,
    })

    if (!uploadResult.ok) {
      const err = await uploadResult.text()
      console.error("Loading error S3:", err)
      res.status(500).json({ error: "Loading error S3" })
      return
    }

    console.log("File uploaded successfully to S3")

    // Step 3: Create the file in Shopify
    // Determine the content type for Shopify based on file type
    const contentType = fileType === "image" ? "IMAGE" : "VIDEO";

    console.log(`Creating ${contentType} in Shopify...`)

    // Different GraphQL query based on file type
    let fileCreateQuery
    if (contentType === "IMAGE") {
      fileCreateQuery = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on MediaImage {
                id
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
      `
    } else if (contentType === "VIDEO") {
      fileCreateQuery = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
              ... on Video {
                id
                fileStatus
                sources {
                  url
                  format
                  mimeType
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
    } else {
      fileCreateQuery = `
        mutation fileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files {
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
      `
    }

    const fileCreateResponse = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
        },
        body: JSON.stringify({
          query: fileCreateQuery,
          variables: {
            files: [
              {
                alt: file.originalname,
                contentType,
                originalSource: target.resourceUrl,
              },
            ],
          },
        }),
      },
    )

    const fileCreateJson = await fileCreateResponse.json()
    console.log("File create response:", JSON.stringify(fileCreateJson, null, 2))

    // Check for direct URL in response
    if (contentType === "IMAGE" && fileCreateJson.data?.fileCreate?.files?.[0]?.image?.url) {
      res.json({ url: fileCreateJson.data.fileCreate.files[0].image.url });
      return;
    } else if (contentType === "VIDEO" && fileCreateJson.data?.fileCreate?.files?.[0]?.sources?.[0]?.url) {
      res.json({ url: fileCreateJson.data.fileCreate.files[0].sources[0].url });
      return;
    } else if (fileCreateJson.data?.fileCreate?.files?.[0]?.url) {
      res.json({ url: fileCreateJson.data.fileCreate.files[0].url });
      return;
    }

    const fileFirst = fileCreateJson.data?.fileCreate?.files?.[0]

    if (!fileFirst?.id) {
      console.error("Error creating file in Shopify:", fileCreateJson)
      res.status(500).json({ error: "Failed to create file in Shopify" })
      return
    }

    // Step 4: Wait for the file to be ready
    console.log("Waiting for file to be ready...")
    try {
      const createdFile = await waitForFileReady(fileFirst.id)
      console.log("File is ready:", createdFile)
      res.json({ url: createdFile })
    } catch (error) {
      console.error("Error waiting for file:", error)
      res.status(500).json({ error: "The file was not ready in the allotted time" })
    }
  } catch (error) {
    console.error("Loading error", error)
    res.status(500).json({ error: "Loading error processing file" })
    return
  }
})

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

