require('dotenv').config();
const dns = require('dns');

// Force IPv4 DNS resolution for cloud servers (e.g. Render)
try {
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {}

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
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatbot';

const mongooseOptions = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 10000,
  family: 4
};

mongoose.connect(MONGO_URI, mongooseOptions)
  .then(async () => {
    console.log('✅ MongoDB Connected');
    try {
      // Clean up legacy non-email unique indexes on 'users' collection to ensure multi-user creation never collides
      const usersCollection = mongoose.connection.collection('users');
      const indexes = await usersCollection.indexes();
      for (const idx of indexes) {
        if (idx.name !== '_id_' && idx.name !== 'email_1' && idx.unique) {
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
    console.log('⚠️ Please ensure MongoDB is running or MONGO_URI is set in Render Environment.');
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
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});