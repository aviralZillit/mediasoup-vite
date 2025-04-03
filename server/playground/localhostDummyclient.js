/* eslint-disable no-console */
/* eslint-disable no-console */
const WebSocket = require('ws');

// Bypass SSL certificate verification (for local development)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ROOM_ID = '46d6e68e472d4ac881d688a607554fe0'; // ✅ Room ID from request
const PEER_ID = '67aee785a2e564575aa717c4'; // ✅ Peer ID from request
const SOCKET_URL = `wss://localhost:4443/?roomId=${ROOM_ID}&peerId=${PEER_ID}`; // ✅ WebSocket URL

const options = {
	headers : {
		'Host'                     : 'localhost:4443',
		'Upgrade'                  : 'websocket',
		'Connection'               : 'Upgrade',
		'Pragma'                   : 'no-cache',
		'Cache-Control'            : 'no-cache',
		'Sec-WebSocket-Version'    : '13',
		'Accept-Encoding'          : 'gzip, deflate, br, zstd',
		'Accept-Language'          : 'en-GB,en-US;q=0.9,en;q=0.8',
		'Sec-WebSocket-Key'        : 'DKGICGbtuDoLViO/hc88Wg==', // ✅ Provided Key
		'Sec-WebSocket-Extensions' : 'permessage-deflate; client_max_window_bits',
		'Sec-WebSocket-Protocol'   : 'protoo',
		'Origin'                   : 'https://localhost:3000' // ✅ Provided Origin
	}
};

// ✅ Create WebSocket connection
const socket = new WebSocket(SOCKET_URL, [ 'protoo' ], options);

// ✅ Handle connection open event
socket.on('open', () => 
{
	console.log('✅ Connected to WebSocket server');

	// ✅ Send "join" event after connecting
	const joinEvent = {
		request : true,
		id      : Date.now(),
		method  : 'join',
		data    : {
			displayName : 'LocalUser',
			device      : {
				flag    : 'chrome',
				name    : 'Chrome',
				version : '134.0.0.0'
			},
			rtpCapabilities : {
				codecs : [
					{
						mimeType             : 'audio/opus',
						kind                 : 'audio',
						preferredPayloadType : 100,
						clockRate            : 48000,
						channels             : 2,
						parameters           : {
							minptime     : 10,
							useinbandfec : 1
						},
						rtcpFeedback : [
							{ type: 'transport-cc', parameter: '' },
							{ type: 'nack', parameter: '' }
						]
					}
				],
				headerExtensions : [
					{
						kind             : 'audio',
						uri              : 'urn:ietf:params:rtp-hdrext:sdes:mid',
						preferredId      : 1,
						preferredEncrypt : false,
						direction        : 'sendrecv'
					}
				]
			},
			sctpCapabilities : {
				numStreams : {
					OS  : 1024,
					MIS : 1024
				}
			}
		}
	};

	console.log('📤 Sending join event:', JSON.stringify(joinEvent, null, 2));
	socket.send(JSON.stringify(joinEvent));
});

// ✅ Handle incoming messages
socket.on('message', (message) => 
{
	try 
	{
		const parsedMessage = JSON.parse(message);

		console.log('📩 Message from server:', JSON.stringify(parsedMessage, null, 2));

		// ✅ Handle hand raise events
		if (parsedMessage.method === 'peerRaisedHand') 
		{
			console.log(`🙋 ${parsedMessage.data.displayName} raised their hand!`);
		}
		else if (parsedMessage.method === 'peerLoweredHand') 
		{
			console.log(`✋ ${parsedMessage.data.displayName} lowered their hand.`);
		}
	}
	catch (error) 
	{
		console.log('📩 Received non-JSON message:', message.toString());
	}
});

// ✅ Handle WebSocket close event (auto-reconnect)
socket.on('close', () => 
{
	console.log('🔌 Connection closed. Reconnecting in 3 seconds...');
	setTimeout(() => 
	{
		console.log('♻️ Reconnecting...');
		reconnectWebSocket();
	}, 3000);
});

// ✅ Handle WebSocket errors
socket.on('error', (err) => 
{
	console.error('❌ WebSocket error:', err.message);
});

// ✅ Function to toggle hand raise status
function toggleHandRaise(raisedHand) 
{
	const handRaiseEvent = {
		request : true,
		id      : Date.now(),
		method  : 'toggleHandRaise',
		data    : {
			raisedHand : raisedHand // true = raise hand, false = lower hand
		}
	};

	console.log(`📤 Toggling hand raise: ${raisedHand ? 'Raising' : 'Lowering'} hand`);
	socket.send(JSON.stringify(handRaiseEvent));
}

// ✅ Function to reconnect WebSocket (if disconnected)
function reconnectWebSocket() 
{
	console.log('🔄 Attempting to reconnect to WebSocket...');
	const newSocket = new WebSocket(SOCKET_URL, [ 'protoo' ], options);

	newSocket.on('open', () => 
	{
		console.log('✅ Reconnected to WebSocket server.');
	});

	newSocket.on('message', (message) => 
	{
		try 
		{
			const parsedMessage = JSON.parse(message);

			console.log('📩 Message from server:', JSON.stringify(parsedMessage, null, 2));
		}
		catch (error) 
		{
			console.log('📩 Received non-JSON message:', message.toString());
		}
	});

	newSocket.on('close', () => 
	{
		console.log('🔌 Connection closed. Reconnecting in 3 seconds...');
		setTimeout(reconnectWebSocket, 3000);
	});

	newSocket.on('error', (err) => 
	{
		console.error('❌ WebSocket error:', err.message);
	});

	// Replace old socket with new socket
	global.socket = newSocket;
}

// Example: Raise hand after 5 seconds, lower it after 10 seconds
setTimeout(() => toggleHandRaise(true), 5000);
setTimeout(() => toggleHandRaise(false), 10000);