const express = require('express');
const router = express.Router();

// VEO Proxy - Routes VEO API requests through Railway (US-based)
// to avoid regional content restrictions

// POST /veo/generate - Submit a VEO video generation job
router.post('/generate', async (req, res) => {
  try {
    const { apiKey, prompt, imageBase64, imageMimeType, aspectRatio } = req.body;

    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const veoUrl = 'https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning?key=' + apiKey;

    const requestBody = {
      instances: [{
        prompt: prompt
      }],
      parameters: {
        aspectRatio: aspectRatio || '16:9'
      }
    };

    // If image provided, add it for image-to-video
    if (imageBase64) {
      requestBody.instances[0].image = {
        bytesBase64Encoded: imageBase64,
        mimeType: imageMimeType || 'image/png'
      };
    }

    const response = await fetch(veoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || data });
    }

    res.json(data);
  } catch (err) {
    console.error('[veo/generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /veo/status - Check VEO job status
router.get('/status', async (req, res) => {
  try {
    const { operationName, apiKey } = req.query;

    if (!operationName || !apiKey) {
      return res.status(400).json({ error: 'operationName and apiKey query params required' });
    }

    const pollUrl = 'https://generativelanguage.googleapis.com/v1beta/' + operationName + '?key=' + apiKey;

    const response = await fetch(pollUrl);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || data });
    }

    res.json(data);
  } catch (err) {
    console.error('[veo/status] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /veo/download - Download VEO video (proxy to avoid region blocks)
router.get('/download', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) return res.status(400).json({ error: 'url query param required' });

    const response = await fetch(url, { redirect: 'follow' });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Download failed: ' + response.status });
    }

    // Stream the video back
    res.setHeader('Content-Type', response.headers.get('content-type') || 'video/mp4');
    const contentLength = response.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const { pipeline } = require('stream/promises');
    await pipeline(response.body, res);
  } catch (err) {
    console.error('[veo/download] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
