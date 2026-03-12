const express = require('express');
const router = express.Router();

// POST /drive/create-folder — Create a subfolder in Google Drive
router.post('/create-folder', async (req, res) => {
  let { parentFolderId, folderName, driveAuth } = req.body;

  if (!parentFolderId || !folderName || !driveAuth) {
    return res.status(400).json({ error: 'parentFolderId, folderName, driveAuth are required' });
  }

  // Defensive: strip leading "=" from n8n expression values
  if (driveAuth.startsWith('=')) {
    driveAuth = driveAuth.substring(1);
  }
  if (folderName.startsWith('=')) {
    folderName = folderName.substring(1);
  }

  console.log(`[drive/create-folder] Creating folder "${folderName}" in parent ${parentFolderId}`);

  try {
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Authorization': driveAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId]
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error(`[drive/create-folder] Drive API error: ${createRes.status} ${errText.substring(0, 200)}`);
      throw new Error(`Drive folder creation failed: ${createRes.status} ${errText.substring(0, 200)}`);
    }

    const folder = await createRes.json();
    console.log(`[drive/create-folder] Created folder "${folderName}" → ${folder.id}`);

    res.json({
      success: true,
      folderId: folder.id,
      folderName
    });
  } catch (err) {
    console.error(`[drive/create-folder] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
