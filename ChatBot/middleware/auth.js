const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'chatbot_jwt_secret_key_super_secure_2026';

// Middleware to protect API routes (returns 401 JSON)
const requireAuthApi = async (req, res, next) => {
  const token = req.cookies?.token || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.split(' ')[1] : null);

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      return res.status(401).json({ error: 'User account not found.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
};

// Middleware to protect Page routes (redirects to /login)
const requireAuthPage = async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      res.clearCookie('token');
      return res.redirect('/login');
    }
    req.user = user;
    res.locals.user = user;
    next();
  } catch (err) {
    res.clearCookie('token');
    return res.redirect('/login');
  }
};

// Middleware to redirect logged-in users away from /login or /signup
const redirectIfAuth = (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return next();

  try {
    jwt.verify(token, JWT_SECRET);
    return res.redirect('/');
  } catch (err) {
    res.clearCookie('token');
    next();
  }
};

module.exports = {
  JWT_SECRET,
  requireAuthApi,
  requireAuthPage,
  redirectIfAuth
};
