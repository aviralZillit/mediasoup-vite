#!/bin/bash

# MediaSoup Real-time Stats Checker
# Tool to easily view producer and consumer statistics

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVER_URL="https://localhost:4443"

echo -e "${BLUE}📊 MediaSoup Real-time Stats Monitor${NC}"
echo "====================================="
echo ""

# Function to check if server is running
check_server() {
    if ! curl -k -s "$SERVER_URL/health" >/dev/null 2>&1; then
        echo -e "${RED}❌ MediaSoup server is not accessible at $SERVER_URL${NC}"
        echo "Please start the server first: ./start-production.sh"
        exit 1
    fi
}

# Function to list all rooms
list_rooms() {
    echo -e "${YELLOW}📋 Available Rooms:${NC}"
    local rooms=$(curl -k -s "$SERVER_URL/analytics/rooms" | jq -r '.[] | "Room: " + .roomId + " - Peers: " + (.currentPeers | tostring) + ", Producers: " + (.totalProducers | tostring) + ", Consumers: " + (.totalConsumers | tostring)')
    
    if [ -z "$rooms" ]; then
        echo -e "${CYAN}   No active rooms found${NC}"
    else
        echo "$rooms" | while read -r line; do
            echo -e "${CYAN}   $line${NC}"
        done
    fi
    echo ""
}

# Function to show server overview
show_server_stats() {
    echo -e "${YELLOW}🖥️  Server Overview:${NC}"
    local server_stats=$(curl -k -s "$SERVER_URL/analytics/server")
    
    if [ ! -z "$server_stats" ]; then
        echo "$server_stats" | jq -r '"   Total Rooms: " + (.totalRooms | tostring) + 
                                         "\n   Total Peers: " + (.totalPeers | tostring) + 
                                         "\n   Total Producers: " + (.totalProducers | tostring) + 
                                         "\n   Total Consumers: " + (.totalConsumers | tostring) + 
                                         "\n   Memory Usage: " + (.memoryUsage.heapUsed / 1024 / 1024 | floor | tostring) + "MB / " + (.memoryUsage.heapTotal / 1024 / 1024 | floor | tostring) + "MB"'
    else
        echo -e "${RED}   Failed to fetch server stats${NC}"
    fi
    echo ""
}

# Function to show room details
show_room_details() {
    local room_id=$1
    echo -e "${YELLOW}🏠 Room Details: $room_id${NC}"
    
    local room_data=$(curl -k -s "$SERVER_URL/analytics/rooms/$room_id")
    if [ ! -z "$room_data" ]; then
        echo "$room_data" | jq -r '"   Room ID: " + .roomId + 
                                   "\n   Current Peers: " + (.currentPeers | tostring) + 
                                   "\n   Total Producers: " + (.totalProducers | tostring) + 
                                   "\n   Total Consumers: " + (.totalConsumers | tostring) + 
                                   "\n   Data Sent: " + (.dataTransferred.sent / 1024 / 1024 | floor | tostring) + "MB" + 
                                   "\n   Data Received: " + (.dataTransferred.received / 1024 / 1024 | floor | tostring) + "MB"'
    else
        echo -e "${RED}   Room not found or failed to fetch data${NC}"
    fi
    echo ""
}

# Function to show producers in a room
show_producers() {
    local room_id=$1
    echo -e "${YELLOW}📤 Producers in Room: $room_id${NC}"
    
    local producers=$(curl -k -s "$SERVER_URL/analytics/rooms/$room_id/producers")
    if [ ! -z "$producers" ] && [ "$producers" != "null" ]; then
        echo "$producers" | jq -r '.[] | "   Producer ID: " + .id + " | Peer: " + .peerId + " | Kind: " + .kind + " | Paused: " + (.paused | tostring)'
    else
        echo -e "${CYAN}   No producers found in this room${NC}"
    fi
    echo ""
}

# Function to show consumers in a room
show_consumers() {
    local room_id=$1
    echo -e "${YELLOW}📥 Consumers in Room: $room_id${NC}"
    
    local consumers=$(curl -k -s "$SERVER_URL/analytics/rooms/$room_id/consumers")
    if [ ! -z "$consumers" ] && [ "$consumers" != "null" ]; then
        echo "$consumers" | jq -r '.[] | "   Consumer ID: " + .id + " | Peer: " + .peerId + " | Kind: " + .kind + " | Paused: " + (.paused | tostring)'
    else
        echo -e "${CYAN}   No consumers found in this room${NC}"
    fi
    echo ""
}

# Function to show detailed stats for a specific producer
show_producer_stats() {
    local room_id=$1
    local producer_id=$2
    echo -e "${YELLOW}📊 Producer Stats: $producer_id${NC}"
    
    local stats=$(curl -k -s "$SERVER_URL/analytics/rooms/$room_id/producers/$producer_id")
    if [ ! -z "$stats" ] && [ "$stats" != "null" ]; then
        echo "$stats" | jq -r '"   Producer ID: " + .id + 
                               "\n   Peer ID: " + .peerId + 
                               "\n   Kind: " + .kind + 
                               "\n   Paused: " + (.paused | tostring) + 
                               "\n   Score: " + (.score | tostring) + 
                               "\n   RTP Parameters: " + (.rtpParameters.codecs[0].mimeType // "N/A")'
    else
        echo -e "${RED}   Producer not found or failed to fetch stats${NC}"
    fi
    echo ""
}

# Function to show detailed stats for a specific consumer
show_consumer_stats() {
    local room_id=$1
    local consumer_id=$2
    echo -e "${YELLOW}📊 Consumer Stats: $consumer_id${NC}"
    
    local stats=$(curl -k -s "$SERVER_URL/analytics/rooms/$room_id/consumers/$consumer_id")
    if [ ! -z "$stats" ] && [ "$stats" != "null" ]; then
        echo "$stats" | jq -r '"   Consumer ID: " + .id + 
                               "\n   Peer ID: " + .peerId + 
                               "\n   Kind: " + .kind + 
                               "\n   Paused: " + (.paused | tostring) + 
                               "\n   Producer Paused: " + (.producerPaused | tostring) + 
                               "\n   Score: " + (.score | tostring)'
    else
        echo -e "${RED}   Consumer not found or failed to fetch stats${NC}"
    fi
    echo ""
}

# Main script logic
check_server

case "$1" in
    "server")
        show_server_stats
        ;;
    "rooms")
        list_rooms
        ;;
    "room")
        if [ -z "$2" ]; then
            echo -e "${RED}Usage: $0 room <room_id>${NC}"
            exit 1
        fi
        show_room_details "$2"
        ;;
    "producers")
        if [ -z "$2" ]; then
            echo -e "${RED}Usage: $0 producers <room_id>${NC}"
            exit 1
        fi
        show_producers "$2"
        ;;
    "consumers")
        if [ -z "$2" ]; then
            echo -e "${RED}Usage: $0 consumers <room_id>${NC}"
            exit 1
        fi
        show_consumers "$2"
        ;;
    "producer")
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo -e "${RED}Usage: $0 producer <room_id> <producer_id>${NC}"
            exit 1
        fi
        show_producer_stats "$2" "$3"
        ;;
    "consumer")
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo -e "${RED}Usage: $0 consumer <room_id> <consumer_id>${NC}"
            exit 1
        fi
        show_consumer_stats "$2" "$3"
        ;;
    "all")
        if [ -z "$2" ]; then
            echo -e "${RED}Usage: $0 all <room_id>${NC}"
            exit 1
        fi
        show_room_details "$2"
        show_producers "$2"
        show_consumers "$2"
        ;;
    "monitor")
        if [ -z "$2" ]; then
            echo -e "${RED}Usage: $0 monitor <room_id>${NC}"
            exit 1
        fi
        echo -e "${GREEN}🔄 Real-time monitoring for room: $2 (Press Ctrl+C to stop)${NC}"
        echo ""
        while true; do
            clear
            echo -e "${BLUE}📊 MediaSoup Real-time Monitor - Room: $2${NC}"
            echo "========================================"
            show_room_details "$2"
            show_producers "$2"
            show_consumers "$2"
            echo -e "${CYAN}Last updated: $(date)${NC}"
            sleep 5
        done
        ;;
    *)
        echo -e "${GREEN}📊 MediaSoup Stats Monitor Usage:${NC}"
        echo ""
        echo -e "${YELLOW}Available Commands:${NC}"
        echo "  $0 server                    - Show server overview"
        echo "  $0 rooms                     - List all active rooms"
        echo "  $0 room <room_id>           - Show room details"
        echo "  $0 producers <room_id>      - List producers in room"
        echo "  $0 consumers <room_id>      - List consumers in room"
        echo "  $0 producer <room_id> <id>  - Show detailed producer stats"
        echo "  $0 consumer <room_id> <id>  - Show detailed consumer stats"
        echo "  $0 all <room_id>            - Show complete room overview"
        echo "  $0 monitor <room_id>        - Real-time monitoring (5s refresh)"
        echo ""
        echo -e "${CYAN}Examples:${NC}"
        echo "  $0 server"
        echo "  $0 rooms"
        echo "  $0 all test-room"
        echo "  $0 monitor test-room"
        echo ""
        
        # Show current server status
        show_server_stats
        list_rooms
        ;;
esac
