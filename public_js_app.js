// Socket.IO connection with reconnection
const socket = io({
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

let currentUser = null;
let currentRoom = 'global';
let privateMessages = [];
let countries = [];

document.addEventListener('DOMContentLoaded', () => {
    loadCountries();
    setupSocketListeners();
    registerServiceWorker();
});

async function loadCountries() {
    try {
        const response = await fetch('/api/countries');
        countries = await response.json();
        populateCountrySelect();
    } catch (error) {
        console.error('Failed to load countries');
    }
}

function populateCountrySelect() {
    const select = document.getElementById('country');
    if (!select) return;
    
    select.innerHTML = '<option value="" disabled selected>Select your country</option>';
    countries.forEach(country => {
        const option = document.createElement('option');
        option.value = country.code;
        option.textContent = `${country.flag} ${country.name}`;
        select.appendChild(option);
    });
}

function showLogin() {
    document.getElementById('home-page').classList.remove('active');
    document.getElementById('login-page').classList.add('active');
}

function handleLogin(event) {
    event.preventDefault();
    
    const nickname = document.getElementById('nickname').value.trim();
    const gender = document.getElementById('gender').value;
    const countryCode = document.getElementById('country').value;
    
    if (!nickname || !gender || !countryCode) {
        alert('Please fill all fields');
        return;
    }
    
    if (nickname.length < 2 || nickname.length > 20) {
        alert('Username must be 2-20 characters');
        return;
    }
    
    socket.emit('user_login', { nickname, gender, countryCode });
}

function setupSocketListeners() {
    socket.on('login_success', (data) => {
        currentUser = data.user;
        displayMessages(data.recentMessages);
        document.getElementById('login-page').classList.remove('active');
        document.getElementById('chat-page').classList.add('active');
        updateUserBadge();
    });
    
    socket.on('login_error', (error) => {
        alert(error.message);
    });
    
    socket.on('new_message', (message) => {
        if (message.room === currentRoom) {
            addMessageToChat(message);
        }
    });
    
    socket.on('private_message', (message) => {
        privateMessages.push(message);
        updatePrivateMessages();
        showNotification(`Private message from ${message.from}`);
    });
    
    socket.on('private_message_sent', (message) => {
        privateMessages.push(message);
        updatePrivateMessages();
    });
    
    socket.on('online_count', (data) => {
        const countElement = document.getElementById(`room-count-${data.room}`);
        if (countElement) countElement.textContent = data.count;
        if (data.room === 'global') {
            document.getElementById('global-online').textContent = `${data.count} online`;
        }
    });
    
    socket.on('online_users', (users) => {
        updateUsersList(users);
    });
    
    socket.on('room_messages', (messages) => {
        document.getElementById('messages').innerHTML = '';
        messages.forEach(msg => addMessageToChat(msg));
    });
    
    socket.on('message_deleted', (data) => {
        const msgElement = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (msgElement) msgElement.remove();
    });
    
    socket.on('banned', (data) => {
        alert(data.message);
        location.reload();
    });
    
    socket.on('error', (error) => {
        alert(error.message);
    });
    
    socket.on('report_submitted', () => {
        alert('Report submitted. Thank you!');
    });
}

function updateUsersList(users) {
    const container = document.getElementById('users-list');
    if (!container) return;
    
    const onlineUsers = users.filter(u => u.nickname !== currentUser?.nickname);
    
    container.innerHTML = onlineUsers.map(user => `
        <div class="user-item" onclick="sendPrivateMessage('${user.nickname}')">
            <div class="user-status"></div>
            <div class="user-info">
                <span class="user-name">${escapeHtml(user.nickname)}</span>
                <span class="user-country">${user.country?.flag || '🌍'}</span>
                ${user.isAuto ? '<span style="margin-left:5px; font-size:10px;">🤖</span>' : ''}
            </div>
        </div>
    `).join('');
}

function switchRoom(room) {
    if (room === 'male_male' && currentUser?.gender !== 'Male') {
        alert('This room is for Male users only');
        return;
    }
    if (room === 'female_female' && currentUser?.gender !== 'Female') {
        alert('This room is for Female users only');
        return;
    }
    
    currentRoom = room;
    
    document.querySelectorAll('.room-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-room="${room}"]`).classList.add('active');
    
    document.getElementById('messages').innerHTML = '';
    socket.emit('join_room', room);
}

function sendMessage(event) {
    event.preventDefault();
    
    const input = document.getElementById('message-input');
    const content = input.value.trim();
    
    if (!content) return;
    if (content.length > 300) {
        alert('Message too long (max 300 characters)');
        return;
    }
    
    socket.emit('send_message', { content });
    input.value = '';
}

function addMessageToChat(message) {
    const messagesDiv = document.getElementById('messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.userId === currentUser?.id ? 'own' : ''}`;
    messageDiv.dataset.messageId = message.id;
    
    const time = new Date(message.timestamp).toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    messageDiv.innerHTML = `
        <div class="message-header">
            <span class="message-username">${escapeHtml(message.username)}</span>
            <span class="message-country">${message.country?.flag || '🌍'}</span>
            ${message.isAuto ? '<span style="margin-left:5px;">🤖</span>' : ''}
            <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${escapeHtml(message.content)}</div>
        ${message.userId !== currentUser?.id ? 
            `<button onclick="showReportModal('${message.id}', '${message.username}')" style="background:none; border:none; color:#999; cursor:pointer; margin-top:5px; font-size:12px;">⚠️ Report</button>` : 
            ''}
    `;
    
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // Clean old messages
    while (messagesDiv.children.length > 100) {
        messagesDiv.removeChild(messagesDiv.firstChild);
    }
}

function displayMessages(messages) {
    const messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML = '';
    messages.forEach(message => addMessageToChat(message));
}

function updateUserBadge() {
    const badge = document.getElementById('user-badge');
    if (currentUser) {
        badge.innerHTML = `${currentUser.nickname} • ${currentUser.country?.flag || '🌍'}`;
    }
}

function logout() {
    if (confirm('Logout?')) {
        location.reload();
    }
}

function sendPrivateMessage(username) {
    const content = prompt(`Private message to ${username}:`);
    if (content && content.trim()) {
        if (content.length > 300) {
            alert('Message too long');
            return;
        }
        socket.emit('private_message', {
            recipient: username,
            content: content.trim()
        });
    }
}

function updatePrivateMessages() {
    const container = document.getElementById('private-messages');
    if (!container) return;
    
    container.innerHTML = '';
    
    privateMessages.slice(-10).reverse().forEach(msg => {
        const div = document.createElement('div');
        div.className = 'private-message-item';
        
        const time = new Date(msg.timestamp).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
        
        div.innerHTML = `
            <div class="pm-header">
                <span class="pm-from">${escapeHtml(msg.from)}</span>
                <span>→ ${escapeHtml(msg.to)}</span>
                <span>${time}</span>
            </div>
            <div class="pm-content">${escapeHtml(msg.content)}</div>
        `;
        
        container.appendChild(div);
    });
    
    const pmBadge = document.getElementById('pm-badge');
    if (privateMessages.length > 0) pmBadge.style.display = 'inline';
}

function showReportModal(messageId, username) {
    document.getElementById('report-message-id').value = messageId;
    document.getElementById('report-username').value = username;
    document.getElementById('report-modal').classList.add('active');
}

function closeReportModal() {
    document.getElementById('report-modal').classList.remove('active');
}

function submitReport(event) {
    event.preventDefault();
    
    socket.emit('report_message', {
        messageId: document.getElementById('report-message-id').value,
        reportedUser: document.getElementById('report-username').value,
        reason: document.getElementById('report-reason').value
    });
    
    closeReportModal();
}

function showAdminLogin() {
    document.getElementById('admin-modal').classList.add('active');
}

function closeAdminModal() {
    document.getElementById('admin-modal').classList.remove('active');
}

function adminLogin(event) {
    event.preventDefault();
    
    socket.emit('admin_login', {
        username: document.getElementById('admin-username').value,
        password: document.getElementById('admin-password').value
    });
}

socket.on('admin_login_success', () => {
    closeAdminModal();
    window.location.href = '/admin.html';
});

socket.on('admin_login_error', (error) => {
    alert(error.message);
});

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(text) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('GlobalChat', { body: text });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(console.error);
    }
}

if ('Notification' in window) {
    Notification.requestPermission();
}

// Request online users periodically
setInterval(() => {
    if (currentUser) socket.emit('request_online_users');
}, 5000);