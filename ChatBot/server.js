require('dotenv').config();
const dns = require('dns');

// Force IPv4 and configure reliable public DNS servers (Google & Cloudflare)
// to resolve MongoDB Atlas SRV records and prevent querySrv ECONNREFUSED on cloud providers like Render.
try {
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (dnsErr) {
  console.warn('⚠️ Could not configure custom DNS servers:', dnsErr.message);
}

const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/authRoutes');
const chatRoutes = require('./routes/chatRoutes');
const { requireAuthPage } = require('./middleware/auth');

const app = express();

// ================= MIDDLEWARE =================
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// View Engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ================= MONGODB =================
const rawMongoUri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
let mongoUri = rawMongoUri;

if (!mongoUri) {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ FATAL: MONGO_URI is not set in Render Environment Variables.');
  } else {
    mongoUri = 'mongodb://127.0.0.1:27017/chatbotDB';
    console.log('ℹ️ No MONGO_URI provided. Defaulting to local MongoDB for development.');
  }
}

// Mask sensitive credentials when logging
const maskedUri = mongoUri ? mongoUri.replace(/\/\/[^@]+@/, '//***:***@') : 'None';
console.log(`Connecting to MongoDB: ${maskedUri}`);

const mongooseOptions = {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 20000,
  family: 4
};

if (mongoUri) {
  mongoose.connect(mongoUri, mongooseOptions)
    .then(async () => {
      console.log('✅ MongoDB Connected');
      try {
        // Clean up legacy conflicting unique indexes (e.g. username_1) while preserving email_1 and mobileNumber_1
        const usersCollection = mongoose.connection.collection('users');
        const indexes = await usersCollection.indexes();
        for (const idx of indexes) {
          if (idx.name !== '_id_' && idx.name !== 'email_1' && idx.name !== 'mobileNumber_1' && idx.unique) {
            console.log(`🔧 Dropping legacy unique index: ${idx.name}`);
            await usersCollection.dropIndex(idx.name);
          }
        }
      } catch (idxErr) {
        // Collection may be new or clean
      }
    })
    .catch((err) => {
      console.error('❌ MongoDB Connection Error:', err.message);
      console.log('⚠️ Please ensure MongoDB Atlas IP Access List allows 0.0.0.0/0 and MONGO_URI is set correctly in Render.');
    });
}

// Database availability guard: do not process API auth requests if DB is disconnected
app.use('/api', (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      error: 'Database is currently connecting or unavailable. Please retry in a moment.'
    });
  }
  next();
});

// ================= ROUTES =================
// Auth routes (/login, /signup, /api/auth/*)
app.use(authRoutes);

// Protected Home route (renders chat app)
app.get('/', requireAuthPage, (req, res) => {
  res.render('index', { user: req.user });
});

// Chat & Conversation routes (/chat, /api/conversations/*, /api/generate-image)
app.use(chatRoutes);

// Global 404 Handler
app.use((req, res) => {
  if (req.accepts('html')) {
    return res.redirect('/');
  }
  return res.status(404).json({ error: 'Endpoint not found' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  return res.status(500).json({ error: err.message || 'Internal server error' });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});