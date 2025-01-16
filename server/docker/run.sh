#!/usr/bin/env bash

function log_info() {
	echo -e "\033[0;36m[run.sh] [INFO] $@\033[0m"
}

function log_error() {
	echo -e "\033[0;31m[run.sh] [ERROR] $@\033[0m" 1>&2;
}

function check_os() {
	unameOut="$(uname -s)"

	case "${unameOut}" in
		Linux*)   os=Linux;;
		Darwin*)  os=Mac;;
		CYGWIN*)  os=Cygwin;;
		MINGW*)   os=MinGw;;
		*)        os="UNKNOWN:${unameOut}"
	esac

	echo ${os}
}

function get_local_ip_in_linux() {
	hostname -I | awk '{print $1}'
	if [ $? -eq 0 ] ; then return 0 ; fi

	return 1;
}

function get_local_ip_in_mac() {
	ipconfig getifaddr en0
	if [ $? -eq 0 ] ; then return 0 ; fi

	ipconfig getifaddr en1
	if [ $? -eq 0 ] ; then return 0 ; fi

	ipconfig getifaddr en2
	if [ $? -eq 0 ] ; then return 0 ; fi

	ipconfig getifaddr en3
	if [ $? -eq 0 ] ; then return 0 ; fi

	ipconfig getifaddr en4
	if [ $? -eq 0 ] ; then return 0 ; fi

	return 1;
}

os=$(check_os)

log_info "detected OS: ${os}"

case "${os}" in
	Linux)
		ip=$(get_local_ip_in_linux)
		;;

	Mac)
		ip=$(get_local_ip_in_mac)
		;;

	*)
		log_error "OS ${os} not supported by run.sh"
		exit 1
esac

if [ $? -ne 0 ]; then
    log_error "could not determine local IP"
    exit 1
fi

log_info "detected local IP: ${ip}"

# Set env variables (don't override if already set).
export DEBUG=${DEBUG:="mediasoup-demo-server:INFO* *WARN* *ERROR*"}
export INTERACTIVE=${INTERACTIVE:="true"}
export MEDIASOUP_ANNOUNCED_IP=${MEDIASOUP_ANNOUNCED_IP:="${ip}"}

log_info "running mediasoup-demo server.js with envs:"
log_info "- DEBUG=${DEBUG}"
log_info "- INTERACTIVE=${INTERACTIVE}"
for env in $(env)
do
	if [[ $env = MEDIASOUP_* ]]
	then
		log_info "- ${env}"
	fi
done

# Load .env file if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Export environment variables

export HTTPS_CERT_FULLCHAIN=${HTTPS_CERT_FULLCHAIN:="$PWD/certs/fullchain.pem"}
export HTTPS_CERT_PRIVKEY=${HTTPS_CERT_PRIVKEY:="$PWD/certs/privkey.pem"}


# Valgrind related options
export MEDIASOUP_USE_VALGRIND=${MEDIASOUP_USE_VALGRIND:="false"}
export MEDIASOUP_VALGRIND_OPTIONS=${MEDIASOUP_VALGRIND_OPTIONS:="--leak-check=full --track-fds=yes --log-file=/storage/mediasoup_valgrind_%p.log"}
export MEDIASOUP_SRC=${MEDIASOUP_SRC:="$PWD"}

# Debugging: Print the variables to confirm they are loaded
echo "DEBUG=$DEBUG"
echo "INTERACTIVE=$INTERACTIVE"
echo "PROTOO_LISTEN_PORT=$PROTOO_LISTEN_PORT"
echo "HTTPS_CERT_FULLCHAIN=$HTTPS_CERT_FULLCHAIN"
echo "HTTPS_CERT_PRIVKEY=$HTTPS_CERT_PRIVKEY"
echo "MEDIASOUP_LISTEN_IP=$MEDIASOUP_LISTEN_IP"
echo "MEDIASOUP_ANNOUNCED_IP=$MEDIASOUP_ANNOUNCED_IP"
echo "MEDIASOUP_MIN_PORT=$MEDIASOUP_MIN_PORT"
echo "MEDIASOUP_MAX_PORT=$MEDIASOUP_MAX_PORT"
echo "MEDIASOUP_USE_VALGRIND=$MEDIASOUP_USE_VALGRIND"
echo "MEDIASOUP_VALGRIND_OPTIONS=$MEDIASOUP_VALGRIND_OPTIONS"
echo "MEDIASOUP_SRC=$MEDIASOUP_SRC"

echo "Mediasoup Source Directory: ${MEDIASOUP_SRC}"

# Check and log the fullchain.pem file
if [ -f "${HTTPS_CERT_FULLCHAIN}" ]; then
  echo "------------------fullchain.pem file exists----------------"
  
else
  echo "Error: fullchain.pem file not found at ${HTTPS_CERT_FULLCHAIN}."
  exit 1
fi

# Check if the certs directory exists and resolve its absolute path
CERTS_DIR="$PWD/certs"
if [ -d "${CERTS_DIR}" ]; then
  ABS_CERTS_DIR=$(realpath "${CERTS_DIR}")
else
  echo "Error: Certificates directory '${CERTS_DIR}' does not exist."
  exit 1
fi

# Run the Docker container
docker run \
    --name=mediasoup-demo \
    -p ${PROTOO_LISTEN_PORT}:${PROTOO_LISTEN_PORT}/tcp \
    -p ${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}:${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}/udp \
    -p ${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}:${MEDIASOUP_MIN_PORT}-${MEDIASOUP_MAX_PORT}/tcp \
    -v ${PWD}:/storage \
    -v ${MEDIASOUP_SRC}:/mediasoup-src \
    -v ${ABS_CERTS_DIR}:/certs \
    -e DEBUG \
    -e INTERACTIVE \
    -e DOMAIN \
    -e PROTOO_LISTEN_PORT \
    -e HTTPS_CERT_FULLCHAIN=/certs/fullchain.pem \
    -e HTTPS_CERT_PRIVKEY=/certs/privkey.pem \
    -e MEDIASOUP_LISTEN_IP \
    -e MEDIASOUP_ANNOUNCED_IP \
    -e MEDIASOUP_MIN_PORT \
    -e MEDIASOUP_MAX_PORT \
    -e MEDIASOUP_USE_VALGRIND \
    -e MEDIASOUP_VALGRIND_OPTIONS \
    -e MEDIASOUP_WORKER_BIN \
    -it --rm \
    mediasoup-demo:latest