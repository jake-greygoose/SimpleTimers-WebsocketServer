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
  } else if (pathname === '/eotm' || pathname === '/eotm/') {
    const dashboardPath = path.join(__dirname, 'eotm-dashboard.html');
    fs.readFile(dashboardPath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>Error 404: Dashboard file not found</h1><p>Please make sure eotm-dashboard.html exists in the application directory.</p>');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error: ' + err.message);
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      }
    });
  } else if (pathname === '/eotm/health') {
    const health = getEotmHealth();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
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

// Create WebSocket servers using the HTTP server (required for WSS on Render.com)
const timerWss = new WebSocket.Server({ noServer: true });
const eotmWss = new WebSocket.Server({ noServer: true });
const eotmAdminWss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/eotm/ws') {
    eotmWss.handleUpgrade(req, socket, head, (ws) => {
      eotmWss.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/eotm/admin') {
    eotmAdminWss.handleUpgrade(req, socket, head, (ws) => {
      eotmAdminWss.emit('connection', ws, req);
    });
    return;
  }

  timerWss.handleUpgrade(req, socket, head, (ws) => {
    timerWss.emit('connection', ws, req);
  });
});

// Clients collection
const clients = new Map();

// Helper function for batch client updates
async function updateClientBatch(clientUpdates, now) {
  for (const update of clientUpdates) {
    try {
      if (update.needsCleanup) {
        // For clients that were terminated, remove them from database
        await runQuery(`DELETE FROM clients WHERE id = ?`, [update.id]);
        console.log(`Cleaned up terminated client ${update.id}`);
      } else if (update.lastSeen) {
        // For active clients, update their last_seen time
        await runQuery(`
          UPDATE clients 
          SET last_seen = ? 
          WHERE id = ?
        `, [update.lastSeen, update.id]);
      }
    } catch (error) {
      console.error(`Error updating client ${update.id}:`, error);
    }
  }
}

// Global keep-alive ping interval and client last_seen updater
const keepAliveInterval = setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  const clientUpdates = [];
  
  timerWss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('Terminating dead client');
      try {
        const clientInfo = clients.get(ws);
        if (clientInfo) {
          // Store client ID before termination to ensure proper cleanup
          console.log(`Marking client ${clientInfo.id} for cleanup`);
          // Add to batch updates
          clientUpdates.push({
            id: clientInfo.id,
            needsCleanup: true
          });
        }
      } catch (error) {
        console.error('Error preparing client for termination:', error);
      }
      return ws.terminate();
    }
    
    // Update last_seen time for active clients
    ws.isAlive = false;
    ws.ping();
    
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      // Add to batch updates
      clientUpdates.push({
        id: clientInfo.id,
        lastSeen: now,
        needsCleanup: false
      });
    }
  });
  
  // Batch update last_seen times and cleanup terminated clients
  if (clientUpdates.length > 0) {
    updateClientBatch(clientUpdates, now);
  }
}, 30000);

// Create a periodic reconciliation interval (runs every 2 minutes)
const reconciliationInterval = setInterval(async () => {
  try {
    console.log("Starting client reconciliation...");
    
    // Get all clients from the database
    const dbClients = await getAll("SELECT * FROM clients");
    
    // Create a set of client IDs that are currently connected in-memory
    const connectedClientIds = new Set();
    for (const [ws, clientInfo] of clients.entries()) {
      connectedClientIds.add(clientInfo.id);
    }
    
    // Find clients in the database that no longer exist in-memory
    const orphanedClients = dbClients.filter(
      dbClient => !connectedClientIds.has(dbClient.id)
    );
    
    if (orphanedClients.length > 0) {
      console.log(`Found ${orphanedClients.length} orphaned clients in database`);
      
      for (const orphan of orphanedClients) {
        try {
          await runQuery(`DELETE FROM clients WHERE id = ?`, [orphan.id]);
          console.log(`Removed orphaned client ${orphan.id} from database`);
          
          // Notify the room if this orphaned client was in a room
          if (orphan.room_id) {
            broadcastToRoom(orphan.room_id, {
              type: 'client_left',
              clientId: orphan.id
            });
          }
        } catch (err) {
          console.error(`Error removing orphaned client ${orphan.id}:`, err);
        }
      }
    } else {
      console.log("No orphaned clients found");
    }
  } catch (error) {
    console.error("Error during client reconciliation:", error);
  }
}, 2 * 60 * 1000);  // Run every 2 minutes

timerWss.on('close', () => {
  clearInterval(keepAliveInterval);
  clearInterval(reconciliationInterval);
  clearInterval(cleanupInterval);
});

// Broadcast to all clients in a specific room
function broadcastToRoom(roomId, message, excludeClient = null) {
  const messageStr = JSON.stringify(message);
  
  timerWss.clients.forEach(client => {
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
  
  timerWss.clients.forEach(client => {
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
timerWss.on('connection', async (ws, req) => {
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
        case 'delete_timer':
          await handleDeleteTimer(message, ws, clientInfo);
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
      
      // Update the client's last_seen time after processing any message
      try {
        await runQuery(`
          UPDATE clients 
          SET last_seen = ? 
          WHERE id = ?
        `, [now, clientInfo.id]);
      } catch (err) {
        console.error(`Error updating last_seen for client ${clientInfo.id}:`, err);
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  // Handle disconnection with improved cleanup
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
        const result = await runQuery(`DELETE FROM clients WHERE id = ?`, [clientInfo.id]);
        console.log(`Client ${clientInfo.id} deleted from database, affected rows: ${result.changes}`);
      } catch (err) {
        console.error(`Error deleting client ${clientInfo.id} from database:`, err);
        
        // Failsafe: if delete fails, mark as inactive
        try {
          await runQuery(`
            UPDATE clients
            SET room_id = NULL, last_seen = 0
            WHERE id = ?
          `, [clientInfo.id]);
          console.log(`Client ${clientInfo.id} marked as inactive (failsafe)`);
        } catch (innerErr) {
          console.error(`Complete failure to cleanup client ${clientInfo.id}:`, innerErr);
        }
      }
    }
  });
});

// Room handlers

async function handleJoinRoom(message, ws, clientInfo, now) {
  let roomId = message.roomId;
  const providedPassword = message.password || null;
  const providedInviteToken = message.inviteToken || null;
  
  let room;
  
  try {
    // If no roomId but inviteToken is provided, try to find room by invite token
    if (!roomId && providedInviteToken) {
      room = await getOne(`SELECT * FROM rooms WHERE invite_token = ?`, [providedInviteToken]);
      if (room) {
        roomId = room.id; // Set roomId if found
      }
    } else {
      room = await getOne(`SELECT * FROM rooms WHERE id = ?`, [roomId]);
    }

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
    
    // Calculate new started_at time for paused timers
    let newStartedAt = now;
    
    if (timer.status === 'paused' && timer.started_at && timer.paused_at) {
      // Calculate elapsed time before pause
      const elapsedBeforePause = timer.paused_at - timer.started_at;
      
      // Adjust the new start time to account for already elapsed time
      newStartedAt = now - elapsedBeforePause;
    }
    
    await runQuery(`
      UPDATE timers
      SET status = ?, started_at = ?, paused_at = NULL, completed_at = NULL
      WHERE id = ?
    `, ['running', newStartedAt, message.timerId]);
    
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

async function handleDeleteTimer(message, ws, clientInfo) {
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room before deleting a timer'
    }));
    return;
  }
  
  try {
    const timer = await getOne(`SELECT * FROM timers WHERE id = ?`, [message.timerId]);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    await runQuery(`DELETE FROM timers WHERE id = ?`, [message.timerId]);
    
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_deleted',
      timerId: message.timerId
    });
    
    console.log(`Timer ${message.timerId} deleted from room ${clientInfo.roomId}`);
    
  } catch (error) {
    console.error('Error deleting timer:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to delete timer',
      error: error.message
    }));
  }
}

// EOTM Assist WebSocket server state and helpers
const eotmClients = new Map();
const eotmInstances = new Map();
const eotmMachines = new Map();
const eotmAdmins = new Set();

function addToGroup(map, key, ws) {
  if (!key) return;
  let group = map.get(key);
  if (!group) {
    group = new Set();
    map.set(key, group);
  }
  group.add(ws);
}

function removeFromGroup(map, key, ws) {
  if (!key) return;
  const group = map.get(key);
  if (!group) return;
  group.delete(ws);
  if (group.size === 0) {
    map.delete(key);
  }
}

function getEotmStatus() {
  const instances = {};
  const machines = {};

  for (const [serverIp, wsSet] of eotmInstances.entries()) {
    instances[serverIp] = [];
    for (const ws of wsSet) {
      const info = eotmClients.get(ws);
      if (!info) continue;
      instances[serverIp].push({
        character: info.character || 'Unknown',
        machine: info.machine || 'Unknown'
      });
    }
  }

  for (const [machine, wsSet] of eotmMachines.entries()) {
    machines[machine] = [];
    for (const ws of wsSet) {
      const info = eotmClients.get(ws);
      if (!info) continue;
      machines[machine].push({
        character: info.character || 'Unknown',
        server_ip: info.server_ip || null
      });
    }
  }

  return {
    type: 'status',
    total_clients: eotmClients.size,
    instances,
    machines
  };
}

function getEotmHealth() {
  return {
    status: 'ok',
    clients: eotmClients.size,
    instances: eotmInstances.size,
    machines: eotmMachines.size
  };
}

function notifyEotmAdmins() {
  const status = getEotmStatus();
  const payload = JSON.stringify(status);
  for (const admin of eotmAdmins) {
    if (admin.readyState === WebSocket.OPEN) {
      admin.send(payload);
    }
  }
}

function sendEotmCommand(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (typeof message === 'string') {
    ws.send(message);
  } else {
    ws.send(JSON.stringify(message));
  }
}

function updateEotmClientMapping(ws, update, now) {
  const current = eotmClients.get(ws) || {
    character: null,
    server_ip: null,
    machine: null,
    last_update: now
  };

  if (Object.prototype.hasOwnProperty.call(update, 'server_ip')) {
    if (update.server_ip && update.server_ip !== current.server_ip) {
      removeFromGroup(eotmInstances, current.server_ip, ws);
      addToGroup(eotmInstances, update.server_ip, ws);
      current.server_ip = update.server_ip;
    } else if (!update.server_ip && current.server_ip) {
      removeFromGroup(eotmInstances, current.server_ip, ws);
      current.server_ip = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(update, 'machine')) {
    if (update.machine && update.machine !== current.machine) {
      removeFromGroup(eotmMachines, current.machine, ws);
      addToGroup(eotmMachines, update.machine, ws);
      current.machine = update.machine;
    } else if (!update.machine && current.machine) {
      removeFromGroup(eotmMachines, current.machine, ws);
      current.machine = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(update, 'character') && update.character) {
    current.character = update.character;
  }

  current.last_update = now;
  eotmClients.set(ws, current);
}

function cleanupEotmClient(ws) {
  const info = eotmClients.get(ws);
  if (info) {
    removeFromGroup(eotmInstances, info.server_ip, ws);
    removeFromGroup(eotmMachines, info.machine, ws);
  }
  eotmClients.delete(ws);
  notifyEotmAdmins();
}

function closeExcessClients(keepCount) {
  for (const [serverIp, wsSet] of eotmInstances.entries()) {
    const clientsArray = Array.from(wsSet);
    if (clientsArray.length <= keepCount) continue;
    clientsArray.sort((a, b) => {
      const aInfo = eotmClients.get(a);
      const bInfo = eotmClients.get(b);
      return (bInfo?.last_update || 0) - (aInfo?.last_update || 0);
    });
    const toClose = clientsArray.slice(keepCount);
    for (const ws of toClose) {
      sendEotmCommand(ws, 'close_game');
    }
    console.log(`EOTM close_excess: ${toClose.length} clients closed on server ${serverIp}`);
  }
}

function keepPerMachine(keepCount) {
  for (const [machine, wsSet] of eotmMachines.entries()) {
    const clientsArray = Array.from(wsSet);
    if (clientsArray.length <= keepCount) continue;
    clientsArray.sort((a, b) => {
      const aInfo = eotmClients.get(a);
      const bInfo = eotmClients.get(b);
      return (bInfo?.last_update || 0) - (aInfo?.last_update || 0);
    });
    const toClose = clientsArray.slice(keepCount);
    for (const ws of toClose) {
      sendEotmCommand(ws, 'close_game');
    }
    console.log(`EOTM keep_per_machine: ${toClose.length} clients closed on machine ${machine}`);
  }
}

function closeMachine(machine) {
  const wsSet = eotmMachines.get(machine);
  if (!wsSet) return;
  for (const ws of wsSet) {
    sendEotmCommand(ws, 'close_game');
  }
  console.log(`EOTM close_machine: ${machine}`);
}

function closeServer(serverIp) {
  const wsSet = eotmInstances.get(serverIp);
  if (!wsSet) return;
  for (const ws of wsSet) {
    sendEotmCommand(ws, { type: 'close_server', server_ip: serverIp });
  }
  console.log(`EOTM close_server: ${serverIp}`);
}

function closeCharacter(character) {
  for (const [ws, info] of eotmClients.entries()) {
    if (info.character === character) {
      sendEotmCommand(ws, { type: 'close_character', character });
    }
  }
  console.log(`EOTM close_character: ${character}`);
}

function closeAllEotm() {
  for (const ws of eotmClients.keys()) {
    sendEotmCommand(ws, 'close_game');
  }
  console.log('EOTM close_all issued');
}

function setFpsAll(fps) {
  for (const ws of eotmClients.keys()) {
    sendEotmCommand(ws, { type: 'set_fps', fps });
  }
  console.log(`EOTM set_fps_all: ${fps}`);
}

function disableFpsLimiterAll() {
  for (const ws of eotmClients.keys()) {
    sendEotmCommand(ws, 'disable_fps_limiter');
  }
  console.log('EOTM disable_fps_limiter_all');
}

// EOTM Assist client connections (game addon)
eotmWss.on('connection', (ws, req) => {
  const now = Date.now();
  eotmClients.set(ws, {
    character: null,
    server_ip: null,
    machine: null,
    last_update: now
  });

  console.log(`EOTM client connected from ${req.socket.remoteAddress || 'unknown'}`);

  ws.on('message', (data) => {
    const text = data.toString();
    let message = null;

    try {
      message = JSON.parse(text);
    } catch (error) {
      message = null;
    }

    const timestamp = Date.now();

    if (!message || typeof message !== 'object') {
      if (text === 'status' || text === 'request_status') {
        sendEotmCommand(ws, getEotmStatus());
      }
      return;
    }

    switch (message.type) {
      case 'map_update':
        updateEotmClientMapping(ws, {
          server_ip: message.server_ip || null,
          character: message.character || null,
          machine: message.machine || null
        }, timestamp);
        notifyEotmAdmins();
        break;
      case 'pong':
        updateEotmClientMapping(ws, {}, timestamp);
        break;
      case 'request_status':
        sendEotmCommand(ws, getEotmStatus());
        break;
      case 'fps_updated':
      case 'fps_limiter_disabled':
        updateEotmClientMapping(ws, {}, timestamp);
        break;
      default:
        console.warn(`EOTM unknown client message type: ${message.type}`);
        break;
    }
  });

  ws.on('close', () => {
    cleanupEotmClient(ws);
  });

  ws.on('error', (error) => {
    console.error('EOTM client error:', error);
    cleanupEotmClient(ws);
  });
});

// EOTM Assist admin/dashboard connections
eotmAdminWss.on('connection', (ws) => {
  eotmAdmins.add(ws);
  sendEotmCommand(ws, getEotmStatus());

  ws.on('message', (data) => {
    const text = data.toString();
    let message = null;

    try {
      message = JSON.parse(text);
    } catch (error) {
      message = null;
    }

    if (!message || typeof message !== 'object') {
      if (text === 'status' || text === 'request_status') {
        sendEotmCommand(ws, getEotmStatus());
      }
      return;
    }

    switch (message.type) {
      case 'request_status':
        sendEotmCommand(ws, getEotmStatus());
        break;
      case 'close_excess':
        closeExcessClients(Number(message.keep_count) || 0);
        break;
      case 'keep_per_machine':
        keepPerMachine(Number(message.keep_count) || 0);
        break;
      case 'close_machine':
        if (message.machine) closeMachine(message.machine);
        break;
      case 'close_server':
        if (message.server_ip) closeServer(message.server_ip);
        break;
      case 'close_character':
        if (message.character) closeCharacter(message.character);
        break;
      case 'close_all':
        closeAllEotm();
        break;
      case 'set_fps_all':
        if (Number.isFinite(Number(message.fps))) {
          setFpsAll(Number(message.fps));
        }
        break;
      case 'disable_fps_limiter_all':
        disableFpsLimiterAll();
        break;
      default:
        console.warn(`EOTM unknown admin message type: ${message.type}`);
        break;
    }
  });

  ws.on('close', () => {
    eotmAdmins.delete(ws);
  });

  ws.on('error', () => {
    eotmAdmins.delete(ws);
  });
});

const eotmPingInterval = setInterval(() => {
  const now = Date.now();
  for (const [ws, info] of eotmClients.entries()) {
    if (now - (info.last_update || 0) > 2 * 60 * 1000) {
      ws.terminate();
      cleanupEotmClient(ws);
      continue;
    }
    sendEotmCommand(ws, 'ping');
  }
}, 30000);

// Cleanup old clients periodically (every 5 minutes)
const cleanupInterval = setInterval(async () => {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour
  
  try {
    // Get clients that should be cleaned up to notify their rooms
    const clientsToClean = await getAll(
      'SELECT id, room_id FROM clients WHERE last_seen < ?', 
      [cutoff]
    );
    
    // Send notifications for each client before deletion
    for (const client of clientsToClean) {
      if (client.room_id) {
        broadcastToRoom(client.room_id, {
          type: 'client_left',
          clientId: client.id
        });
      }
    }
    
    // Now delete the inactive clients
    const result = await runQuery('DELETE FROM clients WHERE last_seen < ?', [cutoff]);
    console.log(`Cleaned up ${result.changes} inactive clients (inactive > 1 hour)`);
  } catch (error) {
    console.error('Error cleaning up clients:', error);
  }
}, 5 * 60 * 1000);

// Start the server by listening on the specified port
server.listen(PORT, () => {
  console.log(`Room-based Timer WebSocket server running on port ${PORT}`);
});

// Close database connection when the server is shutting down
process.on('SIGINT', () => {
  db.close();
  clearInterval(keepAliveInterval);
  clearInterval(reconciliationInterval);
  clearInterval(cleanupInterval);
  clearInterval(eotmPingInterval);
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  clearInterval(keepAliveInterval);
  clearInterval(reconciliationInterval);
  clearInterval(cleanupInterval);
  clearInterval(eotmPingInterval);
  process.exit(0);
});
