const express = require('express');
const router = express.Router();

// In-memory status store: Map<runId, { entries[], createdAt }>
const runs = new Map();

// POST /status/update — called by n8n (requires API key)
router.post('/update', (req, res) => {
  // Auth check (this route is mounted without global auth middleware)
  const API_KEY = process.env.API_KEY || 'dev-key';
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { runId, step, message, progress, data } = req.body;

  if (!runId || !step) {
    return res.status(400).json({ error: 'runId and step are required' });
  }

  if (!runs.has(runId)) {
    runs.set(runId, { entries: [], createdAt: Date.now() });
  }

  const entry = {
    step,
    message: message || step,
    timestamp: new Date().toISOString(),
    progress: progress || 0,
    ...(data ? { data } : {})
  };

  runs.get(runId).entries.push(entry);
  console.log(`[status/${runId}] ${step} (${progress}%) — ${message || ''}`);

  res.json({ success: true, entryCount: runs.get(runId).entries.length });
});

// GET /status/:runId — called by frontend (NO auth, public endpoint)
// runId is a UUID so it acts as an unguessable access token
router.get('/:runId', (req, res) => {
  const { runId } = req.params;
  const run = runs.get(runId);

  if (!run) {
    return res.json({
      runId,
      entries: [],
      latestProgress: 0,
      latestStep: null
    });
  }

  const lastEntry = run.entries[run.entries.length - 1];

  res.json({
    runId,
    entries: run.entries,
    latestProgress: lastEntry ? lastEntry.progress : 0,
    latestStep: lastEntry ? lastEntry.step : null
  });
});

// Auto-cleanup: delete entries older than 1 hour, every 5 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  let cleaned = 0;
  for (const [runId, run] of runs) {
    if (now - run.createdAt > maxAge) {
      runs.delete(runId);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[status] Cleaned up ${cleaned} expired run(s). Active: ${runs.size}`);
  }
}, 5 * 60 * 1000);

module.exports = router;
