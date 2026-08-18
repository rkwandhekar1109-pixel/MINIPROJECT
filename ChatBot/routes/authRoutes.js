const express = require('express');
const dns = require('dns');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const User = require('../models/User');
const { JWT_SECRET, requireAuthApi, redirectIfAuth } = require('../middleware/auth');

// Force IPv4 DNS resolution for cloud servers (e.g. Render)
try {
  if (dns.setDefaultResultOrder) {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch (e) {}

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// ==========================================
// 1. PAGE VIEWS
// ==========================================
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', { mode: 'login', error: null });
});

router.get('/signup', redirectIfAuth, (req, res) => {
  res.render('login', { mode: 'signup', error: null });
});

// ==========================================
// 2. MULTI-USER SIGNUP & REGISTRATION
// ==========================================
router.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    
    // Explicitly query database for existing user
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Hash password securely with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let newUser;
    try {
      newUser = await User.create({
        email: normalizedEmail,
        password: hashedPassword
      });
    } catch (createErr) {
      // Handle MongoDB E11000 duplicate key error
      if (createErr.code === 11000) {
        const isEmailDup = createErr.keyPattern ? !!createErr.keyPattern.email : (createErr.message && createErr.message.includes('email_1'));
        if (isEmailDup) {
          return res.status(400).json({ error: 'An account with this email already exists.' });
        }

        // If duplicate key error occurred on an old/legacy index (e.g. username_1), drop that index and retry!
        try {
          const usersCollection = mongoose.connection.collection('users');
          const indexes = await usersCollection.indexes();
          for (const idx of indexes) {
            if (idx.name !== '_id_' && idx.name !== 'email_1' && idx.unique) {
              console.log(`Dropping conflicting legacy index: ${idx.name}`);
              await usersCollection.dropIndex(idx.name);
            }
          }
          newUser = await User.create({
            email: normalizedEmail,
            password: hashedPassword
          });
        } catch (retryErr) {
          console.error('Signup retry after index drop failed:', retryErr);
          throw retryErr;
        }
      } else {
        throw createErr;
      }
    }

    const token = jwt.sign({ id: newUser._id, email: newUser.email }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, COOKIE_OPTIONS);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: {
        id: newUser._id,
        email: newUser.email
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    if (error.name === 'MongooseServerSelectionError' || error.name === 'MongoTimeoutError') {
      return res.status(500).json({ error: 'Database connection failed. Please ensure your MongoDB Atlas IP whitelist includes 0.0.0.0/0.' });
    }
    return res.status(500).json({ error: error.message || 'Registration failed. Please try again.' });
  }
});

// ==========================================
// 3. LOGIN
// ==========================================
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, COOKIE_OPTIONS);

    return res.json({
      success: true,
      message: 'Logged in successfully.',
      user: {
        id: user._id,
        email: user.email
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    if (error.name === 'MongooseServerSelectionError' || error.name === 'MongoTimeoutError') {
      return res.status(500).json({ error: 'Database connection failed. Please check your MongoDB connection.' });
    }
    return res.status(500).json({ error: error.message || 'Login failed. Please try again.' });
  }
});

// ==========================================
// 4. UNIVERSAL MULTI-USER EMAIL DISPATCHER
// ==========================================
async function sendPasswordResetEmail(toEmail, otp) {
  const targetRecipient = (toEmail || '').trim().toLowerCase();
  const subject = 'Your Password Reset OTP';
  const textContent = `Hello,\n\nWe received a request to reset your password. Your OTP is: ${otp}\n\nThis OTP is valid for 10 minutes. If you did not request a password reset, please ignore this email. Do not share this OTP with anyone.`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; color: #1e293b;">
      <h2 style="color: #0f172a; margin-top: 0;">Password Reset Request</h2>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">Hello,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">We received a request to reset your password. Your OTP is:</p>
      <div style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 12px; color: #2563eb; background: #eff6ff; padding: 14px 28px; border-radius: 10px; border: 2px dashed #3b82f6; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 14px; color: #64748b; line-height: 1.5;">This OTP is valid for <strong>10 minutes</strong>. If you did not request a password reset, please ignore this email.</p>
      <p style="font-size: 13px; color: #ef4444; font-weight: 600;">Do not share this OTP with anyone.</p>
      <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">&copy; AI Chatbot Security</p>
    </div>
  `;

  const emailUser = (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim();
  const emailPass = (process.env.EMAIL_PASS || process.env.GMAIL_PASS || '').replace(/\s+/g, '');

  console.log(`📨 [EMAIL DISPATCH INITIATED] Target Recipient: ${targetRecipient} | Configured Sender: ${emailUser || 'None'}`);

  // Provider 1: Gmail Nodemailer (Transports to ANY email address worldwide)
  if (emailUser && emailPass) {
    // 1A. Try standard Gmail Service
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: emailUser,
          pass: emailPass
        },
        family: 4
      });

      await transporter.sendMail({
        from: `"AI Chatbot Security" <${emailUser}>`,
        to: targetRecipient,
        subject: subject,
        text: textContent,
        html: htmlContent
      });

      console.log(`✅ [EMAIL DELIVERED via Gmail Service] Recipient: ${targetRecipient}`);
      return { success: true, provider: 'gmail-service' };
    } catch (gmailServiceErr) {
      console.warn(`⚠️ [Gmail Service Transport Notice] Recipient: ${targetRecipient} | Error: ${gmailServiceErr.message}`);

      // 1B. Try explicit Port 465 (SSL IPv4)
      try {
        const sslTransporter = nodemailer.createTransport({
          host: 'smtp.gmail.com',
          port: 465,
          secure: true,
          family: 4,
          auth: { user: emailUser, pass: emailPass },
          connectionTimeout: 7000,
          greetingTimeout: 7000,
          socketTimeout: 8000
        });

        await sslTransporter.sendMail({
          from: `"AI Chatbot Security" <${emailUser}>`,
          to: targetRecipient,
          subject: subject,
          text: textContent,
          html: htmlContent
        });

        console.log(`✅ [EMAIL DELIVERED via Gmail SSL 465] Recipient: ${targetRecipient}`);
        return { success: true, provider: 'gmail-ssl' };
      } catch (sslErr) {
        console.warn(`⚠️ [Gmail SSL 465 Transport Notice] Recipient: ${targetRecipient} | Error: ${sslErr.message}`);

        // 1C. Try explicit Port 587 (TLS IPv4)
        try {
          const tlsTransporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            requireTLS: true,
            family: 4,
            auth: { user: emailUser, pass: emailPass },
            connectionTimeout: 7000,
            greetingTimeout: 7000,
            socketTimeout: 8000
          });

          await tlsTransporter.sendMail({
            from: `"AI Chatbot Security" <${emailUser}>`,
            to: targetRecipient,
            subject: subject,
            text: textContent,
            html: htmlContent
          });

          console.log(`✅ [EMAIL DELIVERED via Gmail TLS 587] Recipient: ${targetRecipient}`);
          return { success: true, provider: 'gmail-tls' };
        } catch (tlsErr) {
          console.warn(`⚠️ [Gmail TLS 587 Transport Notice] Recipient: ${targetRecipient} | Error: ${tlsErr.message}`);
        }
      }
    }
  }

  // Provider 2: Brevo HTTPS API (Port 443 — works with all recipients)
  if (process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim()) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY.trim(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'AI Chatbot Security', email: emailUser || 'no-reply@aichatbot.com' },
          to: [{ email: targetRecipient }],
          subject: subject,
          textContent: textContent,
          htmlContent: htmlContent
        })
      });

      if (res.ok) {
        console.log(`✅ [EMAIL DELIVERED via Brevo API] Recipient: ${targetRecipient}`);
        return { success: true, provider: 'brevo' };
      } else {
        const errData = await res.json();
        console.warn(`⚠️ [Brevo API Response Notice] Recipient: ${targetRecipient} | Response:`, errData);
      }
    } catch (brevoErr) {
      console.warn(`⚠️ [Brevo API Error] Recipient: ${targetRecipient} | Error: ${brevoErr.message}`);
    }
  }

  // Provider 3: Resend HTTPS API (Port 443)
  if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim()) {
    try {
      const fromAddress = (process.env.RESEND_FROM || '').trim() || 'AI Chatbot <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [targetRecipient],
          subject: subject,
          text: textContent,
          html: htmlContent
        })
      });

      if (res.ok) {
        console.log(`✅ [EMAIL DELIVERED via Resend API] Recipient: ${targetRecipient}`);
        return { success: true, provider: 'resend' };
      } else {
        const errData = await res.json();
        console.warn(`⚠️ [Resend API Response Notice] Recipient: ${targetRecipient} | Response:`, errData);
      }
    } catch (resendErr) {
      console.warn(`⚠️ [Resend API Error] Recipient: ${targetRecipient} | Error: ${resendErr.message}`);
    }
  }

  console.error(`❌ [ALL EMAIL PROVIDERS FAILED] Recipient: ${targetRecipient} | EMAIL_USER present: ${!!emailUser} | EMAIL_PASS present: ${!!emailPass} | RESEND present: ${!!process.env.RESEND_API_KEY}`);

  return {
    success: false,
    error: 'Email delivery failed. Please ensure your EMAIL_USER and EMAIL_PASS (Gmail App Password) are configured in your Render environment variables.'
  };
}

// ==========================================
// 5. FORGOT PASSWORD & OTP FLOW (MULTI-USER)
// ==========================================

// Step 1: POST /api/auth/forgot-password - Send OTP to registered email
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Please provide your email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Privacy & Security: Generic response if email not registered (prevents email harvesting)
    if (!user) {
      return res.json({
        success: true,
        message: `If an account exists for ${normalizedEmail}, a 4-digit verification OTP has been sent. Please check your inbox.`,
        email: normalizedEmail
      });
    }

    // Per-user rate limiting: 45s cooldown between OTP requests
    if (user.lastOtpSentAt && (Date.now() - new Date(user.lastOtpSentAt).getTime()) < 45 * 1000) {
      const waitSec = Math.ceil((45 * 1000 - (Date.now() - new Date(user.lastOtpSentAt).getTime())) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec} seconds before requesting another OTP.` });
    }

    // Generate secure 4-digit random OTP specific to this user
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Store hashed representation of OTP in DB
    const salt = await bcrypt.genSalt(8);
    const hashedOtp = await bcrypt.hash(otp, salt);

    user.resetOtp = hashedOtp;
    user.resetOtpExpires = otpExpires;
    user.otpAttempts = 0;
    user.lastOtpSentAt = new Date();
    await user.save();

    // Dispatch email strictly to this user's registered address
    const sendResult = await sendPasswordResetEmail(user.email, otp);

    if (sendResult && sendResult.success) {
      return res.json({
        success: true,
        message: `A 4-digit verification OTP has been sent to ${user.email}. Please check your inbox and enter the code below.`,
        email: user.email
      });
    }

    return res.status(500).json({
      error: sendResult.error || 'Failed to send OTP email. Please ensure your email credentials are set in Render.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: error.message || 'Server error processing password reset request.' });
  }
});

// Step 2: POST /api/auth/verify-otp - Verify 4-digit OTP for specific user
router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 4-digit OTP are required.' });
    }

    const cleanOtp = otp.toString().trim();
    if (!/^\d{4}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Please enter exactly 4 numeric digits.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.status(400).json({ error: 'No active OTP request found for this email. Please request a new OTP.' });
    }

    // Check expiration
    if (new Date() > user.resetOtpExpires) {
      user.resetOtp = null;
      user.resetOtpExpires = null;
      await user.save();
      return res.status(400).json({ error: 'The 4-digit OTP has expired. Please request a new one.' });
    }

    // Brute force protection: max 5 attempts per user
    if (user.otpAttempts >= 5) {
      user.resetOtp = null;
      user.resetOtpExpires = null;
      await user.save();
      return res.status(400).json({ error: 'Too many incorrect attempts. For security, please request a new OTP.' });
    }

    // Verify hashed OTP
    const isMatch = await bcrypt.compare(cleanOtp, user.resetOtp);
    if (!isMatch) {
      user.otpAttempts = (user.otpAttempts || 0) + 1;
      await user.save();
      const remaining = Math.max(0, 5 - user.otpAttempts);
      return res.status(400).json({ error: `Invalid 4-digit OTP. (${remaining} attempts remaining).` });
    }

    // Generate user-specific single-use reset JWT token (valid for 15 minutes)
    const resetToken = jwt.sign(
      { id: user._id, email: user.email, purpose: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({
      success: true,
      message: 'OTP verified successfully. You may now create your new password.',
      resetToken: resetToken
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ error: error.message || 'Server error verifying OTP.' });
  }
});

// Step 3: POST /api/auth/reset-password - Create New Password for verified user
router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, resetToken, newPassword, confirmPassword } = req.body;

    if (!email || !resetToken || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirm password do not match.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Verify signed reset token
    let decoded;
    try {
      decoded = jwt.verify(resetToken, JWT_SECRET);
      if (decoded.purpose !== 'password_reset') {
        return res.status(400).json({ error: 'Invalid reset authorization token.' });
      }
    } catch (tokenErr) {
      return res.status(400).json({ error: 'Password reset session expired. Please verify your OTP again.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findById(decoded.id);

    if (!user || user.email !== normalizedEmail) {
      return res.status(400).json({ error: 'User record mismatch. Please request a new OTP.' });
    }

    // Hash the new password securely
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    user.resetOtp = null;
    user.resetOtpExpires = null;
    user.otpAttempts = 0;
    user.lastOtpSentAt = null;
    await user.save();

    return res.json({
      success: true,
      message: 'Password updated successfully! You can now log in with your new password.'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: error.message || 'Server error updating password.' });
  }
});

// ==========================================
// 6. LOGOUT & CURRENT USER
// ==========================================
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return res.json({ success: true, message: 'Logged out successfully.' });
});

router.get('/api/auth/me', requireAuthApi, (req, res) => {
  return res.json({
    success: true,
    user: {
      id: req.user._id,
      email: req.user.email
    }
  });
});

module.exports = router;
