# Mediasoup Server API Documentation

## Overview
This document provides detailed information about the Mediasoup server implementation, including API endpoints, WebSocket events, and integration details for the frontend.

## API Endpoints

### Health Check
**GET** `/health`
- Returns the status of the server.
- **Response:**
  ```json
  {
    "message": "ok"
  }
  ```

### Get Room RTP Capabilities
**GET** `/rooms/:roomId`
- Retrieves Mediasoup router RTP capabilities for a given room.
- **Response:**
  ```json
  {
    "codecs": [...],
    "headerExtensions": [...]
  }
  ```

## WebSocket Communication
The frontend needs to connect to the **Protoo WebSocket Server** to interact with the Mediasoup server. Below is the list of WebSocket events that the frontend must handle.

### Connection Request
- **URL Format:** `ws://server-address?roomId=<room_id>&peerId=<peer_id>`
- **Required Parameters:**
  - `roomId`: The ID of the room the user wants to join.
  - `peerId`: A unique identifier for the peer.

### Events Sent by the Frontend
The frontend must emit the following events:

#### 1. `joinRoom`
- **Description:** Sent when a user wants to join a Mediasoup room.
- **Payload:**
  ```json
  {
    "roomId": "<room_id>",
    "peerId": "<peer_id>"
  }
  ```

#### 2. `produce`
- **Description:** Sent when a user wants to send an audio/video track.
- **Payload:**
  ```json
  {
    "kind": "video", // or "audio"
    "rtpParameters": { ... },
    "appData": {}
  }
  ```

#### 3. `consume`
- **Description:** Sent when a user wants to receive another user's media stream.
- **Payload:**
  ```json
  {
    "producerId": "<producer_id>",
    "rtpCapabilities": { ... }
  }
  ```

#### 4. `resume`
- **Description:** Sent when the user wants to resume a previously paused consumer.
- **Payload:**
  ```json
  {
    "consumerId": "<consumer_id>"
  }
  ```

#### 5. `closeProducer`
- **Description:** Sent when a user wants to stop producing media.
- **Payload:**
  ```json
  {
    "producerId": "<producer_id>"
  }
  ```

### Events Sent by the Server
The frontend must listen for the following events from the WebSocket connection:

#### 1. `newProducer`
- **Description:** Sent when a new producer (stream) is available in the room.
- **Payload:**
  ```json
  {
    "producerId": "<producer_id>",
    "kind": "video" // or "audio"
  }
  ```

#### 2. `consumerPaused`
- **Description:** Sent when a consumer's stream has been paused.
- **Payload:**
  ```json
  {
    "consumerId": "<consumer_id>"
  }
  ```

#### 3. `consumerResumed`
- **Description:** Sent when a consumer's stream has been resumed.
- **Payload:**
  ```json
  {
    "consumerId": "<consumer_id>"
  }
  ```

#### 4. `producerClosed`
- **Description:** Sent when a producer closes their media stream.
- **Payload:**
  ```json
  {
    "producerId": "<producer_id>"
  }
  ```

## Room Management

### Room Creation and Management
- When a user joins a room, the server creates the room if it doesn't exist.
- Rooms are managed dynamically, and when all users leave, the room is removed.

### Mediasoup Workers
- Mediasoup uses multiple workers to handle media streams efficiently.
- The server assigns the next available worker in a round-robin fashion.

## HTTPS Server
- The API runs on an HTTPS server, which can be configured using TLS certificates.
- The server listens on a configurable IP and port.

## Integration Guidelines
- The frontend must establish a **WebSocket connection** before interacting with the Mediasoup server.
- The frontend should handle **reconnections** in case of network interruptions.
- Proper **error handling** should be implemented when dealing with Mediasoup API responses.

## Error Handling
- The server will return proper error codes in API responses and WebSocket events.
- If a requested `roomId` does not exist, an error will be thrown.

## Conclusion
This document provides all necessary details for frontend integration with the Mediasoup-based WebRTC system. Please follow the API and WebSocket event structure to ensure seamless communication between the frontend and the Mediasoup server.
