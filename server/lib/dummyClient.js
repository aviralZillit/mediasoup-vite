/* eslint-disable no-console */
const WebSocket = require('ws');

// ✅ Use correct WebSocket URL with roomId & peerId
const ROOM_ID = '67aee17ae5c26a90c3110914'; // Change dynamically
const PEER_ID = '67aee17ae5c26a90c3110915'; // Change dynamically
const SOCKET_URL = `https://mediasoup-dev.zillit.com/?roomId=${ROOM_ID}&peerId=${PEER_ID}`;

const options = {
	headers : {
		'Host'                     : 'mediasoup-dev.zillit.com',
		'Upgrade'                  : 'websocket',
		'Connection'               : 'Upgrade',
		'Pragma'                   : 'no-cache',
		'Cache-Control'            : 'no-cache',
		// 'Origin'                   : 'https://avimeet.netlify.app', // ✅ Required Origin
		'Sec-WebSocket-Version'    : '13',
		// 'Sec-WebSocket-Protocol'   : 'protoo', // ✅ Important for Mediasoup signaling
		'Sec-WebSocket-Extensions' : 'permessage-deflate; client_max_window_bits'
	}
};

module.exports = async function() 
{
	const socket = new WebSocket(SOCKET_URL, [ 'socket.io', 'protoo' ], options);

	console.log(JSON.stringify(socket));

	socket.on('open', () => 
	{
		console.log('✅ Connected to WebSocket server');
		process.stdin.on('data', (data) => 
		{
			socket.send(data.toString()); // Send user input to WebSocket
		});
	});

	socket.on('message', (message) => 
	{
		console.log('📩 Message from server:', message.toString());
	});

	socket.on('close', () => 
	{
		console.log('🔌 Connection closed');
		process.exit(0);
	});

	socket.on('error', (err) => 
	{
		console.error('❌ WebSocket error:', err.message);
	});
}();