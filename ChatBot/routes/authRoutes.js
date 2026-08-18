const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const User = require('../models/User');
const { JWT_SECRET, requireAuthApi, redirectIfAuth } = require('../middleware/auth');

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

// Helper for Nodemailer transporter (supports SMTP / Gmail)
function getMailTransporter() {
  const emailUser = process.env.EMAIL_USER || process.env.GMAIL_USER;
  const emailPass = process.env.EMAIL_PASS || process.env.GMAIL_PASS;

  if (emailUser && emailPass) {
    return nodemailer.createTransport({
      service: process.env.EMAIL_SERVICE || 'gmail',
      auth: {
        user: emailUser,
        pass: emailPass
      }
    });
  }
  return null;
}

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
    return res.status(500).json({ error: 'Internal server error during registration.' });
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
    return res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// ==========================================
// FORGOT PASSWORD & OTP VERIFICATION FLOW
// ==========================================

// 1. POST /api/auth/forgot-password - Send 4-digit OTP
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Please provide your registered email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email address.' });
    }

    // Generate secure 4-digit numeric OTP (e.g. 1000 - 9999)
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    user.resetOtp = otp;
    user.resetOtpExpires = otpExpires;
    await user.save();

    // Try sending email if SMTP is configured
    const transporter = getMailTransporter();
    let emailSent = false;

    if (transporter) {
      try {
        await transporter.sendMail({
          from: `"AI Chatbot Security" <${process.env.EMAIL_USER || 'no-reply@aichatbot.com'}>`,
          to: user.email,
          subject: '🔐 Your 4-Digit Password Reset OTP',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; background: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
              <h2 style="color: #1e293b; margin-bottom: 8px;">Password Reset Request</h2>
              <p style="color: #64748b; font-size: 14px; line-height: 1.5;">You requested to reset your password for AI Chatbot. Use the 4-digit OTP below to proceed:</p>
              <div style="margin: 24px 0; text-align: center;">
                <span style="display: inline-block; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #2563eb; background: #eff6ff; padding: 12px 24px; border-radius: 8px; border: 2px dashed #3b82f6;">${otp}</span>
              </div>
              <p style="color: #94a3b8; font-size: 12px;">This OTP is valid for 10 minutes. If you did not request a password reset, please ignore this email.</p>
            </div>
          `
        });
        emailSent = true;
      } catch (mailErr) {
        console.warn('Could not send email via SMTP:', mailErr.message);
      }
    }

    return res.json({
      success: true,
      message: '4-digit OTP generated successfully!',
      otp: otp, // Displayed on screen for instant student verification
      email: user.email,
      emailSent: emailSent
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: 'Server error generating password reset OTP.' });
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
