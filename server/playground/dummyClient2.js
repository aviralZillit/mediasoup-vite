/* eslint-disable no-console */
const WebSocket = require('ws');

const ROOM_ID = '67aee17ae5c26a90c3110914'; // Change dynamically
const PEER_ID = '67aee17ae5c26a90c3110916'; // Change dynamically
const SOCKET_URL = `wss://mediasoup-dev.zillit.com/?roomId=${ROOM_ID}&peerId=${PEER_ID}`;

const options = {
	headers : {
		'Host'                     : 'mediasoup-dev.zillit.com',
		'Upgrade'                  : 'websocket',
		'Connection'               : 'Upgrade',
		'Pragma'                   : 'no-cache',
		'Cache-Control'            : 'no-cache',
		'Sec-WebSocket-Version'    : '13',
		'Sec-WebSocket-Extensions' : 'permessage-deflate; client_max_window_bits'
	}
};

// ✅ Connect to WebSocket
const socket = new WebSocket(SOCKET_URL, [ 'protoo' ], options);

// ✅ Handle connection open event
socket.on('open', () => 
{
	console.log('✅ Connected to WebSocket server');

	// ✅ Send "join" event after connecting
	const joinEvent = {
		request : true,
		id      : 4009856,
		method  : 'join',
		data    : {
			displayName : 'Squirtle',
			device      : {
				flag    : 'chrome',
				name    : 'Chrome',
				version : '133.0.0.0'
			},
			rtpCapabilities : {
				codecs : [
					{
						'mimeType'             : 'audio/opus',
						'kind'                 : 'audio',
						'preferredPayloadType' : 100,
						'clockRate'            : 48000,
						'channels'             : 2,
						'parameters'           : {
							'minptime'     : 10,
							'useinbandfec' : 1
						},
						'rtcpFeedback' : [
							{ 'type': 'transport-cc', 'parameter': '' },
							{ 'type': 'nack', 'parameter': '' }
						]
					}
				],
				headerExtensions : [
					{
						'kind'             : 'audio',
						'uri'              : 'urn:ietf:params:rtp-hdrext:sdes:mid',
						'preferredId'      : 1,
						'preferredEncrypt' : false,
						'direction'        : 'sendrecv'
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

// ✅ Handle connection close event
socket.on('close', () => 
{
	console.log('🔌 Connection closed');
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

// Example: Raise hand after 5 seconds, lower it after 10 seconds
// setTimeout(() => toggleHandRaise(true), 5000);
// setTimeout(() => toggleHandRaise(false), 10000);