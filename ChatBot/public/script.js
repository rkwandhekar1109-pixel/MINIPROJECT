/**
 * AI Chatbot Frontend Application
 * Handles Conversations, Streaming/Vision Chat, DALL-E Image Generation, and Themes.
 */

// ==========================================
// STATE & VARIABLES
// ==========================================
let currentConversationId = null;
let conversationsList = [];
let selectedImageFile = null;
let isTyping = false;
let isImageGenMode = false;
let pendingDeleteId = null;

// DOM Elements
const chatBox = document.getElementById('chat-box');
const messagesContainer = document.getElementById('messages-container');
const emptyState = document.getElementById('empty-state');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const imageFileInput = document.getElementById('image-file-input');
const imagePreviewBar = document.getElementById('image-preview-bar');
const imagePreviewImg = document.getElementById('image-preview-img');
const previewFilename = document.getElementById('preview-filename');
const previewFilesize = document.getElementById('preview-filesize');
const imageModeBanner = document.getElementById('image-mode-banner');
const imageGenToolBtn = document.getElementById('image-gen-tool-btn');
const conversationsListEl = document.getElementById('conversations-list');
const currentChatTitleEl = document.getElementById('current-chat-title');
const deleteModal = document.getElementById('delete-modal');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebar-backdrop');
const toastContainer = document.getElementById('toast-container');

// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  lucide.createIcons();
  loadConversations();
  setupEventListeners();
});

function initTheme() {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcon(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('theme-icon-sidebar');
  if (icon) {
    icon.setAttribute('data-lucide', theme === 'dark' ? 'sun' : 'moon');
    lucide.createIcons();
  }
}

// ==========================================
// EVENT LISTENERS
// ==========================================
function setupEventListeners() {
  // Auto-resize textarea & enable/disable send button
  userInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateSendButtonState();

    // Check if user manually typed /image
    if (userInput.value.startsWith('/image ') && !isImageGenMode) {
      setImageGenModeUI(true);
    } else if (!userInput.value.startsWith('/image ') && isImageGenMode && !userInput.value.startsWith('/generate ')) {
      // do not auto-close if button clicked
    }
  });

  // Enter to send (Shift+Enter for newline)
  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) {
        chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    }
  });

  // Drag and Drop support
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  document.body.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0 && files[0].type.startsWith('image/')) {
      handleImageFile(files[0]);
    }
  });
}

function autoResizeTextarea() {
  userInput.style.height = 'auto';
  const newHeight = Math.min(userInput.scrollHeight, 160);
  userInput.style.height = `${newHeight}px`;
}

function updateSendButtonState() {
  const hasText = userInput.value.trim().length > 0;
  const hasImage = selectedImageFile !== null;
  sendBtn.disabled = (!hasText && !hasImage) || isTyping;
}

// ==========================================
// CONVERSATIONS MANAGEMENT
// ==========================================
async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json();
    if (data.success) {
      conversationsList = data.conversations;
      renderConversationsList();
    }
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

function renderConversationsList() {
  conversationsListEl.innerHTML = '';

  if (conversationsList.length === 0) {
    conversationsListEl.innerHTML = `
      <div style="padding: 12px; font-size: 12.5px; color: var(--text-muted); text-align: center;">
        No conversations yet.<br>Send a message to start!
      </div>
    `;
    return;
  }

  conversationsList.forEach((conv) => {
    const item = document.createElement('div');
    item.className = `conv-item ${conv._id === currentConversationId ? 'active' : ''}`;
    item.id = `conv-item-${conv._id}`;
    item.onclick = (e) => {
      if (!e.target.closest('.conv-delete-btn')) {
        selectConversation(conv._id);
      }
    };

    item.innerHTML = `
      <div class="conv-item-left">
        <i data-lucide="message-square" class="conv-icon"></i>
        <span class="conv-title">${escapeHtml(conv.title || 'New Chat')}</span>
      </div>
      <button class="conv-delete-btn" title="Delete conversation" onclick="openDeleteModal('${conv._id}', event)">
        <i data-lucide="trash-2"></i>
      </button>
    `;

    conversationsListEl.appendChild(item);
  });

  lucide.createIcons();
}

async function selectConversation(id) {
  if (isTyping) return;
  currentConversationId = id;
  renderConversationsList();

  // Close mobile sidebar
  closeMobileSidebar();

  // Clear messages container
  messagesContainer.innerHTML = '';
  emptyState.classList.add('hidden');

  try {
    const res = await fetch(`/api/conversations/${id}/messages`);
    const data = await res.json();

    if (data.success) {
      currentChatTitleEl.textContent = data.conversation.title || 'Chat';

      if (data.messages.length === 0) {
        emptyState.classList.remove('hidden');
      } else {
        emptyState.classList.add('hidden');
        data.messages.forEach((msg) => {
          appendMessageBubble(msg.sender, msg.text, {
            imageUrl: msg.imageUrl,
            isGeneratedImage: msg.isGeneratedImage
          });
        });
        scrollToBottom();
      }
    }
  } catch (err) {
    showToast('Failed to load messages for this conversation.');
  }
}

function startNewChat() {
  if (isTyping) return;
  currentConversationId = null;
  currentChatTitleEl.textContent = 'New Chat';
  messagesContainer.innerHTML = '';
  emptyState.classList.remove('hidden');
  clearSelectedImage();
  toggleImageGenMode(false);
  userInput.value = '';
  autoResizeTextarea();
  updateSendButtonState();
  renderConversationsList();
  closeMobileSidebar();
  userInput.focus();
}

// ==========================================
// DELETE CONVERSATION MODAL
// ==========================================
function openDeleteModal(id, e) {
  if (e) e.stopPropagation();
  pendingDeleteId = id;
  deleteModal.classList.remove('hidden');
  lucide.createIcons();
}

function closeDeleteModal() {
  pendingDeleteId = null;
  deleteModal.classList.add('hidden');
}

async function executeDeleteConversation() {
  if (!pendingDeleteId) return;
  const idToDelete = pendingDeleteId;
  closeDeleteModal();

  try {
    const res = await fetch(`/api/conversations/${idToDelete}`, {
      method: 'DELETE'
    });
    const data = await res.json();

    if (data.success) {
      conversationsList = conversationsList.filter((c) => c._id !== idToDelete);
      renderConversationsList();

      if (currentConversationId === idToDelete) {
        startNewChat();
      }
      showToast('Conversation deleted', 'success');
    } else {
      showToast(data.error || 'Failed to delete conversation');
    }
  } catch (err) {
    showToast('Network error while deleting conversation');
  }
}

// ==========================================
// IMAGE UPLOAD HANDLING
// ==========================================
function triggerImageUpload() {
  imageFileInput.click();
}

function handleImageSelection(e) {
  const file = e.target.files[0];
  if (file) {
    handleImageFile(file);
  }
  // Reset file input value so re-selecting same file triggers change
  imageFileInput.value = '';
}

function handleImageFile(file) {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type)) {
    showToast('Unsupported format. Please select a JPG, PNG, WEBP, or GIF image.');
    return;
  }

  const maxSize = 5 * 1024 * 1024; // 5MB
  if (file.size > maxSize) {
    showToast('Image is too large. Maximum allowed size is 5MB.');
    return;
  }

  selectedImageFile = file;

  // Show preview
  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreviewImg.src = e.target.result;
    previewFilename.textContent = file.name;
    previewFilesize.textContent = formatBytes(file.size);
    imagePreviewBar.classList.remove('hidden');
    updateSendButtonState();
    lucide.createIcons();
  };
  reader.readAsDataURL(file);
}

function clearSelectedImage() {
  selectedImageFile = null;
  imagePreviewImg.src = '';
  imagePreviewBar.classList.add('hidden');
  updateSendButtonState();
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  else return (bytes / 1048576).toFixed(1) + ' MB';
}

// ==========================================
// AI IMAGE GENERATION MODE
// ==========================================
function toggleImageGenMode(force) {
  if (typeof force === 'boolean') {
    isImageGenMode = force;
  } else {
    isImageGenMode = !isImageGenMode;
  }
  setImageGenModeUI(isImageGenMode);
}

function setImageGenModeUI(active) {
  isImageGenMode = active;
  if (active) {
    imageModeBanner.classList.remove('hidden');
    imageGenToolBtn.classList.add('active');
    if (!userInput.value.startsWith('/image ')) {
      userInput.value = '/image ' + userInput.value.replace(/^\/image\s*/, '');
    }
  } else {
    imageModeBanner.classList.add('hidden');
    imageGenToolBtn.classList.remove('active');
    if (userInput.value.startsWith('/image ')) {
      userInput.value = userInput.value.replace(/^\/image\s*/, '');
    }
  }
  autoResizeTextarea();
  updateSendButtonState();
  userInput.focus();
}

function applySuggestion(text) {
  userInput.value = text;
  autoResizeTextarea();
  updateSendButtonState();
  if (text.startsWith('/image ')) {
    setImageGenModeUI(true);
  }
  userInput.focus();
}

// ==========================================
// FORM SUBMISSION & MESSAGE SENDING
// ==========================================
async function handleFormSubmit(e) {
  e.preventDefault();
  const text = userInput.value.trim();
  const imageFile = selectedImageFile;

  if ((!text && !imageFile) || isTyping) return;

  isTyping = true;
  updateSendButtonState();
  emptyState.classList.add('hidden');

  const isImageRequest = (
    text.startsWith('/image ') ||
    text.startsWith('/generate ') ||
    text.startsWith('/draw ') ||
    text.startsWith('/img ') ||
    isImageGenMode ||
    /^(?:please\s+)?(?:can\s+you\s+)?(?:create|generate|draw|make|paint|render)\s+(?:an?\s+)?(?:image|picture|photo|illustration|drawing|artwork)/i.test(text)
  ) && !imageFile;

  // Append user bubble immediately
  let localImgPreviewUrl = null;
  if (imageFile) {
    localImgPreviewUrl = URL.createObjectURL(imageFile);
  }

  appendMessageBubble('user', text, { imageUrl: localImgPreviewUrl });

  // Reset Input
  userInput.value = '';
  clearSelectedImage();
  toggleImageGenMode(false);
  autoResizeTextarea();
  scrollToBottom();

  // Create loading typing/generating bubble
  const botRow = createLoadingBubble(isImageRequest);
  messagesContainer.appendChild(botRow);
  scrollToBottom();

  try {
    let resData;

    if ((text.startsWith('/image ') || text.startsWith('/generate ') || text.startsWith('/draw ')) && !imageFile) {
      // Dedicated Slash Image Call
      const prompt = text.replace(/^\/(image|generate|draw|img)\s+/i, '').trim();
      const res = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt,
          conversationId: currentConversationId
        })
      });
      resData = await res.json();
    } else {
      // Standard Chat / Vision / Natural Language Image Call
      const formData = new FormData();
      if (text) formData.append('message', text);
      if (currentConversationId) formData.append('conversationId', currentConversationId);
      if (imageFile) formData.append('image', imageFile);

      const res = await fetch('/chat', {
        method: 'POST',
        body: formData
      });
      resData = await res.json();
    }

    // Remove loading bubble
    botRow.remove();

    if (resData.error) {
      appendMessageBubble('bot', `⚠️ ${resData.error}`);
    } else {
      // Handle conversation update
      if (resData.conversationId) {
        currentConversationId = resData.conversationId;
        if (resData.conversationTitle) {
          currentChatTitleEl.textContent = resData.conversationTitle;
        }
        await loadConversations();
      }

      // Render bot message (text + generated or vision image)
      const targetImgUrl = resData.imageUrl || resData.generatedImageUrl || (resData.botMessage && resData.botMessage.imageUrl);
      const isGen = !!(resData.isGeneratedImage || (resData.botMessage && resData.botMessage.isGeneratedImage));

      appendMessageBubble('bot', resData.reply || '', {
        imageUrl: targetImgUrl,
        isGeneratedImage: isGen
      });
    }

  } catch (err) {
    botRow.remove();
    console.error('Chat error:', err);
    appendMessageBubble('bot', '⚠️ Network error: Could not reach the AI service. Please try again.');
  } finally {
    isTyping = false;
    updateSendButtonState();
    scrollToBottom();
  }
}

// ==========================================
// MESSAGE BUBBLE RENDERING
// ==========================================
function appendMessageBubble(sender, text, options = {}) {
  const row = document.createElement('div');
  row.className = `message-row ${sender}`;

  let contentHtml = '';

  // 1. Uploaded user image
  if (options.imageUrl && !options.isGeneratedImage) {
    contentHtml += `
      <div class="msg-uploaded-image">
        <a href="${options.imageUrl}" target="_blank" rel="noopener noreferrer">
          <img src="${options.imageUrl}" alt="Uploaded image" loading="lazy" />
        </a>
      </div>
    `;
  }

  // 2. Text Content
  if (text) {
    contentHtml += `<div class="msg-text">${formatMessageText(text)}</div>`;
  }

  // 3. AI Generated Image Card
  if (options.imageUrl && options.isGeneratedImage) {
    contentHtml += `
      <div class="generated-image-card">
        <div class="generated-image-wrapper">
          <a href="${options.imageUrl}" target="_blank" rel="noopener noreferrer">
            <img src="${options.imageUrl}" alt="AI Generated Art" loading="lazy" />
          </a>
        </div>
        <div class="generated-image-actions">
          <span class="gen-badge"><i data-lucide="sparkles"></i> DALL·E Generated</span>
          <button class="btn-download-img" onclick="downloadImage('${options.imageUrl}', 'ai-artwork-${Date.now()}.png')">
            <i data-lucide="download"></i> Download
          </button>
        </div>
      </div>
    `;
  }

  const avatar = sender === 'user'
    ? '<div class="msg-avatar"><i data-lucide="user"></i></div>'
    : '<div class="msg-avatar"><i data-lucide="bot"></i></div>';

  row.innerHTML = `
    ${sender === 'bot' ? avatar : ''}
    <div class="msg-bubble">
      ${contentHtml}
    </div>
    ${sender === 'user' ? avatar : ''}
  `;

  messagesContainer.appendChild(row);
  lucide.createIcons();
  scrollToBottom();
}

function createLoadingBubble(isImageGen = false) {
  const row = document.createElement('div');
  row.className = 'message-row bot';

  if (isImageGen) {
    row.innerHTML = `
      <div class="msg-avatar"><i data-lucide="bot"></i></div>
      <div class="msg-bubble">
        <div class="image-gen-loading">
          <span class="gen-spinner"></span>
          <span>Creating your AI image with DALL·E...</span>
        </div>
      </div>
    `;
  } else {
    row.innerHTML = `
      <div class="msg-avatar"><i data-lucide="bot"></i></div>
      <div class="typing-bubble">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </div>
    `;
  }

  lucide.createIcons();
  return row;
}

function formatMessageText(text) {
  // Safe HTML escaping with basic markdown formatting
  let clean = escapeHtml(text);

  // Bold **text**
  clean = clean.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic *text*
  clean = clean.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code `code`
  clean = clean.replace(/`([^`]+)`/g, '<code style="background: var(--bg-hover); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 13px;">$1</code>');

  return clean;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scrollToBottom() {
  chatBox.scrollTop = chatBox.scrollHeight;
}

async function downloadImage(url, filename) {
  try {
    showToast('Downloading image...', 'success');
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename || 'ai-image.png';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(blobUrl);
  } catch (err) {
    // If CORS prevents blob download, open directly
    window.open(url, '_blank');
  }
}

// ==========================================
// MOBILE SIDEBAR CONTROLS
// ==========================================
function toggleMobileSidebar() {
  sidebar.classList.toggle('open');
  sidebarBackdrop.classList.toggle('open');
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

// ==========================================
// LOGOUT & TOAST NOTIFICATIONS
// ==========================================
async function handleLogout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  } catch (err) {
    window.location.href = '/login';
  }
}

function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'toast-success' : 'toast-error'}`;
  toast.innerHTML = `
    <i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  toastContainer.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(40px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}