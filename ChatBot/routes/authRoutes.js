const express = require('express');
const dns = require('dns');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
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

// GET /login & GET /signup
router.get('/login', redirectIfAuth, (req, res) => {
  res.render('login', { mode: 'login', error: null });
});

router.get('/signup', redirectIfAuth, (req, res) => {
  res.render('login', { mode: 'signup', error: null });
});

// POST /api/auth/signup
router.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = await User.create({
      email: normalizedEmail,
      password: hashedPassword
    });

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
    if (error.code === 11000) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    if (error.name === 'MongooseServerSelectionError' || error.name === 'MongoTimeoutError') {
      return res.status(500).json({ error: 'Database connection failed. Please ensure your MongoDB Atlas IP whitelist includes 0.0.0.0/0 (Allow from anywhere).' });
    }
    return res.status(500).json({ error: error.message || 'Registration failed.' });
  }
});

// POST /api/auth/login
router.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
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
      return res.status(500).json({ error: 'Database connection failed. Please ensure your MongoDB Atlas IP whitelist includes 0.0.0.0/0 (Allow from anywhere).' });
    }
    return res.status(500).json({ error: error.message || 'Login failed.' });
  }
});

// ==========================================
// FORGOT PASSWORD & OTP VERIFICATION FLOW
// ==========================================

// Helper function to send email via HTTP APIs (Resend, Brevo) or Nodemailer SMTP
async function sendOtpEmail(toEmail, otp) {
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; color: #1e293b;">
      <div style="text-align: center; margin-bottom: 20px;">
        <h2 style="color: #0f172a; margin: 0;">Password Reset Verification</h2>
        <p style="color: #64748b; font-size: 14px; margin-top: 6px;">AI Chatbot Account Security</p>
      </div>
      <p style="font-size: 14px; line-height: 1.6; color: #334155;">Hello,</p>
      <p style="font-size: 14px; line-height: 1.6; color: #334155;">We received a request to reset your password. Use the following 4-digit OTP to verify your identity:</p>
      <div style="margin: 28px 0; text-align: center;">
        <span style="display: inline-block; font-size: 36px; font-weight: 800; letter-spacing: 12px; color: #2563eb; background: #eff6ff; padding: 14px 28px; border-radius: 10px; border: 2px dashed #3b82f6; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 13px; color: #64748b; line-height: 1.5;">This code will expire in <strong>10 minutes</strong>. If you did not make this request, you can safely ignore this email.</p>
      <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
      <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">&copy; AI Chatbot. All rights reserved.</p>
    </div>
  `;

  // 1. Resend HTTPS API (Port 443 - never blocked by cloud firewalls)
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'AI Chatbot <onboarding@resend.dev>',
          to: [toEmail],
          subject: '🔐 Your 4-Digit Password Reset OTP',
          html: htmlContent
        })
      });
      if (res.ok) return { success: true, provider: 'resend' };
    } catch (e) {
      console.warn('Resend API send error:', e.message);
    }
  }

  // 2. Brevo HTTPS API (Port 443)
  if (process.env.BREVO_API_KEY) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY.trim(),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: { name: 'AI Chatbot', email: process.env.EMAIL_USER || 'no-reply@aichatbot.com' },
          to: [{ email: toEmail }],
          subject: '🔐 Your 4-Digit Password Reset OTP',
          htmlContent: htmlContent
        })
      });
      if (res.ok) return { success: true, provider: 'brevo' };
    } catch (e) {
      console.warn('Brevo API send error:', e.message);
    }
  }

  // 3. Gmail SMTP / Custom SMTP (with fast 4-second timeout to avoid long hangs)
  const emailUser = (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim();
  const emailPass = (process.env.EMAIL_PASS || process.env.GMAIL_PASS || '').replace(/\s+/g, '');

  if (emailUser && emailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        family: 4,
        auth: { user: emailUser, pass: emailPass },
        connectionTimeout: 4000,
        greetingTimeout: 4000,
        socketTimeout: 5000
      });

      await transporter.sendMail({
        from: `"AI Chatbot Security" <${emailUser}>`,
        to: toEmail,
        subject: '🔐 Your 4-Digit Password Reset OTP',
        html: htmlContent
      });
      return { success: true, provider: 'gmail-smtp' };
    } catch (smtpErr) {
      console.warn('Gmail SMTP send failed (likely blocked outbound port on free cloud host):', smtpErr.message);
    }
  }

  return { success: false, error: 'SMTP outbound blocked or credentials not set' };
}

// 1. POST /api/auth/forgot-password - Send 4-digit OTP via Email
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Please provide your registered email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email address. Please register first.' });
    }

    // Generate secure 4-digit numeric OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    user.resetOtp = otp;
    user.resetOtpExpires = otpExpires;
    await user.save();

    // Try sending email
    const sendResult = await sendOtpEmail(user.email, otp);

    if (sendResult && sendResult.success) {
      return res.json({
        success: true,
        message: `A 4-digit verification OTP has been sent directly to ${user.email}. Please check your inbox and enter the code below.`,
        email: user.email
      });
    }

    return res.status(500).json({
      error: `Could not send email to ${user.email}. Render blocks raw SMTP ports. To enable instant live email sending on Render, please add a free RESEND_API_KEY (from resend.com) to your Render Environment variables.`
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: error.message || 'Server error generating password reset OTP.' });
  }
});

// 2. POST /api/auth/verify-otp - Verify 4-digit OTP
router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 4-digit OTP are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.status(400).json({ error: 'No active OTP request found. Please request a new OTP.' });
    }

    if (new Date() > user.resetOtpExpires) {
      return res.status(400).json({ error: 'The 4-digit OTP has expired. Please request a new one.' });
    }

    if (user.resetOtp.trim() !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid 4-digit OTP. Please check and try again.' });
    }

    return res.json({
      success: true,
      message: 'OTP verified successfully. You may now set your new password.'
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ error: 'Server error verifying OTP.' });
  }
});

// 3. POST /api/auth/reset-password - Create New Password & Confirm Password
router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword, confirmPassword } = req.body;

    if (!email || !otp || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirm password do not match.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.status(400).json({ error: 'No active password reset request found.' });
    }

    if (new Date() > user.resetOtpExpires) {
      return res.status(400).json({ error: 'The OTP has expired. Please request a new one.' });
    }

    if (user.resetOtp.trim() !== otp.trim()) {
      return res.status(400).json({ error: 'Invalid OTP code.' });
    }

    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    user.resetOtp = null;
    user.resetOtpExpires = null;
    await user.save();

    return res.json({
      success: true,
      message: 'Password reset successful! You can now log in with your new password.'
    });

  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Server error updating password.' });
  }
});

// POST /api/auth/logout
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  });
  return res.json({ success: true, message: 'Logged out successfully.' });
});

// GET /api/auth/me
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
