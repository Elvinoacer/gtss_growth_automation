const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');

const router = express.Router();
const pagesDir = path.join(__dirname, '..', '..', 'public', 'pages');

router.get('/login', (req, res) => {
  res.sendFile(path.join(pagesDir, 'login.html'));
});

router.post('/login', async (req, res, next) => {
  try {
    const passphrase = (req.body && req.body.passphrase) || '';
    const hash = process.env.PASSPHRASE_HASH || '';
    const matches = hash ? await bcrypt.compare(passphrase, hash) : false;

    if (!matches) {
      return res.redirect('/login?error=1');
    }

    req.session.authenticated = true;
    return res.redirect('/');
  } catch (error) {
    return next(error);
  }
});

function logout(req, res, next) {
  req.session.destroy((error) => {
    if (error) {
      return next(error);
    }

    res.clearCookie('connect.sid');
    return res.redirect('/login');
  });
}

router.post('/logout', logout);
router.get('/logout', logout);

module.exports = router;
