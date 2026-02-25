const net = require('net');
const os = require('os');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('interactiveClient');

const SOCKET_PATH_UNIX = '/tmp/mediasoup-demo.sock';
const SOCKET_PATH_WIN = path.join('\\\\?\\pipe', process.cwd(), 'mediasoup-demo');
const SOCKET_PATH = os.platform() === 'win32'? SOCKET_PATH_WIN : SOCKET_PATH_UNIX;

module.exports = async function()
{
	// Skip interactive client if stdin is not a TTY (e.g., when running with PM2)
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') 
	{
		logger.info('Interactive client disabled (not running in TTY mode)');

		return;
	}

	const socket = net.connect(SOCKET_PATH);

	process.stdin.pipe(socket);
	socket.pipe(process.stdout);

	socket.on('connect', () => process.stdin.setRawMode(true));
	socket.on('close', () => process.exit(0));
	socket.on('exit', () => socket.end());
};
