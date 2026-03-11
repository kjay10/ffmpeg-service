const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const extractRoutes = require('./routes/extract');
const concatRoutes = require('./routes/concat');
const imageToVideoRoutes = require('./routes/image-to-video');
const veoProxyRoutes = require('./routes/veo-proxy');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'dev-key';
const TEMP_DIR = path.join(__dirname, 'tmp');

// Ensure tmp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));

// API key auth middleware
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: true, version: '2.4.0', routes: ['/extract', '/concat', '/image-to-video', '/veo'] });
});

// Echo back Authorization header (used by n8n to extract OAuth token)
app.get('/token-echo', authMiddleware, (req, res) => {
  res.json({ authorization: req.headers['authorization'] || '' });
});

// Protected routes
app.use('/extract', authMiddleware, extractRoutes);
app.use('/concat', authMiddleware, concatRoutes);
app.use('/image-to-video', authMiddleware, imageToVideoRoutes);
app.use('/veo', authMiddleware, veoProxyRoutes);

// Cleanup old temp files every 10 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 30 * 60 * 1000; // 30 minutes
  if (fs.existsSync(TEMP_DIR)) {
    for (const file of fs.readdirSync(TEMP_DIR)) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAge) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`FFmpeg service running on port ${PORT}`);
});
