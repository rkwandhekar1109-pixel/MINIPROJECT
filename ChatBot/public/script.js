let isTyping = false;
let selectedImage = null;

const input = document.getElementById("user-input");
const chatBox = document.getElementById("chat-box");
const sendBtn = document.getElementById("send-btn");

// SEND MESSAGE FUNCTION
function sendMessage() {
  const message = input.value.trim();
  if (!message || isTyping) return;

  // USER MESSAGE
  const userDiv = document.createElement("div");
  userDiv.className = "message user";
  userDiv.innerText = message;
  chatBox.appendChild(userDiv);

  input.value = "";

  // BOT LOADING
  const botDiv = document.createElement("div");
botDiv.className = "message bot";

botDiv.innerHTML = `
  <div class="jump-dots">
    <span></span>
    <span></span>
    <span></span>
  </div>
`;

chatBox.appendChild(botDiv);

chatBox.scrollTop = chatBox.scrollHeight;

getAIResponse(message, botDiv);
}

 

// AI CALL (YOUR BACKEND)
async function getAIResponse(message, botDiv) {
  isTyping = true;

  try {
    const res = await fetch("/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ message })
    });

    const data = await res.json();

    typeText(botDiv, data.reply || "No response");

  } catch (err) {
    botDiv.innerText = "Error";
  }

  isTyping = false;
}

// TYPING EFFECT
function typeText(element, text) {
  element.innerText = "";
  let i = 0;

  const interval = setInterval(() => {
    element.innerText += text[i];
    i++;

    if (i >= text.length) clearInterval(interval);
  }, 20);
}

// CLICK BUTTON
sendBtn.addEventListener("click", sendMessage);

// ENTER KEY (FIXED)
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendMessage();
  }
});


 