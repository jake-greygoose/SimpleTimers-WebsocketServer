<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Timer App Client</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        h1, h2, h3 {
            color: #333;
        }
        .container {
            display: flex;
            gap: 20px;
        }
        .left-panel, .right-panel {
            flex: 1;
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .room-list, .timer-list {
            margin-top: 20px;
            max-height: 300px;
            overflow-y: auto;
        }
        .room-item, .timer-item {
            margin-bottom: 10px;
            padding: 10px;
            background-color: #f9f9f9;
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.2s;
        }
        .room-item:hover, .timer-item:hover {
            background-color: #e9e9e9;
        }
        .room-item.selected, .timer-item.selected {
            background-color: #d1e7dd;
            border-left: 4px solid #198754;
        }
        .form-group {
            margin-bottom: 15px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
        }
        input, button, select {
            width: 100%;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            box-sizing: border-box;
        }
        button {
            background-color: #0d6efd;
            color: white;
            border: none;
            cursor: pointer;
            padding: 10px;
            font-weight: 500;
            transition: background-color 0.2s;
        }
        button:hover {
            background-color: #0b5ed7;
        }
        button:disabled {
            background-color: #6c757d;
            cursor: not-allowed;
        }
        .timer-controls {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .timer-controls button {
            flex: 1;
        }
        .start-btn {
            background-color: #198754;
        }
        .start-btn:hover {
            background-color: #157347;
        }
        .pause-btn {
            background-color: #fd7e14;
        }
        .pause-btn:hover {
            background-color: #e56e06;
        }
        .stop-btn {
            background-color: #dc3545;
        }
        .stop-btn:hover {
            background-color: #bb2d3b;
        }
        #connection-status {
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 20px;
            font-weight: 500;
            text-align: center;
        }
        .connected {
            background-color: #d1e7dd;
            color: #0f5132;
        }
        .disconnected {
            background-color: #f8d7da;
            color: #842029;
        }
        .connecting {
            background-color: #fff3cd;
            color: #664d03;
        }
        .log-container {
            margin-top: 20px;
            background-color: #f8f9fa;
            border: 1px solid #dee2e6;
            border-radius: 4px;
            padding: 10px;
            max-height: 200px;
            overflow-y: auto;
        }
        .log-entry {
            margin-bottom: 5px;
            font-family: monospace;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .room-details {
            padding: 10px;
            background-color: #e9ecef;
            border-radius: 4px;
            margin-bottom: 15px;
        }
        .timer-progress {
            height: 20px;
            background-color: #e9ecef;
            border-radius: 4px;
            margin-bottom: 5px;
            overflow: hidden;
        }
        .timer-progress-bar {
            height: 100%;
            background-color: #0d6efd;
            transition: width 1s linear;
        }
        .timer-details {
            display: flex;
            justify-content: space-between;
            font-size: 0.9rem;
        }
        .badge {
            display: inline-block;
            padding: 3px 6px;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: 500;
            margin-left: 5px;
        }
        .badge-success {
            background-color: #d1e7dd;
            color: #0f5132;
        }
        .badge-warning {
            background-color: #fff3cd;
            color: #664d03;
        }
        .badge-danger {
            background-color: #f8d7da;
            color: #842029;
        }
        .badge-info {
            background-color: #cff4fc;
            color: #055160;
        }
    </style>
</head>
<body>
    <h1>Timer App Test Client</h1>
    
    <div id="connection-status" class="disconnected">Disconnected</div>
    
    <div class="form-group">
        <label for="server-url">WebSocket Server URL</label>
        <div style="display: flex; gap: 10px;">
            <input type="text" id="server-url" value="wss://simple-timers-wss.onrender.com" placeholder="ws://localhost:8080">
            <button id="connect-btn" style="width: auto;">Connect</button>
            <button id="disconnect-btn" style="width: auto;" disabled>Disconnect</button>
        </div>
    </div>
    
    <div class="container">
        <div class="left-panel">
            <h2>Rooms</h2>
            
            <div id="create-room-form">
                <h3>Create Room</h3>
                <div class="form-group">
                    <label for="room-name">Room Name</label>
                    <input type="text" id="room-name" placeholder="My Room">
                </div>
                <div class="form-group">
                    <label for="room-password">Password (optional)</label>
                    <input type="password" id="room-password" placeholder="Leave empty for no password">
                </div>
                <div class="form-group">
                    <label>
                        <input type="checkbox" id="room-public" checked>
                        Public Room
                    </label>
                </div>
                <button id="create-room-btn" disabled>Create Room</button>
            </div>
            
            <div id="join-room-form" style="margin-top: 20px;">
                <h3>Join Room</h3>
                <div class="form-group">
                    <label for="join-room-password">Password (if required)</label>
                    <input type="password" id="join-room-password" placeholder="Enter room password">
                </div>
                <div class="form-group">
                    <label for="join-invite-token">Invite Token (if available)</label>
                    <input type="text" id="join-invite-token" placeholder="Enter invite token">
                </div>
                <button id="join-room-btn" disabled>Join Selected Room</button>
                <button id="leave-room-btn" disabled>Leave Current Room</button>
            </div>
            
            <h3>Available Rooms</h3>
            <div id="room-list" class="room-list">
                <div class="room-item">Loading rooms...</div>
            </div>
        </div>
        
        <div class="right-panel">
            <div id="current-room-info">
                <h2>Current Room: <span id="current-room-name">None</span></h2>
                <div id="room-details" class="room-details" style="display: none;">
                    <div><strong>Room ID:</strong> <span id="current-room-id"></span></div>
                    <div><strong>Invite Token:</strong> <span id="current-room-token"></span></div>
                </div>
            </div>
            
            <div id="create-timer-form">
                <h3>Create Timer</h3>
                <div class="form-group">
                    <label for="timer-name">Timer Name</label>
                    <input type="text" id="timer-name" placeholder="My Timer">
                </div>
                <div class="form-group">
                    <label for="timer-duration">Duration (seconds)</label>
                    <input type="number" id="timer-duration" value="60" min="1">
                </div>
                <button id="create-timer-btn" disabled>Create Timer</button>
            </div>
            
            <h3>Active Timers</h3>
            <div id="timer-list" class="timer-list">
                <div class="timer-item">Join a room to see timers</div>
            </div>
            
            <div id="timer-controls" class="timer-controls" style="display: none;">
                <button id="start-timer-btn" class="start-btn" disabled>Start</button>
                <button id="pause-timer-btn" class="pause-btn" disabled>Pause</button>
                <button id="stop-timer-btn" class="stop-btn" disabled>Stop</button>
            </div>
        </div>
    </div>
    
    <h3>Connection Log</h3>
    <div id="log-container" class="log-container">
        <div class="log-entry">Waiting for connection...</div>
    </div>
    
    <script>
        // Verify DOM loaded completely before accessing elements
        document.addEventListener('DOMContentLoaded', function() {
            console.log('DOM fully loaded - starting application');
            initializeApp();
        });

        function initializeApp() {
            // Global variables
            let ws = null;
            let selectedRoomId = null;
            let currentRoomId = null;
            let selectedTimerId = null;
            let availableRooms = [];
            let roomTimers = [];
            let timerIntervals = {};
            
            // Verify DOM elements exist
            const connectBtn = document.getElementById('connect-btn');
            const disconnectBtn = document.getElementById('disconnect-btn');
            const serverUrlInput = document.getElementById('server-url');
            const connectionStatus = document.getElementById('connection-status');
            const logContainer = document.getElementById('log-container');
            
            const roomNameInput = document.getElementById('room-name');
            const roomPasswordInput = document.getElementById('room-password');
            const roomPublicCheckbox = document.getElementById('room-public');
            const createRoomBtn = document.getElementById('create-room-btn');
            
            const joinRoomPasswordInput = document.getElementById('join-room-password');
            const joinInviteTokenInput = document.getElementById('join-invite-token');
            const joinRoomBtn = document.getElementById('join-room-btn');
            const leaveRoomBtn = document.getElementById('leave-room-btn');
            
            const roomList = document.getElementById('room-list');
            const currentRoomName = document.getElementById('current-room-name');
            const currentRoomIdElement = document.getElementById('current-room-id');
            const currentRoomToken = document.getElementById('current-room-token');
            const roomDetails = document.getElementById('room-details');
            
            const timerNameInput = document.getElementById('timer-name');
            const timerDurationInput = document.getElementById('timer-duration');
            const createTimerBtn = document.getElementById('create-timer-btn');
            
            const timerList = document.getElementById('timer-list');
            const timerControls = document.getElementById('timer-controls');
            const startTimerBtn = document.getElementById('start-timer-btn');
            const pauseTimerBtn = document.getElementById('pause-timer-btn');
            const stopTimerBtn = document.getElementById('stop-timer-btn');
            
            // Check if all elements were found
            const requiredElements = {
                connectBtn, disconnectBtn, serverUrlInput, connectionStatus, logContainer,
                roomNameInput, roomPasswordInput, roomPublicCheckbox, createRoomBtn,
                joinRoomPasswordInput, joinInviteTokenInput, joinRoomBtn, leaveRoomBtn,
                roomList, currentRoomName, currentRoomIdElement, currentRoomToken, roomDetails,
                timerNameInput, timerDurationInput, createTimerBtn,
                timerList, timerControls, startTimerBtn, pauseTimerBtn, stopTimerBtn
            };
            
            let missingElements = [];
            for (const [name, element] of Object.entries(requiredElements)) {
                if (!element) {
                    missingElements.push(name);
                    console.error(`Missing DOM element: ${name}`);
                }
            }
            
            if (missingElements.length > 0) {
                console.error('Application initialization failed. Missing DOM elements:', missingElements);
                alert(`Application cannot start. Missing elements: ${missingElements.join(', ')}`);
                return; // Stop initialization if elements are missing
            }
            
            console.log('All DOM elements verified. Continuing initialization...');
            
            // Helper functions
            function logMessage(message, data = null) {
                const now = new Date().toLocaleTimeString();
                const logEntry = document.createElement('div');
                logEntry.className = 'log-entry';
                
                if (data) {
                    let displayData;
                    try {
                        displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
                    } catch (e) {
                        displayData = String(data);
                    }
                    logEntry.textContent = `[${now}] ${message}: ${displayData}`;
                } else {
                    logEntry.textContent = `[${now}] ${message}`;
                }
                
                logContainer.appendChild(logEntry);
                logContainer.scrollTop = logContainer.scrollHeight;
            }
            
            function updateConnectionStatus(status) {
                connectionStatus.textContent = status;
                connectionStatus.className = status.toLowerCase().replace(' ', '-');
            }
            
            function formatTime(seconds) {
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
            }
            
            function getStatusBadge(status) {
                switch(status) {
                    case 'created': return '<span class="badge badge-info">Created</span>';
                    case 'running': return '<span class="badge badge-success">Running</span>';
                    case 'paused': return '<span class="badge badge-warning">Paused</span>';
                    case 'completed': return '<span class="badge badge-danger">Completed</span>';
                    default: return `<span class="badge">${status}</span>`;
                }
            }
            
            function displayRooms(rooms) {
                console.log('Displaying rooms:', rooms);
                
                // Clear the room list first
                roomList.innerHTML = '';
                
                if (!rooms || rooms.length === 0) {
                    const emptyItem = document.createElement('div');
                    emptyItem.className = 'room-item';
                    emptyItem.textContent = 'No rooms available';
                    roomList.appendChild(emptyItem);
                    return;
                }
                
                // Create room items
                rooms.forEach(room => {
                    const roomItem = document.createElement('div');
                    roomItem.className = 'room-item';
                    if (selectedRoomId === room.id) {
                        roomItem.classList.add('selected');
                    }
                    roomItem.setAttribute('data-room-id', room.id);
                    
                    const roomName = document.createElement('div');
                    roomName.innerHTML = `<strong>${room.name || 'Unnamed Room'}</strong>`;
                    
                    const roomDetails = document.createElement('div');
                    const isPublic = room.is_public === 1 || room.is_public === true;
                    const clientCount = room.client_count || 0;
                    roomDetails.textContent = `Public: ${isPublic ? 'Yes' : 'No'} - Clients: ${clientCount}`;
                    
                    roomItem.appendChild(roomName);
                    roomItem.appendChild(roomDetails);
                    
                    roomItem.addEventListener('click', () => {
                        document.querySelectorAll('.room-item.selected').forEach(el => {
                            el.classList.remove('selected');
                        });
                        roomItem.classList.add('selected');
                        selectedRoomId = room.id;
                        joinRoomBtn.disabled = currentRoomId === selectedRoomId;
                    });
                    
                    roomList.appendChild(roomItem);
                });
                
                console.log('Room list updated with', rooms.length, 'rooms');
            }
            
            function updateTimerDisplay(timer) {
                const timerElement = document.querySelector(`.timer-item[data-timer-id="${timer.id}"]`);
                if (!timerElement) return;
                
                const progressBar = timerElement.querySelector('.timer-progress-bar');
                const remainingTimeElement = timerElement.querySelector('.timer-remaining');
                const statusElement = timerElement.querySelector('.timer-status');
                
                // Update progress bar
                const progressPercent = Math.max(0, Math.min(100, (timer.remaining / timer.duration) * 100));
                progressBar.style.width = `${progressPercent}%`;
                
                // Update remaining time
                remainingTimeElement.textContent = formatTime(timer.remaining);
                
                // Update status
                statusElement.innerHTML = getStatusBadge(timer.status);
                
                // Update timer controls based on status
                updateTimerControls(timer.status);
            }
            
            function renderTimerList() {
                timerList.innerHTML = '';
                
                if (!currentRoomId) {
                    const emptyItem = document.createElement('div');
                    emptyItem.className = 'timer-item';
                    emptyItem.textContent = 'Join a room to see timers';
                    timerList.appendChild(emptyItem);
                    return;
                }
                
                if (roomTimers.length === 0) {
                    const emptyItem = document.createElement('div');
                    emptyItem.className = 'timer-item';
                    emptyItem.textContent = 'No timers in this room';
                    timerList.appendChild(emptyItem);
                    return;
                }
                
                roomTimers.forEach(timer => {
                    const timerItem = document.createElement('div');
                    timerItem.className = 'timer-item';
                    if (selectedTimerId === timer.id) {
                        timerItem.classList.add('selected');
                    }
                    timerItem.setAttribute('data-timer-id', timer.id);
                    
                    timerItem.innerHTML = `
                        <div><strong>${timer.name}</strong> <span class="timer-status">${getStatusBadge(timer.status)}</span></div>
                        <div class="timer-progress">
                            <div class="timer-progress-bar" style="width: ${Math.max(0, Math.min(100, (timer.remaining / timer.duration) * 100))}%"></div>
                        </div>
                        <div class="timer-details">
                            <div>Total: ${formatTime(timer.duration)}</div>
                            <div class="timer-remaining">${formatTime(timer.remaining)}</div>
                        </div>
                    `;
                    
                    timerItem.addEventListener('click', () => {
                        document.querySelectorAll('.timer-item.selected').forEach(el => {
                            el.classList.remove('selected');
                        });
                        timerItem.classList.add('selected');
                        selectedTimerId = timer.id;
                        updateTimerControls(timer.status);
                        timerControls.style.display = 'flex';
                    });
                    
                    timerList.appendChild(timerItem);
                    
                    // Start interval for updating this timer if it's running
                    if (timer.status === 'running' && !timerIntervals[timer.id]) {
                        startTimerInterval(timer);
                    }
                });
            }
            
            function startTimerInterval(timer) {
                // Clear any existing interval for this timer
                if (timerIntervals[timer.id]) {
                    clearInterval(timerIntervals[timer.id]);
                }
                
                // Only create interval for running timers
                if (timer.status !== 'running') return;
                
                let remaining = timer.remaining;
                const duration = timer.duration;
                const startTime = Date.now();
                const offset = Math.floor(Date.now() / 1000) - timer.current_server_time;
                
                timerIntervals[timer.id] = setInterval(() => {
                    // Calculate elapsed time since the interval started
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    
                    // Calculate new remaining time
                    remaining = Math.max(0, timer.remaining - elapsed);
                    
                    // Update the timer object
                    const updatedTimer = {...timer, remaining};
                    
                    // If timer reaches zero, update status to completed
                    if (remaining <= 0) {
                        updatedTimer.status = 'completed';
                        clearInterval(timerIntervals[timer.id]);
                        delete timerIntervals[timer.id];
                    }
                    
                    // Update the display
                    updateTimerDisplay(updatedTimer);
                }, 1000);
            }
            
            function updateTimerControls(status) {
                if (!selectedTimerId) {
                    startTimerBtn.disabled = true;
                    pauseTimerBtn.disabled = true;
                    stopTimerBtn.disabled = true;
                    return;
                }
                
                switch(status) {
                    case 'created':
                        startTimerBtn.disabled = false;
                        pauseTimerBtn.disabled = true;
                        stopTimerBtn.disabled = false;
                        break;
                    case 'running':
                        startTimerBtn.disabled = true;
                        pauseTimerBtn.disabled = false;
                        stopTimerBtn.disabled = false;
                        break;
                    case 'paused':
                        startTimerBtn.disabled = false;
                        pauseTimerBtn.disabled = true;
                        stopTimerBtn.disabled = false;
                        break;
                    case 'completed':
                        startTimerBtn.disabled = false;
                        pauseTimerBtn.disabled = true;
                        stopTimerBtn.disabled = true;
                        break;
                    default:
                        startTimerBtn.disabled = true;
                        pauseTimerBtn.disabled = true;
                        stopTimerBtn.disabled = true;
                }
            }
            
            function updateUIForRoomJoined(room) {
                currentRoomId = room.id;
                currentRoomName.textContent = room.name;
                currentRoomIdElement.textContent = room.id;
                currentRoomToken.textContent = room.invite_token || 'None';
                roomDetails.style.display = 'block';
                
                leaveRoomBtn.disabled = false;
                createTimerBtn.disabled = false;
                joinRoomBtn.disabled = true;
                
                // Highlight the current room in the list
                document.querySelectorAll('.room-item').forEach(el => {
                    if (el.getAttribute('data-room-id') === room.id) {
                        el.classList.add('selected');
                        selectedRoomId = room.id;
                    } else {
                        el.classList.remove('selected');
                    }
                });
            }
            
            function updateUIForRoomLeft() {
                currentRoomId = null;
                currentRoomName.textContent = 'None';
                roomDetails.style.display = 'none';
                
                leaveRoomBtn.disabled = true;
                createTimerBtn.disabled = true;
                joinRoomBtn.disabled = !selectedRoomId;
                
                // Clear timers and selection
                roomTimers = [];
                selectedTimerId = null;
                timerControls.style.display = 'none';
                renderTimerList();
                
                // Clear any running intervals
                Object.keys(timerIntervals).forEach(timerId => {
                    clearInterval(timerIntervals[timerId]);
                    delete timerIntervals[timerId];
                });
            }
            
            // WebSocket connection handling
            function connectToServer() {
                const serverUrl = serverUrlInput.value.trim();
                if (!serverUrl) {
                    alert('Please enter a valid WebSocket server URL');
                    return;
                }
                
                try {
                    updateConnectionStatus('Connecting...');
                    console.log('Attempting to connect to:', serverUrl);
                    ws = new WebSocket(serverUrl);
                    
                    ws.onopen = () => {
                        updateConnectionStatus('Connected');
                        logMessage('Connected to server');
                        console.log('WebSocket connection established');
                        
                        connectBtn.disabled = true;
                        disconnectBtn.disabled = false;
                        createRoomBtn.disabled = false;
                    };
                    
                    ws.onclose = () => {
                        updateConnectionStatus('Disconnected');
                        logMessage('Disconnected from server');
                        console.log('WebSocket connection closed');
                        
                        connectBtn.disabled = false;
                        disconnectBtn.disabled = true;
                        createRoomBtn.disabled = true;
                        joinRoomBtn.disabled = true;
                        leaveRoomBtn.disabled = true;
                        createTimerBtn.disabled = true;
                        
                        updateUIForRoomLeft();
                        
                        // Clear intervals
                        Object.keys(timerIntervals).forEach(timerId => {
                            clearInterval(timerIntervals[timerId]);
                            delete timerIntervals[timerId];
                        });
                    };
                    
                    ws.onerror = (error) => {
                        updateConnectionStatus('Error');
                        console.error('WebSocket connection error:', error);
                        logMessage('WebSocket error', 'Connection failed. Check console for details.');
                        alert('Failed to connect to the WebSocket server. Please check if the server is running and accessible.');
                    };
                    
                    ws.onmessage = (event) => {
                        try {
                            const message = JSON.parse(event.data);
                            console.log('WebSocket message received:', message);
                            logMessage('Received message', message);
                            
                            switch(message.type) {
                                case 'available_rooms':
                                    console.log('DEBUG: Available rooms data:', message.rooms);
                                    // Update rooms and display them
                                    availableRooms = message.rooms || [];
                                    displayRooms(availableRooms);
                                    break;
                                
                                case 'room_created':
                                    logMessage('Room created successfully', message.room);
                                    updateUIForRoomJoined(message.room);
                                    break;
                                    
                                case 'room_joined':
                                    logMessage('Joined room', message.room);
                                    updateUIForRoomJoined(message.room);
                                    
                                    // Set timers for this room
                                    roomTimers = message.timers || [];
                                    renderTimerList();
                                    break;
                                    
                                case 'room_left':
                                    logMessage('Left room');
                                    updateUIForRoomLeft();
                                    break;
                                    
                                case 'timer_list':
                                    roomTimers = message.timers || [];
                                    renderTimerList();
                                    break;
                                    
                                case 'timer_created':
                                    logMessage('Timer created', message.timer);
                                    roomTimers.push(message.timer);
                                    renderTimerList();
                                    break;
                                    
                                case 'timer_started':
                                    logMessage('Timer started', message.timer);
                                    // Update the timer in our list
                                    roomTimers = roomTimers.map(t => 
                                        t.id === message.timer.id ? message.timer : t
                                    );
                                    renderTimerList();
                                    break;
                                    
                                case 'timer_paused':
                                    logMessage('Timer paused', message.timer);
                                    // Clear the interval
                                    if (timerIntervals[message.timer.id]) {
                                        clearInterval(timerIntervals[message.timer.id]);
                                        delete timerIntervals[message.timer.id];
                                    }
                                    
                                    // Update the timer in our list
                                    roomTimers = roomTimers.map(t => 
                                        t.id === message.timer.id ? message.timer : t
                                    );
                                    renderTimerList();
                                    break;
                                    
                                case 'timer_completed':
                                    logMessage('Timer completed', message.timer);
                                    // Clear the interval
                                    if (timerIntervals[message.timer.id]) {
                                        clearInterval(timerIntervals[message.timer.id]);
                                        delete timerIntervals[message.timer.id];
                                    }
                                    
                                    // Update the timer in our list
                                    roomTimers = roomTimers.map(t => 
                                        t.id === message.timer.id ? message.timer : t
                                    );
                                    renderTimerList();
                                    break;
                                    
                                case 'client_left':
                                    logMessage('Client left', message.clientId);
                                    break;
                                    
                                case 'ping':
                                    logMessage('Received ping from server');
                                    // Immediately respond with a pong
                                    if (ws && ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({ type: 'pong' }));
                                        logMessage('Sent pong response');
                                    }
                                    break;
                                    
                                case 'pong':
                                    logMessage('Received pong from server');
                                    break;
                                    
                                case 'error':
                                    logMessage('Error from server', message);
                                    alert(`Server error: ${message.message}`);
                                    break;
                                    
                                default:
                                    logMessage('Unknown message type', message);
                            }
                        } catch (error) {
                            console.error('Error processing message:', error);
                            logMessage('Error parsing message', error.message);
                        }
                    };
                    
                    // Send ping every 20 seconds to keep connection alive
                    const pingInterval = setInterval(() => {
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'ping' }));
                            logMessage('Sent ping to server');
                        } else {
                            clearInterval(pingInterval);
                        }
                    }, 20000);
                    
                } catch (error) {
                    updateConnectionStatus('Error');
                    console.error('Connection error:', error);
                    logMessage('Connection error', error.message);
                }
            }
            
            function disconnectFromServer() {
                if (ws) {
                    ws.close();
                    ws = null;
                }
            }
            
            // Event listeners
            connectBtn.addEventListener('click', connectToServer);
            disconnectBtn.addEventListener('click', disconnectFromServer);
            
            createRoomBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                const roomName = roomNameInput.value.trim();
                if (!roomName) {
                    alert('Please enter a room name');
                    return;
                }
                
                const message = {
                    type: 'create_room',
                    name: roomName,
                    isPublic: roomPublicCheckbox.checked
                };
                
                const password = roomPasswordInput.value.trim();
                if (password) {
                    message.password = password;
                }
                
                ws.send(JSON.stringify(message));
                logMessage('Creating room', message);
            });
            
            joinRoomBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!selectedRoomId) {
                    alert('Please select a room to join');
                    return;
                }
                
                const message = {
                    type: 'join_room',
                    roomId: selectedRoomId
                };
                
                const password = joinRoomPasswordInput.value.trim();
                if (password) {
                    message.password = password;
                }
                
                const inviteToken = joinInviteTokenInput.value.trim();
                if (inviteToken) {
                    message.inviteToken = inviteToken;
                }
                
                ws.send(JSON.stringify(message));
                logMessage('Joining room', message);
            });
            
            leaveRoomBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!currentRoomId) {
                    alert('Not in a room');
                    return;
                }
                
                ws.send(JSON.stringify({ type: 'leave_room' }));
                logMessage('Leaving room');
            });
            
            createTimerBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!currentRoomId) {
                    alert('Not in a room');
                    return;
                }
                
                const timerName = timerNameInput.value.trim();
                if (!timerName) {
                    alert('Please enter a timer name');
                    return;
                }
                
                const timerDuration = parseInt(timerDurationInput.value);
                if (isNaN(timerDuration) || timerDuration <= 0) {
                    alert('Please enter a valid duration');
                    return;
                }
                
                const message = {
                    type: 'create_timer',
                    name: timerName,
                    duration: timerDuration
                };
                
                ws.send(JSON.stringify(message));
                logMessage('Creating timer', message);
            });
            
            startTimerBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!selectedTimerId) {
                    alert('Please select a timer');
                    return;
                }
                
                const message = {
                    type: 'start_timer',
                    timerId: selectedTimerId
                };
                
                ws.send(JSON.stringify(message));
                logMessage('Starting timer', message);
            });
            
            pauseTimerBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!selectedTimerId) {
                    alert('Please select a timer');
                    return;
                }
                
                const message = {
                    type: 'pause_timer',
                    timerId: selectedTimerId
                };
                
                ws.send(JSON.stringify(message));
                logMessage('Pausing timer', message);
            });
            
            stopTimerBtn.addEventListener('click', () => {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    alert('Not connected to server');
                    return;
                }
                
                if (!selectedTimerId) {
                    alert('Please select a timer');
                    return;
                }
                
                const message = {
                    type: 'stop_timer',
                    timerId: selectedTimerId
                };
                
                ws.send(JSON.stringify(message));
                logMessage('Stopping timer', message);
            });
            
            // Auto-connect if URL is already set
            if (serverUrlInput.value) {
                console.log('URL already set, initiating connection...');
                connectBtn.click();
            }
        }
    </script>
</body>
</html>
