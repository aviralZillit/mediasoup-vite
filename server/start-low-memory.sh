#!/bin/bash

# Ultra Low Memory MediaSoup Production Server
# Optimized for systems with limited memory (< 20MB heap)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
LOG_DIR="./logs"
PID_DIR="$LOG_DIR"

echo -e "${BLUE}🚀 Starting Low Memory MediaSoup Server${NC}"
echo "=============================================="

# Create logs directory if it doesn't exist
mkdir -p $LOG_DIR

# Check if server is already running
if [ -f "$PID_DIR/mediasoup.pid" ]; then
    EXISTING_PID=$(cat $PID_DIR/mediasoup.pid)
    if ps -p $EXISTING_PID > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  MediaSoup server is already running (PID: $EXISTING_PID)${NC}"
        echo "Use ./stop-services.sh to stop it first"
        exit 1
    else
        echo -e "${YELLOW}🧹 Cleaning up stale PID file${NC}"
        rm -f $PID_DIR/mediasoup.pid
    fi
fi

# Stop any existing monitoring dashboard
if [ -f "$PID_DIR/monitoring.pid" ]; then
    MONITORING_PID=$(cat $PID_DIR/monitoring.pid)
    if ps -p $MONITORING_PID > /dev/null 2>&1; then
        echo -e "${YELLOW}🛑 Stopping existing monitoring dashboard${NC}"
        kill $MONITORING_PID 2>/dev/null || true
        sleep 2
    fi
    rm -f $PID_DIR/monitoring.pid
fi

# Auto-detect IP address
if command -v ip >/dev/null 2>&1; then
    # Linux
    ANNOUNCED_IP=$(ip route get 8.8.8.8 | grep -oP 'src \K\S+' 2>/dev/null || echo "127.0.0.1")
elif command -v route >/dev/null 2>&1; then
    # macOS
    ANNOUNCED_IP=$(route get default | grep interface | awk '{print $2}' | xargs ifconfig | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -n1 2>/dev/null || echo "127.0.0.1")
else
    ANNOUNCED_IP="127.0.0.1"
fi

echo -e "${BLUE}📡 Using IP address: $ANNOUNCED_IP${NC}"

# Set environment variables for ultra low memory operation
export DEBUG="${DEBUG:-mediasoup:ERROR mediasoup:WARN}"
export MEDIASOUP_LISTEN_IP="0.0.0.0"
export MEDIASOUP_ANNOUNCED_IP="$ANNOUNCED_IP"
export DOMAIN="$ANNOUNCED_IP"
export PROTOO_LISTEN_PORT="4443"
export HTTPS="true"
export INTERACTIVE="false"

# Balanced Node.js memory optimization flags (more conservative)
NODE_FLAGS="--expose-gc --max-old-space-size=16 --optimize-for-size"

echo -e "${YELLOW}🔧 Low Memory Mode Configuration:${NC}"
echo "   Max Old Space: 16MB (balanced)"
echo "   Optimization: Size-optimized"
echo "   GC: Manual trigger available"
echo "   Analytics: Minimal"
echo "   Monitoring: Conservative"
echo ""

# Check if server.js is executable
if [ ! -x "./server.js" ]; then
    echo -e "${YELLOW}🔧 Making server.js executable${NC}"
    chmod +x ./server.js
fi

# Start server with ultra low memory flags
echo -e "${GREEN}🎥 Starting MediaSoup Server (Ultra Low Memory Mode)${NC}"
echo "   Server will be available at: https://$ANNOUNCED_IP:4443"
echo "   Logs: $LOG_DIR/mediasoup.log"
echo ""

# Start server in background with balanced memory settings
nohup node $NODE_FLAGS ./server.js > $LOG_DIR/mediasoup.log 2>&1 &
MEDIASOUP_PID=$!

# Save PID
echo $MEDIASOUP_PID > $PID_DIR/mediasoup.pid

# Wait a moment for server to start
sleep 3

# Check if server started successfully
if ps -p $MEDIASOUP_PID > /dev/null 2>&1; then
    echo -e "${GREEN}✅ MediaSoup Server started successfully (PID: $MEDIASOUP_PID)${NC}"
    
    # Test HTTPS endpoint
    echo -e "${YELLOW}🔍 Testing server connectivity...${NC}"
    if curl -k -s "https://localhost:4443" >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Server is responding to HTTPS requests${NC}"
    else
        echo -e "${YELLOW}⚠️  Server may still be starting up${NC}"
    fi
    
    # Start monitoring dashboard with reduced memory footprint
    echo -e "${GREEN}📊 Starting Ultra Low Memory Monitoring Dashboard${NC}"
    nohup node --max-old-space-size=8 ./monitoring-dashboard.js > $LOG_DIR/monitoring.log 2>&1 &
    MONITORING_PID=$!
    echo $MONITORING_PID > $PID_DIR/monitoring.pid
    
    sleep 2
    if ps -p $MONITORING_PID > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Monitoring Dashboard started (PID: $MONITORING_PID)${NC}"
        echo "   Dashboard: http://localhost:8080"
    else
        echo -e "${RED}❌ Failed to start Monitoring Dashboard${NC}"
        rm -f $PID_DIR/monitoring.pid
    fi
    
else
    echo -e "${RED}❌ Failed to start MediaSoup Server${NC}"
    echo "Check the logs: $LOG_DIR/mediasoup.log"
    rm -f $PID_DIR/mediasoup.pid
    exit 1
fi

echo ""
echo -e "${GREEN}🎉 Low Memory MediaSoup Server is now running!${NC}"
echo ""
echo -e "${YELLOW}📋 Service URLs:${NC}"
echo "   MediaSoup Server: https://$ANNOUNCED_IP:4443"
echo "   Monitoring Dashboard: http://localhost:8080"
echo ""
echo -e "${YELLOW}📁 Log Files:${NC}"
echo "   MediaSoup:   $LOG_DIR/mediasoup.log"
echo "   Monitoring:  $LOG_DIR/monitoring.log"
echo ""
echo -e "${YELLOW}🔧 Memory Optimization Status:${NC}"
echo "   Mode: Ultra Low Memory"
echo "   Max Heap: 12MB"
echo "   Analytics: Minimal (3 errors, 5 events max)"
echo "   Monitoring: 30s intervals"
echo "   GC: Aggressive (every 100ms)"
echo ""
echo -e "${YELLOW}📝 Management Commands:${NC}"
echo "   Stop services: ./stop-services.sh"
echo "   View logs: tail -f $LOG_DIR/mediasoup.log"
echo "   Monitor memory: watch 'curl -s http://localhost:8080/api/analytics | jq .system.memory'"
echo ""
