const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { requireAuthApi } = require('../middleware/auth');

const router = express.Router();

// Apply requireAuthApi to all routes in this router
router.use(requireAuthApi);

// Initialize Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || ''
});

// Helper for OpenAI
const getOpenAIClient = () => {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured in backend environment variables.');
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
};

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
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

// Helper to convert image file to inlineData for Gemini
function fileToGenerativePart(filePath, mimeType) {
  return {
    inlineData: {
      data: Buffer.from(fs.readFileSync(filePath)).toString('base64'),
      mimeType
    }
  };
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
    return res.status(500).json({ error: 'Failed to load chat history.' });
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
    return res.status(500).json({ error: 'Failed to create new chat session.' });
  }
});

// GET /api/conversations/:id/messages - Get all messages for a conversation
router.get('/api/conversations/:id/messages', async (req, res) => {
  try {
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
    return res.status(500).json({ error: 'Failed to load conversation messages.' });
  }
});

// DELETE /api/conversations/:id - Delete a conversation and all its messages
router.delete('/api/conversations/:id', async (req, res) => {
  try {
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
    return res.status(500).json({ error: 'Failed to delete conversation.' });
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
    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId: req.user._id });
    }

    if (!conversation) {
      // Auto generate title from first message
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
    const userMessageDoc = await Message.create({
      conversationId: conversation._id,
      userId: req.user._id,
      sender: 'user',
      text: userMsg,
      imageUrl: imageUrl
    });

    // Prepare contents for Gemini
    let geminiResponse;
    try {
      if (uploadedFile) {
        // Multimodal Vision Call
        const imagePart = fileToGenerativePart(uploadedFile.path, uploadedFile.mimetype);
        const promptText = userMsg || 'Please analyze this image in detail.';

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            promptText,
            imagePart
          ],
          config: {
            systemInstruction: 'You are an intelligent, helpful, and friendly AI assistant with strong vision capabilities. Provide clear, structured, and helpful responses.'
          }
        });
        geminiResponse = response.text || 'I analyzed the image, but could not generate a textual description.';
      } else {
        // Text-only Call
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: userMsg,
          config: {
            systemInstruction: 'You are a knowledgeable and friendly AI assistant. Give helpful, accurate, and concise answers with clear formatting.'
          }
        });
        geminiResponse = response.text || 'No response generated.';
      }
    } catch (apiError) {
      console.error('Gemini API Error:', apiError);
      geminiResponse = 'Sorry, there was an issue communicating with the AI service. Please check your API key or try again in a moment.';
    }

    // Save bot reply to MongoDB
    const botMessageDoc = await Message.create({
      conversationId: conversation._id,
      userId: req.user._id,
      sender: 'bot',
      text: geminiResponse,
      imageUrl: '',
      isGeneratedImage: false
    });

    // Update conversation timestamp
    conversation.updatedAt = Date.now();
    await conversation.save();

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
    return res.status(500).json({ error: 'Server error processing your message.' });
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
    if (conversationId) {
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
    const userMessageDoc = await Message.create({
      conversationId: conversation._id,
      userId: req.user._id,
      sender: 'user',
      text: `/image ${prompt}`,
      imageUrl: ''
    });

    // Call OpenAI DALL-E
    let generatedImageUrl = '';
    let botReplyText = `Generated image for prompt: "${prompt}"`;

    try {
      const openai = getOpenAIClient();
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

      generatedImageUrl = response.data[0].url;
    } catch (openaiErr) {
      console.error('OpenAI Image Generation Error:', openaiErr);
      botReplyText = `Image generation failed: ${openaiErr.message || 'OpenAI API error. Please verify your OPENAI_API_KEY.'}`;
    }

    // Save bot message with generated image
    const botMessageDoc = await Message.create({
      conversationId: conversation._id,
      userId: req.user._id,
      sender: 'bot',
      text: botReplyText,
      imageUrl: generatedImageUrl,
      isGeneratedImage: !!generatedImageUrl
    });

    conversation.updatedAt = Date.now();
    await conversation.save();

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
