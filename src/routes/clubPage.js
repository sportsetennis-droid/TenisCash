// /clube/:slug — página pública do clube permanente (HTML estático que lê /api/clubs/:slug)
const express = require('express');
const path = require('path');

const router = express.Router();
router.get('/:slug', (req, res) => {
  if (!/^[a-z0-9-]{1,80}$/.test(String(req.params.slug))) return res.status(404).send('Clube não encontrado');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../../public/clube.html'));
});

module.exports = router;
