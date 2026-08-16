// require('dotenv').config();

// const express = require('express');
// const mongoose = require('mongoose');
// const bodyParser = require('body-parser');
// const cors = require('cors');
// const { GoogleGenAI } = require('@google/genai');

// const Message = require('./models/Message');

// const app = express();

// // Gemini setup
// const ai = new GoogleGenAI({
//   apiKey: process.env.GEMINI_API_KEY
// });

// // Middleware
// app.use(cors());
// app.use(bodyParser.json());
// app.use(express.static('public'));
// app.set('view engine', 'ejs');

// // MongoDB connection
// mongoose.connect(process.env.MONGO_URI)
//   .then(() => console.log(' MongoDB Connected'))
//   .catch(err => console.log('DB Error:', err));

// // Home route
// app.get('/', (req, res) => {
//   res.render('index');
// });

// // Chat route
// // Chat route
// app.post('/chat', async (req, res) => {
//   try {
//     const userMsg = req.body.message || '';

//     if (!userMsg.trim()) {
//       return res.json({ reply: 'Please type something 🙂' });
//     }

//     // Updated model and structured system instruction
//     const response = await ai.models.generateContent({
//       model: 'gemini-3.5-flash',
//       contents: userMsg,
//       config: {
//         // systemInstruction: 'You are a professional teacher. Always give detailed explanations with headings and examples.',
//        systemInstruction: 'You are a guide teacher. Give answers exactly as the customer asks, in a simple and clear way.'
//       }
//     });

//     const reply = response.text || 'No response from Gemini';

//     // Save to MongoDB
//     await Message.create({
//       userMessage: userMsg,
//       botReply: reply,
//       image: ''
//     });

//     res.json({ reply });

//   } catch (error) {
//     console.error('❌ Gemini Error:', error);
//     res.json({ reply: 'Gemini API error' });
//   }
// });

// // Start server
// app.listen(3000, () => {
//   console.log(' Server running on http://localhost:3000');
// });











require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");

const Message = require("./models/Message");

const app = express();

// ================= GEMINI =================

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// ================= MIDDLEWARE =================

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

app.set("view engine", "ejs");

// ================= MONGODB =================

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => {
        console.log("MongoDB Connected");
    })
    .catch((error) => {
        console.error("MongoDB Error:", error.message);
    });

// ================= HOME =================

app.get("/", (req, res) => {
    res.render("index");
});

// ================= CHAT =================

app.post("/chat", async (req, res) => {
    try {
        const userMsg = req.body.message || "";

        if (!userMsg.trim()) {
            return res.json({
                reply: "Please type something 🙂"
            });
        }

        console.log("User:", userMsg);

        const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: userMsg,
            config: {
                systemInstruction:
                    "You are a guide teacher. Give answers exactly as the customer asks, in a simple and clear way."
            }
        });

        const reply = response.text || "No response from Gemini";

        console.log("Bot:", reply);

        // Save chat in MongoDB
        try {
            await Message.create({
                userMessage: userMsg,
                botReply: reply,
                image: ""
            });

            console.log("Message saved to MongoDB");
        } catch (dbError) {
            console.error("MongoDB Save Error:", dbError.message);
        }

        res.json({
            reply: reply
        });

    } catch (error) {
        console.error("Gemini Error:", error);

        res.status(500).json({
            reply: error.message || "Gemini API error"
        });
    }
});

// ================= SERVER =================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});