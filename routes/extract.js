const express = require('express');
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// Download a file from URL to local path
async function downloadFile(url, destPath) {
  const res = await fetch(url);
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

// POST /extract/frames
// Extracts thumbnail strip from video (1 frame per interval)
// Body: { videoUrl, interval: 1 } (interval in seconds)
// Returns: { frames: [{ timestamp, image: base64 }], duration, width, height }
router.post('/frames', async (req, res) => {
  const { videoUrl, interval = 1 } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

  const jobId = uuidv4();
  const videoPath = path.join(TEMP_DIR, `${jobId}-input.mp4`);
  const framesDir = path.join(TEMP_DIR, `${jobId}-frames`);

  try {
    fs.mkdirSync(framesDir, { recursive: true });

    // Download video
    await downloadFile(videoUrl, videoPath);

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
    fs.rmSync(videoPath, { force: true });
    fs.rmSync(framesDir, { recursive: true, force: true });
  }
});

// POST /extract/frame
// Extracts a single full-resolution frame at given timestamp
// Body: { videoUrl, timestamp: 2.5 }
// Returns: { image: base64, width, height }
router.post('/frame', async (req, res) => {
  const { videoUrl, timestamp = 0 } = req.body;
  if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });

  const jobId = uuidv4();
  const videoPath = path.join(TEMP_DIR, `${jobId}-input.mp4`);
  const framePath = path.join(TEMP_DIR, `${jobId}-frame.png`);

  try {
    // Download video
    await downloadFile(videoUrl, videoPath);

    // Get video info
    const info = await getVideoInfo(videoPath);
    const videoStream = info.streams.find(s => s.codec_type === 'video');

    // Extract single frame at full resolution
    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(timestamp)
        .outputOptions(['-frames:v', '1', '-q:v', '1'])
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
    fs.rmSync(videoPath, { force: true });
    fs.rmSync(framePath, { force: true });
  }
});

module.exports = router;
