const express = require('express');
const router = express.Router();
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// POST /image-to-video
// Creates a video from a static image with optional zoom/pan effect
// Accepts: JSON { image: base64, mimeType, duration, width, height, effect }
// Returns: JSON { video: base64, duration, width, height }
router.post('/', async (req, res) => {
  const jobId = uuidv4();
  const { image, mimeType = 'image/png', duration = 5, width = 1280, height = 720, effect = 'zoom' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'image (base64) is required' });
  }

  // Determine file extension from mimeType
  const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg' : 'png';
  const imagePath = path.join(TEMP_DIR, `${jobId}-input.${ext}`);
  const outputPath = path.join(TEMP_DIR, `${jobId}-output.mp4`);

  try {
    // Write base64 image to file
    const imageBuffer = Buffer.from(image, 'base64');
    fs.writeFileSync(imagePath, imageBuffer);

    // Build FFmpeg filter based on effect type
    let filterComplex;
    const dur = Math.min(Math.max(duration, 1), 30); // 1-30 seconds

    switch (effect) {
      case 'zoom':
        // Slow zoom in (Ken Burns effect)
        filterComplex = `[0:v]scale=8000:-1,zoompan=z='min(zoom+0.002,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${dur * 25}:s=${width}x${height}:fps=25[v]`;
        break;
      case 'pan':
        // Slow pan from left to right
        filterComplex = `[0:v]scale=8000:-1,zoompan=z='1.1':x='if(eq(on,1),0,x+2)':y='ih/2-(ih/zoom/2)':d=${dur * 25}:s=${width}x${height}:fps=25[v]`;
        break;
      case 'none':
      default:
        // Static image, no movement
        filterComplex = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,loop=${dur * 25}:${dur * 25}:0,fps=25[v]`;
        break;
    }

    // Run FFmpeg to create video from image (using execFileSync to avoid shell escaping issues)
    const args = [
      '-y',
      '-loop', '1',
      '-i', imagePath,
      '-filter_complex', filterComplex,
      '-map', '[v]',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'fast',
      '-t', String(dur),
      '-movflags', '+faststart',
      outputPath
    ];

    console.log(`[image-to-video] Running: ffmpeg for job ${jobId}, effect=${effect}, duration=${dur}s`);
    execFileSync('ffmpeg', args, { timeout: 120000, stdio: 'pipe' });

    // Read output video
    const videoBuffer = fs.readFileSync(outputPath);
    const videoBase64 = videoBuffer.toString('base64');

    console.log(`[image-to-video] Job ${jobId} complete: ${videoBuffer.length} bytes`);

    res.json({
      video: videoBase64,
      duration: dur,
      width,
      height,
      effect,
      size: videoBuffer.length
    });
  } catch (err) {
    console.error('[image-to-video] Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Cleanup
    fs.rmSync(imagePath, { force: true });
    fs.rmSync(outputPath, { force: true });
  }
});

module.exports = router;
