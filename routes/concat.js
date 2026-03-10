const express = require('express');
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');
const multer = require('multer');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});

async function downloadFile(url, destPath, authHeader) {
  const headers = {};
  if (authHeader) headers['Authorization'] = authHeader;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(res.body, fileStream);
}

function getVideoInfo(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

// POST /concat
// Concatenates hook video (prepend) with original video
// Matches original video's codec, resolution, bitrate
// Accepts: JSON { hookVideoUrl, originalVideoUrl } OR multipart (fields: "hookVideo", "originalVideo")
// Optional: x-video-auth header forwarded when downloading URLs
// Returns: binary MP4 file
router.post('/', upload.fields([
  { name: 'hookVideo', maxCount: 1 },
  { name: 'originalVideo', maxCount: 1 }
]), async (req, res) => {
  const { hookVideoUrl, originalVideoUrl } = req.body;
  const files = req.files || {};
  const hasUploads = files.hookVideo && files.originalVideo;
  const hasUrls = hookVideoUrl && originalVideoUrl;

  if (!hasUploads && !hasUrls) {
    return res.status(400).json({ error: 'hookVideoUrl+originalVideoUrl or file uploads required' });
  }

  const jobId = uuidv4();
  const hookPath = path.join(TEMP_DIR, `${jobId}-hook.mp4`);
  const originalPath = path.join(TEMP_DIR, `${jobId}-original.mp4`);
  const hookNormalizedPath = path.join(TEMP_DIR, `${jobId}-hook-normalized.mp4`);
  const concatListPath = path.join(TEMP_DIR, `${jobId}-concat.txt`);
  const outputPath = path.join(TEMP_DIR, `${jobId}-output.mp4`);

  try {
    if (hasUploads) {
      fs.renameSync(files.hookVideo[0].path, hookPath);
      fs.renameSync(files.originalVideo[0].path, originalPath);
    } else {
      const authHeader = req.headers['x-video-auth'];
      await Promise.all([
        downloadFile(hookVideoUrl, hookPath, authHeader),
        downloadFile(originalVideoUrl, originalPath, authHeader)
      ]);
    }

    // Get original video info to match its properties
    const originalInfo = await getVideoInfo(originalPath);
    const videoStream = originalInfo.streams.find(s => s.codec_type === 'video');
    const audioStream = originalInfo.streams.find(s => s.codec_type === 'audio');

    const width = videoStream.width;
    const height = videoStream.height;
    const fps = videoStream.r_frame_rate; // e.g. "30/1"
    const bitrate = originalInfo.format.bit_rate;
    const pixFmt = videoStream.pix_fmt || 'yuv420p';

    // Re-encode hook video to match original's properties
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(hookPath)
        .outputOptions([
          `-vf`, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
          `-r`, fps,
          `-c:v`, `libx264`,
          `-pix_fmt`, pixFmt,
          `-b:v`, `${Math.round(parseInt(bitrate) * 0.9)}`,
          `-preset`, `medium`,
          `-movflags`, `+faststart`
        ]);

      // Handle audio: if hook has no audio, add silent audio track matching original
      if (audioStream) {
        cmd = cmd.outputOptions([
          `-c:a`, `aac`,
          `-b:a`, `${audioStream.bit_rate || '128000'}`,
          `-ar`, `${audioStream.sample_rate || '44100'}`,
          `-ac`, `${audioStream.channels || 2}`
        ]);
      }

      cmd
        .output(hookNormalizedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Also re-encode original to ensure matching format for concat
    const originalNormalizedPath = path.join(TEMP_DIR, `${jobId}-original-normalized.mp4`);
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(originalPath)
        .outputOptions([
          `-c:v`, `libx264`,
          `-pix_fmt`, pixFmt,
          `-b:v`, bitrate,
          `-r`, fps,
          `-preset`, `medium`,
          `-movflags`, `+faststart`
        ]);

      if (audioStream) {
        cmd = cmd.outputOptions([
          `-c:a`, `aac`,
          `-b:a`, `${audioStream.bit_rate || '128000'}`,
          `-ar`, `${audioStream.sample_rate || '44100'}`,
          `-ac`, `${audioStream.channels || 2}`
        ]);
      }

      cmd
        .output(originalNormalizedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Create concat file list
    fs.writeFileSync(concatListPath, [
      `file '${hookNormalizedPath}'`,
      `file '${originalNormalizedPath}'`
    ].join('\n'));

    // Concatenate using concat demuxer
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c', 'copy',
          '-movflags', '+faststart'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Get output file info
    const outputInfo = await getVideoInfo(outputPath);

    // Send as binary response
    const outputBuffer = fs.readFileSync(outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', outputBuffer.length);
    res.setHeader('X-Video-Duration', outputInfo.format.duration);
    res.setHeader('X-Video-Size', outputBuffer.length);
    res.send(outputBuffer);
  } catch (err) {
    console.error('Concat error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup all temp files
    for (const f of [hookPath, originalPath, hookNormalizedPath,
      path.join(TEMP_DIR, `${jobId}-original-normalized.mp4`),
      concatListPath, outputPath]) {
      fs.rmSync(f, { force: true });
    }
  }
});

// POST /concat/base64
// Concatenates hook video with original video using base64-encoded inputs
// Accepts: JSON { hookVideo: base64, originalVideo: base64 }
// Returns: JSON { video: base64, duration, size }
router.post('/base64', express.json({ limit: '200mb' }), async (req, res) => {
  const { hookVideo, originalVideo } = req.body;

  if (!hookVideo || !originalVideo) {
    return res.status(400).json({ error: 'hookVideo (base64) and originalVideo (base64) are required' });
  }

  const jobId = uuidv4();
  const hookPath = path.join(TEMP_DIR, `${jobId}-hook.mp4`);
  const originalPath = path.join(TEMP_DIR, `${jobId}-original.mp4`);
  const hookNormalizedPath = path.join(TEMP_DIR, `${jobId}-hook-normalized.mp4`);
  const originalNormalizedPath = path.join(TEMP_DIR, `${jobId}-original-normalized.mp4`);
  const concatListPath = path.join(TEMP_DIR, `${jobId}-concat.txt`);
  const outputPath = path.join(TEMP_DIR, `${jobId}-output.mp4`);

  try {
    // Write base64 videos to files
    fs.writeFileSync(hookPath, Buffer.from(hookVideo, 'base64'));
    fs.writeFileSync(originalPath, Buffer.from(originalVideo, 'base64'));

    console.log(`[concat/base64] Job ${jobId}: hook=${Buffer.from(hookVideo, 'base64').length} bytes, original=${Buffer.from(originalVideo, 'base64').length} bytes`);

    // Get original video info to match its properties
    const originalInfo = await getVideoInfo(originalPath);
    const videoStream = originalInfo.streams.find(s => s.codec_type === 'video');
    const audioStream = originalInfo.streams.find(s => s.codec_type === 'audio');

    const width = videoStream.width;
    const height = videoStream.height;
    const fps = videoStream.r_frame_rate;
    const bitrate = originalInfo.format.bit_rate;
    const pixFmt = videoStream.pix_fmt || 'yuv420p';

    // Re-encode hook video to match original's properties
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(hookPath)
        .outputOptions([
          `-vf`, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
          `-r`, fps,
          `-c:v`, `libx264`,
          `-pix_fmt`, pixFmt,
          `-b:v`, `${Math.round(parseInt(bitrate) * 0.9)}`,
          `-preset`, `fast`,
          `-movflags`, `+faststart`
        ]);

      if (audioStream) {
        cmd = cmd.outputOptions([
          `-c:a`, `aac`,
          `-b:a`, `${audioStream.bit_rate || '128000'}`,
          `-ar`, `${audioStream.sample_rate || '44100'}`,
          `-ac`, `${audioStream.channels || 2}`
        ]);
      }

      cmd.output(hookNormalizedPath).on('end', resolve).on('error', reject).run();
    });

    // Re-encode original to ensure matching format
    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(originalPath)
        .outputOptions([
          `-c:v`, `libx264`,
          `-pix_fmt`, pixFmt,
          `-b:v`, bitrate,
          `-r`, fps,
          `-preset`, `fast`,
          `-movflags`, `+faststart`
        ]);

      if (audioStream) {
        cmd = cmd.outputOptions([
          `-c:a`, `aac`,
          `-b:a`, `${audioStream.bit_rate || '128000'}`,
          `-ar`, `${audioStream.sample_rate || '44100'}`,
          `-ac`, `${audioStream.channels || 2}`
        ]);
      }

      cmd.output(originalNormalizedPath).on('end', resolve).on('error', reject).run();
    });

    // Create concat file list
    fs.writeFileSync(concatListPath, [
      `file '${hookNormalizedPath}'`,
      `file '${originalNormalizedPath}'`
    ].join('\n'));

    // Concatenate using concat demuxer
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const outputInfo = await getVideoInfo(outputPath);
    const outputBuffer = fs.readFileSync(outputPath);
    const outputBase64 = outputBuffer.toString('base64');

    console.log(`[concat/base64] Job ${jobId} complete: ${outputBuffer.length} bytes`);

    res.json({
      video: outputBase64,
      duration: parseFloat(outputInfo.format.duration),
      size: outputBuffer.length
    });
  } catch (err) {
    console.error('[concat/base64] Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    for (const f of [hookPath, originalPath, hookNormalizedPath, originalNormalizedPath, concatListPath, outputPath]) {
      fs.rmSync(f, { force: true });
    }
  }
});

module.exports = router;
