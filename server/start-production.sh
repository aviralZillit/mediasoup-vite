#!/bin/bash

# Production MediaSoup Server Startup Script
# This script starts both the MediaSoup server and monitoring dashboard

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
MEDIASOUP_PORT=4443
MONITORING_PORT=8080
LOG_DIR="./logs"

# Create logs directory
mkdir -p $LOG_DIR

echo -e "${GREEN}🚀 Starting Production MediaSoup Server with Monitoring${NC}"
echo "=================================================="

# Check if ports are available
check_port() {
    local port=$1
    local service=$2
    
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null; then
        echo -e "${RED}❌ Port $port is already in use (required for $service)${NC}"
        echo "Please stop the service using port $port or change the configuration"
        exit 1
    else
        echo -e "${GREEN}✅ Port $port is available for $service${NC}"
    fi
}

# Check dependencies
check_dependencies() {
    echo -e "${YELLOW}📦 Checking dependencies...${NC}"
    
    if ! command -v node &> /dev/null; then
        echo -e "${RED}❌ Node.js is not installed${NC}"
        exit 1
    fi
    
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}❌ npm is not installed${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Node.js $(node --version) and npm $(npm --version) are available${NC}"
    
    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}📦 Installing dependencies...${NC}"
        npm install
    fi
}

# Auto-detect local IP (similar to run.sh)
get_local_ip() {
    # Try common network interfaces on macOS
    for interface in en0 en1 en2 en3 en4; do
        ip=$(ipconfig getifaddr $interface 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$ip" ]; then
            echo $ip
            return 0
        fi
    done
    
    # Fallback for Linux
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if [ $? -eq 0 ] && [ -n "$ip" ]; then
        echo $ip
        return 0
    fi
    
    # Final fallback
    echo "127.0.0.1"
}

# Start MediaSoup server
start_mediasoup() {
    echo -e "${YELLOW}🎥 Starting MediaSoup Server on port $MEDIASOUP_PORT...${NC}"
    
    # Auto-detect IP if not set
    local_ip=$(get_local_ip)
    echo -e "${GREEN}✅ Detected local IP: $local_ip${NC}"
    
    # Set environment variables (similar to run.sh)
    export DEBUG="${DEBUG:-mediasoup-demo-server:INFO* *WARN* *ERROR*}"
    export INTERACTIVE="${INTERACTIVE:-false}"
    export MEDIASOUP_ANNOUNCED_IP="${MEDIASOUP_ANNOUNCED_IP:-$local_ip}"
    
    echo -e "${YELLOW}📋 Environment:${NC}"
    echo "   DEBUG=$DEBUG"
    echo "   INTERACTIVE=$INTERACTIVE"
    echo "   MEDIASOUP_ANNOUNCED_IP=$MEDIASOUP_ANNOUNCED_IP"
    
    # Start server in background using ./server.js (like run.sh)
    # Enable garbage collection monitoring for memory optimization
    nohup node --expose-gc ./server.js > $LOG_DIR/mediasoup.log 2>&1 &
    MEDIASOUP_PID=$!
    
    echo "MediaSoup PID: $MEDIASOUP_PID"
    echo $MEDIASOUP_PID > $LOG_DIR/mediasoup.pid
    
    # Wait for server to start
    echo "Waiting for MediaSoup server to start..."
    for i in {1..30}; do
        if curl -k -s https://localhost:$MEDIASOUP_PORT/health >/dev/null 2>&1; then
            echo -e "${GREEN}✅ MediaSoup Server started successfully${NC}"
            return 0
        fi
        sleep 1
    done
    
    echo -e "${RED}❌ MediaSoup Server failed to start within 30 seconds${NC}"
    return 1
}

# Start monitoring dashboard
start_monitoring() {
    echo -e "${YELLOW}📊 Starting Monitoring Dashboard on port $MONITORING_PORT...${NC}"
    
    # Set monitoring environment
    export MEDIASOUP_URL="https://localhost:$MEDIASOUP_PORT"
    
    # Start monitoring dashboard in background
    nohup node monitoring-dashboard.js > $LOG_DIR/monitoring.log 2>&1 &
    MONITORING_PID=$!
    
    echo "Monitoring PID: $MONITORING_PID"
    echo $MONITORING_PID > $LOG_DIR/monitoring.pid
    
    # Wait for dashboard to start
    echo "Waiting for Monitoring Dashboard to start..."
    for i in {1..15}; do
        if curl -s http://localhost:$MONITORING_PORT >/dev/null 2>&1; then
            echo -e "${GREEN}✅ Monitoring Dashboard started successfully${NC}"
            return 0
        fi
        sleep 1
    done
    
    echo -e "${RED}❌ Monitoring Dashboard failed to start within 15 seconds${NC}"
    return 1
}

# Show status
show_status() {
    echo ""
    echo -e "${GREEN}🎉 Production MediaSoup Server is now running!${NC}"
    echo "=================================================="
    echo -e "📺 MediaSoup Server:     ${GREEN}https://localhost:$MEDIASOUP_PORT${NC}"
    echo -e "📊 Monitoring Dashboard: ${GREEN}http://localhost:$MONITORING_PORT${NC}"
    echo ""
    echo -e "${YELLOW}📋 Service Status:${NC}"
    
    if ps -p $(cat $LOG_DIR/mediasoup.pid 2>/dev/null) > /dev/null 2>&1; then
        echo -e "   MediaSoup Server:     ${GREEN}✅ Running${NC} (PID: $(cat $LOG_DIR/mediasoup.pid))"
    else
        echo -e "   MediaSoup Server:     ${RED}❌ Not Running${NC}"
    fi
    
    if ps -p $(cat $LOG_DIR/monitoring.pid 2>/dev/null) > /dev/null 2>&1; then
        echo -e "   Monitoring Dashboard: ${GREEN}✅ Running${NC} (PID: $(cat $LOG_DIR/monitoring.pid))"
    else
        echo -e "   Monitoring Dashboard: ${RED}❌ Not Running${NC}"
    fi
    
    echo ""
    echo -e "${YELLOW}📁 Log Files:${NC}"
    echo "   MediaSoup:   $LOG_DIR/mediasoup.log"
    echo "   Monitoring:  $LOG_DIR/monitoring.log"
    echo ""
    echo -e "${YELLOW}🛑 To stop services:${NC}"
    echo "   ./stop-services.sh"
    echo ""
}

# Cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}🛑 Shutting down services...${NC}"
    
    if [ -f "$LOG_DIR/mediasoup.pid" ]; then
        kill $(cat $LOG_DIR/mediasoup.pid) 2>/dev/null || true
        rm -f $LOG_DIR/mediasoup.pid
    fi
    
    if [ -f "$LOG_DIR/monitoring.pid" ]; then
        kill $(cat $LOG_DIR/monitoring.pid) 2>/dev/null || true
        rm -f $LOG_DIR/monitoring.pid
    fi
    
    echo -e "${GREEN}✅ Services stopped${NC}"
    exit 0
}

# Set trap for cleanup
trap cleanup SIGINT SIGTERM

# Main execution
main() {
    check_dependencies
    check_port $MEDIASOUP_PORT "MediaSoup Server"
    check_port $MONITORING_PORT "Monitoring Dashboard"
    
    if start_mediasoup && start_monitoring; then
        show_status
        
        # Keep script running
        echo -e "${YELLOW}💡 Press Ctrl+C to stop all services${NC}"
        while true; do
            sleep 5
            
            # Check if services are still running
            if ! ps -p $(cat $LOG_DIR/mediasoup.pid 2>/dev/null) > /dev/null 2>&1; then
                echo -e "${RED}❌ MediaSoup Server has stopped unexpectedly${NC}"
                cleanup
            fi
            
            if ! ps -p $(cat $LOG_DIR/monitoring.pid 2>/dev/null) > /dev/null 2>&1; then
                echo -e "${RED}❌ Monitoring Dashboard has stopped unexpectedly${NC}"
                cleanup
            fi
        done
    else
        echo -e "${RED}❌ Failed to start services${NC}"
        cleanup
    fi
}

# Run main function
main "$@"
