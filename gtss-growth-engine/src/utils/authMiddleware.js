function authMiddleware(req, res, next) {
  if (req.path === '/login' || req.path.startsWith('/login/')) {
    return next();
  }

  if (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1') {
    req.session.authenticated = true;
    return next();
  }

  if (req.session && req.session.authenticated) {
    return next();
  }

  return res.redirect('/login');
}

module.exports = authMiddleware;
