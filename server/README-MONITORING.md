# Production-Grade MediaSoup Server with Real-time Monitoring

This enhanced MediaSoup server includes comprehensive production-grade features with real-time call analytics, consumer drop detection, and live monitoring capabilities.

## 🚀 Features

### Production-Grade Enhancements
- **Real-time Analytics**: Track consumer/producer behavior during live calls
- **Consumer Drop Detection**: Instant alerts when consumers disconnect
- **Connection Quality Monitoring**: Live quality scoring for all participants
- **Comprehensive Error Tracking**: Detailed error logging and analytics
- **Production Docker Setup**: Multi-stage build with security improvements
- **Health Monitoring**: Server health checks and resource monitoring
- **Real-time Dashboard**: Web-based monitoring interface

### Monitoring Capabilities
- **Room Analytics**: Per-room statistics and participant tracking
- **Peer Monitoring**: Individual peer connection quality and status
- **Server Metrics**: System resource usage and performance metrics
- **Alert System**: Real-time alerts for issues and anomalies
- **Event Tracking**: Comprehensive event logging for all activities

## 📦 Installation

### 1. Install Dependencies
```bash
cd server
npm install
```

### 2. Build Docker Image (Production)
```bash
docker build -t mediasoup-server .
```

### 3. Run with Docker Compose
```bash
docker run -p 4443:4443 -p 8080:8080 -p 40000-40100:40000-40100/udp mediasoup-server
```

## 🔧 Configuration

### Environment Variables
```bash
# MediaSoup Server
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=your.server.ip
DEBUG=mediasoup-demo-server:INFO* *WARN* *ERROR*

# Monitoring Dashboard
MEDIASOUP_URL=https://localhost:4443
MONITORING_PORT=8080
```

### Config Files
- `config.js` - Main MediaSoup server configuration
- `monitoring-dashboard.js` - Monitoring system configuration

## 🚦 Running the System

### Development Mode
```bash
# Start MediaSoup server
npm start

# Start monitoring dashboard (in separate terminal)
npm run monitor
```

### Production Mode
```bash
# Using Docker
docker run -d \
  --name mediasoup-server \
  -p 4443:4443 \
  -p 8080:8080 \
  -p 40000-40100:40000-40100/udp \
  -e MEDIASOUP_ANNOUNCED_IP=your.server.ip \
  mediasoup-server

# Using PM2 (alternative)
pm2 start server.js --name mediasoup-server
pm2 start monitoring-dashboard.js --name monitoring-dashboard
```

## 📊 Monitoring Dashboard

Access the monitoring dashboard at: `http://localhost:8080`

### Dashboard Features

#### 🎯 Real-time Metrics
- **Server Overview**: Uptime, total rooms, peers, workers
- **Room Summary**: Active rooms, participants, producers/consumers
- **System Resources**: Memory usage, CPU metrics

#### 🏠 Room Monitoring
- **Live Room Status**: Current participants and connection quality
- **Producer/Consumer Tracking**: Real-time media stream monitoring
- **Connection Quality Scores**: 1-5 rating for each participant
- **Error Tracking**: Recent errors and issues per room

#### 🚨 Alert System
- **Consumer Drop Alerts**: Instant notifications when consumers disconnect
- **Connection Quality Warnings**: Alerts for poor connection quality
- **High Error Rate Alerts**: Notifications for rooms with frequent errors
- **System Health Alerts**: Server resource and performance warnings

## 📈 API Endpoints

### Analytics API
```bash
# Server analytics
GET /analytics/server

# All rooms analytics
GET /analytics/rooms

# Specific room analytics
GET /analytics/rooms/:roomId

# Peer analytics
GET /analytics/rooms/:roomId/peers/:peerId
```

### Monitoring API
```bash
# Current metrics
GET /api/metrics

# Active alerts
GET /api/alerts

# Clear alerts
DELETE /api/alerts

# Room data
GET /api/rooms/:roomId
```

## 🔍 Consumer Drop Detection

The system automatically detects and reports consumer drops with:

### Detection Mechanisms
- **Transport Close Monitoring**: Tracks transport disconnections
- **Consumer State Tracking**: Monitors consumer lifecycle events
- **Connection Quality Analysis**: Detects degrading connections
- **Error Pattern Recognition**: Identifies problematic patterns

### Alert Types
- **CONSUMER_DROP**: Immediate consumer disconnection
- **LOW_CONNECTION_QUALITY**: Poor connection quality warning
- **HIGH_ERROR_RATE**: Excessive errors in room
- **TRANSPORT_FAILURE**: Transport layer issues

## 📋 Production Deployment

### Docker Deployment
```yaml
# docker-compose.yml
version: '3.8'
services:
  mediasoup:
    build: .
    ports:
      - "4443:4443"
      - "8080:8080"
      - "40000-40100:40000-40100/udp"
    environment:
      - MEDIASOUP_ANNOUNCED_IP=your.server.ip
      - NODE_ENV=production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-k", "-f", "https://localhost:4443/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Kubernetes Deployment
```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mediasoup-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mediasoup-server
  template:
    metadata:
      labels:
        app: mediasoup-server
    spec:
      containers:
      - name: mediasoup
        image: mediasoup-server:latest
        ports:
        - containerPort: 4443
        - containerPort: 8080
        env:
        - name: MEDIASOUP_ANNOUNCED_IP
          value: "your.k8s.ip"
```

### Nginx Configuration
```nginx
# nginx.conf
upstream mediasoup {
    server localhost:4443;
}

upstream monitoring {
    server localhost:8080;
}

server {
    listen 443 ssl;
    server_name your.domain.com;

    location / {
        proxy_pass http://mediasoup;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /monitor {
        proxy_pass http://monitoring;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

## 🔧 Advanced Configuration

### Custom Alert Thresholds
```javascript
// In monitoring-dashboard.js
const config = {
    alertThresholds: {
        highPacketLoss: 5,     // 5% packet loss
        lowQualityScore: 2,    // Quality score below 2
        highErrorRate: 10,     // More than 10 errors per minute
        lowFramerate: 15       // Video framerate below 15fps
    }
};
```

### Custom Metrics Collection
```javascript
// Add custom metrics in Room.js
_collectCustomMetrics() {
    return {
        customMetric1: this.calculateCustomMetric1(),
        customMetric2: this.calculateCustomMetric2()
    };
}
```

## 🐛 Troubleshooting

### Common Issues

#### Consumer Drops
1. **Check Network Quality**: Monitor connection quality scores
2. **Review Error Logs**: Check recent errors in affected rooms
3. **Verify TURN/STUN**: Ensure proper WebRTC connectivity
4. **Check Server Resources**: Monitor CPU/memory usage

#### Monitoring Dashboard Issues
1. **Connection Errors**: Verify MediaSoup server is running on port 4443
2. **Missing Data**: Check API endpoints are accessible
3. **Alert Not Working**: Verify alert thresholds configuration

#### Performance Issues
1. **High Memory Usage**: Check for memory leaks in analytics
2. **Slow Response**: Optimize metrics collection frequency
3. **Too Many Alerts**: Adjust alert thresholds

## 📝 Logs and Debugging

### Log Locations
- **Server Logs**: Console output or `/var/log/mediasoup.log`
- **Analytics Logs**: Room analytics and events
- **Error Logs**: Detailed error tracking with stack traces

### Debug Mode
```bash
DEBUG=*mediasoup*:WARN,*mediasoup*:ERROR,*analytics* npm start
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- MediaSoup team for the excellent WebRTC framework
- Socket.io for real-time communication
- Express.js for the web framework
- Chart.js for monitoring visualizations
