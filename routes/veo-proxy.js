const express = require('express');
const router = express.Router();

// VEO Proxy - Routes VEO API requests through Railway (US-based)
// to avoid regional content restrictions

// POST /veo/generate - Submit a VEO video generation job
router.post('/generate', async (req, res) => {
  try {
    const { apiKey, prompt, imageBase64, imageMimeType, aspectRatio, model, personGeneration } = req.body;

    if (!apiKey) return res.status(400).json({ error: 'apiKey is required' });
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const veoModel = model || 'veo-2.0-generate-001';
    console.log(`[veo/generate] Using model: ${veoModel}`);
    console.log(`[veo/generate] Image provided: ${!!imageBase64}, size: ${imageBase64 ? imageBase64.length : 0} chars, mimeType: ${imageMimeType || 'image/png'}`);
    console.log(`[veo/generate] Prompt: ${prompt?.substring(0, 100)}`);
    const veoUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' + veoModel + ':predictLongRunning?key=' + apiKey;

    const parameters = {
      aspectRatio: aspectRatio || '9:16'
    };

    // VEO 3.x models don't support personGeneration parameter
    if (!veoModel.startsWith('veo-3')) {
      parameters.personGeneration = ['allow_adult', 'dont_allow'].includes(personGeneration) ? personGeneration : 'allow_adult';
    }

    const requestBody = {
      instances: [{
        prompt: prompt
      }],
      parameters
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
      console.error(`[veo/generate] VEO API error ${response.status}:`, JSON.stringify(data));
      return res.status(response.status).json({ error: data.error || data });
    }

    console.log(`[veo/generate] Success: ${data.name}`);
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
