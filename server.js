const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// ============ CONFIG ============
const CONFIG = {
    MAX_MESSAGES_PER_ROOM: 30,
    MAX_PRIVATE_MESSAGES: 50,
    MAX_USERS: 100,
    MAX_MESSAGE_LENGTH: 300,
    CLEANUP_INTERVAL: 1800000,
    INACTIVE_TIMEOUT: 900000
};

// ============ ADMIN CONFIG ============
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';
let adminSessions = new Set();

// ============ DATA STORAGE ============
let users = [];
let messages = {
    global: [],
    male_female: [],
    male_male: [],
    female_female: []
};
let privateMessages = [];
let reports = [];
let bannedUsers = new Set();
let bannedIPs = new Set();
let autoUsers = [];

// ============ COUNTRIES ============
const countries = [
    { code: 'US', name: 'United States', flag: '🇺🇸' },
    { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
    { code: 'CA', name: 'Canada', flag: '🇨🇦' },
    { code: 'AU', name: 'Australia', flag: '🇦🇺' },
    { code: 'DE', name: 'Germany', flag: '🇩🇪' },
    { code: 'FR', name: 'France', flag: '🇫🇷' },
    { code: 'JP', name: 'Japan', flag: '🇯🇵' },
    { code: 'IN', name: 'India', flag: '🇮🇳' },
    { code: 'BR', name: 'Brazil', flag: '🇧🇷' },
    { code: 'PK', name: 'Pakistan', flag: '🇵🇰' },
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
    { code: 'RU', name: 'Russia', flag: '🇷🇺' },
    { code: 'MX', name: 'Mexico', flag: '🇲🇽' },
    { code: 'ID', name: 'Indonesia', flag: '🇮🇩' },
    { code: 'TR', name: 'Turkey', flag: '🇹🇷' }
];

// ============ AUTO MESSAGES ============
const AUTO_MESSAGES = [
    "Just joined this awesome chat! 👋",
    "Anyone here from Asia? 🌏",
    "What's everyone talking about? 💬",
    "This platform is so fast! ⚡",
    "Nice to meet you all! 🤝",
    "Working from home today 💻",
    "The weather is beautiful ☀️",
    "Any music recommendations? 🎵",
    "Just had coffee ☕",
    "Good morning/evening everyone! 🌙"
];

// ============ CREATE AUTO USERS ============
function createAutoUsers() {
    const names = ['Sarah', 'Mike', 'Emma', 'Alex', 'Lisa'];
    const genders = ['Female', 'Male', 'Female', 'Male', 'Female'];
    const countryCodes = ['US', 'GB', 'CA', 'AU', 'DE'];
    
    for (let i = 0; i < 5; i++) {
        const country = countries.find(c => c.code === countryCodes[i]);
        autoUsers.push({
            id: `auto_${i}_${Date.now()}`,
            nickname: names[i],
            gender: genders[i],
            country: country,
            online: true,
            currentRoom: 'global',
            isAuto: true
        });
    }
}

// ============ START AUTO MESSAGES ============
function startAutoMessages() {
    setInterval(() => {
        const realUsersOnline = users.filter(u => u.online && !u.isAuto).length;
        if (realUsersOnline === 0) return;
        
        const autoUser = autoUsers[Math.floor(Math.random() * autoUsers.length)];
        if (!autoUser) return;
        
        const rooms = ['global', 'male_female', 'male_male', 'female_female'];
        const room = rooms[Math.floor(Math.random() * rooms.length)];
        
        if (room === 'male_male' && autoUser.gender !== 'Male') return;
        if (room === 'female_female' && autoUser.gender !== 'Female') return;
        
        const message = {
            id: `auto_${Date.now()}`,
            userId: autoUser.id,
            username: autoUser.nickname,
            gender: autoUser.gender,
            country: autoUser.country,
            content: AUTO_MESSAGES[Math.floor(Math.random() * AUTO_MESSAGES.length)],
            timestamp: new Date(),
            room: room,
            isAuto: true
        };
        
        messages[room].push(message);
        if (messages[room].length > CONFIG.MAX_MESSAGES_PER_ROOM) {
            messages[room].shift();
        }
        
        io.to(room).emit('new_message', message);
    }, 45000);
}

// ============ MIDDLEWARE ============
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: 'global-chat-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ============ API ============
app.get('/api/countries', (req, res) => res.json(countries));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ============ SOCKET.IO ============
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

function broadcastOnlineUsers() {
    const onlineUsers = users.filter(u => u.online).map(u => ({
        nickname: u.nickname,
        gender: u.gender,
        country: u.country,
        currentRoom: u.currentRoom,
        isAuto: u.isAuto || false
    }));
    io.emit('online_users', onlineUsers);
}

function updateOnlineCounts() {
    const rooms = ['global', 'male_female', 'male_male', 'female_female'];
    rooms.forEach(room => {
        const count = users.filter(u => u.online && u.currentRoom === room).length;
        io.to(room).emit('online_count', { room, count });
    });
}

io.on('connection', (socket) => {
    console.log('🔵 User connected:', socket.id);
    
    socket.on('user_login', (data) => {
        if (bannedUsers.has(data.nickname)) {
            socket.emit('login_error', { message: 'Username is banned' });
            return;
        }
        
        if (users.length >= CONFIG.MAX_USERS) {
            socket.emit('login_error', { message: 'Server is full' });
            return;
        }
        
        const country = countries.find(c => c.code === data.countryCode);
        if (!country) return;
        
        const user = {
            id: socket.id,
            nickname: data.nickname,
            gender: data.gender,
            country: country,
            online: true,
            currentRoom: 'global',
            socketId: socket.id,
            lastActivity: new Date(),
            isAuto: false
        };
        
        users.push(user);
        socket.userData = user;
        socket.join('global');
        
        socket.emit('login_success', {
            user: user,
            recentMessages: messages.global.slice(-CONFIG.MAX_MESSAGES_PER_ROOM)
        });
        
        io.emit('online_count', users.filter(u => u.online).length);
        updateOnlineCounts();
        broadcastOnlineUsers();
    });
    
    socket.on('request_online_users', () => broadcastOnlineUsers());
    
    socket.on('join_room', (room) => {
        if (!socket.userData) return;
        socket.leave(socket.userData.currentRoom);
        socket.join(room);
        socket.userData.currentRoom = room;
        socket.userData.lastActivity = new Date();
        socket.emit('room_messages', messages[room].slice(-CONFIG.MAX_MESSAGES_PER_ROOM));
        updateOnlineCounts();
        broadcastOnlineUsers();
    });
    
    socket.on('send_message', (data) => {
        if (!socket.userData) return;
        if (bannedUsers.has(socket.userData.nickname)) return;
        
        socket.userData.lastActivity = new Date();
        
        const message = {
            id: `msg_${Date.now()}_${socket.id}`,
            userId: socket.userData.id,
            username: socket.userData.nickname,
            gender: socket.userData.gender,
            country: socket.userData.country,
            content: data.content.substring(0, CONFIG.MAX_MESSAGE_LENGTH),
            timestamp: new Date(),
            room: socket.userData.currentRoom,
            isAuto: false
        };
        
        messages[socket.userData.currentRoom].push(message);
        if (messages[socket.userData.currentRoom].length > CONFIG.MAX_MESSAGES_PER_ROOM) {
            messages[socket.userData.currentRoom].shift();
        }
        
        io.to(socket.userData.currentRoom).emit('new_message', message);
    });
    
    socket.on('private_message', (data) => {
        const sender = socket.userData;
        if (!sender) return;
        
        const recipient = users.find(u => u.nickname === data.recipient && u.online);
        if (!recipient) {
            socket.emit('error', { message: 'User offline' });
            return;
        }
        
        const pm = {
            id: `pm_${Date.now()}`,
            from: sender.nickname,
            to: recipient.nickname,
            content: data.content.substring(0, CONFIG.MAX_MESSAGE_LENGTH),
            timestamp: new Date()
        };
        
        privateMessages.push(pm);
        if (privateMessages.length > CONFIG.MAX_PRIVATE_MESSAGES) {
            privateMessages.shift();
        }
        
        const recipientSocket = io.sockets.sockets.get(recipient.id);
        if (recipientSocket) {
            recipientSocket.emit('private_message', pm);
        }
        socket.emit('private_message_sent', pm);
    });
    
    socket.on('admin_login', (data) => {
        if (data.username === ADMIN_USERNAME && data.password === ADMIN_PASSWORD) {
            const sessionId = `admin_${Date.now()}`;
            adminSessions.add(sessionId);
            socket.adminSession = sessionId;
            
            socket.emit('admin_login_success', {
                stats: {
                    totalUsers: users.length,
                    onlineUsers: users.filter(u => u.online).length,
                    totalMessages: Object.values(messages).reduce((a, b) => a + b.length, 0),
                    totalPrivateMessages: privateMessages.length,
                    usersByRoom: {
                        global: users.filter(u => u.online && u.currentRoom === 'global').length,
                        male_female: users.filter(u => u.online && u.currentRoom === 'male_female').length,
                        male_male: users.filter(u => u.online && u.currentRoom === 'male_male').length,
                        female_female: users.filter(u => u.online && u.currentRoom === 'female_female').length
                    }
                },
                users: users.filter(u => u.online).map(u => ({
                    nickname: u.nickname,
                    gender: u.gender,
                    country: u.country,
                    currentRoom: u.currentRoom,
                    isAuto: u.isAuto || false
                })),
                messages: messages,
                privateMessages: privateMessages.slice(-30),
                reports: reports.slice(-20)
            });
        } else {
            socket.emit('admin_login_error', { message: 'Invalid credentials' });
        }
    });
    
    socket.on('admin_action', (action) => {
        if (!socket.adminSession || !adminSessions.has(socket.adminSession)) return;
        
        switch(action.type) {
            case 'delete_message':
                if (messages[action.room]) {
                    messages[action.room] = messages[action.room].filter(m => m.id !== action.messageId);
                    io.to(action.room).emit('message_deleted', { messageId: action.messageId });
                }
                break;
            case 'ban_user':
                bannedUsers.add(action.username);
                const userToBan = users.find(u => u.nickname === action.username);
                if (userToBan && userToBan.socketId) {
                    const userSocket = io.sockets.sockets.get(userToBan.socketId);
                    if (userSocket) {
                        userSocket.emit('banned', { message: 'You have been banned' });
                        userSocket.disconnect();
                    }
                }
                break;
            case 'ban_ip':
                bannedIPs.add(action.ip);
                users.filter(u => u.ip === action.ip).forEach(u => {
                    const userSocket = io.sockets.sockets.get(u.socketId);
                    if (userSocket) {
                        userSocket.emit('banned', { message: 'Your IP has been banned' });
                        userSocket.disconnect();
                    }
                });
                break;
            case 'resolve_report':
                const report = reports.find(r => r.id === action.reportId);
                if (report) report.status = 'resolved';
                break;
        }
    });
    
    socket.on('report_message', (data) => {
        const report = {
            id: `report_${Date.now()}`,
            messageId: data.messageId,
            reportedUser: data.reportedUser,
            reportedBy: socket.userData?.nickname || 'Anonymous',
            reason: data.reason,
            timestamp: new Date(),
            status: 'pending'
        };
        reports.push(report);
        if (reports.length > 50) reports.shift();
        socket.emit('report_submitted', { success: true });
    });
    
    socket.on('disconnect', () => {
        if (socket.userData) {
            socket.userData.online = false;
            users = users.filter(u => u.id !== socket.id);
            io.emit('online_count', users.filter(u => u.online).length);
            updateOnlineCounts();
            broadcastOnlineUsers();
        }
    });
});

// ============ CLEANUP ============
setInterval(() => {
    const now = new Date();
    users = users.filter(user => {
        if (!user.online) return false;
        return (now - user.lastActivity) < CONFIG.INACTIVE_TIMEOUT;
    });
}, CONFIG.CLEANUP_INTERVAL);

// ============ INITIALIZE ============
createAutoUsers();
startAutoMessages();

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 GLOBAL CHAT RUNNING!`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`👥 Max users: ${CONFIG.MAX_USERS}`);
    console.log(`🤖 Auto users: 5`);
    console.log(`🛡️ Admin: admin / admin123`);
    console.log(`🌍 Ready!\n`);
});