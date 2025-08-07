# **Documentation: Protoo Request Handling for Frontend Integration**

This document outlines the events and requests that the frontend needs to handle while interacting with the **Protoo signaling server** in a **Mediasoup-based WebRTC application**. It details what the frontend must send and what it will receive for each request.

---

## **1. Request: `getRouterRtpCapabilities`**
### **Description**:
Retrieves the RTP capabilities of the Mediasoup router.

### **Frontend Must Send**:
```json
{
  "method": "getRouterRtpCapabilities"
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "rtpCapabilities": { ... }  // Contains supported audio/video codecs
  }
}
```

---

## **2. Request: `join`**
### **Description**:
Used for a peer to join the room.

### **Frontend Must Send**:
```json
{
  "method": "join",
  "data": {
    "displayName": "John Doe",
    "device": {
      "name": "Chrome",
      "version": "110",
      "platform": "Windows"
    },
    "rtpCapabilities": { ... },  // Obtained from getRouterRtpCapabilities
    "sctpCapabilities": { ... }  // SCTP capabilities (for data channels)
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "peers": [
      {
        "id": "peerId123",
        "displayName": "Alice",
        "device": {
          "name": "Firefox",
          "version": "99",
          "platform": "MacOS"
        }
      },
      ...
    ]
  }
}
```

---

## **3. Request: `createWebRtcTransport`**
### **Description**:
Creates a WebRTC transport for sending/receiving media.

### **Frontend Must Send**:
```json
{
  "method": "createWebRtcTransport",
  "data": {
    "forceTcp": false,  
    "producing": true,  
    "consuming": true,
    "sctpCapabilities": { ... }  
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "id": "transportId123",
    "iceParameters": { ... },
    "iceCandidates": [ ... ],
    "dtlsParameters": { ... },
    "sctpParameters": { ... }
  }
}
```

---

## **4. Request: `connectWebRtcTransport`**
### **Description**:
Connects a WebRTC transport.

### **Frontend Must Send**:
```json
{
  "method": "connectWebRtcTransport",
  "data": {
    "transportId": "transportId123",
    "dtlsParameters": { ... }
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200
}
```

---

## **5. Request: `restartIce`**
### **Description**:
Restarts ICE on a transport.

### **Frontend Must Send**:
```json
{
  "method": "restartIce",
  "data": {
    "transportId": "transportId123"
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "iceParameters": { ... }
  }
}
```

---

## **6. Request: `produce`**
### **Description**:
Creates a media producer (audio/video stream).

### **Frontend Must Send**:
```json
{
  "method": "produce",
  "data": {
    "transportId": "transportId123",
    "kind": "video",
    "rtpParameters": { ... },
    "appData": { "type": "camera" }
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "id": "producerId123"
  }
}
```

---

## **7. Request: `closeProducer`**
### **Description**:
Closes a media producer.

### **Frontend Must Send**:
```json
{
  "method": "closeProducer",
  "data": {
    "producerId": "producerId123"
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200
}
```

---

## **8. Request: `pauseProducer` / `resumeProducer`**
### **Description**:
Pauses or resumes a producer (mute/unmute).

### **Frontend Must Send (Pause Producer)**:
```json
{
  "method": "pauseProducer",
  "data": {
    "producerId": "producerId123"
  }
}
```

### **Frontend Must Send (Resume Producer)**:
```json
{
  "method": "resumeProducer",
  "data": {
    "producerId": "producerId123"
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200
}
```

---

## **9. Request: `produceData`**
### **Description**:
Creates a data channel.

### **Frontend Must Send**:
```json
{
  "method": "produceData",
  "data": {
    "transportId": "transportId123",
    "sctpStreamParameters": { ... },
    "label": "chat",
    "protocol": "",
    "appData": { }
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": {
    "id": "dataProducerId123"
  }
}
```

---

## **10. Request: `changeDisplayName`**
### **Description**:
Changes the display name of a peer.

### **Frontend Must Send**:
```json
{
  "method": "changeDisplayName",
  "data": {
    "displayName": "New Name"
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200
}
```

---

## **11. Request: `getTransportStats`, `getProducerStats`, `getConsumerStats`**
### **Description**:
Fetches statistics for a given transport, producer, or consumer.

### **Frontend Must Send**:
```json
{
  "method": "getTransportStats",
  "data": {
    "transportId": "transportId123"
  }
}
```

OR

```json
{
  "method": "getProducerStats",
  "data": {
    "producerId": "producerId123"
  }
}
```

OR

```json
{
  "method": "getConsumerStats",
  "data": {
    "consumerId": "consumerId123"
  }
}
```

### **Frontend Will Receive (on success)**:
```json
{
  "code": 200,
  "data": { ... }  // Various statistics data
}
```

---

# **Conclusion**
This documentation covers all the essential Protoo requests required for the frontend to interact with the **Mediasoup signaling server**. 

To implement:
1. Ensure **proper request formatting**.
2. Handle **successful and error responses**.
3. Manage peer state changes **(joining, leaving, muting, stats, etc.)**.
4. Handle **transport creation and media exchange** properly.

