const express = require('express');
const dns = require('dns');
const crypto = require('crypto');
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
// VALIDATION & NORMALIZATION HELPERS
// ==========================================

/**
 * Validate and normalize Indian mobile number
 * Accepts formats: +91 9876543210, +91-98765-43210, 919876543210, 09876543210, 9876543210
 * Returns clean 10-digit number starting with 6-9, or null if invalid.
 */
function validateAndNormalizeIndianMobile(input) {
  if (!input || typeof input !== 'string') return null;
  let cleaned = input.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+91')) {
    cleaned = cleaned.substring(3);
  } else if (cleaned.startsWith('91') && cleaned.length === 12) {
    cleaned = cleaned.substring(2);
  } else if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = cleaned.substring(1);
  }
  if (/^[6-9]\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

/**
 * Auto-detect whether an entered string is an email address or mobile number
 */
function detectIdentifier(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.includes('@')) {
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (emailRegex.test(trimmed)) {
      return { type: 'email', value: trimmed.toLowerCase() };
    }
    return { type: 'invalid_email', value: trimmed };
  } else {
    const normalizedMobile = validateAndNormalizeIndianMobile(trimmed);
    if (normalizedMobile) {
      return { type: 'mobile', value: normalizedMobile };
    }
    return { type: 'invalid_mobile', value: trimmed };
  }
}

/**
 * Generate cryptographically secure random 6-digit OTP
 */
function generateSecure6DigitOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

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
    const { name, email, password, confirmPassword } = req.body;
    const mobileNumber = req.body.mobileNumber || req.body.mobile || req.body.phone || req.body.phoneNumber || req.body.mobile_number;

    // Required fields check
    if (!name || !email || !mobileNumber || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    const trimmedName = name.trim();
    if (trimmedName.length < 2) {
      return res.status(400).json({ error: 'Please enter your full name.' });
    }

    // Email format validation
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // Indian mobile number validation (+91 optional, 10-digit starting with 6-9)
    const normalizedMobile = validateAndNormalizeIndianMobile(mobileNumber);
    if (!normalizedMobile) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number (+91 optional).' });
    }

    // Password validation
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Prevent duplicate registration: check email
    const existingEmail = await User.findOne({ email: normalizedEmail });
    if (existingEmail) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Prevent duplicate registration: check mobile number
    const existingMobile = await User.findOne({ mobileNumber: normalizedMobile });
    if (existingMobile) {
      return res.status(400).json({ error: 'An account with this mobile number already exists.' });
    }

    // Hash password securely with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    let newUser;
    try {
      newUser = await User.create({
        name: trimmedName,
        email: normalizedEmail,
        mobileNumber: normalizedMobile,
        password: hashedPassword
      });
    } catch (createErr) {
      // Handle MongoDB E11000 duplicate key error
      if (createErr.code === 11000) {
        const isEmailDup = createErr.keyPattern?.email || (createErr.message && createErr.message.includes('email_1'));
        if (isEmailDup) {
          return res.status(400).json({ error: 'An account with this email already exists.' });
        }
        const isMobileDup = createErr.keyPattern?.mobileNumber || (createErr.message && createErr.message.includes('mobileNumber_1'));
        if (isMobileDup) {
          return res.status(400).json({ error: 'An account with this mobile number already exists.' });
        }

        // Drop conflicting legacy index (e.g. username_1) while preserving email_1 and mobileNumber_1
        try {
          const usersCollection = mongoose.connection.collection('users');
          const indexes = await usersCollection.indexes();
          for (const idx of indexes) {
            if (idx.name !== '_id_' && idx.name !== 'email_1' && idx.name !== 'mobileNumber_1' && idx.unique) {
              console.log(`Dropping conflicting legacy index: ${idx.name}`);
              await usersCollection.dropIndex(idx.name);
            }
          }
          newUser = await User.create({
            name: trimmedName,
            email: normalizedEmail,
            mobileNumber: normalizedMobile,
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

    const token = jwt.sign(
      { id: newUser._id, email: newUser.email, name: newUser.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('token', token, COOKIE_OPTIONS);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        mobileNumber: newUser.mobileNumber
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ error: messages.join(', ') });
    }
    if (error.name === 'MongooseServerSelectionError' || error.name === 'MongoTimeoutError') {
      return res.status(500).json({ error: 'Database connection failed. Please ensure MongoDB is running.' });
    }
    return res.status(500).json({ error: error.message || 'Registration failed. Please try again.' });
  }
});

// ==========================================
// 3. LOGIN – EMAIL OR MOBILE NUMBER
// ==========================================
router.post('/api/auth/login', async (req, res) => {
  try {
    const rawIdentifier = req.body.identifier || req.body.email || req.body.mobileNumber;
    const { password } = req.body;

    if (!rawIdentifier || !password) {
      return res.status(400).json({ error: 'Email or mobile number and password are required.' });
    }

    const detected = detectIdentifier(rawIdentifier);
    if (!detected || detected.type === 'invalid_email' || detected.type === 'invalid_mobile') {
      return res.status(400).json({ error: 'Please enter a valid email address or 10-digit mobile number.' });
    }

    let user;
    if (detected.type === 'email') {
      user = await User.findOne({ email: detected.value });
    } else if (detected.type === 'mobile') {
      user = await User.findOne({ mobileNumber: detected.value });
    }

    if (!user) {
      return res.status(401).json({ error: 'No account found with this email or mobile number.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.cookie('token', token, COOKIE_OPTIONS);

    return res.json({
      success: true,
      message: 'Logged in successfully.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        mobileNumber: user.mobileNumber
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
// 4. FAST, UNIVERSAL EMAIL DISPATCHER (MULTI-PROVIDER)
// ==========================================
async function sendPasswordResetEmail(toEmail, otp) {
  const targetRecipient = (toEmail || '').trim().toLowerCase();
  const subject = 'Your Password Reset OTP';
  const textContent = `Hello,\n\nWe received a request to reset your password. Your password reset OTP is: ${otp}\n\nThis OTP is valid for 10 minutes. If you did not request a password reset, please ignore this email.\n\nDo not share this OTP with anyone.`;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 28px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; color: #1e293b;">
      <h2 style="color: #0f172a; margin-top: 0;">Password Reset Request</h2>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">Hello,</p>
      <p style="font-size: 15px; line-height: 1.6; color: #334155;">We received a request to reset your password. Your 6-digit OTP is:</p>
      <div style="margin: 24px 0; text-align: center;">
        <span style="display: inline-block; font-size: 34px; font-weight: 800; letter-spacing: 10px; color: #2563eb; background: #eff6ff; padding: 14px 28px; border-radius: 10px; border: 2px dashed #3b82f6; font-family: monospace;">${otp}</span>
      </div>
      <p style="font-size: 14px; color: #64748b; line-height: 1.5;">This OTP is valid for <strong>10 minutes</strong>. If you did not request a password reset, please ignore this email.</p>
      <p style="font-size: 13px; color: #ef4444; font-weight: 600;">Do not share this OTP with anyone.</p>
      <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">&copy; AI Chatbot Security</p>
    </div>
  `;

  const emailService = (process.env.EMAIL_SERVICE || 'gmail').trim().toLowerCase();
  const emailUser = (process.env.EMAIL_USER || process.env.GMAIL_USER || '').trim();
  const emailPass = (process.env.EMAIL_PASSWORD || process.env.EMAIL_PASS || process.env.GMAIL_PASS || '').replace(/\s+/g, '');
  const emailFrom = (process.env.EMAIL_FROM || emailUser).trim();

  console.log(`📨 [EMAIL DISPATCH INITIATED] Target: ${targetRecipient} | Sender: ${emailUser || 'None'}`);

  const executeDispatch = async () => {
    let lastErrorMsg = '';

    // 1. Primary Provider: Gmail SMTP via Nodemailer
    if (emailUser && emailPass) {
      try {
        const gmailTransporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: emailUser,
            pass: emailPass
          },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 12000
        });

        await gmailTransporter.sendMail({
          from: `"AI Chatbot Security" <${emailFrom || emailUser}>`,
          to: targetRecipient,
          subject: subject,
          text: textContent,
          html: htmlContent
        });

        console.log(`✅ [EMAIL DELIVERED via Gmail SMTP] Recipient: ${targetRecipient}`);
        return { success: true, provider: 'gmail' };
      } catch (gmailErr) {
        console.warn(`⚠️ [Gmail SMTP Error]:`, gmailErr.message);
        if (gmailErr.message && (gmailErr.message.includes('535') || gmailErr.message.includes('BadCredentials') || gmailErr.message.includes('Username and Password not accepted'))) {
          lastErrorMsg = 'Gmail authentication failed (535 BadCredentials). Please verify that EMAIL_USER is your Gmail address and EMAIL_PASSWORD is an active 16-character Google App Password (not your regular Gmail password). Ensure 2-Step Verification is turned ON in Google Account security.';
        } else if (gmailErr.code === 'ETIMEDOUT' || gmailErr.code === 'ECONNREFUSED' || (gmailErr.message && gmailErr.message.includes('timeout'))) {
          lastErrorMsg = 'Outbound connection to Gmail SMTP timed out. Render blocks outbound SMTP ports (465, 587) on free plans. Configure a free BREVO_API_KEY (Port 443) in Render to bypass port restrictions.';
        } else {
          lastErrorMsg = `Gmail SMTP error: ${gmailErr.message}`;
        }
      }
    }

    // 2. Fallback: Brevo HTTPS API (Port 443 — useful when cloud host blocks SMTP ports)
    if (process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim()) {
      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': process.env.BREVO_API_KEY.trim(),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: 'AI Chatbot Security', email: emailFrom || emailUser || 'no-reply@aichatbot.com' },
            to: [{ email: targetRecipient }],
            subject: subject,
            textContent: textContent,
            htmlContent: htmlContent
          }),
          signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
          console.log(`✅ [EMAIL DELIVERED via Brevo API] Recipient: ${targetRecipient}`);
          return { success: true, provider: 'brevo' };
        } else {
          const errData = await res.json();
          console.warn(`⚠️ [Brevo API Notice]`, errData);
          lastErrorMsg = errData.message || 'Brevo API error';
        }
      } catch (brevoErr) {
        console.warn(`⚠️ [Brevo API Error]:`, brevoErr.message);
        lastErrorMsg = brevoErr.message;
      }
    }

    // 3. Fallback: Resend HTTPS API (Port 443)
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
          }),
          signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
          console.log(`✅ [EMAIL DELIVERED via Resend API] Recipient: ${targetRecipient}`);
          return { success: true, provider: 'resend' };
        } else {
          const errData = await res.json();
          lastErrorMsg = errData.message || 'Resend API error';
        }
      } catch (resendErr) {
        lastErrorMsg = resendErr.message;
      }
    }

    return {
      success: false,
      error: lastErrorMsg || 'Email delivery failed. Please configure EMAIL_USER and EMAIL_PASSWORD (16-character Gmail App Password) in environment variables.'
    };
  };

  // Enforce 14-second total timeout
  try {
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: false,
          error: 'Email delivery timed out. Please verify your email configuration in Render (or configure BREVO_API_KEY to send via HTTPS Port 443).'
        });
      }, 14000);
    });

    return await Promise.race([executeDispatch(), timeoutPromise]);
  } catch (err) {
    console.error('Email dispatch exception:', err.message);
    return {
      success: false,
      error: 'Email service error: ' + err.message
    };
  }
}

// ==========================================
// 5. FORGOT PASSWORD & 6-DIGIT OTP FLOW
// ==========================================

// Step 1: POST /api/auth/forgot-password – Send 6-Digit OTP to registered email
router.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Please enter your registered email address.' });
    }

    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Validate email exists in database
    if (!user) {
      return res.status(404).json({ error: 'No account found with this email address.' });
    }

    // Rate limiting: 45s cooldown between OTP requests
    if (user.lastOtpSentAt && (Date.now() - new Date(user.lastOtpSentAt).getTime()) < 45 * 1000) {
      const waitSec = Math.ceil((45 * 1000 - (Date.now() - new Date(user.lastOtpSentAt).getTime())) / 1000);
      return res.status(429).json({ error: `Please wait ${waitSec} seconds before requesting another OTP.` });
    }

    // Generate secure 6-digit random OTP
    const otp = generateSecure6DigitOtp();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Store hashed OTP in DB using User.updateOne (never invokes document validation)
    const salt = await bcrypt.genSalt(10);
    const hashedOtp = await bcrypt.hash(otp, salt);

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetOtp: hashedOtp,
          resetOtpExpires: otpExpires,
          otpAttempts: 0,
          lastOtpSentAt: new Date(),
          resetPasswordToken: null,
          resetPasswordTokenExpires: null
        }
      }
    );

    // Dispatch email
    const sendResult = await sendPasswordResetEmail(user.email, otp);

    if (sendResult && sendResult.success) {
      return res.json({
        success: true,
        message: 'OTP has been sent to your registered email address.',
        email: user.email
      });
    }

    return res.status(500).json({
      error: sendResult.error || 'Failed to send OTP email. Please check your email credentials on Render.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: error.message || 'Server error processing password reset request.' });
  }
});

// Step 2: POST /api/auth/verify-otp – Verify 6-digit OTP for specific user
router.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit OTP are required.' });
    }

    const cleanOtp = otp.toString().trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      return res.status(400).json({ error: 'Please enter a valid 6-digit numeric OTP.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.status(400).json({ error: 'No active OTP request found for this email. Please request a new OTP.' });
    }

    // Check expiration
    if (new Date() > user.resetOtpExpires) {
      await User.updateOne(
        { _id: user._id },
        { $set: { resetOtp: null, resetOtpExpires: null } }
      );
      return res.status(400).json({ error: 'OTP has expired. Please request a new OTP.' });
    }

    // Brute force protection: max 5 attempts per user
    if (user.otpAttempts >= 5) {
      await User.updateOne(
        { _id: user._id },
        { $set: { resetOtp: null, resetOtpExpires: null } }
      );
      return res.status(400).json({ error: 'Too many incorrect attempts. For security, please request a new OTP.' });
    }

    // Verify hashed OTP
    const isMatch = await bcrypt.compare(cleanOtp, user.resetOtp);
    if (!isMatch) {
      const attempts = (user.otpAttempts || 0) + 1;
      await User.updateOne(
        { _id: user._id },
        { $set: { otpAttempts: attempts } }
      );
      const remaining = Math.max(0, 5 - attempts);
      return res.status(400).json({ error: `Invalid OTP. Please try again. (${remaining} attempts remaining)` });
    }

    // Single-use: immediately invalidate OTP and generate cryptographic reset token
    const rawSessionToken = crypto.randomBytes(32).toString('hex');
    const hashedSessionToken = await bcrypt.hash(rawSessionToken, 10);
    const tokenExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          resetOtp: null,
          resetOtpExpires: null,
          otpAttempts: 0,
          resetPasswordToken: hashedSessionToken,
          resetPasswordTokenExpires: tokenExpires
        }
      }
    );

    // Generate signed JWT reset token
    const resetToken = jwt.sign(
      { id: user._id, email: user.email, sessionToken: rawSessionToken, purpose: 'password_reset' },
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

// Step 3: POST /api/auth/reset-password – Create New Password for verified user
router.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, resetToken, newPassword, confirmPassword } = req.body;

    if (!email || !resetToken || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
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

    if (!user.resetPasswordToken || !user.resetPasswordTokenExpires) {
      return res.status(400).json({ error: 'Invalid or already used reset session. Please request a new OTP.' });
    }

    if (new Date() > user.resetPasswordTokenExpires) {
      await User.updateOne(
        { _id: user._id },
        { $set: { resetPasswordToken: null, resetPasswordTokenExpires: null } }
      );
      return res.status(400).json({ error: 'Password reset session expired. Please request a new OTP.' });
    }

    const isSessionValid = await bcrypt.compare(decoded.sessionToken, user.resetPasswordToken);
    if (!isSessionValid) {
      return res.status(400).json({ error: 'Invalid or already used reset session. Please request a new OTP.' });
    }

    // Hash the new password securely
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Invalidate old password and all reset tokens using User.updateOne
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          password: hashedPassword,
          resetPasswordToken: null,
          resetPasswordTokenExpires: null,
          resetOtp: null,
          resetOtpExpires: null,
          otpAttempts: 0,
          lastOtpSentAt: null
        }
      }
    );

    return res.json({
      success: true,
      message: 'Password reset successfully. You can now login with your new password.'
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
      name: req.user.name,
      email: req.user.email,
      mobileNumber: req.user.mobileNumber
    }
  });
});

module.exports = router;
