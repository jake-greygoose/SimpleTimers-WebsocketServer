const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const url = require('url');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');


/**
 * Generate a short, readable invite code
 * @param {number} [length=6] - Length of the invite code
 * @returns {string} Generated invite code
 */
function generateInviteCode(length = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // easy-to-read characters
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Generate a unique invite code for a room
 * @returns {Promise<string>} Unique invite code
 */
async function generateUniqueInviteCode() {
  while (true) {
    const code = generateInviteCode();
    try {
      const existingRoom = await getOne('SELECT * FROM rooms WHERE invite_token = ?', [code]);
      if (!existingRoom) {
        return code;
      }
      // If code exists, loop will generate a new one
    } catch (error) {
      console.error('Error checking invite code uniqueness:', error);
      throw error;
    }
  }
}


// Create a simple HTTP server with improved routing
  const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  
  // Route for the client page
  if (pathname === '/client') {
    const clientPath = path.join(__dirname, 'client.html');
    
    // Read the client HTML file and serve it
    fs.readFile(clientPath, (err, content) => {
      if (err) {
        // If the file doesn't exist, create a simple error response
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>Error 404: Client file not found</h1><p>Please make sure client.html exists in the application directory.</p>');
        } else {
          // Server error
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error: ' + err.message);
        }
      } else {
        // Successfully read the file, serve it
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
  } else {
    // Default response for the root and other routes
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Timer WebSocket server is running');
  }
});

// Get port from environment variable (required for Render.com)
const PORT = process.env.PORT || 8080;

// Ensure tmp directory exists for Render.com
const dbDir = '/data';
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Configure database path that works on Render.com
const dbPath = path.join(dbDir, 'timer_app.db');
console.log(`Using persistent database at: ${dbPath}`);

// Initialize SQLite database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database opening error:', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize the database schema

function initializeDatabase() {
  db.serialize(() => {
    // Enable WAL Mode
    db.exec("PRAGMA journal_mode = WAL;");

    // Create rooms table
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      password_hash TEXT,
      is_public INTEGER DEFAULT 1,
      invite_token TEXT UNIQUE
    )`);

    // Create timers table
    db.run(`CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      name TEXT NOT NULL,
      duration INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER DEFAULT NULL,
      paused_at INTEGER DEFAULT NULL,
      completed_at INTEGER DEFAULT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )`);

    // Create clients table
    db.run(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )`);

    // Create a default public room if none exists
    const now = Math.floor(Date.now() / 1000);
    
    // Modify to use the new invite code generation
    (async () => {
      try {
        const defaultInviteToken = await generateUniqueInviteCode();
        
        db.run(`INSERT OR IGNORE INTO rooms (id, name, created_at, is_public, invite_token)
          VALUES ('default', 'Public Room', ?, 1, ?)`, 
          [now, defaultInviteToken], 
          function(err) {
            if (err) {
              console.error('Error creating default room:', err);
            } else if (this.changes > 0) {
              console.log('Default room created');
            }
          }
        );
      } catch (error) {
        console.error('Error generating invite token for default room:', error);
      }
    })();
  });
}

// Create a promise-based wrapper for database operations
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function getAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Helper function to calculate the current state of a timer.
 * Computes the remaining time based on the timer's status and timestamps.
 */
function calculateCurrentTimerState(timer) {
  const now = Math.floor(Date.now() / 1000);
  let remaining = timer.duration;

  switch (timer.status) {
    case 'running':
      remaining = Math.max(0, timer.duration - (now - timer.started_at));
      if (remaining === 0) {
        timer.status = 'completed';
        timer.completed_at = timer.started_at + timer.duration;
      }
      break;
    case 'paused':
      remaining = Math.max(0, timer.duration - (timer.paused_at - timer.started_at));
      break;
    case 'completed':
      remaining = 0;
      break;
    default:
      remaining = timer.duration;
  }

  return {
    ...timer,
    remaining,
    current_server_time: now
  };
}

// Create WebSocket server using the HTTP server (required for WSS on Render.com)
const wss = new WebSocket.Server({ server });

// Clients collection
const clients = new Map();

// Global keep-alive ping interval
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating dead client');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Broadcast to all clients in a specific room
function broadcastToRoom(roomId, message, excludeClient = null) {
  const messageStr = JSON.stringify(message);
  
  wss.clients.forEach(client => {
    const clientInfo = clients.get(client);
    if (client !== excludeClient && 
        client.readyState === WebSocket.OPEN && 
        clientInfo && 
        clientInfo.roomId === roomId) {
      client.send(messageStr);
    }
  });
}

// Specialized broadcast function for timer updates
function broadcastTimerUpdate(roomId, message, excludeClient = null) {
  const messageStr = JSON.stringify(message);
  const timerId = message.timer ? message.timer.id : null;
  
  wss.clients.forEach(client => {
    const clientInfo = clients.get(client);
    
    if (client === excludeClient || 
        !clientInfo || 
        clientInfo.roomId !== roomId || 
        client.readyState !== WebSocket.OPEN) {
      return;
    }
    
    if (timerId && 
        message.type.startsWith('timer_') && 
        clientInfo.subscribedTimers.size > 0 && 
        !clientInfo.subscribedTimers.has(timerId)) {
      return;
    }
    
    client.send(messageStr);
  });
}

// Handle WebSocket connections
wss.on('connection', async (ws, req) => {
  // Set up heartbeat mechanism
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Generate client ID for new connection
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null, subscribedTimers: new Set() });
  
  console.log(`Client connected: ${clientId}`);
  
  try {
    // Send available rooms to the newly connected client
    const publicRooms = await getAll(`
      SELECT r.id, r.name, r.created_at, r.is_public,
        (SELECT COUNT(*) FROM clients WHERE clients.room_id = r.id) AS client_count
      FROM rooms r
      WHERE r.is_public = 1 OR r.id = ?
      ORDER BY r.name
    `, ['default']);
    
    ws.send(JSON.stringify({
      type: 'available_rooms',
      rooms: publicRooms
    }));
  } catch (error) {
    console.error('Error getting rooms:', error);
  }
  
  // Handle incoming messages
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      const clientInfo = clients.get(ws);
      
      console.log(`Received from ${clientInfo.id}:`, message);
      
      // Update client's last seen time
      const now = Math.floor(Date.now() / 1000);
      
      switch(message.type) {
        case 'join_room':
          await handleJoinRoom(message, ws, clientInfo, now);
          break;
        case 'create_room':
          await handleCreateRoom(message, ws, clientInfo, now);
          break;
        case 'leave_room':
          await handleLeaveRoom(ws, clientInfo, now);
          break;
        case 'create_timer':
          await handleCreateTimer(message, ws, clientInfo, now);
          break;
        case 'start_timer':
          await handleStartTimer(message, ws, clientInfo);
          break;
        case 'pause_timer':
          await handlePauseTimer(message, ws, clientInfo);
          break;
        case 'stop_timer':
          await handleStopTimer(message, ws, clientInfo);
          break;
        case 'get_timers':
          await handleGetTimers(message, ws, clientInfo);
          break;
        case 'subscribe_to_timer':
          await handleSubscribeToTimer(message, ws, clientInfo);
          break;
        case 'unsubscribe_from_timer':
          await handleUnsubscribeFromTimer(message, ws, clientInfo);
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        default:
          console.warn(`Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  // Handle disconnection with cleanup
  ws.on('close', async () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log(`Client disconnected: ${clientInfo.id}`);
      
      if (clientInfo.roomId) {
        broadcastToRoom(clientInfo.roomId, {
          type: 'client_left',
          clientId: clientInfo.id
        }, ws);
      }
      
      clients.delete(ws);
      
      // Immediately remove client entry from database upon disconnect
      try {
        await runQuery(`DELETE FROM clients WHERE id = ?`, [clientInfo.id]);
      } catch (err) {
        console.error(`Error deleting client ${clientInfo.id} from database:`, err);
      }
    }
  });
});

// Room handlers

async function handleJoinRoom(message, ws, clientInfo, now) {
  const roomId = message.roomId;
  const providedPassword = message.password || null;
  const providedInviteToken = message.inviteToken || null;

  try {
    const room = await getOne(`SELECT * FROM rooms WHERE id = ?`, [roomId]);

    if (!room) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
    }

    let accessGranted = room.is_public;

    if (!accessGranted && room.password_hash && providedPassword) {
      accessGranted = await bcrypt.compare(providedPassword, room.password_hash);
    }

    if (!accessGranted && providedInviteToken && providedInviteToken === room.invite_token) {
      accessGranted = true;
    }

    if (!accessGranted) {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid credentials or invite token' }));
    }

    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);

    await runQuery(`
      INSERT INTO clients (id, room_id, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, last_seen = excluded.last_seen
    `, [clientInfo.id, roomId, now]);

    const activeTimers = await getAll(`SELECT * FROM timers WHERE room_id = ?`, [roomId]);
    const timersWithStates = activeTimers.map(calculateCurrentTimerState);

    ws.send(JSON.stringify({
      type: 'room_joined',
      roomId: roomId,
      room: room,
      timers: timersWithStates
    }));

  } catch (error) {
    console.error('Error joining room:', error);
    ws.send(JSON.stringify({
      type: 'error', 
      message: 'Failed to join room',
      details: error.message
    }));
  }
}

async function handleCreateRoom(message, ws, clientInfo, now) {
  const roomId = crypto.randomUUID();
  const inviteToken = await generateUniqueInviteCode();
  const roomName = message.name || 'New Room';
  const isPublic = message.isPublic !== false;
  let hashedPassword = null;

  try {
    if (message.password) {
      hashedPassword = await bcrypt.hash(message.password, 10);
    }

    await runQuery(`
      INSERT INTO rooms (id, name, created_at, password_hash, is_public, invite_token)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [roomId, roomName, now, hashedPassword, isPublic ? 1 : 0, inviteToken]);

    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);

    ws.send(JSON.stringify({
      type: 'room_created',
      room: {
        id: roomId,
        name: roomName,
        created_at: now,
        is_public: isPublic ? 1 : 0,
        invite_token: inviteToken
      }
    }));

  } catch (error) {
    console.error('Error creating room:', error);
    ws.send(JSON.stringify({
      type: 'error', 
      message: 'Failed to create room',
      details: error.message
    }));
  }
}

async function handleLeaveRoom(ws, clientInfo, now) {
  if (!clientInfo.roomId) return;
  
  const roomId = clientInfo.roomId;
  
  try {
    broadcastToRoom(roomId, {
      type: 'client_left',
      clientId: clientInfo.id
    }, ws);
    
    clientInfo.roomId = null;
    clients.set(ws, clientInfo);
    
    await runQuery(`
      INSERT INTO clients (id, room_id, last_seen)
      VALUES (?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET room_id = NULL, last_seen = excluded.last_seen
    `, [clientInfo.id, now]);
    
    ws.send(JSON.stringify({ type: 'room_left' }));
    
    const publicRooms = await getAll(`
      SELECT r.id, r.name, r.created_at, r.is_public,
        (SELECT COUNT(*) FROM clients WHERE clients.room_id = r.id) AS client_count
      FROM rooms r
      WHERE r.is_public = 1 OR r.id = ?
      ORDER BY r.name
    `, ['default']);
    
    ws.send(JSON.stringify({
      type: 'available_rooms',
      rooms: publicRooms
    }));
    
    console.log(`Client ${clientInfo.id} left room ${roomId}`);
    
  } catch (error) {
    console.error('Error leaving room:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to leave room',
      error: error.message
    }));
  }
}

async function handleCreateTimer(message, ws, clientInfo, now) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before creating a timer'
    }));
    return;
  }
  
  const timerId = crypto.randomUUID();
  
  try {
    await runQuery(`
      INSERT INTO timers (id, room_id, name, duration, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      timerId,
      clientInfo.roomId,
      message.name || 'Timer',
      message.duration,
      now,
      'created'
    ]);
    
    const timerData = await getOne(`SELECT * FROM timers WHERE id = ?`, [timerId]);
    
    // Include exact timer state when broadcasting timer creation
    broadcastTimerUpdate(clientInfo.roomId, {
      type: 'timer_created',
      timer: calculateCurrentTimerState(timerData)
    });
    
    console.log(`Timer ${timerId} created in room ${clientInfo.roomId}`);
    
  } catch (error) {
    console.error('Error creating timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to create timer',
      error: error.message
    }));
  }
}

async function handleStartTimer(message, ws, clientInfo) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const timer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    await runQuery(`
      UPDATE timers
      SET status = ?, started_at = ?, paused_at = NULL, completed_at = NULL
      WHERE id = ?
    `, ['running', now, message.timerId]);
    
    const updatedTimer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    broadcastTimerUpdate(clientInfo.roomId, {
      type: 'timer_started',
      timer: calculateCurrentTimerState(updatedTimer)
    });
    
    console.log(`Timer ${message.timerId} started in room ${clientInfo.roomId}`);
    
  } catch (error) {
    console.error('Error starting timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to start timer',
      error: error.message
    }));
  }
}

async function handlePauseTimer(message, ws, clientInfo) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const timer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    await runQuery(`
      UPDATE timers
      SET status = ?, paused_at = ?
      WHERE id = ?
    `, ['paused', now, message.timerId]);
    
    const updatedTimer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    broadcastTimerUpdate(clientInfo.roomId, {
      type: 'timer_paused',
      timer: calculateCurrentTimerState(updatedTimer)
    });
    
    console.log(`Timer ${message.timerId} paused in room ${clientInfo.roomId}`);
    
  } catch (error) {
    console.error('Error pausing timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to pause timer',
      error: error.message
    }));
  }
}

async function handleStopTimer(message, ws, clientInfo) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    const timer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    await runQuery(`
      UPDATE timers
      SET status = ?, completed_at = ?
      WHERE id = ?
    `, ['completed', now, message.timerId]);
    
    const updatedTimer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    broadcastTimerUpdate(clientInfo.roomId, {
      type: 'timer_completed',
      timer: calculateCurrentTimerState(updatedTimer)
    });
    
    console.log(`Timer ${message.timerId} stopped in room ${clientInfo.roomId}`);
    
  } catch (error) {
    console.error('Error stopping timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to stop timer',
      error: error.message
    }));
  }
}

async function handleGetTimers(message, ws, clientInfo) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room to see timers'
    }));
    return;
  }
  
  try {
    const timers = await getAll(`SELECT * FROM timers WHERE room_id = ? ORDER BY created_at DESC`, [clientInfo.roomId]);
    
    // Calculate current states for each timer
    const timersWithExactStates = timers.map(calculateCurrentTimerState);
    
    ws.send(JSON.stringify({
      type: 'timer_list',
      timers: timersWithExactStates
    }));
    
  } catch (error) {
    console.error('Error getting timers:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to get timers',
      error: error.message
    }));
  }
}

async function handleSubscribeToTimer(message, ws, clientInfo) {
  const timerId = message.timerId;
  
  if (!timerId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Missing timer ID'
    }));
    return;
  }
  
  try {
    const timer = await getOne(`SELECT * FROM timers WHERE id = ? AND room_id = ?`, [timerId, clientInfo.roomId]);
    
    if (!timer) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your room'
      }));
      return;
    }
    
    clientInfo.subscribedTimers.add(timerId);
    
    ws.send(JSON.stringify({
      type: 'timer_subscribed',
      timerId: timerId
    }));
    
    console.log(`Client ${clientInfo.id} subscribed to timer ${timerId}`);
    
  } catch (error) {
    console.error('Error subscribing to timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to subscribe to timer',
      error: error.message
    }));
  }
}

async function handleUnsubscribeFromTimer(message, ws, clientInfo) {
  const timerId = message.timerId;
  
  if (!timerId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Missing timer ID'
    }));
    return;
  }
  
  try {
    clientInfo.subscribedTimers.delete(timerId);
    
    ws.send(JSON.stringify({
      type: 'timer_unsubscribed',
      timerId: timerId
    }));
    
    console.log(`Client ${clientInfo.id} unsubscribed from timer ${timerId}`);
    
  } catch (error) {
    console.error('Error unsubscribing from timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to unsubscribe from timer',
      error: error.message
    }));
  }
}

// Start the server by listening on the specified port
server.listen(PORT, () => {
  console.log(`Room-based Timer WebSocket server running on port ${PORT}`);
});

// Cleanup old clients periodically (every 5 minutes)
setInterval(async () => {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour
  
  try {
    const result = await runQuery('DELETE FROM clients WHERE last_seen < ?', [cutoff]);
    console.log(`Cleaned up ${result.changes} inactive clients`);
  } catch (error) {
    console.error('Error cleaning up clients:', error);
  }
}, 5 * 60 * 1000);

// Close database connection when the server is shutting down
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
