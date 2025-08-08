# 📊 MediaSoup Real-time Consumer & Producer Stats Guide

## Overview
Your production-grade MediaSoup server now has comprehensive real-time analytics for monitoring consumer and producer behavior during live calls. This guide shows you all the ways to access this data.

## 🚀 Quick Start

### Check Current Server Status
```bash
./check-stats.sh server
```

### List All Active Rooms
```bash
./check-stats.sh rooms
```

### Get Complete Room Overview
```bash
./check-stats.sh all <room_id>
```

### Real-time Monitoring (5-second updates)
```bash
./check-stats.sh monitor <room_id>
```

## 📊 Detailed Analytics

### Current Live Session Example
Based on your current active session, here's what you can see:

**Room ID:** `hztp8pdv`
- **Peers:** 2 active users ("Aipom" and "Quilladin")
- **Producers:** 4 total (2 audio, 2 video)
- **Consumers:** 4 total (cross-consuming each other's media)

### Producer Stats Include:
- **Producer ID** and **Peer Information**
- **Media Type**: audio/video
- **Pause Status**: true/false
- **Quality Score**: 0-10 (10 = perfect)
- **Codec Information**: VP8, Opus, etc.
- **RTP Parameters**: detailed media settings
- **Simulcast Layers**: for video quality adaptation

### Consumer Stats Include:
- **Consumer ID** and **Peer Information**
- **Producer Connection**: which producer they're consuming
- **Pause Status**: consumer and producer pause states
- **Quality Scores**: real-time quality metrics
- **Layer Information**: current and preferred quality layers
- **Producer Scores**: per-layer quality indicators

## 🔧 CLI Commands Reference

### Basic Commands
```bash
# Server overview
./check-stats.sh server

# List rooms
./check-stats.sh rooms

# Room details
./check-stats.sh room <room_id>

# All producers in room
./check-stats.sh producers <room_id>

# All consumers in room
./check-stats.sh consumers <room_id>

# Complete room overview
./check-stats.sh all <room_id>

# Real-time monitoring
./check-stats.sh monitor <room_id>
```

### Advanced Commands
```bash
# Specific producer details
./check-stats.sh producer <room_id> <producer_id>

# Specific consumer details
./check-stats.sh consumer <room_id> <consumer_id>
```

## 🌐 API Endpoints

### REST API Access
All stats are available via HTTPS API endpoints:

```bash
# Server overview
curl -k -s https://localhost:4443/analytics/server | jq .

# All rooms
curl -k -s https://localhost:4443/analytics/rooms | jq .

# Room details
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID | jq .

# All producers in room
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/producers | jq .

# All consumers in room
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/consumers | jq .

# Specific producer
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/producers/PRODUCER_ID | jq .

# Specific consumer
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/consumers/CONSUMER_ID | jq .

# Peer-specific stats
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/peers/PEER_ID | jq .
```

## 🎯 Consumer Drop Detection

### Automatic Detection
The system automatically detects and logs:
- Consumer disconnections
- Quality degradation below thresholds
- Network connectivity issues
- Bitrate drops and packet loss
- Transport errors

### Monitoring Quality Issues
```bash
# Check connection quality for all peers
./check-stats.sh all <room_id>

# Monitor for drops in real-time
./check-stats.sh monitor <room_id>

# Check server logs for detailed error information
tail -f logs/mediasoup.log | grep -E "(consumer|producer|transport)" 
```

## 📈 Real-time Monitoring Dashboard

### Web Interface
Access the monitoring dashboard at: **http://localhost:8080**

### Features:
- Real-time visual charts
- Automatic updates every 30 seconds
- Historical data tracking
- Quality score visualization
- Connection status indicators

## 🔍 Understanding the Data

### Quality Scores
- **10**: Perfect connection
- **8-9**: Good quality
- **5-7**: Moderate quality
- **3-4**: Poor quality (potential issues)
- **0-2**: Very poor (likely drops/disconnections)

### Producer/Consumer States
- **Paused**: Media flow stopped (user muted/disabled camera)
- **Active**: Media flowing normally
- **Producer Paused**: Source media paused
- **Consumer Paused**: Receiving side paused

### Layer Information (Video)
- **Spatial Layers**: Different resolutions (0=low, 1=medium, 2=high)
- **Temporal Layers**: Different frame rates
- **Current vs Preferred**: Actual vs requested quality

## 🚨 Troubleshooting

### Common Issues

#### Consumers Not Appearing
```bash
# Check if peers are properly connected
./check-stats.sh room <room_id>

# Verify producers are active
./check-stats.sh producers <room_id>
```

#### Quality Issues
```bash
# Check individual consumer scores
./check-stats.sh consumers <room_id>

# Monitor for changes
./check-stats.sh monitor <room_id>
```

#### Connection Problems
```bash
# Check server logs
tail -f logs/mediasoup.log

# Check peer connection quality
curl -k -s https://localhost:4443/analytics/rooms/ROOM_ID/peers/PEER_ID | jq .
```

## 🎬 Example: Current Live Session Analysis

Based on your current session, here's what the stats show:

### Producers:
1. **Aipom (mwszuj8k)**:
   - Audio: Paused (user muted)
   - Video: Active (VP8, simulcast with 2 layers)

2. **Quilladin (ayib5exx)**:
   - Audio: Paused (user muted) 
   - Video: Active (VP8, simulcast with 3 layers)

### Consumers:
1. **Cross-consumption working perfectly**:
   - Each peer consuming the other's media
   - Audio consumers ready (but producers paused)
   - Video consumers active with high quality scores (10/10)
   - Adaptive quality working (layer switching)

### Quality Analysis:
- **Excellent connection quality** (all scores = 10)
- **Simulcast working** (multiple quality layers available)
- **No packet loss** detected
- **Low latency** transmission

## 🔄 Continuous Monitoring

### For Production Use
```bash
# Set up continuous monitoring
nohup ./check-stats.sh monitor <room_id> > room_monitor.log 2>&1 &

# View logs
tail -f room_monitor.log

# Stop monitoring
pkill -f "check-stats.sh monitor"
```

### Integration with Monitoring Systems
The API endpoints can be integrated with:
- Prometheus/Grafana for metrics visualization
- Custom alerting systems
- Load balancing decisions based on quality scores
- Automatic scaling based on consumer counts

---

**🎉 Your MediaSoup server now provides comprehensive real-time visibility into consumer and producer behavior, enabling proactive monitoring and immediate detection of any issues during live calls!**
