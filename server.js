const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Timer WebSocket server is running');
});

// Get port from environment variable (required for Render.com)
const PORT = process.env.PORT || 8080;

// Create database path that works on Render.com (using /tmp directory for writable storage)
const dbPath = process.env.NODE_ENV === 'production' 
  ? path.join('/tmp', 'timer_app.db')
  : 'timer_app.db';

// Initialize SQLite database
const db = sqlite3(dbPath);

// Create tables with room support
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    password TEXT,
    is_public BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS timers (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    name TEXT NOT NULL,
    duration INTEGER NOT NULL, -- in seconds
    created_at INTEGER NOT NULL,
    started_at INTEGER DEFAULT NULL,
    paused_at INTEGER DEFAULT NULL,
    completed_at INTEGER DEFAULT NULL,
    status TEXT NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    last_seen INTEGER NOT NULL,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );
  
  -- Create a default public room if none exists
  INSERT OR IGNORE INTO rooms (id, name, created_at, is_public)
  VALUES ('default', 'Public Room', ${Math.floor(Date.now() / 1000)}, 1);
`);

// Prepare statements for rooms
const createRoom = db.prepare(`
  INSERT INTO rooms (id, name, created_at, password, is_public)
  VALUES (?, ?, ?, ?, ?)
`);

const getRoom = db.prepare(`
  SELECT * FROM rooms WHERE id = ?
`);

const getRooms = db.prepare(`
  SELECT id, name, created_at, is_public, 
    (SELECT COUNT(*) FROM clients WHERE clients.room_id = rooms.id) AS client_count
  FROM rooms
  WHERE is_public = 1 OR id = ?
  ORDER BY name
`);

const verifyRoomPassword = db.prepare(`
  SELECT id FROM rooms WHERE id = ? AND (password IS NULL OR password = ?)
`);

// Prepare statements for timers
const createTimer = db.prepare(`
  INSERT INTO timers (id, room_id, name, duration, created_at, status)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateTimerStatus = db.prepare(`
  UPDATE timers
  SET status = ?,
      started_at = CASE WHEN ? IS NOT NULL THEN ? ELSE started_at END,
      paused_at = CASE WHEN ? IS NOT NULL THEN ? ELSE paused_at END,
      completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END
  WHERE id = ?
`);

const getTimer = db.prepare(`
  SELECT * FROM timers WHERE id = ?
`);

const getActiveTimers = db.prepare(`
  SELECT * FROM timers 
  WHERE room_id = ? AND status IN ('running', 'paused') 
  ORDER BY created_at DESC
`);

const getAllTimers = db.prepare(`
  SELECT * FROM timers 
  WHERE room_id = ? 
  ORDER BY created_at DESC
`);

// Prepare statements for clients
const upsertClient = db.prepare(`
  INSERT INTO clients (id, room_id, last_seen)
  VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, last_seen = excluded.last_seen
`);

const getClientsInRoom = db.prepare(`
  SELECT COUNT(*) as count FROM clients WHERE room_id = ?
`);

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
wss.on('connection', (ws, req) => {
  // Generate client ID if new connection
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null });
  
  console.log(`Client connected: ${clientId}`);
  
  // Send available rooms to the newly connected client
  const publicRooms = getRooms.all('default');
  ws.send(JSON.stringify({
    type: 'available_rooms',
    rooms: publicRooms
  }));
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const clientInfo = clients.get(ws);
      
      console.log(`Received from ${clientInfo.id}:`, message);
      
      // Update client's last seen time
      const now = Math.floor(Date.now() / 1000);
      
      switch(message.type) {
        case 'join_room':
          handleJoinRoom(message, ws, clientInfo, now);
          break;
        case 'create_room':
          handleCreateRoom(message, ws, clientInfo, now);
          break;
        case 'leave_room':
          handleLeaveRoom(ws, clientInfo, now);
          break;
        case 'create_timer':
          handleCreateTimer(message, ws, clientInfo, now);
          break;
        case 'start_timer':
          handleStartTimer(message, ws, clientInfo);
          break;
        case 'pause_timer':
          handlePauseTimer(message, ws, clientInfo);
          break;
        case 'stop_timer':
          handleStopTimer(message, ws, clientInfo);
          break;
        case 'get_timers':
          handleGetTimers(message, ws, clientInfo);
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
function handleJoinRoom(message, ws, clientInfo, now) {
  const roomId = message.roomId;
  const password = message.password || null;
  
  // Verify room exists and password matches (if any)
  const roomAccess = verifyRoomPassword.get(roomId, password);
  
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
  upsertClient.run(clientInfo.id, roomId, now);
  
  // Get timers for this room
  const activeTimers = getAllTimers.all(roomId);
  
  // Send room joined confirmation with timers
  ws.send(JSON.stringify({
    type: 'room_joined',
    roomId: roomId,
    room: getRoom.get(roomId),
    timers: activeTimers
  }));
  
  // Notify other clients in the room
  broadcastToRoom(roomId, {
    type: 'client_joined',
    clientId: clientInfo.id
  }, ws);
  
  console.log(`Client ${clientInfo.id} joined room ${roomId}`);
}

function handleCreateRoom(message, ws, clientInfo, now) {
  const roomId = crypto.randomUUID();
  const roomName = message.name || 'New Room';
  const isPublic = message.isPublic !== false;
  const password = message.password || null;
  
  try {
    // Create the room
    createRoom.run(
      roomId,
      roomName,
      now,
      password,
      isPublic ? 1 : 0
    );
    
    // Join the newly created room
    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);
    
    // Update client in database
    upsertClient.run(clientInfo.id, roomId, now);
    
    // Send confirmation
    ws.send(JSON.stringify({
      type: 'room_created',
      room: {
        id: roomId,
        name: roomName,
        created_at: now,
        is_public: isPublic,
        client_count: 1
      }
    }));
    
    // Send joined room confirmation
    ws.send(JSON.stringify({
      type: 'room_joined',
      roomId: roomId,
      room: getRoom.get(roomId),
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

function handleLeaveRoom(ws, clientInfo, now) {
  if (!clientInfo.roomId) {
    return;
  }
  
  const roomId = clientInfo.roomId;
  
  // Notify other clients in the room
  broadcastToRoom(roomId, {
    type: 'client_left',
    clientId: clientInfo.id
  }, ws);
  
  // Update client
  clientInfo.roomId = null;
  clients.set(ws, clientInfo);
  
  // Update in database (set room_id to NULL)
  upsertClient.run(clientInfo.id, null, now);
  
  // Send confirmation
  ws.send(JSON.stringify({
    type: 'room_left'
  }));
  
  // Send available rooms again
  const publicRooms = getRooms.all('default');
  ws.send(JSON.stringify({
    type: 'available_rooms',
    rooms: publicRooms
  }));
  
  console.log(`Client ${clientInfo.id} left room ${roomId}`);
}

// Timer handlers
function handleCreateTimer(message, ws, clientInfo, now) {
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
    createTimer.run(
      timerId,
      clientInfo.roomId,
      message.name || 'Timer',
      message.duration,
      now,
      'created'
    );
    
    const timerData = getTimer.get(timerId);
    
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

function handleStartTimer(message, ws, clientInfo) {
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
    const timer = getTimer.get(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    updateTimerStatus.run(
      'running',
      now, now,   // started_at
      null, null, // paused_at
      null, null, // completed_at
      message.timerId
    );
    
    const timerData = getTimer.get(message.timerId);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_started',
      timer: timerData
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

function handlePauseTimer(message, ws, clientInfo) {
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
    const timer = getTimer.get(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    updateTimerStatus.run(
      'paused',
      null, null, // started_at
      now, now,   // paused_at
      null, null, // completed_at
      message.timerId
    );
    
    const timerData = getTimer.get(message.timerId);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_paused',
      timer: timerData
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

function handleStopTimer(message, ws, clientInfo) {
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
    const timer = getTimer.get(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    updateTimerStatus.run(
      'completed',
      null, null, // started_at
      null, null, // paused_at
      now, now,   // completed_at
      message.timerId
    );
    
    const timerData = getTimer.get(message.timerId);
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_completed',
      timer: timerData
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

function handleGetTimers(message, ws, clientInfo) {
  // Check if client is in a room
  if (!clientInfo.roomId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'You must join a room to see timers'
    }));
    return;
  }
  
  try {
    const timers = getAllTimers.all(clientInfo.roomId);
    
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
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour
  db.prepare('DELETE FROM clients WHERE last_seen < ?').run(cutoff);
  console.log('Cleaned up inactive clients');
}, 5 * 60 * 1000);
