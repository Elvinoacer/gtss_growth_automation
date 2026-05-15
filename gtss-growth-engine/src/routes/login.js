const path = require('path');
const express = require('express');
const { verifyPassphrase } = require('../services/authService');

const router = express.Router();
const pagesDir = path.join(__dirname, '..', '..', 'public', 'pages');

router.get('/', (req, res) => {
  res.sendFile(path.join(pagesDir, 'login.html'));
});

router.post('/', (req, res) => {
  if (!verifyPassphrase(req.body.passphrase || '')) {
    return res.status(401).sendFile(path.join(pagesDir, 'login-error.html'));
  }

  req.session.authenticated = true;
  return res.redirect('/');
});

module.exports = router;
