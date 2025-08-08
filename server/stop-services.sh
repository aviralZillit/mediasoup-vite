#!/bin/bash

# Stop Production MediaSoup Server and Monitoring Dashboard

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

LOG_DIR="./logs"

echo -e "${YELLOW}🛑 Stopping MediaSoup Production Services${NC}"
echo "=============================================="

# Stop MediaSoup server
if [ -f "$LOG_DIR/mediasoup.pid" ]; then
    MEDIASOUP_PID=$(cat $LOG_DIR/mediasoup.pid)
    if ps -p $MEDIASOUP_PID > /dev/null 2>&1; then
        echo -e "${YELLOW}🎥 Stopping MediaSoup Server (PID: $MEDIASOUP_PID)${NC}"
        kill $MEDIASOUP_PID
        
        # Wait for graceful shutdown
        for i in {1..10}; do
            if ! ps -p $MEDIASOUP_PID > /dev/null 2>&1; then
                echo -e "${GREEN}✅ MediaSoup Server stopped gracefully${NC}"
                break
            fi
            sleep 1
        done
        
        # Force kill if still running
        if ps -p $MEDIASOUP_PID > /dev/null 2>&1; then
            echo -e "${YELLOW}⚡ Force stopping MediaSoup Server${NC}"
            kill -9 $MEDIASOUP_PID
        fi
    else
        echo -e "${YELLOW}⚠️  MediaSoup Server was not running${NC}"
    fi
    rm -f $LOG_DIR/mediasoup.pid
else
    echo -e "${YELLOW}⚠️  No MediaSoup Server PID file found${NC}"
fi

# Stop monitoring dashboard
if [ -f "$LOG_DIR/monitoring.pid" ]; then
    MONITORING_PID=$(cat $LOG_DIR/monitoring.pid)
    if ps -p $MONITORING_PID > /dev/null 2>&1; then
        echo -e "${YELLOW}📊 Stopping Monitoring Dashboard (PID: $MONITORING_PID)${NC}"
        kill $MONITORING_PID
        
        # Wait for graceful shutdown
        for i in {1..10}; do
            if ! ps -p $MONITORING_PID > /dev/null 2>&1; then
                echo -e "${GREEN}✅ Monitoring Dashboard stopped gracefully${NC}"
                break
            fi
            sleep 1
        done
        
        # Force kill if still running
        if ps -p $MONITORING_PID > /dev/null 2>&1; then
            echo -e "${YELLOW}⚡ Force stopping Monitoring Dashboard${NC}"
            kill -9 $MONITORING_PID
        fi
    else
        echo -e "${YELLOW}⚠️  Monitoring Dashboard was not running${NC}"
    fi
    rm -f $LOG_DIR/monitoring.pid
else
    echo -e "${YELLOW}⚠️  No Monitoring Dashboard PID file found${NC}"
fi

# Kill any remaining processes on the ports
echo -e "${YELLOW}🔍 Checking for remaining processes on ports 4443 and 8080${NC}"

# Check port 4443 (MediaSoup)
if lsof -Pi :4443 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}⚡ Killing remaining process on port 4443${NC}"
    lsof -ti:4443 | xargs kill -9 2>/dev/null || true
fi

# Check port 8080 (Monitoring)
if lsof -Pi :8080 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo -e "${YELLOW}⚡ Killing remaining process on port 8080${NC}"
    lsof -ti:8080 | xargs kill -9 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}✅ All MediaSoup services have been stopped${NC}"
echo ""
echo -e "${YELLOW}📁 Log files preserved in:${NC}"
echo "   MediaSoup:   $LOG_DIR/mediasoup.log"
echo "   Monitoring:  $LOG_DIR/monitoring.log"
echo ""
