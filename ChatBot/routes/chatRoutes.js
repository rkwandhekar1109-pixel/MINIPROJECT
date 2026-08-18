const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { requireAuthApi } = require('../middleware/auth');

const router = express.Router();

// Apply requireAuthApi to all routes in this router
router.use(requireAuthApi);

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (e) {
    console.warn('Could not create uploads directory:', e.message);
  }
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowedTypes.includes(file.mimetype.toLowerCase())) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported format. Only JPG, PNG, WEBP, and GIF images are allowed. (Max 5MB)'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: fileFilter
});

// Helper for Gemini AI Completion
async function callGeminiAI(userMsg, uploadedFile) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '') {
    return '⚠️ GEMINI_API_KEY is not configured in your server environment variables. Please add your GEMINI_API_KEY in your hosting dashboard (e.g. Render Settings > Environment).';
  }

  const promptText = userMsg || 'Please analyze this image.';
  let lastError = null;

  const candidateModels = [
    process.env.GEMINI_MODEL,
    'gemini-3.6-flash',
    'gemini-3.6-pro',
    'gemini-3.7-flash',
    'gemini-3.5-flash',
    'gemini-3.0-flash'
  ].filter(Boolean);

  // Try using @google/genai SDK first
  for (const modelName of candidateModels) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      
      let contents;
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        const fileBuffer = fs.readFileSync(uploadedFile.path);
        const base64Data = Buffer.from(fileBuffer).toString('base64');
        contents = [
          { text: promptText },
          {
            inlineData: {
              mimeType: uploadedFile.mimetype,
              data: base64Data
            }
          }
        ];
      } else {
        contents = promptText;
      }

      const response = await ai.models.generateContent({
        model: modelName,
        contents: contents
      });

      if (response && response.text) {
        return response.text;
      }
    } catch (sdkError) {
      console.warn(`@google/genai failed with model ${modelName}:`, sdkError.message);
      lastError = sdkError;
    }
  }

  // Fallback to @google/generative-ai SDK
  for (const modelName of candidateModels) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });

      let result;
      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        const fileBuffer = fs.readFileSync(uploadedFile.path);
        const imagePart = {
          inlineData: {
            data: Buffer.from(fileBuffer).toString('base64'),
            mimeType: uploadedFile.mimetype
          }
        };
        result = await model.generateContent([promptText, imagePart]);
      } else {
        result = await model.generateContent(promptText);
      }

      const response = await result.response;
      const text = response.text();
      if (text) {
        return text;
      }
    } catch (altError) {
      console.warn(`@google/generative-ai failed with model ${modelName}:`, altError.message);
      lastError = altError;
    }
  }

  return `⚠️ Unable to connect to Gemini AI (${lastError ? lastError.message : 'Model error'}). Please verify your GEMINI_API_KEY in Render.`;
}

// ==========================================
// NATURAL LANGUAGE IMAGE PROMPT DETECTOR
// ==========================================
function extractImagePrompt(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // 1. Explicit slash commands: /image, /generate, /draw, /img
  if (/^\/(image|generate|draw|img)\s+/i.test(trimmed)) {
    return trimmed.replace(/^\/(image|generate|draw|img)\s+/i, '').trim();
  }

  // 2. Natural language image request patterns
  const patterns = [
    /^(?:please\s+)?(?:can\s+you\s+)?(?:create|generate|draw|make|paint|render|produce|design)\s+(?:an?\s+)?(?:image|picture|photo|illustration|drawing|artwork|art|graphic|wallpaper)\s+(?:of|about|for|showing|depicting|with)?\s*(.+)$/i,
    /^(?:show\s+me|give\s+me)\s+(?:an?\s+)?(?:image|picture|photo|illustration|drawing|artwork)\s+(?:of|about|showing|depicting)?\s*(.+)$/i,
    /^(?:i\s+want\s+(?:an?\s+)?(?:image|picture|photo|drawing|illustration)\s+(?:of|about|showing)?\s*)(.+)$/i
  ];

  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1] && match[1].trim().length > 1) {
      return match[1].trim();
    }
  }

  return null;
}

// ==========================================
// AI IMAGE GENERATOR (OpenAI DALL-E & Fast AI Engine)
// ==========================================
async function generateAIImage(prompt) {
  // Strategy 1: OpenAI DALL-E (if OPENAI_API_KEY is configured)
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim() !== '') {
    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
      let response;
      try {
        response = await openai.images.generate({
          model: 'dall-e-3',
          prompt: prompt,
          n: 1,
          size: '1024x1024',
          quality: 'standard'
        });
      } catch (dalle3Err) {
        console.warn('DALL-E 3 error, falling back to DALL-E 2:', dalle3Err.message);
        response = await openai.images.generate({
          model: 'dall-e-2',
          prompt: prompt,
          n: 1,
          size: '512x512'
        });
      }

      if (response && response.data && response.data[0] && response.data[0].url) {
        // Download and cache image locally to avoid expiring temporary URLs
        try {
          const imgFetch = await fetch(response.data[0].url);
          if (imgFetch.ok) {
            const buffer = Buffer.from(await imgFetch.arrayBuffer());
            const filename = `dalle-${Date.now()}-${Math.round(Math.random() * 1e6)}.png`;
            const localFilePath = path.join(uploadsDir, filename);
            fs.writeFileSync(localFilePath, buffer);
            return {
              imageUrl: `/uploads/${filename}`,
              provider: 'DALL·E 3'
            };
          }
        } catch (downloadErr) {
          console.warn('Could not save DALL-E image locally, using remote URL:', downloadErr.message);
          return {
            imageUrl: response.data[0].url,
            provider: 'DALL·E 3'
          };
        }
      }
    } catch (openaiErr) {
      console.warn('OpenAI Image Generation Error, falling back to AI engine:', openaiErr.message);
    }
  }

  // Strategy 2: High-Definition AI Engine (Pollinations / Stable Diffusion HD)
  try {
    const seed = Math.floor(Math.random() * 1e9);
    const encodedPrompt = encodeURIComponent(prompt);
    const remoteUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&nologo=true&seed=${seed}&model=flux`;

    const imgRes = await fetch(remoteUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (imgRes.ok) {
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const filename = `ai-art-${Date.now()}-${Math.round(Math.random() * 1e6)}.jpg`;
      const localFilePath = path.join(uploadsDir, filename);
      fs.writeFileSync(localFilePath, buffer);
      return {
        imageUrl: `/uploads/${filename}`,
        provider: 'AI Vision Engine'
      };
    }
  } catch (hdErr) {
    console.warn('High-Def AI generator fetch error, using direct stream URL:', hdErr.message);
    const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
    return {
      imageUrl: fallbackUrl,
      provider: 'AI Vision Engine'
    };
  }

  throw new Error('All image generation services are currently unavailable. Please try again in a few moments.');
}

// ==========================================
// 1. CONVERSATIONS MANAGEMENT
// ==========================================

// GET /api/conversations - List all conversations for the user
router.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.user._id })
      .sort({ updatedAt: -1 })
      .lean();

    return res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error fetching conversations:', error);
    return res.status(500).json({ error: 'Failed to load chat history: ' + error.message });
  }
});

// POST /api/conversations - Create a new conversation session
router.post('/api/conversations', async (req, res) => {
  try {
    const conversation = await Conversation.create({
      userId: req.user._id,
      title: req.body.title || 'New Chat'
    });

    return res.status(201).json({ success: true, conversation });
  } catch (error) {
    console.error('Error creating conversation:', error);
    return res.status(500).json({ error: 'Failed to create new chat session: ' + error.message });
  }
});

// GET /api/conversations/:id/messages - Get all messages for a conversation
router.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }

    const conversation = await Conversation.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    const messages = await Message.find({
      conversationId: conversation._id,
      userId: req.user._id
    }).sort({ createdAt: 1 }).lean();

    return res.json({
      success: true,
      conversation,
      messages
    });
  } catch (error) {
    console.error('Error fetching conversation messages:', error);
    return res.status(500).json({ error: 'Failed to load conversation messages: ' + error.message });
  }
});

// DELETE /api/conversations/:id - Delete a conversation and all its messages
router.delete('/api/conversations/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid conversation ID.' });
    }

    const conversation = await Conversation.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found.' });
    }

    // Delete associated messages
    await Message.deleteMany({
      conversationId: req.params.id,
      userId: req.user._id
    });

    return res.json({ success: true, message: 'Conversation deleted.' });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    return res.status(500).json({ error: 'Failed to delete conversation: ' + error.message });
  }
});

// ==========================================
// 2. CHAT & VISION COMPLETION
// ==========================================

// Handle Image Generation Execution
async function handleImageGeneration(req, res, prompt, conversationId, originalText) {
  try {
    const cleanPrompt = (prompt || '').trim();
    if (!cleanPrompt) {
      return res.status(400).json({ error: 'Please provide a description for the image you want to generate.' });
    }

    // Ensure conversation exists
    let conversation;
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.user._id });
    }

    if (!conversation) {
      conversation = await Conversation.create({
        userId: req.user._id,
        title: `Image: ${cleanPrompt.length > 25 ? cleanPrompt.substring(0, 25) + '...' : cleanPrompt}`
      });
      conversationId = conversation._id;
    } else if (conversation.title === 'New Chat') {
      conversation.title = `Image: ${cleanPrompt.length > 25 ? cleanPrompt.substring(0, 25) + '...' : cleanPrompt}`;
      await conversation.save();
    }

    // Save user prompt message
    let userMessageDoc;
    try {
      userMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'user',
        text: originalText || cleanPrompt,
        imageUrl: ''
      });
    } catch (dbErr) {
      console.error('DB Error user message:', dbErr);
    }

    // Generate the image
    let generatedData;
    try {
      generatedData = await generateAIImage(cleanPrompt);
    } catch (genErr) {
      console.error('Image generation error:', genErr);
      return res.status(500).json({ error: 'Failed to generate image: ' + genErr.message });
    }

    const botReplyText = `Here is your generated image for: "${cleanPrompt}"`;

    // Save bot message with generated image
    let botMessageDoc;
    try {
      botMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'bot',
        text: botReplyText,
        imageUrl: generatedData.imageUrl,
        isGeneratedImage: true
      });
    } catch (dbErr) {
      console.error('DB Error bot message:', dbErr);
    }

    try {
      conversation.updatedAt = new Date();
      await conversation.save();
    } catch (dbErr) {
      console.error('DB Error update conversation:', dbErr);
    }

    return res.json({
      success: true,
      reply: botReplyText,
      imageUrl: generatedData.imageUrl,
      generatedImageUrl: generatedData.imageUrl,
      isGeneratedImage: true,
      provider: generatedData.provider,
      conversationId: conversation._id,
      conversationTitle: conversation.title,
      userMessage: userMessageDoc,
      botMessage: botMessageDoc
    });

  } catch (err) {
    console.error('handleImageGeneration error:', err);
    return res.status(500).json({ error: err.message || 'Error generating image.' });
  }
}

// POST /chat - Send text and optional image to Gemini
router.post('/chat', (req, res, next) => {
  upload.single('image')(req, res, function (err) {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Image too large. Maximum size is 5MB.' });
      }
      return res.status(400).json({ error: err.message });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userMsg = (req.body.message || '').trim();
    let conversationId = req.body.conversationId;
    const uploadedFile = req.file;

    if (!userMsg && !uploadedFile) {
      return res.status(400).json({ error: 'Please provide a message or upload an image.' });
    }

    // Check if the user message is an image generation request (slash command or natural language)
    const detectedImagePrompt = !uploadedFile ? extractImagePrompt(userMsg) : null;
    if (detectedImagePrompt) {
      return handleImageGeneration(req, res, detectedImagePrompt, conversationId, userMsg);
    }

    // Ensure or create conversation
    let conversation;
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.user._id });
    }

    if (!conversation) {
      const initialTitle = userMsg
        ? (userMsg.length > 35 ? userMsg.substring(0, 35) + '...' : userMsg)
        : (uploadedFile ? 'Image Analysis' : 'New Chat');

      conversation = await Conversation.create({
        userId: req.user._id,
        title: initialTitle
      });
      conversationId = conversation._id;
    } else if (conversation.title === 'New Chat' && userMsg) {
      conversation.title = userMsg.length > 35 ? userMsg.substring(0, 35) + '...' : userMsg;
      await conversation.save();
    }

    const imageUrl = uploadedFile ? `/uploads/${uploadedFile.filename}` : '';

    // Save user message to MongoDB
    let userMessageDoc;
    try {
      userMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'user',
        text: userMsg,
        imageUrl: imageUrl
      });
    } catch (dbErr) {
      console.error('DB Error saving user message:', dbErr);
    }

    // Call Gemini AI
    const botReply = await callGeminiAI(userMsg, uploadedFile);

    // Save bot reply to MongoDB
    let botMessageDoc;
    try {
      botMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'bot',
        text: botReply,
        imageUrl: ''
      });
    } catch (dbErr) {
      console.error('DB Error saving bot message:', dbErr);
    }

    // Update conversation timestamp
    try {
      conversation.updatedAt = new Date();
      await conversation.save();
    } catch (dbErr) {
      console.error('DB Error updating conversation:', dbErr);
    }

    return res.json({
      success: true,
      reply: botReply,
      imageUrl: '',
      conversationId: conversation._id,
      conversationTitle: conversation.title,
      userMessage: userMessageDoc,
      botMessage: botMessageDoc
    });

  } catch (error) {
    console.error('Error in /chat endpoint:', error);
    return res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

// POST /api/generate-image - Dedicated API route for image generation
router.post('/api/generate-image', async (req, res) => {
  const { prompt, conversationId } = req.body;
  return handleImageGeneration(req, res, prompt, conversationId, `/image ${prompt}`);
});

module.exports = router;
