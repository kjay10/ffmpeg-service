const express = require('express');
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');
const multer = require('multer');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// Multer config for file uploads
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Download a file from URL to local path
async function downloadFile(url, destPath, authHeader) {
  const headers = {};
  if (authHeader) headers['Authorization'] = authHeader;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(res.body, fileStream);
}

// Get video metadata
function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

// Resolve video to a local file path (from URL, upload, fileId, or auth URL)
async function resolveVideo(req, jobId) {
  const videoPath = path.join(TEMP_DIR, `${jobId}-input.mp4`);

  if (req.file) {
    // File was uploaded via multipart
    fs.renameSync(req.file.path, videoPath);
    return videoPath;
  }

  // Support Google Drive fileId — build download URL automatically
  let { videoUrl, fileId, driveAuth } = req.body;

  // Defensive: strip leading "=" from n8n expression values
  if (fileId && fileId.startsWith('=')) fileId = fileId.substring(1);
  if (driveAuth && driveAuth.startsWith('=')) driveAuth = driveAuth.substring(1);

  if (fileId) {
    const driveDownloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const authHeader = driveAuth || req.headers['x-video-auth'];
    if (!authHeader) throw new Error('driveAuth or x-video-auth header required when using fileId');
    console.log(`[extract] Downloading Drive file ${fileId} directly`);
    await downloadFile(driveDownloadUrl, videoPath, authHeader);
    return videoPath;
  }

  if (!videoUrl) throw new Error('videoUrl, fileId, or file upload required');

  const authHeader = req.headers['x-video-auth'];
  await downloadFile(videoUrl, videoPath, authHeader);
  return videoPath;
}

// POST /extract/frames
// Extracts thumbnail strip from video (1 frame per interval)
// Accepts: JSON { videoUrl, interval } OR multipart file upload (field: "video") + interval query/body param
// Optional: x-video-auth header forwarded when downloading videoUrl
// Returns: { frames: [{ timestamp, image: base64 }], duration, width, height }
router.post('/frames', upload.single('video'), async (req, res) => {
  const interval = parseInt(req.body.interval) || 1;
  const jobId = uuidv4();
  const framesDir = path.join(TEMP_DIR, `${jobId}-frames`);
  let videoPath;

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    // Resolve video from upload or URL
    videoPath = await resolveVideo(req, jobId);

    // Get video info
    const info = await getVideoInfo(videoPath);
    const videoStream = info.streams.find(s => s.codec_type === 'video');
    const duration = parseFloat(info.format.duration);

    // Extract frames
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .outputOptions([
          `-vf`, `fps=1/${interval},scale=320:-1`,
          `-q:v`, `3`
        ])
        .output(path.join(framesDir, 'frame-%04d.jpg'))
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Read frames and convert to base64
    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.jpg'))
      .sort();

    const frames = frameFiles.map((file, i) => ({
      timestamp: i * interval,
      image: `data:image/jpeg;base64,${fs.readFileSync(path.join(framesDir, file)).toString('base64')}`
    }));

    res.json({
      frames,
      duration,
      width: videoStream?.width,
      height: videoStream?.height,
      codec: videoStream?.codec_name
    });
  } catch (err) {
    console.error('Frame extraction error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup
    if (videoPath) fs.rmSync(videoPath, { force: true });
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
});

// POST /extract/frame
// Extracts a single full-resolution frame at given timestamp
// Accepts: JSON { videoUrl, timestamp } OR multipart file upload (field: "video") + timestamp query/body param
// Optional: x-video-auth header forwarded when downloading videoUrl
// Returns: { image: base64, width, height }
router.post('/frame', upload.single('video'), async (req, res) => {
  const timestamp = parseFloat(req.body.timestamp) || 0;
  const jobId = uuidv4();
  const framePath = path.join(TEMP_DIR, `${jobId}-frame.png`);
  let videoPath;

  try {
    // Resolve video from upload or URL
    videoPath = await resolveVideo(req, jobId);

    // Get video info
    const info = await getVideoInfo(videoPath);
    const videoStream = info.streams.find(s => s.codec_type === 'video');

    // Extract single frame, optionally resize to target dimensions
    const targetWidth = parseInt(req.body.width) || null;
    const targetHeight = parseInt(req.body.height) || null;

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(videoPath)
        .seekInput(timestamp);

      if (targetWidth && targetHeight) {
        // Scale to exact dimensions with padding (no crop, no distortion)
        cmd = cmd.outputOptions([
          '-frames:v', '1', '-q:v', '1',
          '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`
        ]);
      } else {
        cmd = cmd.outputOptions(['-frames:v', '1', '-q:v', '1']);
      }

      cmd
        .output(framePath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const imageBuffer = fs.readFileSync(framePath);

    res.json({
      image: `data:image/png;base64,${imageBuffer.toString('base64')}`,
      width: videoStream?.width,
      height: videoStream?.height,
      timestamp
    });
  } catch (err) {
    console.error('Single frame extraction error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (videoPath) fs.rmSync(videoPath, { force: true });
    fs.rmSync(framePath, { force: true });
  }
});

module.exports = router;
