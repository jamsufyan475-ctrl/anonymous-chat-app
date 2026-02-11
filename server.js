const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ==================== CONFIG ====================
const ADMIN_SECRET = crypto.randomBytes(8).toString('hex');
const ADMIN_URL = `/admin-${ADMIN_SECRET}-dashboard`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PORT = process.env.PORT || 3000;

// ==================== IN-MEMORY STORES ====================
const users = new Map(); // socketId -> {nickname, country, gender, ip, room, status, muted, muteEnd}
const messages = new Map(); // room -> [array of messages]
const bannedIPs = new Set();
const rooms = ['global', 'm2m', 'm2f', 'f2f'];
const MAX_USERS = 100;
const MAX_MESSAGES_PER_ROOM = 100;
const MESSAGE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

rooms.forEach(room => {
  messages.set(room, []);
});

// ==================== SESSION SETUP ====================
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, maxAge: 60 * 60 * 1000 } // 1 hour
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== ROUTES: MAIN SITE ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== ROUTES: ADMIN LOGIN ====================
app.get(ADMIN_URL, (req, res) => {
  if (req.session.adminLoggedIn) {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  } else {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Admin Login</title>
        <style>
          body { font-family: Arial; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
          .login-box { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); text-align: center; }
          input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
          button { width: 100%; padding: 10px; background: #667eea; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
          button:hover { background: #764ba2; }
          h2 { color: #333; }
          .error { color: red; margin-top: 10px; }
        </style>
      </head>
      <body>
        <div class="login-box">
          <h2>🔐 Admin Login</h2>
          <form method="POST" action="${ADMIN_URL}/login">
            <input type="text" name="username" placeholder="Username" required>
            <input type="password" name="password" placeholder="Password" required>
            <button type="submit">Login</button>
          </form>
          ${req.query.error ? '<p class="error">Invalid credentials</p>' : ''}
        </div>
      </body>
      </html>
    `);
  }
});

app.post(`${ADMIN_URL}/login`, (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.adminLoggedIn = true;
    res.redirect(ADMIN_URL);
  } else {
    res.redirect(`${ADMIN_URL}?error=1`);
  }
});

app.get(`${ADMIN_URL}/logout`, (req, res) => {
  req.session.destroy();
  res.redirect(ADMIN_URL);
});

// ==================== SOCKET.IO HANDLERS ====================
io.on('connection', (socket) => {
  console.log(`[CONNECT] Socket: ${socket.id}, IP: ${socket.handshake.address}`);

  // Check if IP is banned
  const clientIP = socket.handshake.address;
  if (bannedIPs.has(clientIP)) {
    socket.disconnect(true);
    return;
  }

  // ===== USER JOIN =====
  socket.on('user_join', (data) => {
    const { nickname, country, gender } = data;

    // Validate input
    if (!nickname || nickname.length < 2 || nickname.length > 20) {
      socket.emit('error', 'Invalid nickname');
      return;
    }
    if (!country) {
      socket.emit('error', 'Country required');
      return;
    }
    if (gender !== 'Male' && gender !== 'Female') {
      socket.emit('error', 'Invalid gender');
      return;
    }

    // Determine room based on gender
    let room = 'global';
    if (gender === 'Male') room = 'm2m';
    if (gender === 'Female') room = 'f2f';
    // Note: m2f is manually joined via 'join_m2f' event

    // Cap users
    if (users.size >= MAX_USERS) {
      socket.emit('error', 'Server full');
      return;
    }

    // Store user
    const userObj = {
      nickname,
      country,
      gender,
      ip: clientIP,
      room,
      status: 'online',
      muted: false,
      muteEnd: null,
      joinedAt: Date.now()
    };

    users.set(socket.id, userObj);
    socket.join(room);

    console.log(`[JOIN] ${nickname} joined ${room}`);

    // Notify room (but DON'T show user list or online status to other users)
    io.to(room).emit('user_joined', {
      nickname,
      country,
      message: `${nickname} joined the chat`
    });

    // Broadcast to admin
    io.to('admin_namespace').emit('admin_user_joined', {
      socketId: socket.id,
      ...userObj
    });
  });

  // ===== JOIN M2F ROOM =====
  socket.on('join_m2f', () => {
    const user = users.get(socket.id);
    if (!user) return;

    socket.leave(user.room);
    user.room = 'm2f';
    socket.join('m2f');

    io.to('m2f').emit('user_joined', {
      nickname: user.nickname,
      country: user.country,
      message: `${user.nickname} joined M2F`
    });

    io.to('admin_namespace').emit('admin_user_room_change', {
      socketId: socket.id,
      newRoom: 'm2f'
    });
  });

  // ===== SEND MESSAGE =====
  socket.on('send_message', (data) => {
    const user = users.get(socket.id);
    if (!user) return;

    // Check if muted
    if (user.muted && user.muteEnd > Date.now()) {
      socket.emit('error', 'You are muted');
      return;
    } else {
      user.muted = false;
    }

    const { text } = data;
    if (!text || text.trim().length === 0) return;

    const message = {
      id: crypto.randomUUID(),
      nickname: user.nickname,
      country: user.country,
      text: text.trim(),
      timestamp: new Date().toISOString(),
      room: user.room
    };

    // Store message
    const roomMessages = messages.get(user.room);
    if (roomMessages.length >= MAX_MESSAGES_PER_ROOM) {
      roomMessages.shift(); // FIFO
    }
    roomMessages.push(message);

    // Broadcast to room (NO IP, NO status)
    io.to(user.room).emit('receive_message', {
      nickname: message.nickname,
      country: message.country,
      text: message.text,
      timestamp: message.timestamp
    });

    // Broadcast to admin with full details
    io.to('admin_namespace').emit('admin_message', message);
  });

  // ===== TYPING INDICATOR =====
  socket.on('typing', () => {
    const user = users.get(socket.id);
    if (!user) return;

    io.to(user.room).emit('user_typing', {
      nickname: user.nickname
    });
  });

  socket.on('stop_typing', () => {
    const user = users.get(socket.id);
    if (!user) return;

    io.to(user.room).emit('user_stop_typing', {
      nickname: user.nickname
    });
  });

  // ===== ADMIN NAMESPACE =====
  socket.on('admin_connect', (adminToken) => {
    // In production, verify admin token properly
    if (adminToken === 'admin') {
      socket.join('admin_namespace');
      console.log('[ADMIN] Connected');

      // Send current state
      const usersArray = Array.from(users.values()).map((u, idx) => ({
        socketId: Array.from(users.keys())[idx],
        ...u
      }));

      socket.emit('admin_state', {
        users: usersArray,
        messages: Object.fromEntries(messages),
        bannedIPs: Array.from(bannedIPs)
      });
    }
  });

  socket.on('admin_block_user', (data) => {
    const { socketId } = data;
    const user = users.get(socketId);
    if (user) {
      bannedIPs.add(user.ip);
      io.to(socketId).emit('error', 'You have been blocked');
      io.sockets.sockets.get(socketId)?.disconnect(true);
      users.delete(socketId);
    }
  });

  socket.on('admin_mute_user', (data) => {
    const { socketId, duration } = data; // duration in ms
    const user = users.get(socketId);
    if (user) {
      user.muted = true;
      user.muteEnd = Date.now() + duration;
      io.to('admin_namespace').emit('admin_user_muted', {
        socketId,
        muteEnd: user.muteEnd
      });
    }
  });

  socket.on('admin_delete_message', (data) => {
    const { room, messageId } = data;
    const roomMessages = messages.get(room);
    if (roomMessages) {
      const idx = roomMessages.findIndex(m => m.id === messageId);
      if (idx !== -1) {
        roomMessages.splice(idx, 1);
        io.to('admin_namespace').emit('admin_message_deleted', {
          room,
          messageId
        });
      }
    }
  });

  socket.on('admin_export_logs', () => {
    const logsData = {
      timestamp: new Date().toISOString(),
      users: Array.from(users.values()),
      messages: Object.fromEntries(messages),
      bannedIPs: Array.from(bannedIPs)
    };
    socket.emit('admin_logs_export', JSON.stringify(logsData, null, 2));
  });

  // ===== DISCONNECT =====
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      console.log(`[DISCONNECT] ${user.nickname} from ${user.room}`);
      users.delete(socket.id);

      io.to('admin_namespace').emit('admin_user_disconnected', {
        socketId: socket.id
      });
    }
  });
});

// ==================== AUTO CLEANUP ====================
setInterval(() => {
  rooms.forEach(room => {
    const roomMessages = messages.get(room);
    const now = Date.now();
    // Remove messages older than 24 hours
    const filtered = roomMessages.filter(m => (now - new Date(m.timestamp).getTime()) < MESSAGE_RETENTION_MS);
    messages.set(room, filtered);
  });
}, 60 * 60 * 1000); // Every hour

// ==================== START SERVER ====================
server.listen(PORT, () => {
  console.log(`\n🚀 Chat Server running on http://localhost:${PORT}`);
  console.log(`🔐 Admin URL: http://localhost:${PORT}${ADMIN_URL}`);
  console.log(`👤 Admin User: ${ADMIN_USER}`);
  console.log(`🔑 Admin Pass: ${ADMIN_PASS}\n`);
});
