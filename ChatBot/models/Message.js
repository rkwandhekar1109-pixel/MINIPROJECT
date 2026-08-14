const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  userMessage: String,
  botReply: String,
  image: String
});

module.exports = mongoose.model("Message", messageSchema);


 