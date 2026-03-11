const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// POST /upload-to-drive
// Uploads a file to Google Drive from either a URL or base64 data
// Body: { fileUrl?, fileAuth?, base64Data?, driveFolderId, driveAuth, fileName, mimeType? }
// Provide either fileUrl (download from URL) or base64Data (direct base64 content)
router.post('/', async (req, res) => {
  const { fileUrl, fileAuth, base64Data, driveFolderId, driveAuth, fileName, mimeType } = req.body;
  const jobId = uuidv4().substring(0, 8);
  let tempPath = null;

  try {
    if (!fileUrl && !base64Data) throw new Error('Either fileUrl or base64Data is required');
    if (!driveFolderId) throw new Error('driveFolderId is required');
    if (!driveAuth) throw new Error('driveAuth is required');

    const uploadFileName = fileName || `upload-${jobId}`;

    // Detect MIME type
    let detectedMime = mimeType;
    if (!detectedMime) {
      if (base64Data) {
        // Detect from base64 magic bytes
        detectedMime = base64Data.startsWith('/9j/') ? 'image/jpeg'
          : base64Data.startsWith('iVBOR') ? 'image/png'
          : 'application/octet-stream';
      } else if (fileUrl) {
        detectedMime = fileUrl.match(/\.png/i) ? 'image/png'
          : fileUrl.match(/\.jpe?g/i) ? 'image/jpeg'
          : 'application/octet-stream';
      }
    }

    // Step 1: Get file to temp (either from base64 or URL download)
    let fileSize;

    if (base64Data) {
      // Base64 mode: decode and write to temp file
      console.log(`[upload-to-drive/${jobId}] Decoding base64 data (${Math.round(base64Data.length / 1024)}KB encoded)...`);
      const buffer = Buffer.from(base64Data, 'base64');
      const ext = detectedMime === 'image/jpeg' ? '.jpg' : detectedMime === 'image/png' ? '.png' : '.bin';
      tempPath = path.join(TEMP_DIR, `${jobId}-upload${ext}`);
      fs.writeFileSync(tempPath, buffer);
      fileSize = buffer.length;
      if (fileSize === 0) throw new Error('Base64 data decoded to empty file');
      console.log(`[upload-to-drive/${jobId}] Decoded: ${fileSize} bytes`);
    } else {
      // URL mode: download file
      console.log(`[upload-to-drive/${jobId}] Downloading: ${fileUrl.substring(0, 120)}...`);
      const headers = {};
      if (fileAuth) headers['Authorization'] = fileAuth;

      const dlRes = await fetch(fileUrl, { headers, redirect: 'follow' });
      if (!dlRes.ok) {
        throw new Error(`Download failed: ${dlRes.status} ${dlRes.statusText}`);
      }

      tempPath = path.join(TEMP_DIR, `${jobId}-upload${path.extname(fileUrl.split('?')[0]) || '.bin'}`);
      const fileStream = fs.createWriteStream(tempPath);
      await pipeline(dlRes.body, fileStream);

      fileSize = fs.statSync(tempPath).size;
      if (fileSize === 0) throw new Error('Downloaded file is empty');
      console.log(`[upload-to-drive/${jobId}] Downloaded: ${fileSize} bytes`);
    }

    // Step 2: Initiate resumable upload to Drive
    const initRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
      {
        method: 'POST',
        headers: {
          'Authorization': driveAuth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: uploadFileName,
          parents: [driveFolderId],
          mimeType: detectedMime
        })
      }
    );
    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error(`Drive init failed: ${initRes.status} ${errText.substring(0, 200)}`);
    }

    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) throw new Error('No upload URL from Drive');

    // Step 3: Upload file to Drive
    const fileBuffer = fs.readFileSync(tempPath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': detectedMime,
        'Content-Length': fileSize.toString()
      },
      body: fileBuffer
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`Drive upload failed: ${uploadRes.status} ${errText.substring(0, 200)}`);
    }

    const driveFile = await uploadRes.json();
    console.log(`[upload-to-drive/${jobId}] Uploaded to Drive: ${driveFile.id} (${uploadFileName})`);

    res.json({
      success: true,
      driveFileId: driveFile.id,
      fileName: uploadFileName,
      fileSize,
      mimeType: detectedMime
    });

  } catch (err) {
    console.error(`[upload-to-drive/${jobId}] FAILED:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
});

module.exports = router;
