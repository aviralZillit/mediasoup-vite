#!/bin/bash

# Memory Usage Monitor for MediaSoup Server
# Tracks memory usage in real-time to validate optimizations

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 MediaSoup Memory Monitor${NC}"
echo "=========================="
echo ""

# Function to format bytes to MB
format_memory() {
    echo "scale=1; $1 / 1024 / 1024" | bc -l
}

# Function to get process memory info
get_process_memory() {
    local pid=$1
    local name=$2
    
    if ps -p $pid > /dev/null 2>&1; then
        local mem_kb=$(ps -o rss= -p $pid | awk '{sum += $1} END {print sum}')
        local mem_mb=$(format_memory $(($mem_kb * 1024)))
        echo -e "${GREEN}✅ $name (PID: $pid): ${mem_mb}MB${NC}"
        return 0
    else
        echo -e "${RED}❌ $name (PID: $pid): Not running${NC}"
        return 1
    fi
}

# Function to monitor system memory
monitor_system() {
    echo -e "${YELLOW}💾 System Memory Status:${NC}"
    
    if command -v free >/dev/null 2>&1; then
        # Linux
        free -h
    elif command -v vm_stat >/dev/null 2>&1; then
        # macOS
        local pages_free=$(vm_stat | grep "Pages free" | awk '{print $3}' | sed 's/\.//')
        local pages_active=$(vm_stat | grep "Pages active" | awk '{print $3}' | sed 's/\.//')
        local pages_inactive=$(vm_stat | grep "Pages inactive" | awk '{print $3}' | sed 's/\.//')
        local pages_wired=$(vm_stat | grep "Pages wired down" | awk '{print $4}' | sed 's/\.//')
        
        local page_size=4096
        local free_mb=$(format_memory $(($pages_free * $page_size)))
        local active_mb=$(format_memory $(($pages_active * $page_size)))
        local inactive_mb=$(format_memory $(($pages_inactive * $page_size)))
        local wired_mb=$(format_memory $(($pages_wired * $page_size)))
        
        echo "Free: ${free_mb}MB, Active: ${active_mb}MB, Inactive: ${inactive_mb}MB, Wired: ${wired_mb}MB"
    fi
    echo ""
}

# Function to get Node.js heap info from API
get_heap_info() {
    echo -e "${YELLOW}🧠 Node.js Heap Status:${NC}"
    
    if curl -s http://localhost:8080/api/analytics >/dev/null 2>&1; then
        local heap_info=$(curl -s http://localhost:8080/api/analytics | jq -r '.system.memory // empty' 2>/dev/null)
        if [ ! -z "$heap_info" ]; then
            echo "$heap_info" | jq -r '"Heap Used: " + (.heapUsed | tostring) + "MB / " + (.heapTotal | tostring) + "MB (" + (.heapPercent | tostring) + "%)"' 2>/dev/null || echo "Heap info available via API"
        else
            echo "Heap info not available"
        fi
    else
        echo "Monitoring API not accessible"
    fi
    echo ""
}

# Check if MediaSoup processes are running
echo -e "${YELLOW}🔍 Checking MediaSoup Processes:${NC}"

MEDIASOUP_PID=""
MONITORING_PID=""

if [ -f "./logs/mediasoup.pid" ]; then
    MEDIASOUP_PID=$(cat ./logs/mediasoup.pid)
fi

if [ -f "./logs/monitoring.pid" ]; then
    MONITORING_PID=$(cat ./logs/monitoring.pid)
fi

# Monitor processes
mediasoup_running=false
monitoring_running=false

if [ ! -z "$MEDIASOUP_PID" ]; then
    if get_process_memory "$MEDIASOUP_PID" "MediaSoup Server"; then
        mediasoup_running=true
    fi
fi

if [ ! -z "$MONITORING_PID" ]; then
    if get_process_memory "$MONITORING_PID" "Monitoring Dashboard"; then
        monitoring_running=true
    fi
fi

echo ""

# Show system memory
monitor_system

# Show heap info if available
if [ "$monitoring_running" = true ]; then
    get_heap_info
fi

# Total Node.js memory usage
echo -e "${YELLOW}📊 Total Node.js Memory Usage:${NC}"
node_total=$(ps aux | grep node | grep -v grep | awk '{sum += $6} END {print sum/1024}' | bc -l 2>/dev/null || echo "0")
echo -e "All Node.js processes: ${node_total}MB"
echo ""

# Recommendations
echo -e "${BLUE}💡 Memory Optimization Status:${NC}"
if [ "$mediasoup_running" = true ]; then
    echo -e "${GREEN}✅ MediaSoup server is running${NC}"
    echo "   - Monitor heap usage via: curl -s http://localhost:8080/api/analytics | jq .system.memory"
    echo "   - Watch memory in real-time: watch -n 5 '$0'"
    echo "   - Current optimizations: Ultra-aggressive GC, minimal analytics, conservative monitoring"
else
    echo -e "${RED}❌ MediaSoup server is not running${NC}"
    echo "   - Start with: ./start-low-memory.sh"
    echo "   - Check logs: tail -f logs/mediasoup.log"
fi

echo ""
echo -e "${YELLOW}🔧 Available Commands:${NC}"
echo "   Real-time monitoring: watch -n 5 '$0'"
echo "   Start server: ./start-low-memory.sh"
echo "   Stop server: ./stop-services.sh"
echo "   View heap details: curl -s http://localhost:8080/api/analytics | jq .system"
