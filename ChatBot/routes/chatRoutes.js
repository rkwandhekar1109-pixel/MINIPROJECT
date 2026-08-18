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

  const candidateModels = [
    process.env.GEMINI_MODEL,
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.0-flash',
    'gemini-2.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro-latest'
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
        contents: contents,
        config: {
          systemInstruction: 'You are an intelligent, helpful, and friendly AI assistant. Provide clear, well-structured answers.'
        }
      });

      if (response && response.text) {
        return response.text;
      }
    } catch (sdkError) {
      console.warn(`@google/genai failed with model ${modelName}:`, sdkError.message);
    }
  }

  // Fallback to @google/generative-ai SDK
  for (const modelName of candidateModels) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });

      if (uploadedFile && fs.existsSync(uploadedFile.path)) {
        const fileBuffer = fs.readFileSync(uploadedFile.path);
        const imagePart = {
          inlineData: {
            data: Buffer.from(fileBuffer).toString('base64'),
            mimeType: uploadedFile.mimetype
          }
        };
        const result = await model.generateContent([promptText, imagePart]);
        const response = await result.response;
        return response.text();
      } else {
        const result = await model.generateContent(promptText);
        const response = await result.response;
        return response.text();
      }
    } catch (fallbackError) {
      console.warn(`@google/generative-ai failed with model ${modelName}:`, fallbackError.message);
    }
  }

  return '⚠️ Unable to connect to Gemini AI. Please verify your GEMINI_API_KEY and API quotas in Google AI Studio.';
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

    // Check if the user intends to generate an AI image via slash command
    if (userMsg.startsWith('/image ') || userMsg.startsWith('/generate ')) {
      const prompt = userMsg.replace(/^\/(image|generate)\s+/, '').trim();
      return handleImageGeneration(req, res, prompt, conversationId);
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
      console.error('Error saving user message to MongoDB:', dbErr);
    }

    // Call Gemini AI
    const geminiResponse = await callGeminiAI(userMsg, uploadedFile);

    // Save bot reply to MongoDB
    let botMessageDoc;
    try {
      botMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'bot',
        text: geminiResponse,
        imageUrl: '',
        isGeneratedImage: false
      });
    } catch (dbErr) {
      console.error('Error saving bot reply to MongoDB:', dbErr);
    }

    // Update conversation timestamp
    try {
      conversation.updatedAt = new Date();
      await conversation.save();
    } catch (dbErr) {
      console.error('Error updating conversation timestamp:', dbErr);
    }

    return res.json({
      success: true,
      reply: geminiResponse,
      conversationId: conversation._id,
      conversationTitle: conversation.title,
      userMessage: userMessageDoc,
      botMessage: botMessageDoc
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    return res.status(500).json({ error: error.message || 'Server error processing your message.' });
  }
});

// ==========================================
// 3. AI IMAGE GENERATION (DALL·E)
// ==========================================

async function handleImageGeneration(req, res, prompt, conversationId) {
  try {
    if (!prompt) {
      return res.status(400).json({ error: 'Please provide a prompt for image generation (e.g. /image a serene mountain lake at sunrise).' });
    }

    // Ensure conversation exists
    let conversation;
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.user._id });
    }

    if (!conversation) {
      conversation = await Conversation.create({
        userId: req.user._id,
        title: `Image: ${prompt.length > 25 ? prompt.substring(0, 25) + '...' : prompt}`
      });
      conversationId = conversation._id;
    } else if (conversation.title === 'New Chat') {
      conversation.title = `Image: ${prompt.length > 25 ? prompt.substring(0, 25) + '...' : prompt}`;
      await conversation.save();
    }

    // Save user prompt message
    let userMessageDoc;
    try {
      userMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'user',
        text: `/image ${prompt}`,
        imageUrl: ''
      });
    } catch (dbErr) {
      console.error('DB Error:', dbErr);
    }

    // Call OpenAI DALL-E
    let generatedImageUrl = '';
    let botReplyText = `Generated image for prompt: "${prompt}"`;

    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.trim() === '') {
      botReplyText = '⚠️ OPENAI_API_KEY is not configured in your server environment variables. Please add your OPENAI_API_KEY in your hosting dashboard (e.g. Render Settings > Environment) to generate images.';
    } else {
      try {
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

        if (response && response.data && response.data[0]) {
          generatedImageUrl = response.data[0].url;
        }
      } catch (openaiErr) {
        console.error('OpenAI Image Generation Error:', openaiErr);
        botReplyText = `⚠️ Image generation failed: ${openaiErr.message || 'OpenAI API error'}`;
      }
    }

    // Save bot message with generated image
    let botMessageDoc;
    try {
      botMessageDoc = await Message.create({
        conversationId: conversation._id,
        userId: req.user._id,
        sender: 'bot',
        text: botReplyText,
        imageUrl: generatedImageUrl,
        isGeneratedImage: !!generatedImageUrl
      });
    } catch (dbErr) {
      console.error('DB Error:', dbErr);
    }

    try {
      conversation.updatedAt = new Date();
      await conversation.save();
    } catch (dbErr) {
      console.error('DB Error:', dbErr);
    }

    return res.json({
      success: true,
      reply: botReplyText,
      generatedImageUrl: generatedImageUrl,
      isGeneratedImage: !!generatedImageUrl,
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

// POST /api/generate-image - Dedicated API route for image generation
router.post('/api/generate-image', async (req, res) => {
  const { prompt, conversationId } = req.body;
  return handleImageGeneration(req, res, prompt, conversationId);
});

module.exports = router;
