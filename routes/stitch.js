const express = require('express');
const router = express.Router();
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pipeline } = require('stream/promises');

const TEMP_DIR = path.join(__dirname, '..', 'tmp');

// ─── Status reporting helper ───────────────────────────
// If runId is provided, report progress to /status/update
async function reportStatus(runId, step, progress, message, data) {
  if (!runId) return;
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 3001}`;
    await fetch(`${baseUrl}/status/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.API_KEY || 'dev-key',
      },
      body: JSON.stringify({ runId, step, progress, message, data }),
    });
  } catch (err) {
    console.warn(`[stitch/status] Failed to report status: ${err.message}`);
  }
}

// ─── Helpers ───────────────────────────────────────────

async function downloadFile(url, destPath, authHeader) {
  const headers = {};
  if (authHeader) headers['Authorization'] = authHeader;

  // Unwrap VEO proxy URLs
  if (url.includes('/veo/download?url=')) {
    try {
      const parsedUrl = new URL(url);
      const actualUrl = parsedUrl.searchParams.get('url');
      if (actualUrl) { url = actualUrl; delete headers['Authorization']; }
    } catch (e) {}
  }

  if (url.includes('ffmpeg-service-production') || url.includes('localhost:3001')) {
    headers['x-api-key'] = process.env.API_KEY || 'dev-key';
  }

  console.log(`[stitch/download] ${url.substring(0, 120)}...`);
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    let body = ''; try { body = await res.text(); } catch(e) {}
    throw new Error(`Download ${res.status} for ${url.substring(0, 80)} - ${body.substring(0, 200)}`);
  }
  const fileStream = fs.createWriteStream(destPath);
  await pipeline(res.body, fileStream);
  const stat = fs.statSync(destPath);
  console.log(`[stitch/download] Saved ${stat.size} bytes`);
  if (stat.size === 0) throw new Error('Downloaded file is empty');
}

function getDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(parseFloat(metadata.format.duration) || 0);
    });
  });
}

function hasAudio(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      resolve(!!audioStream);
    });
  });
}

function runCmd(args) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    console.log(`[stitch/cmd] ffmpeg ${args.slice(-3).join(' ')}...`);
    execFile('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[stitch/cmd] FAILED: ${stderr.substring(stderr.length - 500)}`);
        return reject(new Error(`FFmpeg failed: ${stderr.substring(stderr.length - 300)}`));
      }
      resolve(true);
    });
  });
}

// ─── prep_clip: normalize a clip to 1080x1920 @ 30fps, h264+aac ───

async function prepClip(input, output, duration, forceSilence = false) {
  const inputHasAudio = await hasAudio(input);
  const needSilence = !inputHasAudio || forceSilence;

  const args = ['-y'];

  if (needSilence) {
    // Add silent audio source
    args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
    args.push('-i', input, '-t', String(duration));
    args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1');
    args.push('-c:v', 'libx264', '-preset', 'fast', '-r', '30', '-pix_fmt', 'yuv420p');
    args.push('-map', '1:v', '-map', '0:a', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-shortest');
  } else {
    args.push('-i', input, '-t', String(duration));
    args.push('-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1');
    args.push('-c:v', 'libx264', '-preset', 'fast', '-r', '30', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-ar', '44100', '-ac', '2');
  }

  args.push('-movflags', '+faststart', output);
  await runCmd(args);
}

// ─── crossfade_stitch: join 2 or 3 clips with video+audio crossfade ───

async function crossfadeStitch(parts, output, fade, maxTotal) {
  const n = parts.length;
  let cmd, filt;

  if (n === 2) {
    const d0 = await getDuration(parts[0]);
    const off1 = Math.max(d0 - fade, 0);
    filt = `[0:v][1:v]xfade=transition=fade:duration=${fade}:offset=${off1}[outv];` +
           `[0:a][1:a]acrossfade=d=${fade}:c1=tri:c2=tri[outa]`;
    cmd = [
      '-y', '-i', parts[0], '-i', parts[1],
      '-filter_complex', filt,
      '-map', '[outv]', '-map', '[outa]',
      '-t', String(maxTotal),
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
      '-movflags', '+faststart', '-shortest', output
    ];
  } else if (n === 3) {
    const d0 = await getDuration(parts[0]);
    const d1 = await getDuration(parts[1]);
    const off1 = Math.max(d0 - fade, 0);
    const off2 = Math.max(d0 + d1 - fade * 2, 0);
    filt = `[0:v][1:v]xfade=transition=fade:duration=${fade}:offset=${off1}[v01];` +
           `[v01][2:v]xfade=transition=fade:duration=${fade}:offset=${off2}[outv];` +
           `[0:a][1:a]acrossfade=d=${fade}:c1=tri:c2=tri[a01];` +
           `[a01][2:a]acrossfade=d=${fade}:c1=tri:c2=tri[outa]`;
    cmd = [
      '-y', '-i', parts[0], '-i', parts[1], '-i', parts[2],
      '-filter_complex', filt,
      '-map', '[outv]', '-map', '[outa]',
      '-t', String(maxTotal),
      '-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac',
      '-movflags', '+faststart', '-shortest', output
    ];
  } else {
    throw new Error(`crossfadeStitch: unsupported ${n} parts`);
  }

  await runCmd(cmd);
}

// ─── POST /stitch ───────────────────────────────────────
//
// Full video edit pipeline:
// 1. Download hook video + original video + packshot
// 2. Trim original from frameTimestamp (remove beginning)
// 3. Normalize all clips to 1080x1920 @ 30fps
// 4. Crossfade stitch: [hook] + [original from frame N] + [packshot]
// 5. Enforce max total duration (59.2s)
// 6. Upload to Google Drive (or return as stream)
//
// Body params:
//   hookVideoUrl     - VEO hook video URL
//   originalVideoUrl - Original video URL (Google Drive)
//   originalAuth     - Bearer token for original video
//   packshotUrl      - Packshot video URL (Google Drive or static)
//   packshotAuth     - Bearer token for packshot (optional)
//   frameTimestamp   - Seconds into original where hook frame was taken (frames before this are removed)
//   maxTotal         - Max total duration in seconds (default: 59.2)
//   packDur          - Packshot duration in seconds (default: 3)
//   fadeDur          - Crossfade duration in seconds (default: 1.5)
//   driveFolderId    - If provided, upload result to Google Drive
//   driveAuth        - Bearer token for Drive upload
//   fileName         - Output file name

router.post('/', express.json({ limit: '10mb' }), async (req, res) => {
  const {
    hookVideoUrl, originalVideoUrl, originalAuth,
    packshotUrl, packshotAuth,
    frameTimestamp: rawFrameTimestamp = 0,
    maxTotal: rawMaxTotal = 59.2,
    packDur: rawPackDur = 3,
    fadeDur: rawFadeDur = 1.5,
    driveFolderId, driveAuth, fileName,
    runId
  } = req.body;

  const frameTimestamp = parseFloat(rawFrameTimestamp) || 0;
  const maxTotal = parseFloat(rawMaxTotal) || 59.2;
  const packDur = parseFloat(rawPackDur) || 3;
  const fadeDur = parseFloat(rawFadeDur) || 1.5;

  if (!hookVideoUrl || !originalVideoUrl) {
    return res.status(400).json({ error: 'hookVideoUrl and originalVideoUrl required' });
  }

  const jobId = uuidv4();
  const hookRaw = path.join(TEMP_DIR, `${jobId}-hook-raw.mp4`);
  const origRaw = path.join(TEMP_DIR, `${jobId}-orig-raw.mp4`);
  const origTrimmed = path.join(TEMP_DIR, `${jobId}-orig-trimmed.mp4`);
  const packRaw = path.join(TEMP_DIR, `${jobId}-pack-raw.mp4`);
  const hookPrepped = path.join(TEMP_DIR, `${jobId}-hook-prep.mp4`);
  const origPrepped = path.join(TEMP_DIR, `${jobId}-orig-prep.mp4`);
  const packPrepped = path.join(TEMP_DIR, `${jobId}-pack-prep.mp4`);
  const outputPath = path.join(TEMP_DIR, `${jobId}-output.mp4`);
  const allTempFiles = [hookRaw, origRaw, origTrimmed, packRaw, hookPrepped, origPrepped, packPrepped, outputPath];

  let stage = 'init';

  try {
    // ── Stage 1: Download all videos ──
    stage = 'download';
    await reportStatus(runId, 'download', 10, 'Downloading videos...');
    const sharedAuth = req.headers['x-video-auth'];
    const requestAuth = req.headers['authorization'];

    const downloads = [
      downloadFile(hookVideoUrl, hookRaw),
      downloadFile(originalVideoUrl, origRaw, originalAuth || requestAuth || sharedAuth)
    ];
    if (packshotUrl) {
      downloads.push(downloadFile(packshotUrl, packRaw, packshotAuth || requestAuth || sharedAuth));
    }
    await Promise.all(downloads);

    // ── Stage 2: Trim original from frameTimestamp ──
    stage = 'trim-original';
    await reportStatus(runId, 'trim', 25, 'Trimming original video...');
    const origDuration = await getDuration(origRaw);
    const trimStart = parseFloat(frameTimestamp) || 0;

    if (trimStart > 0 && trimStart < origDuration) {
      // Trim: remove everything before frameTimestamp
      await runCmd([
        '-y', '-ss', String(trimStart), '-i', origRaw,
        '-c', 'copy', '-movflags', '+faststart', origTrimmed
      ]);
      console.log(`[stitch] Trimmed original: removed first ${trimStart}s`);
    } else {
      // No trim needed, use as-is
      fs.copyFileSync(origRaw, origTrimmed);
    }

    // ── Stage 3: Calculate durations ──
    stage = 'calculate';
    const hookDuration = await getDuration(hookRaw);
    const trimmedOrigDuration = await getDuration(origTrimmed);
    const usePackshot = !!packshotUrl && fs.existsSync(packRaw);
    const effectivePackDur = usePackshot ? packDur : 0;

    // How much time is available for the original?
    const origMaxDur = Math.max(maxTotal - hookDuration - effectivePackDur, 1);
    const origUseDur = Math.min(trimmedOrigDuration, origMaxDur);

    console.log(`[stitch] Durations: hook=${hookDuration.toFixed(1)}s, orig=${origUseDur.toFixed(1)}s (of ${trimmedOrigDuration.toFixed(1)}s), pack=${effectivePackDur}s, total=${(hookDuration + origUseDur + effectivePackDur).toFixed(1)}s`);

    // ── Stage 4: Normalize all clips to 1080x1920 @ 30fps ──
    stage = 'prep-hook';
    await reportStatus(runId, 'normalize', 40, 'Normalizing clips...');
    await prepClip(hookRaw, hookPrepped, hookDuration);

    stage = 'prep-original';
    await prepClip(origTrimmed, origPrepped, origUseDur);

    const parts = [hookPrepped, origPrepped];

    if (usePackshot) {
      stage = 'prep-packshot';
      await prepClip(packRaw, packPrepped, effectivePackDur);
      parts.push(packPrepped);
    }

    // ── Stage 5: Crossfade stitch ──
    stage = 'crossfade';
    await reportStatus(runId, 'stitch', 60, 'Stitching with crossfade...');
    await crossfadeStitch(parts, outputPath, fadeDur, maxTotal);

    const finalDuration = await getDuration(outputPath);
    const finalSize = fs.statSync(outputPath).size;
    console.log(`[stitch] Final: ${finalSize} bytes, ${finalDuration.toFixed(1)}s`);

    // ── Stage 6: Upload to Drive or return ──
    stage = 'deliver';
    if (driveFolderId && driveAuth) {
      stage = 'drive-upload';
      await reportStatus(runId, 'upload', 80, 'Uploading to Google Drive...');
      const uploadFileName = fileName || 'hooked-output.mp4';

      const initRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        {
          method: 'POST',
          headers: { 'Authorization': driveAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: uploadFileName, parents: [driveFolderId], mimeType: 'video/mp4' })
        }
      );
      if (!initRes.ok) {
        const errText = await initRes.text();
        throw new Error(`Drive init failed: ${initRes.status} ${errText.substring(0, 200)}`);
      }

      const uploadUrl = initRes.headers.get('location');
      if (!uploadUrl) throw new Error('No upload URL from Drive');

      const fileBuffer = fs.readFileSync(outputPath);
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': finalSize.toString() },
        body: fileBuffer
      });
      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Drive upload failed: ${uploadRes.status} ${errText.substring(0, 200)}`);
      }

      const driveFile = await uploadRes.json();
      console.log(`[stitch] Uploaded to Drive: ${driveFile.id}`);
      await reportStatus(runId, 'done', 100, 'Video ready!', { driveFileId: driveFile.id, fileName: uploadFileName });

      res.json({
        success: true,
        driveFileId: driveFile.id,
        fileName: uploadFileName,
        fileSize: finalSize,
        duration: finalDuration.toFixed(1),
        hookDuration: hookDuration.toFixed(1),
        originalDuration: origUseDur.toFixed(1),
        packshotDuration: effectivePackDur
      });
    } else {
      // Stream video back
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', finalSize);
      res.setHeader('X-Video-Duration', finalDuration.toFixed(1));
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(outputPath);
        readStream.pipe(res);
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });
    }
  } catch (err) {
    console.error(`[stitch] FAILED at stage=${stage}:`, err.message);
    await reportStatus(runId, 'error', 0, `Failed at ${stage}: ${err.message}`);
    res.status(500).json({ error: err.message, stage });
  } finally {
    for (const f of allTempFiles) {
      fs.rmSync(f, { force: true });
    }
  }
});

module.exports = router;
