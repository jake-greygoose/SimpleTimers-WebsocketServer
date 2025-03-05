const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Timer WebSocket server is running');
});

// Get port from environment variable (required for Render.com)
const PORT = process.env.PORT || 8080;

// Ensure tmp directory exists for Render.com
const dbDir = process.env.NODE_ENV === 'production' ? '/tmp' : './data';
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Configure database path that works on Render.com
const dbPath = path.join(dbDir, 'timer_app.db');
console.log(`Using database at: ${dbPath}`);

// Initialize SQLite database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database opening error: ', err);
  } else {
    console.log('Connected to SQLite database');
    initializeDatabase();
  }
});

// Initialize the database schema
function initializeDatabase() {
  db.serialize(() => {
    // Create tables with room support
    db.run(`CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      password TEXT,
      is_public INTEGER DEFAULT 1
    )`);

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

    db.run(`CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    )`);

    // Create a default public room if none exists
    const now = Math.floor(Date.now() / 1000);
    db.run(`INSERT OR IGNORE INTO rooms (id, name, created_at, is_public)
      VALUES ('default', 'Public Room', ?, 1)`, 
      [now], 
      function(err) {
        if (err) {
          console.error('Error creating default room:', err);
        } else if (this.changes > 0) {
          console.log('Default room created');
        }
      }
    );
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

// Create WebSocket server using the HTTP server (required for WSS on Render.com)
const wss = new WebSocket.Server({ server });

// Clients collection
const clients = new Map();

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

// Handle WebSocket connections
wss.on('connection', async (ws, req) => {
  // Generate client ID if new connection
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null });
  
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
  
  // Handle disconnection
  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      console.log(`Client disconnected: ${clientInfo.id}`);
      
      // Notify other clients in the room about this client leaving
      if (clientInfo.roomId) {
        broadcastToRoom(clientInfo.roomId, {
          type: 'client_left',
          clientId: clientInfo.id
        }, ws);
      }
      
      clients.delete(ws);
    }
  });
});

// Room handlers
async function handleJoinRoom(message, ws, clientInfo, now) {
  const roomId = message.roomId;
  const password = message.password || null;
  
  try {
    // Verify room exists and password matches (if any)
    const roomAccess = await getOne(`
      SELECT id FROM rooms WHERE id = ? AND (password IS NULL OR password = ?)
    `, [roomId, password]);
    
    if (!roomAccess) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid room ID or password'
      }));
      return;
    }
    
    // Update client's room
    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);
    
    // Update client in database
    await runQuery(`
      INSERT INTO clients (id, room_id, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, last_seen = excluded.last_seen
    `, [clientInfo.id, roomId, now]);
    
    // Get room details
    const room = await getOne(`
      SELECT * FROM rooms WHERE id = ?
    `, [roomId]);
    
    // Get timers for this room
    const activeTimers = await getAll(`
      SELECT * FROM timers 
      WHERE room_id = ? 
      ORDER BY created_at DESC
    `, [roomId]);
    
    // Send room joined confirmation with timers
    ws.send(JSON.stringify({
      type: 'room_joined',
      roomId: roomId,
      room: room,
      timers: activeTimers
    }));
    
    // Notify other clients in the room
    broadcastToRoom(roomId, {
      type: 'client_joined',
      clientId: clientInfo.id
    }, ws);
    
    console.log(`Client ${clientInfo.id} joined room ${roomId}`);
    
  } catch (error) {
    console.error('Error joining room:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to join room',
      error: error.message
    }));
  }
}

async function handleCreateRoom(message, ws, clientInfo, now) {
  const roomId = crypto.randomUUID();
  const roomName = message.name || 'New Room';
  const isPublic = message.isPublic !== false;
  const password = message.password || null;
  
  try {
    // Create the room
    await runQuery(`
      INSERT INTO rooms (id, name, created_at, password, is_public)
      VALUES (?, ?, ?, ?, ?)
    `, [roomId, roomName, now, password, isPublic ? 1 : 0]);
    
    // Join the newly created room
    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);
    
    // Update client in database
    await runQuery(`
      INSERT INTO clients (id, room_id, last_seen)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, last_seen = excluded.last_seen
    `, [clientInfo.id, roomId, now]);
    
    // Send confirmation
    ws.send(JSON.stringify({
      type: 'room_created',
      room: {
        id: roomId,
        name: roomName,
        created_at: now,
        is_public: isPublic ? 1 : 0,
        client_count: 1
      }
    }));
    
    // Get room details
    const room = await getOne(`
      SELECT * FROM rooms WHERE id = ?
    `, [roomId]);
    
    // Send joined room confirmation
    ws.send(JSON.stringify({
      type: 'room_joined',
      roomId: roomId,
      room: room,
      timers: []
    }));
    
    console.log(`Client ${clientInfo.id} created and joined room ${roomId}`);
    
  } catch (error) {
    console.error('Error creating room:', error);
    
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to create room',
      error: error.message
    }));
  }
}

async function handleLeaveRoom(ws, clientInfo, now) {
  if (!clientInfo.roomId) {
    return;
  }
  
  const roomId = clientInfo.roomId;
  
  try {
    // Notify other clients in the room
    broadcastToRoom(roomId, {
      type: 'client_left',
      clientId: clientInfo.id
    }, ws);
    
    // Update client
    clientInfo.roomId = null;
    clients.set(ws, clientInfo);
    
    // Update in database (set room_id to NULL)
    await runQuery(`
      INSERT INTO clients (id, room_id, last_seen)
      VALUES (?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET room_id = NULL, last_seen = excluded.last_seen
    `, [clientInfo.id, now]);
    
    // Send confirmation
    ws.send(JSON.stringify({
      type: 'room_left'
    }));
    
    // Send available rooms again
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

// Timer handlers
async function handleCreateTimer(message, ws, clientInfo, now) {
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before creating a timer'
    }));
    return;
  }
  
  const timerId = crypto.randomUUID();
  
  try {
    // Create timer
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
    
    // Get timer data
    const timerData = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [timerId]);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_created',
      timer: timerData
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
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    // Get the timer to verify it belongs to the client's room
    const timer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    // Update timer status
    await runQuery(`
      UPDATE timers
      SET status = ?,
          started_at = ?,
          paused_at = NULL,
          completed_at = NULL
      WHERE id = ?
    `, ['running', now, message.timerId]);
    
    // Get updated timer data
    const updatedTimer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_started',
      timer: updatedTimer
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
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    // Get the timer to verify it belongs to the client's room
    const timer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    // Update timer status
    await runQuery(`
      UPDATE timers
      SET status = ?,
          paused_at = ?
      WHERE id = ?
    `, ['paused', now, message.timerId]);
    
    // Get updated timer data
    const updatedTimer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_paused',
      timer: updatedTimer
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
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before controlling a timer'
    }));
    return;
  }
  
  const now = Math.floor(Date.now() / 1000);
  
  try {
    // Get the timer to verify it belongs to the client's room
    const timer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    // Update timer status
    await runQuery(`
      UPDATE timers
      SET status = ?,
          completed_at = ?
      WHERE id = ?
    `, ['completed', now, message.timerId]);
    
    // Get updated timer data
    const updatedTimer = await getOne(`
      SELECT * FROM timers WHERE id = ?
    `, [message.timerId]);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_completed',
      timer: updatedTimer
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
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room to see timers'
    }));
    return;
  }
  
  try {
    const timers = await getAll(`
      SELECT * FROM timers 
      WHERE room_id = ? 
      ORDER BY created_at DESC
    `, [clientInfo.roomId]);
    
    ws.send(JSON.stringify({
      type: 'timer_list',
      timers: timers
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
