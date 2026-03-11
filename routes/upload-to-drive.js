const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// POST /upload-to-drive
// Downloads a file from a URL and uploads it to Google Drive
// Body: { fileUrl, fileAuth?, driveFolderId, driveAuth, fileName, mimeType? }
router.post('/', async (req, res) => {
  const { fileUrl, fileAuth, driveFolderId, driveAuth, fileName, mimeType } = req.body;
  const jobId = uuidv4().substring(0, 8);
  let tempPath = null;

  try {
    if (!fileUrl) throw new Error('fileUrl is required');
    if (!driveFolderId) throw new Error('driveFolderId is required');
    if (!driveAuth) throw new Error('driveAuth is required');

    const uploadFileName = fileName || `upload-${jobId}`;
    const detectedMime = mimeType || (fileUrl.match(/\.png/i) ? 'image/png' : fileUrl.match(/\.jpe?g/i) ? 'image/jpeg' : 'application/octet-stream');

    // Step 1: Download file
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

    const fileSize = fs.statSync(tempPath).size;
    if (fileSize === 0) throw new Error('Downloaded file is empty');
    console.log(`[upload-to-drive/${jobId}] Downloaded: ${fileSize} bytes`);

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
