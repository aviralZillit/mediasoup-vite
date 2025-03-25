# Mediasoup Calling Architecture

## Overview
This document outlines the architecture and implementation of a **calling system** using Mediasoup. The system allows:
- **One-to-one** and **group calling**.
- **Push notifications** for call alerts.
- **Real-time signaling** using WebSockets.
- **Automatic room creation** when a call starts.
- **Call acceptance, rejection, and timeout handling.**

![Mediasoup flow digram](output.png)

## Components
### **1. Signaling Server** (Node.js + WebSockets)
- Manages **call signaling** (start, accept, decline, and end calls).
- Creates a **room in Mediasoup** when a call starts.
- Tracks **active calls** and manages call status.
- Sends push notifications when the receiver is offline.

### **2. Media Server** (Mediasoup)
- Handles **audio/video transmission** between participants.
- Creates **rooms dynamically** and routes WebRTC streams.
- Ensures **low-latency media communication**.

### **3. Push Notification Service**
- Notifies the receiver of an **incoming call**.
- Uses **Firebase Cloud Messaging (FCM)** or **Web Push API**.
- Ensures users get call alerts even if they are offline.

## Event Flow
### **1. Call Initialization**
1. **Client 1** (Caller) sends a `start-call` request to the **Signaling Server**.
2. **Signaling Server** checks if a room exists. If not, it **creates a new room**.
3. The server sends a **call request** to **Client 2 (Receiver)**.
4. If **Client 2 is offline**, a **push notification** is sent.

### **2. Call Acceptance or Decline**
1. **Client 2 receives the `call-started` event**.
2. Client 2 can either **accept** or **decline** the call.
3. If **accepted**, the server:
   - Sends a `call-accepted` event to **Client 1**.
   - Allows **both clients to join the Mediasoup room**.
4. If **declined**, the server:
   - Sends a `call-declined` event to **Client 1**.
   - Ends the call session.
5. If no response within **30 seconds**, the call is **automatically canceled**.

### **3. Call Connection**
1. Both clients **exchange WebRTC credentials** via **Signaling Server**.
2. Clients **join the Mediasoup room** and start media streaming.
3. The Mediasoup **router handles video/audio transmission**.

### **4. Ending the Call**
- If a user disconnects, an `end-call` event is emitted.
- The Mediasoup room **closes if no participants remain**.
- The Signaling Server **clears the call session** from memory.


## Implementation
### **1. WebSocket Signaling Server (Node.js)**
```javascript
const io = require('socket.io')(server);
const activeCalls = {}; // Store active call sessions

ios.on('connection', (socket) => {
    socket.on('start-call', async ({ callerId, receiverId }) => {
        const roomId = `room_${callerId}_${receiverId}`;
        const room = await createRoom(roomId);
        io.to(receiverId).emit('call-started', { roomId, callerId });
        activeCalls[roomId] = { callerId, receiverId, status: 'pending' };
    });

    socket.on('answer-call', ({ roomId }) => {
        if (!activeCalls[roomId]) return;
        activeCalls[roomId].status = 'accepted';
        io.to(activeCalls[roomId].callerId).emit('call-accepted', { roomId });
        socket.join(roomId);
    });

    socket.on('decline-call', ({ roomId }) => {
        if (!activeCalls[roomId]) return;
        io.to(activeCalls[roomId].callerId).emit('call-declined', { roomId });
        delete activeCalls[roomId];
    });
});
```

### **2. Mediasoup Room Creation**
```javascript
const mediasoup = require('mediasoup');
const rooms = {};

async function createRoom(roomId) {
    if (rooms[roomId]) return rooms[roomId];
    const worker = await mediasoup.createWorker();
    const router = await worker.createRouter({
        mediaCodecs: [
            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }
        ]
    });
    rooms[roomId] = { router, peers: {} };
    return rooms[roomId];
}
```

### **3. Push Notification for Offline Users (FCM Example)**
```javascript
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert('path/to/fcm-key.json') });

async function sendPushNotification(token, callerName) {
    const message = {
        notification: {
            title: `Incoming Call from ${callerName}`,
            body: 'Tap to answer the call',
        },
        token: token
    };
    await admin.messaging().send(message);
}
```

## Tech Stack
| Component | Technology |
|-----------|-----------|
| Signaling | Node.js + Socket.IO |
| Media Server | Mediasoup |
| Push Notifications | Firebase Cloud Messaging (FCM) |
| Authentication | JWT / Firebase Auth |
| Database | Redis (for active calls) |
| Web Frontend | React (Vite) |
| Mobile | React Native / Kotlin |

## Deployment Considerations
✅ **Use Docker** to containerize services.
✅ **Use PM2** for managing the Signaling Server.
✅ **Ensure TLS encryption** for WebRTC connections.
✅ **Set up firewall rules** to allow required ports.

## Conclusion
This architecture ensures a seamless and real-time **video calling feature** integrated with Mediasoup. It efficiently handles call signaling, media streaming, and push notifications.

Would you like additional security considerations or optimizations? 🚀

