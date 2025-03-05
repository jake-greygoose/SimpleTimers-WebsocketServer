const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Timer WebSocket server is running');
});

// Get port from environment variable (required for Render.com)
const PORT = process.env.PORT || 8080;

// Simple in-memory database implementation
class InMemoryDB {
  constructor() {
    this.rooms = new Map();
    this.timers = new Map();
    this.clients = new Map();
    
    // Create default room
    this.rooms.set('default', {
      id: 'default',
      name: 'Public Room',
      created_at: Math.floor(Date.now() / 1000),
      password: null,
      is_public: true
    });
  }
  
  // Room methods
  createRoom(id, name, created_at, password, is_public) {
    this.rooms.set(id, {
      id,
      name,
      created_at,
      password,
      is_public: is_public ? true : false
    });
    return this.rooms.get(id);
  }
  
  getRoom(id) {
    return this.rooms.get(id) || null;
  }
  
  getPublicRooms(clientRoomId = 'default') {
    const results = [];
    for (const [id, room] of this.rooms.entries()) {
      if (room.is_public || id === clientRoomId) {
        // Count clients in this room
        let client_count = 0;
        for (const client of this.clients.values()) {
          if (client.room_id === id) {
            client_count++;
          }
        }
        
        results.push({
          ...room,
          client_count
        });
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }
  
  verifyRoomPassword(roomId, password) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.password === null || room.password === password;
  }
  
  // Timer methods
  createTimer(id, room_id, name, duration, created_at, status) {
    const timer = {
      id,
      room_id,
      name,
      duration,
      created_at,
      started_at: null,
      paused_at: null,
      completed_at: null,
      status
    };
    this.timers.set(id, timer);
    return timer;
  }
  
  updateTimerStatus(id, status, started_at, paused_at, completed_at) {
    const timer = this.timers.get(id);
    if (!timer) return null;
    
    timer.status = status;
    
    if (started_at !== null) {
      timer.started_at = started_at;
    }
    
    if (paused_at !== null) {
      timer.paused_at = paused_at;
    }
    
    if (completed_at !== null) {
      timer.completed_at = completed_at;
    }
    
    return timer;
  }
  
  getTimer(id) {
    return this.timers.get(id) || null;
  }
  
  getActiveTimers(room_id) {
    const results = [];
    for (const timer of this.timers.values()) {
      if (timer.room_id === room_id && ['running', 'paused'].includes(timer.status)) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => b.created_at - a.created_at);
  }
  
  getAllTimers(room_id) {
    const results = [];
    for (const timer of this.timers.values()) {
      if (timer.room_id === room_id) {
        results.push(timer);
      }
    }
    return results.sort((a, b) => b.created_at - a.created_at);
  }
  
  // Client methods
  upsertClient(id, room_id, last_seen) {
    this.clients.set(id, {
      id,
      room_id,
      last_seen
    });
    return this.clients.get(id);
  }
  
  getClientsInRoom(room_id) {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.room_id === room_id) {
        count++;
      }
    }
    return { count };
  }
  
  // Cleanup old clients
  cleanupInactiveClients(cutoff) {
    for (const [id, client] of this.clients.entries()) {
      if (client.last_seen < cutoff) {
        this.clients.delete(id);
      }
    }
  }
  
  // Persistence methods (optional, for saving state between restarts)
  saveToFile(filePath) {
    const data = {
      rooms: Array.from(this.rooms.values()),
      timers: Array.from(this.timers.values()),
      clients: Array.from(this.clients.values())
    };
    
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }
  
  loadFromFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      // Clear existing data
      this.rooms.clear();
      this.timers.clear();
      this.clients.clear();
      
      // Load data
      for (const room of data.rooms) {
        this.rooms.set(room.id, room);
      }
      
      for (const timer of data.timers) {
        this.timers.set(timer.id, timer);
      }
      
      for (const client of data.clients) {
        this.clients.set(client.id, client);
      }
    } catch (error) {
      console.error('Error loading data from file:', error);
    }
  }
}

// Initialize database
const db = new InMemoryDB();

// Try to load saved data (if using file persistence)
const dataPath = process.env.NODE_ENV === 'production'
  ? path.join('/tmp', 'timer_app_data.json')
  : path.join(__dirname, 'timer_app_data.json');

try {
  db.loadFromFile(dataPath);
  console.log('Loaded saved data');
} catch (error) {
  console.log('No saved data found, starting with empty database');
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
wss.on('connection', (ws, req) => {
  // Generate client ID if new connection
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null });
  
  console.log(`Client connected: ${clientId}`);
  
  // Send available rooms to the newly connected client
  const publicRooms = db.getPublicRooms('default');
  ws.send(JSON.stringify({
    type: 'available_rooms',
    rooms: publicRooms
  }));
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
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
  const roomAccess = db.verifyRoomPassword(roomId, password);
  
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
  db.upsertClient(clientInfo.id, roomId, now);
  
  // Get timers for this room
  const activeTimers = db.getAllTimers(roomId);
  
  // Send room joined confirmation with timers
  ws.send(JSON.stringify({
    type: 'room_joined',
    roomId: roomId,
    room: db.getRoom(roomId),
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
    const room = db.createRoom(
      roomId,
      roomName,
      now,
      password,
      isPublic
    );
    
    // Join the newly created room
    clientInfo.roomId = roomId;
    clients.set(ws, clientInfo);
    
    // Update client in database
    db.upsertClient(clientInfo.id, roomId, now);
    
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
      room: db.getRoom(roomId),
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
  db.upsertClient(clientInfo.id, null, now);
  
  // Send confirmation
  ws.send(JSON.stringify({
    type: 'room_left'
  }));
  
  // Send available rooms again
  const publicRooms = db.getPublicRooms('default');
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
    const timer = db.createTimer(
      timerId,
      clientInfo.roomId,
      message.name || 'Timer',
      message.duration,
      now,
      'created'
    );
    
    // Broadcast to all clients in the room
    broadcastToRoom(clientInfo.roomId, {
      type: 'timer_created',
      timer: timer
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
    const timer = db.getTimer(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    const updatedTimer = db.updateTimerStatus(
      message.timerId,
      'running',
      now,     // started_at
      null,    // paused_at
      null     // completed_at
    );
    
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
    const timer = db.getTimer(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    const updatedTimer = db.updateTimerStatus(
      message.timerId,
      'paused',
      null,    // started_at
      now,     // paused_at
      null     // completed_at
    );
    
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
    const timer = db.getTimer(message.timerId);
    
    if (!timer || timer.room_id !== clientInfo.roomId) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Timer not found in your current room'
      }));
      return;
    }
    
    const updatedTimer = db.updateTimerStatus(
      message.timerId,
      'completed',
      null,    // started_at
      null,    // paused_at
      now      // completed_at
    );
    
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
    const timers = db.getAllTimers(clientInfo.roomId);
    
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

// Periodically save data (optional, for persistence between restarts)
function saveData() {
  try {
    db.saveToFile(dataPath);
    console.log('Data saved successfully');
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

// Start the server by listening on the specified port
server.listen(PORT, () => {
  console.log(`Room-based Timer WebSocket server running on port ${PORT}`);
});

// Cleanup old clients periodically (every 5 minutes)
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour
  db.cleanupInactiveClients(cutoff);
  console.log('Cleaned up inactive clients');
  
  // Save data after cleanup
  saveData();
}, 5 * 60 * 1000);

// Save data on process termination
process.on('SIGINT', () => {
  console.log('Saving data before shutdown...');
  saveData();
  process.exit();
});

process.on('SIGTERM', () => {
  console.log('Saving data before shutdown...');
  saveData();
  process.exit();
});
