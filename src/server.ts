import express from "express"
import fetch from "node-fetch"
import cors from "cors"
import multer from "multer"
import FormData from "form-data"
import "dotenv/config"
import sharp from "sharp"
import { v4 as uuidv4 } from "uuid"
import fs from "fs"
import path from "path"
import ffmpeg from "fluent-ffmpeg"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

// Создаем временную директорию для файлов
const tempDir = path.join(__dirname, "temp")
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

// Проверка наличия ffmpeg
let ffmpegAvailable = false

async function checkFfmpeg() {
  try {
    await execAsync("ffmpeg -version")
    console.log("ffmpeg is available")
    ffmpegAvailable = true
  } catch (error) {
    console.warn("ffmpeg is not installed. Video compression will be skipped.")
    console.warn("To enable video compression, please install ffmpeg: https://ffmpeg.org/download.html")
    ffmpegAvailable = false
  }
}

// Проверяем наличие ffmpeg при запуске
checkFfmpeg()

// Хранилище для отслеживания статуса загрузки и активных запросов
interface UploadStatus {
  id: string
  status: "waiting" | "compressing" | "uploading" | "completed" | "error" | "cancelled"
  progress: number
  originalFilename: string
  error?: string
  url?: string
  type: "image" | "video"
  timestamp?: number
  abortController?: AbortController // Для отмены fetch запросов
  tempFiles?: string[] // Пути к временным файлам
}

const uploadStatuses = new Map<string, UploadStatus>()

// Очистка старых статусов (старше 1 часа)
setInterval(() => {
  const now = Date.now()
  for (const [id, status] of uploadStatuses.entries()) {
    if (status.timestamp && now - status.timestamp > 3600000) {
      // Очищаем временные файлы
      if (status.tempFiles) {
        status.tempFiles.forEach((file) => {
          try {
            if (fs.existsSync(file)) {
              fs.unlinkSync(file)
            }
          } catch (error) {
            console.error(`Error deleting temp file ${file}:`, error)
          }
        })
      }
      uploadStatuses.delete(id)
    }
  }
}, 3600000)

async function waitForFileReady(fileId: string, uploadId: string, maxAttempts = 30, interval = 5000) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const status = uploadStatuses.get(uploadId)
    if (!status || status.status === "cancelled") {
      throw new Error("Upload cancelled")
    }

    const abortController = new AbortController()
    status.abortController = abortController

    try {
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
        // Исправление типизации для node-fetch
        signal: abortController.signal as any,
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
    } catch (error) {
      if ((error as any).name === "AbortError") {
        throw new Error("Upload cancelled")
      }
      console.error("Error checking file status:", error)
    }

    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  throw new Error("The file did not become ready in the allotted time.")
}

// Функция для сжатия изображения
async function compressImage(inputPath: string, outputPath: string): Promise<void> {
  try {
    await sharp(inputPath)
      .withMetadata()
      .resize(1920, 1080, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toFile(outputPath)
  } catch (error) {
    console.error("Error compressing image:", error)
    throw error
  }
}

// Функция для сжатия видео
async function compressVideo(inputPath: string, outputPath: string, uploadId: string): Promise<void> {
  // Если ffmpeg не доступен, просто копируем файл
  if (!ffmpegAvailable) {
    fs.copyFileSync(inputPath, outputPath)
    return
  }

  return new Promise((resolve, reject) => {
    // Проверяем, не была ли загрузка отменена
    const checkCancellation = setInterval(() => {
      const status = uploadStatuses.get(uploadId)
      if (!status || status.status === "cancelled") {
        ffmpegCommand.kill("SIGTERM")
        clearInterval(checkCancellation)
        reject(new Error("Upload cancelled"))
      }
    }, 1000)

    const ffmpegCommand = ffmpeg(inputPath)
      .outputOptions([
        "-c:v libx264",
        "-crf 28",
        "-preset medium",
        "-c:a aac",
        "-b:a 128k",
        "-movflags +faststart",
        "-vf scale=1280:-2",
      ])
      .output(outputPath)
      .on("end", () => {
        clearInterval(checkCancellation)
        resolve()
      })
      .on("error", (err) => {
        clearInterval(checkCancellation)
        reject(err)
      })

    ffmpegCommand.run()
  })
}

const app = express()

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type"],
  }),
)

app.use(express.json({ limit: "500mb" }))
app.use(express.urlencoded({ limit: "500mb", extended: true }))

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, tempDir)
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`)
    },
  }),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
})

// Эндпоинт для инициализации загрузки
app.post("/api/init-upload", (req, res) => {
  const { filename, fileType } = req.body

  if (!filename || !fileType) {
    res.status(400).json({ error: "Missing filename or fileType" })
    return
  }

  const uploadId = uuidv4()

  uploadStatuses.set(uploadId, {
    id: uploadId,
    status: "waiting",
    progress: 0,
    originalFilename: filename,
    type: fileType,
    timestamp: Date.now(),
    tempFiles: [],
  })

  res.json({ uploadId })
})

// Эндпоинт для проверки статуса загрузки
app.get("/api/upload-status/:uploadId", (req, res) => {
  const { uploadId } = req.params

  if (!uploadId || !uploadStatuses.has(uploadId)) {
    res.status(404).json({ error: "Upload not found" })
    return
  }

  res.json(uploadStatuses.get(uploadId))
})

// Эндпоинт для отмены загрузки
app.delete("/api/cancel-upload/:uploadId", (req, res) => {
  const { uploadId } = req.params

  if (!uploadId || !uploadStatuses.has(uploadId)) {
    res.status(404).json({ error: "Upload not found" })
    return
  }

  const status = uploadStatuses.get(uploadId)!

  // Отменяем все активные запросы
  if (status.abortController) {
    try {
      status.abortController.abort()
    } catch (error) {
      console.error("Error aborting request:", error)
    }
  }

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...status,
    status: "cancelled",
    error: "Upload cancelled by user",
  })

  // Удаляем временные файлы
  if (status.tempFiles) {
    status.tempFiles.forEach((file) => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      } catch (error) {
        console.error(`Error deleting temp file ${file}:`, error)
      }
    })
  }

  res.json({ success: true, message: "Upload cancelled" })
})

// Эндпоинт для загрузки файла
app.post("/api/upload-file", upload.single("file"), async (req, res) => {
  try {
    const file = req.file
    const fileType = req.body.fileType // 'image' or 'video'
    const uploadId = req.body.uploadId

    if (!file) {
      res.status(400).json({ error: "The file was not uploaded" })
      return
    }

    if (!uploadId || !uploadStatuses.has(uploadId)) {
      res.status(400).json({ error: "Invalid upload ID" })
      return
    }

    // Добавляем путь к файлу в список временных файлов
    const status = uploadStatuses.get(uploadId)!
    status.tempFiles = status.tempFiles || []
    status.tempFiles.push(file.path)

    // Обновляем статус
    uploadStatuses.set(uploadId, {
      ...status,
      status: "compressing",
      progress: 10,
    })

    console.log(
      `Processing ${fileType} file: ${file.originalname}, size: ${file.size} bytes, mimetype: ${file.mimetype}`,
    )

    // Validate file size
    const maxSize = fileType === "image" ? 10 * 1024 * 1024 : 100 * 1024 * 1024
    if (file.size > maxSize) {
      uploadStatuses.set(uploadId, {
        ...uploadStatuses.get(uploadId)!,
        status: "error",
        error: `File too large. ${fileType === "image" ? "Images" : "Videos"} must be under ${fileType === "image" ? "10MB" : "100MB"}.`,
      })

      res.status(400).json({
        error: `File too large. ${fileType === "image" ? "Images" : "Videos"} must be under ${fileType === "image" ? "10MB" : "100MB"}.`,
      })
      return
    }

    // Проверяем, не была ли загрузка отменена
    if (uploadStatuses.get(uploadId)?.status === "cancelled") {
      res.status(400).json({ error: "Upload cancelled by user" })
      return
    }

    // Сжимаем файл на сервере
    const compressedFilePath = path.join(tempDir, `compressed-${file.filename}`)
    status.tempFiles.push(compressedFilePath)

    try {
      if (fileType === "image") {
        await compressImage(file.path, compressedFilePath)
      } else if (fileType === "video") {
        await compressVideo(file.path, compressedFilePath, uploadId)
      } else {
        // Если тип не поддерживается, просто копируем файл
        fs.copyFileSync(file.path, compressedFilePath)
      }

      // Обновляем статус
      uploadStatuses.set(uploadId, {
        ...uploadStatuses.get(uploadId)!,
        status: "uploading",
        progress: 30,
      })
    } catch (error) {
      console.error("Error compressing file:", error)

      // Проверяем, не была ли загрузка отменена
      if ((error as Error).message === "Upload cancelled") {
        res.status(400).json({ error: "Upload cancelled by user" })
        return
      }

      // В случае ошибки сжатия используем оригинальный файл
      fs.copyFileSync(file.path, compressedFilePath)

      uploadStatuses.set(uploadId, {
        ...uploadStatuses.get(uploadId)!,
        status: "uploading",
        progress: 30,
      })
    }

    // Проверяем, не была ли загрузка отменена
    if (uploadStatuses.get(uploadId)?.status === "cancelled") {
      res.status(400).json({ error: "Upload cancelled by user" })
      return
    }

    try {
      let url

      // Используем разные подходы для изображений и видео
      if (fileType === "image") {
        url = await uploadImageToShopify(compressedFilePath, file.originalname, file.mimetype, uploadId)
      } else if (fileType === "video") {
        url = await uploadVideoToShopify(compressedFilePath, file.originalname, file.mimetype, uploadId)
      } else {
        url = await uploadGenericFileToShopify(compressedFilePath, file.originalname, file.mimetype, uploadId)
      }

      // Обновляем статус
      uploadStatuses.set(uploadId, {
        ...uploadStatuses.get(uploadId)!,
        status: "completed",
        progress: 100,
        url,
      })

      res.json({ url })
    } catch (error) {
      console.error("Error uploading file:", error)

      // Проверяем, не была ли загрузка отменена
      if ((error as Error).message === "Upload cancelled") {
        res.status(400).json({ error: "Upload cancelled by user" })
        return
      }

      uploadStatuses.set(uploadId, {
        ...uploadStatuses.get(uploadId)!,
        status: "error",
        error: (error as Error).message || "Error uploading file",
      })

      res.status(500).json({ error: "Error uploading file" })
    }

    // Очистка временных файлов
    try {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path)
      }
      if (fs.existsSync(compressedFilePath)) {
        fs.unlinkSync(compressedFilePath)
      }
    } catch (error) {
      console.error("Error cleaning up temporary files:", error)
    }
  } catch (error) {
    console.error("Loading error", error)

    if (req.body.uploadId && uploadStatuses.has(req.body.uploadId)) {
      uploadStatuses.set(req.body.uploadId, {
        ...uploadStatuses.get(req.body.uploadId)!,
        status: "error",
        error: "Loading error processing file",
      })
    }

    res.status(500).json({ error: "Loading error processing file" })
    return
  }
})

// Функция для загрузки видео в Shopify
async function uploadVideoToShopify(
  filePath: string,
  filename: string,
  mimeType: string,
  uploadId: string,
): Promise<string> {
  console.log("Uploading video to Shopify...")

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 50,
  })

  // Step 1: Create a staged upload for VIDEO
  const abortController1 = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController: abortController1,
  })

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
              filename: filename,
              mimeType: mimeType,
              resource: "VIDEO", // Используем VIDEO вместо FILE
              fileSize: fs.statSync(filePath).size.toString(),
              httpMethod: "POST",
            },
          ],
        },
      }),
      signal: abortController1.signal as any,
    },
  )

  const stagedUploadJson = await stagedUploadResponse.json()
  console.log("Video staged upload response:", JSON.stringify(stagedUploadJson, null, 2))

  const target = stagedUploadJson.data?.stagedUploadsCreate?.stagedTargets?.[0]

  if (!target) {
    console.error("Error at stagedUploadsCreate stage:", stagedUploadJson)
    throw new Error("Failed to get download URL for video")
  }

  // Step 2: Upload the file to the staged URL
  console.log("Uploading video to staged URL...")
  const formData = new FormData()
  for (const param of target.parameters) {
    formData.append(param.name, param.value)
  }
  formData.append("file", fs.createReadStream(filePath))

  const headers = {
    ...formData.getHeaders(),
  }

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 70,
  })

  const abortController2 = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController: abortController2,
  })

  const uploadResult = await fetch(target.url, {
    method: "POST",
    body: formData as any,
    headers,
    signal: abortController2.signal as any,
  })

  if (!uploadResult.ok) {
    const err = await uploadResult.text()
    console.error("Loading error S3:", err)
    throw new Error(`Loading error S3: ${err}`)
  }

  console.log("Video uploaded successfully to S3")

  // Step 3: Create the video in Shopify
  console.log("Creating video in Shopify...")
  const fileCreateQuery = `
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
  `

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 80,
  })

  const abortController3 = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController: abortController3,
  })

  const fileCreateResponse = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`, {
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
            alt: filename,
            contentType: "VIDEO",
            originalSource: target.resourceUrl,
          },
        ],
      },
    }),
    signal: abortController3.signal as any,
  })

  const fileCreateJson = await fileCreateResponse.json()
  console.log("Video create response:", JSON.stringify(fileCreateJson, null, 2))

  // Проверяем наличие URL в ответе
  if (fileCreateJson.data?.fileCreate?.files?.[0]?.sources?.[0]?.url) {
    return fileCreateJson.data.fileCreate.files[0].sources[0].url
  }

  const fileId = fileCreateJson.data?.fileCreate?.files?.[0]?.id
  if (!fileId) {
    if (fileCreateJson.data?.fileCreate?.userErrors?.length > 0) {
      throw new Error(fileCreateJson.data.fileCreate.userErrors[0].message)
    }
    throw new Error("Failed to create video in Shopify")
  }

  // Step 4: Wait for the file to be ready
  console.log("Waiting for video to be ready...")
  return await waitForFileReady(fileId, uploadId)
}

// Функция для загрузки изображения в Shopify
async function uploadImageToShopify(
  filePath: string,
  filename: string,
  mimeType: string,
  uploadId: string,
): Promise<string> {
  // Создаем staged upload
  const stagedUpload = await createStagedUpload(filePath, filename, mimeType, "FILE", uploadId)

  // Загружаем файл в S3
  await uploadFileToS3(filePath, stagedUpload, uploadId)

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 80,
  })

  // Создаем файл в Shopify
  const fileCreateQuery = `
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

  const abortController = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController,
  })

  const fileCreateResponse = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`, {
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
            alt: filename,
            contentType: "IMAGE",
            originalSource: stagedUpload.resourceUrl,
          },
        ],
      },
    }),
    signal: abortController.signal as any,
  })

  const fileCreateJson = await fileCreateResponse.json()
  console.log("Image create response:", JSON.stringify(fileCreateJson, null, 2))

  if (fileCreateJson.data?.fileCreate?.files?.[0]?.image?.url) {
    return fileCreateJson.data.fileCreate.files[0].image.url
  }

  const fileId = fileCreateJson.data?.fileCreate?.files?.[0]?.id
  if (!fileId) {
    throw new Error("Failed to create image in Shopify")
  }

  // Ждем, пока файл будет готов
  return await waitForFileReady(fileId, uploadId)
}

// Функция для загрузки обычного файла в Shopify
async function uploadGenericFileToShopify(
  filePath: string,
  filename: string,
  mimeType: string,
  uploadId: string,
): Promise<string> {
  // Создаем staged upload
  const stagedUpload = await createStagedUpload(filePath, filename, mimeType, "FILE", uploadId)

  // Загружаем файл в S3
  await uploadFileToS3(filePath, stagedUpload, uploadId)

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 80,
  })

  // Создаем файл в Shopify
  const fileCreateQuery = `
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

  const abortController = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController,
  })

  const fileCreateResponse = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`, {
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
            alt: filename,
            contentType: "FILE",
            originalSource: stagedUpload.resourceUrl,
          },
        ],
      },
    }),
    signal: abortController.signal as any,
  })

  const fileCreateJson = await fileCreateResponse.json()
  console.log("Generic file create response:", JSON.stringify(fileCreateJson, null, 2))

  if (fileCreateJson.data?.fileCreate?.files?.[0]?.url) {
    return fileCreateJson.data.fileCreate.files[0].url
  }

  const fileId = fileCreateJson.data?.fileCreate?.files?.[0]?.id
  if (!fileId) {
    throw new Error("Failed to create file in Shopify")
  }

  // Ждем, пока файл будет готов
  return await waitForFileReady(fileId, uploadId)
}

// Обновим функцию createStagedUpload, добавив проверку максимального размера файла
async function createStagedUpload(
  filePath: string,
  filename: string,
  mimeType: string,
  resource: "FILE" | "VIDEO" | "IMAGE",
  uploadId: string,
) {
  console.log(`Creating staged upload for ${resource}...`)

  // Проверка максимального размера файла
  const fileSize = fs.statSync(filePath).size
  const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100MB

  if (resource === "VIDEO" && fileSize > MAX_VIDEO_SIZE) {
    throw new Error(`Video file exceeds maximum size of ${MAX_VIDEO_SIZE / 1024 / 1024}MB`)
  }

  const abortController = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController,
  })

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
              filename: filename,
              mimeType: mimeType,
              resource: resource,
              fileSize: fileSize.toString(),
              httpMethod: "POST",
            },
          ],
        },
      }),
      signal: abortController.signal as any,
    },
  )

  const stagedUploadJson = await stagedUploadResponse.json()
  console.log("Staged upload response:", JSON.stringify(stagedUploadJson, null, 2))

  const target = stagedUploadJson.data?.stagedUploadsCreate?.stagedTargets?.[0]

  if (!target) {
    console.error("Error at stagedUploadsCreate stage:", stagedUploadJson)
    throw new Error("Failed to get download URL")
  }

  return target
}

// Функция для загрузки файла в S3
async function uploadFileToS3(filePath: string, stagedUpload: any, uploadId: string) {
  console.log("Uploading file to S3...")

  // Обновляем статус
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    status: "uploading",
    progress: 60,
  })

  const formData = new FormData()

  for (const param of stagedUpload.parameters) {
    formData.append(param.name, param.value)
  }

  formData.append("file", fs.createReadStream(filePath))

  const headers = {
    ...formData.getHeaders(),
  }

  const abortController = new AbortController()
  uploadStatuses.set(uploadId, {
    ...uploadStatuses.get(uploadId)!,
    abortController,
  })

  const uploadResult = await fetch(stagedUpload.url, {
    method: "POST",
    body: formData as any,
    headers,
    signal: abortController.signal as any,
  })

  if (!uploadResult.ok) {
    const err = await uploadResult.text()
    console.error("Loading error S3:", err)
    throw new Error(`Loading error S3: ${err}`)
  }

  console.log("File uploaded successfully to S3")
}

app.post("/shopify-admin-proxy", async (req, res) => {
  try {
    const response = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_API_TOKEN!,
      },
      body: JSON.stringify(req.body),
    })

    if (!response.ok) throw new Error("Shopify API error")

    const data = await response.json()
    res.json(data)
  } catch (error) {
    console.error("Proxy error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

const port = process.env.PORT || 3001
app.listen(port, () => {
  console.log(`Proxy server running on port ${port}`)
})
