/* eslint-disable camelcase */
const EventEmitter = require('events').EventEmitter;
const mediasoup = require('mediasoup');
const protoo = require('protoo-server');
// const rtp = require('rtp.js');
const throttle = require('@sitespeed.io/throttle');
const Logger = require('./Logger');
const utils = require('./utils');
const config = require('../config');
const Bot = require('./Bot');
const GStreamer = require('./GStreamer');

const CallRepo = require('../repositories/MediasoupCalls');
const logger = new Logger('Room');

/**
 * Room class.
 *
 * This is not a "mediasoup Room" by itself, by a custom class that holds
 * a protoo Room (for signaling with WebSocket clients) and a mediasoup Router
 * (for sending and receiving media to/from those WebSocket peers).
 */
class Room extends EventEmitter
{
	/**
	 * Factory function that creates and returns Room instance.
	 *
	 * @async
	 *
	 * @param {mediasoup.Worker} mediasoupWorker - The mediasoup Worker in which a new
	 *   mediasoup Router must be created.
	 * @param {String} roomId - Id of the Room instance.
	 */
	static async create({ mediasoupWorker, roomId, consumerReplicas })
	{
		logger.info('create() [roomId:%s]', roomId);

		// Create a protoo Room instance.
		const protooRoom = new protoo.Room();

		// Router media codecs.
		const { mediaCodecs } = config.mediasoup.routerOptions;

		// Create a mediasoup Router.
		const mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });

		// Create a mediasoup AudioLevelObserver.
		const audioLevelObserver = await mediasoupRouter.createAudioLevelObserver(
			{
				maxEntries : 1,
				threshold  : -80,
				interval   : 800
			});

		// Create a mediasoup ActiveSpeakerObserver.
		const activeSpeakerObserver = await mediasoupRouter.createActiveSpeakerObserver();

		const bot = await Bot.create({ mediasoupRouter });

		return new Room(
			{
				roomId,
				protooRoom,
				webRtcServer : mediasoupWorker.appData.webRtcServer,
				mediasoupRouter,
				audioLevelObserver,
				activeSpeakerObserver,
				consumerReplicas,
				bot
			});
	}

	constructor(
		{
			roomId,
			protooRoom,
			webRtcServer,
			mediasoupRouter,
			audioLevelObserver,
			activeSpeakerObserver,
			consumerReplicas,
			bot
		})
	{
		super();

		this.setMaxListeners(Infinity);

		// Room id.
		// @type {String}
		this._roomId = roomId;

		// Closed flag.
		// @type {Boolean}
		this._closed = false;

		// protoo Room instance.
		// @type {protoo.Room}
		this._protooRoom = protooRoom;

		// Map of broadcasters indexed by id. Each Object has:
		// - {String} id
		// - {Object} data
		//   - {String} displayName
		//   - {Object} device
		//   - {RTCRtpCapabilities} rtpCapabilities
		//   - {Map<String, mediasoup.Transport>} transports
		//   - {Map<String, mediasoup.Producer>} producers
		//   - {Map<String, mediasoup.Consumers>} consumers
		//   - {Map<String, mediasoup.DataProducer>} dataProducers
		//   - {Map<String, mediasoup.DataConsumers>} dataConsumers
		// @type {Map<String, Object>}
		this._broadcasters = new Map();

		// mediasoup WebRtcServer instance.
		// @type {mediasoup.WebRtcServer}
		this._webRtcServer = webRtcServer;

		// mediasoup Router instance.
		// @type {mediasoup.Router}
		this._mediasoupRouter = mediasoupRouter;

		// mediasoup AudioLevelObserver.
		// @type {mediasoup.AudioLevelObserver}
		this._audioLevelObserver = audioLevelObserver;

		// mediasoup ActiveSpeakerObserver.
		// @type {mediasoup.ActiveSpeakerObserver}
		this._activeSpeakerObserver = activeSpeakerObserver;

		// DataChannel bot.
		// @type {Bot}
		this._bot = bot;

		// Consumer replicas.
		// @type {Number}
		this._consumerReplicas = consumerReplicas || 0;

		// Network throttled.
		// @type {Boolean}
		this._networkThrottled = false;

		// Real-time analytics and monitoring (Ultra Memory Optimized)
		this._analytics = {
			roomCreatedAt    : Date.now(),
			totalPeers       : 0,
			activePeers      : 0,
			totalProducers   : 0,
			totalConsumers   : 0,
			totalTransports  : 0,
			dataTransferred  : { sent: 0, received: 0 },
			errors           : [], // Max 3 entries (ultra-aggressive)
			connectionEvents : [], // Max 5 entries (ultra-aggressive)
			peerEvents       : [] // Max 3 entries (ultra-aggressive)
		};

		// Ultra-aggressive memory management settings
		this._maxErrors = 3;
		this._maxConnectionEvents = 5;
		this._maxPeerEvents = 3;
		this._analyticsCleanupInterval = 120000; // 2 minutes (more frequent cleanup)

		// Monitoring intervals (ultra-conservative frequency)
		this._monitoringIntervals = new Map();
		this._monitoringFrequency = 60000; // 60 seconds (reduced from 15s)

		// Connection quality monitoring (minimal data)
		this._connectionQuality = new Map(); // peerId -> quality metrics

		// Recording state
		// @type {GStreamer}
		this._gstreamer = undefined;
		// @type {Map<String, Object>} producerId -> { transport, consumer }
		this._recordingConsumers = new Map();
		// @type {Set<Number>} ports in use
		this._usedRecordingPorts = new Set();
		// @type {String} peerId of the user who started recording
		this._recordingInitiatorPeerId = undefined;
		// @type {Boolean} lock to prevent concurrent recording operations
		this._recordingLock = false;
		// @type {Number} timestamp when recording started
		this._recordingStartTime = undefined;
		// @type {Array<String>} list of segment file paths for merging
		this._recordingSegments = [];
		// @type {String} base filename for the final merged recording
		this._recordingBaseFileName = undefined;

		// Handle audioLevelObserver.
		this._handleAudioLevelObserver();

		// Handle activeSpeakerObserver.
		this._handleActiveSpeakerObserver();

		// Start comprehensive monitoring
		this._startRoomMonitoring();

		// For debugging.
		global.audioLevelObserver = this._audioLevelObserver;
		global.activeSpeakerObserver = this._activeSpeakerObserver;
		global.bot = this._bot;
	}

	/**
	 * Closes the Room instance by closing the protoo Room and the mediasoup Router.
	 */
	close()
	{
		logger.debug('close()');

		this._closed = true;

		// Stop any ongoing recording before closing
		if (this._gstreamer)
		{
			logger.info('close() | Stopping recording due to room close');
			try
			{
				this._gstreamer.kill();
				this._gstreamer = undefined;
				
				// Clean up recording resources
				for (const { transport, consumer } of this._recordingConsumers.values())
				{
					try { consumer.close(); }
					catch (e) { /* ignore */ }
					try { transport.close(); }
					catch (e) { /* ignore */ }
				}
				this._recordingConsumers.clear();
				this._usedRecordingPorts.clear();
				this._recordingInitiatorPeerId = undefined;
				this._recordingStartTime = undefined;
			}
			catch (error)
			{
				logger.error('close() | Error stopping recording: %o', error);
			}
		}

		// Close the protoo Room.
		this._protooRoom.close();

		// Close the mediasoup Router.
		this._mediasoupRouter.close();

		// Close the Bot.
		this._bot.close();

		// Emit 'close' event.
		this.emit('close');

		// Stop network throttling.
		if (this._networkThrottled)
		{
			logger.debug('close() | stopping network throttle');

			throttle.stop({})
				.catch((error) =>
				{
					logger.error(`close() | failed to stop network throttle:${error}`);
				});
		}
	}

	logStatus()
	{
		logger.info(
			'logStatus() [roomId:%s, protoo Peers:%s]',
			this._roomId,
			this._protooRoom.peers.length);
	}

	/**
	 * Called from server.js upon a protoo WebSocket connection request from a
	 * browser.
	 *
	 * @param {String} peerId - The id of the protoo peer to be created.
	 * @param {Boolean} consume - Whether this peer wants to consume from others.
	 * @param {protoo.WebSocketTransport} protooWebSocketTransport - The associated
	 *   protoo WebSocket transport.
	 */
	handleProtooConnection({ peerId, consume, protooWebSocketTransport })
	{
		const existingPeer = this._protooRoom.getPeer(peerId);

		if (existingPeer)
		{
			logger.warn(
				'handleProtooConnection() | there is already a protoo Peer with same peerId, closing it [peerId:%s]',
				peerId);

			existingPeer.close();
		}

		let peer;

		// Create a new protoo Peer with the given peerId.
		try
		{
			peer = this._protooRoom.createPeer(peerId, protooWebSocketTransport);
		}
		catch (error)
		{
			logger.error('protooRoom.createPeer() failed:%o', error);
		}

		// Notify mediasoup version to the peer.
		peer.notify('mediasoup-version', { version: mediasoup.version })
			.catch(() => {});

		// Use the peer.data object to store mediasoup related objects.

		// Not joined after a custom protoo 'join' request is later received.
		peer.data.consume = consume;
		peer.data.joined = false;
		peer.data.displayName = undefined;
		peer.data.device = undefined;
		peer.data.rtpCapabilities = undefined;
		peer.data.sctpCapabilities = undefined;

		// Have mediasoup related maps ready even before the Peer joins since we
		// allow creating Transports before joining.
		peer.data.transports = new Map();
		peer.data.producers = new Map();
		peer.data.consumers = new Map();
		peer.data.dataProducers = new Map();
		peer.data.dataConsumers = new Map();

		peer.on('request', (request, accept, reject) =>
		{
			logger.debug(
				'protoo Peer "request" event [method:%s, peerId:%s]',
				request.method, peer.id);

			this._handleProtooRequest(peer, request, accept, reject)
				.catch((error) =>
				{
					logger.error('request failed:%o', error);

					reject(error);
				});
		});

		peer.on('close', async () =>
		{
			if (this._closed)
				return;

			logger.debug('protoo Peer "close" event [peerId:%s]', peer.id);

			// Check if leaving peer is the recording initiator
			// If so, stop the recording gracefully
			if (this._gstreamer && this._recordingInitiatorPeerId === peer.id)
			{
				logger.info('Recording initiator left, stopping recording [peerId:%s]', peer.id);
				try
				{
					await this._stopRecording({ reason: 'initiator_left' });
				}
				catch (error)
				{
					logger.error('Error stopping recording when initiator left: %o', error);
				}
			}

			// Record peer departure analytics
			this._recordEvent('peer_left', 
				{
					peerId      : peer.id,
					displayName : peer.data.displayName,
					duration    : peer.data.joined ? Date.now() - peer.data.joinTime : 0,
					reason      : 'peer_disconnected'
				});

			// If the Peer was joined, notify all Peers.
			if (peer.data.joined)
			{
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify('peerClosed', { peerId: peer.id })
						.catch(() => {});
				}
			}
			
			const call = await CallRepo.getCall({ filters: { room_id: this._roomId } });

			try 
			{
				if (call) 
				{
					const userToUpdate = call.call_users
						.find((user) => user.user_id.toString() === peer.id);
	
					if (userToUpdate) 
					{
						// Check if user ever answered the call (was ever 'incall')
						const wasEverInCall = userToUpdate.current_status === 'incall' || userToUpdate.current_status === 'caller';								   

						if (wasEverInCall) 
						{
							// User was in the call and then left
							userToUpdate.current_status = 'left';
							logger.info(`✅ User ${peer.id} marked as left (was in call) in room ${this._roomId}`);
						}
						else 
						{
							// User never answered - mark as missed call
							userToUpdate.missed_call = true;
							userToUpdate.current_status = 'invited'; // Keep as invited but mark missed
							logger.info(`✅ User ${peer.id} marked as missed call (never answered) in room ${this._roomId}`);
						}
						
						call.markModified('call_users');
						await call.save();
					}

					// 🔄 Check if all peers have left the MediaSoup room
					const remainingPeers = this._getJoinedPeers().length;

					logger.info(`🔍 Auto-end check for room ${this._roomId}: ${remainingPeers} peers remaining in MediaSoup room`);

					// If no peers remain in the MediaSoup room, mark call as ended
					if (remainingPeers === 0) 
					{
						call.end_time = Date.now();
						call.current_status = 'call_ended';
						await call.save();

						logger.info(`✅ Call auto-ended for room ${this._roomId} - no active participants`);

						// Close the MediaSoup room since call has ended
						this.close();

						return; // Exit early since we're closing the room
					}
					else 
					{
						logger.info(`⏳ Call continues for room ${this._roomId} - ${remainingPeers} peers still present`);
					}
				}
			}
			catch (error) 
			{
				logger.error(`Error updating user leave status: ${error.message}`);
			}

			// Iterate and close all mediasoup Transport associated to this Peer, so all
			// its Producers and Consumers will also be closed.
			for (const transport of peer.data.transports.values())
			{
				transport.close();
			}

			// If this is the latest Peer in the room, close the room.
			if (this._protooRoom.peers.length === 0)
			{
				logger.info(
					'last Peer in the room left, closing the room [roomId:%s]',
					this._roomId);

				this.close();
			}
		});
	}

	getRouterRtpCapabilities()
	{
		return this._mediasoupRouter.rtpCapabilities;
	}

	/**
	 * Create a Broadcaster. This is for HTTP API requests (see server.js).
	 *
	 * @async
	 *
	 * @type {String} id - Broadcaster id.
	 * @type {String} displayName - Descriptive name.
	 * @type {Object} [device] - Additional info with name, version and flags fields.
	 * @type {RTCRtpCapabilities} [rtpCapabilities] - Device RTP capabilities.
	 */
	async createBroadcaster({ id, displayName, device = {}, rtpCapabilities })
	{
		if (typeof id !== 'string' || !id)
			throw new TypeError('missing body.id');
		else if (typeof displayName !== 'string' || !displayName)
			throw new TypeError('missing body.displayName');
		else if (typeof device.name !== 'string' || !device.name)
			throw new TypeError('missing body.device.name');
		else if (rtpCapabilities && typeof rtpCapabilities !== 'object')
			throw new TypeError('wrong body.rtpCapabilities');

		if (this._broadcasters.has(id))
			throw new Error(`broadcaster with id "${id}" already exists`);

		const broadcaster =
		{
			id,
			data :
			{
				displayName,
				device :
				{
					flag    : 'broadcaster',
					name    : device.name || 'Unknown device',
					version : device.version
				},
				rtpCapabilities,
				transports    : new Map(),
				producers     : new Map(),
				consumers     : new Map(),
				dataProducers : new Map(),
				dataConsumers : new Map()
			}
		};

		// Store the Broadcaster into the map.
		this._broadcasters.set(broadcaster.id, broadcaster);

		// Notify the new Broadcaster to all Peers.
		for (const otherPeer of this._getJoinedPeers())
		{
			otherPeer.notify(
				'newPeer',
				{
					id          : broadcaster.id,
					displayName : broadcaster.data.displayName,
					device      : broadcaster.data.device
				})
				.catch(() => {});
		}

		// Reply with the list of Peers and their Producers.
		const peerInfos = [];
		const joinedPeers = this._getJoinedPeers();

		// Just fill the list of Peers if the Broadcaster provided its rtpCapabilities.
		if (rtpCapabilities)
		{
			for (const joinedPeer of joinedPeers)
			{
				const peerInfo =
				{
					id          : joinedPeer.id,
					displayName : joinedPeer.data.displayName,
					device      : joinedPeer.data.device,
					producers   : []
				};

				for (const producer of joinedPeer.data.producers.values())
				{
					// Ignore Producers that the Broadcaster cannot consume.
					if (
						!this._mediasoupRouter.canConsume(
							{
								producerId : producer.id,
								rtpCapabilities
							})
					)
					{
						continue;
					}

					peerInfo.producers.push(
						{
							id   : producer.id,
							kind : producer.kind
						});
				}

				peerInfos.push(peerInfo);
			}
		}

		return { peers: peerInfos };
	}

	/**
	 * Delete a Broadcaster.
	 *
	 * @type {String} broadcasterId
	 */
	deleteBroadcaster({ broadcasterId })
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		for (const transport of broadcaster.data.transports.values())
		{
			transport.close();
		}

		this._broadcasters.delete(broadcasterId);

		for (const peer of this._getJoinedPeers())
		{
			peer.notify('peerClosed', { peerId: broadcasterId })
				.catch(() => {});
		}
	}

	/**
	 * Create a mediasoup Transport associated to a Broadcaster. It can be a
	 * PlainTransport or a WebRtcTransport.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} type - Can be 'plain' (PlainTransport) or 'webrtc'
	 *   (WebRtcTransport).
	 * @type {Boolean} [rtcpMux=false] - Just for PlainTransport, use RTCP mux.
	 * @type {Boolean} [comedia=true] - Just for PlainTransport, enable remote IP:port
	 *   autodetection.
	 * @type {Object} [sctpCapabilities] - SCTP capabilities
	 */
	async createBroadcasterTransport(
		{
			broadcasterId,
			type,
			rtcpMux = false,
			comedia = true,
			sctpCapabilities
		})
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		switch (type)
		{
			case 'webrtc':
			{
				const webRtcTransportOptions =
				{
					...utils.clone(config.mediasoup.webRtcTransportOptions),
					webRtcServer      : this._webRtcServer,
					iceConsentTimeout : 20,
					enableSctp        : Boolean(sctpCapabilities),
					numSctpStreams    : (sctpCapabilities || {}).numStreams
				};

				const transport =
					await this._mediasoupRouter.createWebRtcTransport(webRtcTransportOptions);

				// Store it.
				broadcaster.data.transports.set(transport.id, transport);

				return {
					id             : transport.id,
					iceParameters  : transport.iceParameters,
					iceCandidates  : transport.iceCandidates,
					dtlsParameters : transport.dtlsParameters,
					sctpParameters : transport.sctpParameters
				};
			}

			case 'plain':
			{
				const plainTransportOptions =
				{
					...utils.clone(config.mediasoup.plainTransportOptions),
					rtcpMux : rtcpMux,
					comedia : comedia
				};

				const transport = await this._mediasoupRouter.createPlainTransport(
					plainTransportOptions);

				// Store it.
				broadcaster.data.transports.set(transport.id, transport);

				return {
					id       : transport.id,
					ip       : transport.tuple.localIp,
					port     : transport.tuple.localPort,
					rtcpPort : transport.rtcpTuple ? transport.rtcpTuple.localPort : undefined
				};
			}

			default:
			{
				throw new TypeError('invalid type');
			}
		}
	}

	/**
	 * Connect a Broadcaster mediasoup WebRtcTransport.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {RTCDtlsParameters} dtlsParameters - Remote DTLS parameters.
	 */
	async connectBroadcasterTransport(
		{
			broadcasterId,
			transportId,
			dtlsParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		if (transport.constructor.name !== 'WebRtcTransport')
		{
			throw new Error(
				`transport with id "${transportId}" is not a WebRtcTransport`);
		}

		await transport.connect({ dtlsParameters });
	}

	/**
	 * Create a mediasoup Producer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} kind - 'audio' or 'video' kind for the Producer.
	 * @type {RTCRtpParameters} rtpParameters - RTP parameters for the Producer.
	 */
	async createBroadcasterProducer(
		{
			broadcasterId,
			transportId,
			kind,
			rtpParameters
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const producer =
			await transport.produce({ kind, rtpParameters });

		// Store it.
		broadcaster.data.producers.set(producer.id, producer);

		// Set Producer events.
		// producer.on('score', (score) =>
		// {
		// 	logger.debug(
		// 		'broadcaster producer "score" event [producerId:%s, score:%o]',
		// 		producer.id, score);
		// });

		producer.on('videoorientationchange', (videoOrientation) =>
		{
			logger.debug(
				'broadcaster producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
				producer.id, videoOrientation);
		});

		// Optimization: Create a server-side Consumer for each Peer.
		for (const peer of this._getJoinedPeers())
		{
			this._createConsumer(
				{
					consumerPeer : peer,
					producerPeer : broadcaster,
					producer
				});
		}

		// Add into the AudioLevelObserver and ActiveSpeakerObserver.
		if (producer.kind === 'audio')
		{
			this._audioLevelObserver.addProducer({ producerId: producer.id })
				.catch(() => {});

			this._activeSpeakerObserver.addProducer({ producerId: producer.id })
				.catch(() => {});
		}

		return { id: producer.id };
	}

	/**
	 * Create a mediasoup Consumer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} producerId
	 */
	async createBroadcasterConsumer(
		{
			broadcasterId,
			transportId,
			producerId
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		if (!broadcaster.data.rtpCapabilities)
			throw new Error('broadcaster does not have rtpCapabilities');

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const consumer = await transport.consume(
			{
				producerId,
				rtpCapabilities : broadcaster.data.rtpCapabilities
			});

		// Store it.
		broadcaster.data.consumers.set(consumer.id, consumer);

		// Set Consumer events.
		consumer.on('transportclose', () =>
		{
			// Remove from its map.
			broadcaster.data.consumers.delete(consumer.id);
		});

		consumer.on('producerclose', () =>
		{
			// Remove from its map.
			broadcaster.data.consumers.delete(consumer.id);
		});

		return {
			id            : consumer.id,
			producerId,
			kind          : consumer.kind,
			rtpParameters : consumer.rtpParameters,
			type          : consumer.type
		};
	}

	/**
	 * Create a mediasoup DataConsumer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 * @type {String} dataProducerId
	 */
	async createBroadcasterDataConsumer(
		{
			broadcasterId,
			transportId,
			dataProducerId
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		if (!broadcaster.data.rtpCapabilities)
			throw new Error('broadcaster does not have rtpCapabilities');

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const dataConsumer = await transport.consumeData(
			{
				dataProducerId
			});

		// Store it.
		broadcaster.data.dataConsumers.set(dataConsumer.id, dataConsumer);

		// Set Consumer events.
		dataConsumer.on('transportclose', () =>
		{
			// Remove from its map.
			broadcaster.data.dataConsumers.delete(dataConsumer.id);
		});

		dataConsumer.on('dataproducerclose', () =>
		{
			// Remove from its map.
			broadcaster.data.dataConsumers.delete(dataConsumer.id);
		});

		return {
			id       : dataConsumer.id,
			streamId : dataConsumer.sctpStreamParameters.streamId
		};
	}

	/**
	 * Create a mediasoup DataProducer associated to a Broadcaster.
	 *
	 * @async
	 *
	 * @type {String} broadcasterId
	 * @type {String} transportId
	 */
	async createBroadcasterDataProducer(
		{
			broadcasterId,
			transportId,
			label,
			protocol,
			sctpStreamParameters,
			appData
		}
	)
	{
		const broadcaster = this._broadcasters.get(broadcasterId);

		if (!broadcaster)
			throw new Error(`broadcaster with id "${broadcasterId}" does not exist`);

		// if (!broadcaster.data.sctpCapabilities)
		// 	throw new Error('broadcaster does not have sctpCapabilities');

		const transport = broadcaster.data.transports.get(transportId);

		if (!transport)
			throw new Error(`transport with id "${transportId}" does not exist`);

		const dataProducer = await transport.produceData(
			{
				sctpStreamParameters,
				label,
				protocol,
				appData
			});

		// Store it.
		broadcaster.data.dataProducers.set(dataProducer.id, dataProducer);

		// Set Consumer events.
		dataProducer.on('transportclose', () =>
		{
			// Remove from its map.
			broadcaster.data.dataProducers.delete(dataProducer.id);
		});

		// // Optimization: Create a server-side Consumer for each Peer.
		// for (const peer of this._getJoinedPeers())
		// {
		// 	this._createDataConsumer(
		// 		{
		// 			dataConsumerPeer : peer,
		// 			dataProducerPeer : broadcaster,
		// 			dataProducer: dataProducer
		// 		});
		// }

		return {
			id : dataProducer.id
		};
	}

	_handleAudioLevelObserver()
	{
		this._audioLevelObserver.on('volumes', (volumes) =>
		{
			const { producer, volume } = volumes[0];

			logger.debug(
				'audioLevelObserver "volumes" event [producerId:%s, volume:%s]',
				producer.id, volume);

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify(
					'activeSpeaker',
					{
						peerId : producer.appData.peerId,
						volume : volume
					})
					.catch(() => {});
			}
		});

		this._audioLevelObserver.on('silence', () =>
		{
			logger.debug('audioLevelObserver "silence" event');

			// Notify all Peers.
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('activeSpeaker', { peerId: null })
					.catch(() => {});
			}
		});
	}

	_handleActiveSpeakerObserver()
	{
		this._activeSpeakerObserver.on('dominantspeaker', (dominantSpeaker) =>
		{
			logger.debug(
				'activeSpeakerObserver "dominantspeaker" event [producerId:%s]',
				dominantSpeaker.producer.id);
		});
	}

	/**
	 * Handle protoo requests from browsers.
	 *
	 * @async
	 */
	async _handleProtooRequest(peer, request, accept, reject)
	{
		switch (request.method)
		{
			case 'getRouterRtpCapabilities':
			{
				accept(this._mediasoupRouter.rtpCapabilities);

				break;
			}

			case 'join':
			{
				// Ensure the Peer is not already joined.
				if (peer.data.joined)
					throw new Error('Peer already joined');

				const {
					displayName,
					device,
					rtpCapabilities,
					sctpCapabilities
				} = request.data;

				// Store client data into the protoo Peer data object.
				peer.data.joined = true;
				peer.data.displayName = displayName;
				peer.data.device = device;
				peer.data.rtpCapabilities = rtpCapabilities;
				peer.data.sctpCapabilities = sctpCapabilities;
				peer.data.joinTime = Date.now(); // Track join time

				// Update analytics
				this._analytics.totalPeers++;

				// Record peer join
				this._recordEvent('peer_joined', 
					{
						peerId      : peer.id,
						displayName : displayName,
						device      : device,
						timestamp   : Date.now()
					});

				// Tell the new Peer about already joined Peers.
				// And also create Consumers for existing Producers.

				const joinedPeers =
				[
					...this._getJoinedPeers(),
					...this._broadcasters.values()
				];

				// Reply now the request with the list of joined peers (all but the new one).
				const peerInfos = joinedPeers
					.filter((joinedPeer) => joinedPeer.id !== peer.id)
					.map((joinedPeer) => ({
						id          : joinedPeer.id,
						displayName : joinedPeer.data.displayName,
						device      : joinedPeer.data.device
					}));

				accept({ peers: peerInfos });

				// Mark the new Peer as joined.
				peer.data.joined = true;

				for (const joinedPeer of joinedPeers)
				{
					// Create Consumers for existing Producers.
					for (const producer of joinedPeer.data.producers.values())
					{
						this._createConsumer(
							{
								consumerPeer : peer,
								producerPeer : joinedPeer,
								producer
							});
					}

					// Create DataConsumers for existing DataProducers.
					for (const dataProducer of joinedPeer.data.dataProducers.values())
					{
						if (dataProducer.label === 'bot')
							continue;

						this._createDataConsumer(
							{
								dataConsumerPeer : peer,
								dataProducerPeer : joinedPeer,
								dataProducer
							});
					}
				}

				// Create DataConsumers for bot DataProducer.
				this._createDataConsumer(
					{
						dataConsumerPeer : peer,
						dataProducerPeer : null,
						dataProducer     : this._bot.dataProducer
					});

				// Notify the new Peer to all other Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'newPeer',
						{
							id          : peer.id,
							displayName : peer.data.displayName,
							device      : peer.data.device
						})
						.catch(() => {});
				}

				// If recording is in progress, notify the new peer
				if (this._gstreamer)
				{
					const initiator = this._getJoinedPeers()
						.find((p) => p.id === this._recordingInitiatorPeerId);

					peer.notify('recordingStarted', {
						initiatorPeerId : this._recordingInitiatorPeerId,
						initiatorName   : initiator ? initiator.data.displayName : 'Unknown',
						startTime       : this._recordingStartTime
					}).catch(() => {});
				}

				break;
			}

			case 'createWebRtcTransport':
			{
				// NOTE: Don't require that the Peer is joined here, so the client can
				// initiate mediasoup Transports and be ready when he later joins.

				const {
					forceTcp,
					producing,
					consuming,
					sctpCapabilities
				} = request.data;

				const webRtcTransportOptions =
				{
					...utils.clone(config.mediasoup.webRtcTransportOptions),
					webRtcServer      : this._webRtcServer,
					iceConsentTimeout : 20,
					enableSctp        : Boolean(sctpCapabilities),
					numSctpStreams    : (sctpCapabilities || {}).numStreams,
					appData           : { producing, consuming }
				};

				if (forceTcp)
				{
					webRtcTransportOptions.listenInfos = webRtcTransportOptions.listenInfos
						.filter((listenInfo) => listenInfo.protocol === 'tcp');

					webRtcTransportOptions.enableUdp = false;
					webRtcTransportOptions.enableTcp = true;
				}

				const transport =
					await this._mediasoupRouter.createWebRtcTransport(webRtcTransportOptions);

				transport.on('icestatechange', (iceState) =>
				{
					if (iceState === 'disconnected' || iceState === 'closed')
					{
						logger.warn('WebRtcTransport "icestatechange" event [iceState:%s], closing peer', iceState);

						peer.close();
					}
				});

				transport.on('sctpstatechange', (sctpState) =>
				{
					logger.debug('WebRtcTransport "sctpstatechange" event [sctpState:%s]', sctpState);
				});

				transport.on('dtlsstatechange', (dtlsState) =>
				{
					if (dtlsState === 'failed' || dtlsState === 'closed')
					{
						logger.warn('WebRtcTransport "dtlsstatechange" event [dtlsState:%s], closing peer', dtlsState);

						peer.close();
					}
				});

				// NOTE: For testing.
				// await transport.enableTraceEvent([ 'probation', 'bwe' ]);
				await transport.enableTraceEvent([ 'bwe' ]);

				transport.on('trace', (trace) =>
				{
					logger.debug(
						'transport "trace" event [transportId:%s, trace.type:%s, trace:%o]',
						transport.id, trace.type, trace);

					if (trace.type === 'bwe' && trace.direction === 'out')
					{
						peer.notify(
							'downlinkBwe',
							{
								desiredBitrate          : trace.info.desiredBitrate,
								effectiveDesiredBitrate : trace.info.effectiveDesiredBitrate,
								availableBitrate        : trace.info.availableBitrate
							})
							.catch(() => {});
					}
				});

				// Store the WebRtcTransport into the protoo Peer data Object.
				peer.data.transports.set(transport.id, transport);

				accept(
					{
						id             : transport.id,
						iceParameters  : transport.iceParameters,
						iceCandidates  : transport.iceCandidates,
						dtlsParameters : transport.dtlsParameters,
						sctpParameters : transport.sctpParameters
					});

				const { maxIncomingBitrate } = config.mediasoup.webRtcTransportOptions;

				// If set, apply max incoming bitrate limit.
				if (maxIncomingBitrate)
				{
					try { await transport.setMaxIncomingBitrate(maxIncomingBitrate); }
					catch (error) {}
				}

				break;
			}

			case 'connectWebRtcTransport':
			{
				const { transportId, dtlsParameters } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				await transport.connect({ dtlsParameters });

				accept();

				break;
			}

			case 'restartIce':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const iceParameters = await transport.restartIce();

				accept(iceParameters);

				break;
			}

			case 'produce':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { transportId, kind, rtpParameters } = request.data;
				let { appData } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				// Add peerId into appData to later get the associated Peer during
				// the 'loudest' event of the audioLevelObserver.
				appData = { ...appData, peerId: peer.id };

				const producer = await transport.produce(
					{
						kind,
						rtpParameters,
						appData
						// keyFrameRequestDelay: 5000
					});

				// Store the Producer into the protoo Peer data Object.
				peer.data.producers.set(producer.id, producer);

				// Set Producer events.
				producer.on('score', (score) =>
				{
					// logger.debug(
					// 	'producer "score" event [producerId:%s, score:%o]',
					// 	producer.id, score);

					peer.notify('producerScore', { producerId: producer.id, score })
						.catch(() => {});
				});

				producer.on('videoorientationchange', (videoOrientation) =>
				{
					logger.debug(
						'producer "videoorientationchange" event [producerId:%s, videoOrientation:%o]',
						producer.id, videoOrientation);
				});

				// NOTE: For testing.
				// await producer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
				// await producer.enableTraceEvent([ 'pli', 'fir' ]);
				// await producer.enableTraceEvent([ 'keyframe' ]);

				producer.on('trace', (trace) =>
				{
					logger.debug(
						'producer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
						producer.id, trace.type, trace);
				});

				accept({ id: producer.id });

				// Optimization: Create a server-side Consumer for each Peer.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					this._createConsumer(
						{
							consumerPeer : otherPeer,
							producerPeer : peer,
							producer
						});
				}

				/* Test rtpjs lib. */

				// const directTransport = await this._mediasoupRouter.createDirectTransport();

				// directTransport.on('rtcp', (buffer) =>
				// {
				// 	const rtcpPacket =
				// 		new rtp.packets.CompoundPacket(rtp.utils.nodeBufferToDataView(buffer));

				// 	logger.info('RTCP packet');
				// 	logger.info(rtcpPacket.dump());
				// });

				// const directConsumer = await directTransport.consume(
				// 	{
				// 		producerId      : producer.id,
				// 		rtpCapabilities : this._mediasoupRouter.rtpCapabilities
				// 	}
				// );

				// const directProducer = await directTransport.produce(
				// 	{
				// 		kind          : directConsumer.kind,
				// 		rtpParameters : directConsumer.rtpParameters
				// 	});

				// directConsumer.on('rtp', (buffer) =>
				// {
				// 	const rtpPacket =
				// 		new rtp.packets.RtpPacket(rtp.utils.nodeBufferToDataView(buffer));

				// 	// logger.info('RTP packet');
				// 	// logger.info(rtpPacket.dump());

				// 	directProducer.send(buffer);
				// });

				// Add into the AudioLevelObserver and ActiveSpeakerObserver.
				if (producer.kind === 'audio')
				{
					this._audioLevelObserver.addProducer({ producerId: producer.id })
						.catch(() => {});

					this._activeSpeakerObserver.addProducer({ producerId: producer.id })
						.catch(() => {});
				}

				// If recording is in progress and this is a new video producer,
				// restart recording to include the new participant
				if (this._gstreamer && producer.kind === 'video')
				{
					logger.info(
						'New video producer during recording, restarting to include [peerId:%s]',
						peer.id);

					// Schedule restart (don't await to not block the response)
					this._restartRecordingForNewProducer(peer)
						.catch((error) =>
						{
							logger.error('Failed to restart recording for new producer: %o', error);
						});
				}

				break;
			}

			case 'closeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				producer.close();

				// Remove from its map.
				peer.data.producers.delete(producer.id);

				accept();

				break;
			}

			case 'pauseProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.pause();

				accept();

				break;
			}

			case 'resumeProducer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				await producer.resume();

				accept();

				break;
			}

			case 'pauseConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.pause();

				accept();

				break;
			}

			case 'resumeConsumer':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.resume();

				accept();

				break;
			}

			case 'setConsumerPreferredLayers':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, spatialLayer, temporalLayer } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPreferredLayers({ spatialLayer, temporalLayer });

				accept();

				break;
			}

			case 'setConsumerPriority':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId, priority } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.setPriority(priority);

				accept();

				break;
			}

			case 'requestConsumerKeyFrame':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				await consumer.requestKeyFrame();

				accept();

				break;
			}

			case 'produceData':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const {
					transportId,
					sctpStreamParameters,
					label,
					protocol,
					appData
				} = request.data;

				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const dataProducer = await transport.produceData(
					{
						sctpStreamParameters,
						label,
						protocol,
						appData
					});

				// Store the Producer into the protoo Peer data Object.
				peer.data.dataProducers.set(dataProducer.id, dataProducer);

				accept({ id: dataProducer.id });

				switch (dataProducer.label)
				{
					case 'chat':
					{
						// Create a server-side DataConsumer for each Peer.
						for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
						{
							this._createDataConsumer(
								{
									dataConsumerPeer : otherPeer,
									dataProducerPeer : peer,
									dataProducer
								});
						}

						break;
					}

					case 'bot':
					{
						// Pass it to the bot.
						this._bot.handlePeerDataProducer(
							{
								dataProducerId : dataProducer.id,
								peer
							});

						break;
					}
				}

				break;
			}

			case 'changeDisplayName':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const { displayName } = request.data;
				const oldDisplayName = peer.data.displayName;

				// Store the display name into the custom data Object of the protoo
				// Peer.
				peer.data.displayName = displayName;

				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer }))
				{
					otherPeer.notify(
						'peerDisplayNameChanged',
						{
							peerId : peer.id,
							displayName,
							oldDisplayName
						})
						.catch(() => {});
				}

				accept();

				break;
			}

			case 'getTransportStats':
			{
				const { transportId } = request.data;
				const transport = peer.data.transports.get(transportId);

				if (!transport)
					throw new Error(`transport with id "${transportId}" not found`);

				const stats = await transport.getStats();

				accept(stats);

				break;
			}

			case 'getProducerStats':
			{
				const { producerId } = request.data;
				const producer = peer.data.producers.get(producerId);

				if (!producer)
					throw new Error(`producer with id "${producerId}" not found`);

				const stats = await producer.getStats();

				accept(stats);

				break;
			}

			case 'getConsumerStats':
			{
				const { consumerId } = request.data;
				const consumer = peer.data.consumers.get(consumerId);

				if (!consumer)
					throw new Error(`consumer with id "${consumerId}" not found`);

				const stats = await consumer.getStats();

				accept(stats);

				break;
			}

			case 'getDataProducerStats':
			{
				const { dataProducerId } = request.data;
				const dataProducer = peer.data.dataProducers.get(dataProducerId);

				if (!dataProducer)
					throw new Error(`dataProducer with id "${dataProducerId}" not found`);

				const stats = await dataProducer.getStats();

				accept(stats);

				break;
			}

			case 'getDataConsumerStats':
			{
				const { dataConsumerId } = request.data;
				const dataConsumer = peer.data.dataConsumers.get(dataConsumerId);

				if (!dataConsumer)
					throw new Error(`dataConsumer with id "${dataConsumerId}" not found`);

				const stats = await dataConsumer.getStats();

				accept(stats);

				break;
			}

			case 'applyNetworkThrottle':
			{
				const DefaultUplink = 1000000;
				const DefaultDownlink = 1000000;
				const DefaultRtt = 0;
				const DefaultPacketLoss = 0;

				const { secret, uplink, downlink, rtt, packetLoss } = request.data;

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed');

					return;
				}

				try
				{
					this._networkThrottled = true;

					await throttle.start(
						{
							up         : uplink || DefaultUplink,
							down       : downlink || DefaultDownlink,
							rtt        : rtt || DefaultRtt,
							packetLoss : packetLoss || DefaultPacketLoss
						});

					logger.warn(
						'network throttle set [uplink:%s, downlink:%s, rtt:%s, packetLoss:%s]',
						uplink || DefaultUplink,
						downlink || DefaultDownlink,
						rtt || DefaultRtt,
						packetLoss || DefaultPacketLoss);

					accept();
				}
				catch (error)
				{
					logger.error('network throttle apply failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			case 'resetNetworkThrottle':
			{
				const { secret } = request.data;

				if (!secret || secret !== process.env.NETWORK_THROTTLE_SECRET)
				{
					reject(403, 'operation NOT allowed');

					return;
				}

				try
				{
					await throttle.stop({});

					logger.warn('network throttle stopped');

					accept();
				}
				catch (error)
				{
					logger.error('network throttle stop failed: %o', error);

					reject(500, error.toString());
				}

				break;
			}

			case 'toggleHandRaise':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');
				
				// Toggle hand raise state
				const raisedHand = request.data.raisedHand; // true = raise, false = lower

				peer.data.raisedHand = raisedHand;
				
				// Choose the correct notification method
				const notificationType = raisedHand ? 'peerRaisedHand' : 'peerLoweredHand';
				
				// Notify other joined Peers.
				for (const otherPeer of this._getJoinedPeers({ excludePeer: peer })) 
				{
					otherPeer.notify(
						notificationType,
						{
							peerId      : peer.id,
							displayName : peer.data.displayName
						}
					).catch(() => {});
				}
				
				accept();
				break;
			}

			case 'startRecording':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				logger.info('startRecording() [peerId:%s]', peer.id);

				try
				{
					await this._startRecording({ peer });

					accept();
				}
				catch (error)
				{
					logger.error('startRecording() failed:%o', error);

					reject(500, error.message);
				}

				break;
			}

			case 'stopRecording':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				logger.info('stopRecording() [peerId:%s]', peer.id);

				try
				{
					await this._stopRecording({ reason: 'user_requested' });

					accept();
				}
				catch (error)
				{
					logger.error('stopRecording() failed:%o', error);

					reject(500, error.message);
				}

				break;
			}

			case 'getRecordingStatus':
			{
				// Ensure the Peer is joined.
				if (!peer.data.joined)
					throw new Error('Peer not yet joined');

				const isRecording = Boolean(this._gstreamer);
				const initiator = isRecording 
					? this._getJoinedPeers().find((p) => p.id === this._recordingInitiatorPeerId)
					: null;

				accept({
					isRecording,
					initiatorPeerId : this._recordingInitiatorPeerId || null,
					initiatorName   : initiator ? initiator.data.displayName : null,
					startTime       : this._recordingStartTime || null,
					duration        : this._recordingStartTime 
						? Date.now() - this._recordingStartTime 
						: 0
				});

				break;
			}

			default:
			{
				logger.error('unknown request.method "%s"', request.method);

				reject(500, `unknown request.method "${request.method}"`);
			}
		}
	}

	/**
	 * Helper to get the list of joined protoo peers.
	 */
	_getJoinedPeers({ excludePeer = undefined } = {})
	{
		return this._protooRoom.peers
			.filter((peer) => peer.data.joined && peer !== excludePeer);
	}

	/**
	 * Creates a mediasoup Consumer for the given mediasoup Producer.
	 *
	 * @async
	 */
	async _createConsumer({ consumerPeer, producerPeer, producer })
	{
		// Optimization:
		// - Create the server-side Consumer in paused mode.
		// - Tell its Peer about it and wait for its response.
		// - Upon receipt of the response, resume the server-side Consumer.
		// - If video, this will mean a single key frame requested by the
		//   server-side Consumer (when resuming it).
		// - If audio (or video), it will avoid that RTP packets are received by the
		//   remote endpoint *before* the Consumer is locally created in the endpoint
		//   (and before the local SDP O/A procedure ends). If that happens (RTP
		//   packets are received before the SDP O/A is done) the PeerConnection may
		//   fail to associate the RTP stream.

		// NOTE: Don't create the Consumer if the remote Peer cannot consume it.
		if (
			!consumerPeer.data.rtpCapabilities ||
			!this._mediasoupRouter.canConsume(
				{
					producerId      : producer.id,
					rtpCapabilities : consumerPeer.data.rtpCapabilities
				})
		)
		{
			return;
		}

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(consumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createConsumer() | Transport for consuming not found');

			return;
		}

		const promises = [];

		const consumerCount = 1 + this._consumerReplicas;

		for (let i=0; i<consumerCount; i++)
		{
			promises.push(
				// eslint-disable-next-line no-async-promise-executor
				new Promise(async (resolve) =>
				{
					// Create the Consumer in paused mode.
					let consumer;

					try
					{
						consumer = await transport.consume(
							{
								producerId      : producer.id,
								rtpCapabilities : consumerPeer.data.rtpCapabilities,
								// Enable NACK for OPUS.
								enableRtx       : true,
								paused          : true,
								ignoreDtx       : true
							});
					}
					catch (error)
					{
						logger.warn('_createConsumer() | transport.consume():%o', error);

						resolve();

						return;
					}

					// Store the Consumer into the protoo consumerPeer data Object.
					consumerPeer.data.consumers.set(consumer.id, consumer);

					// Set Consumer events.
					consumer.on('transportclose', () =>
					{
						// Remove from its map.
						consumerPeer.data.consumers.delete(consumer.id);
			
						// Record consumer drop
						this._recordEvent('consumer_dropped', 
							{
								consumerId   : consumer.id,
								peerId       : consumerPeer.id,
								producerId   : producer.id,
								producerPeer : producerPeer.id,
								reason       : 'transport_closed',
								severity     : 'high'
							});
					});

					consumer.on('producerclose', () =>
					{
						// Remove from its map.
						consumerPeer.data.consumers.delete(consumer.id);

						// Record consumer drop due to producer close
						this._recordEvent('consumer_dropped', 
							{
								consumerId   : consumer.id,
								peerId       : consumerPeer.id,
								producerId   : producer.id,
								producerPeer : producerPeer.id,
								reason       : 'producer_closed',
								severity     : 'medium'
							});

						consumerPeer.notify('consumerClosed', { consumerId: consumer.id })
							.catch(() => {});
					});					consumer.on('producerpause', () =>
					{
						consumerPeer.notify('consumerPaused', { consumerId: consumer.id })
							.catch(() => {});
					});

					consumer.on('producerresume', () =>
					{
						consumerPeer.notify('consumerResumed', { consumerId: consumer.id })
							.catch(() => {});
					});

					consumer.on('score', (score) =>
					{
						// logger.debug(
						//	 'consumer "score" event [consumerId:%s, score:%o]',
						//	 consumer.id, score);

						consumerPeer.notify('consumerScore', { consumerId: consumer.id, score })
							.catch(() => {});
					});

					consumer.on('layerschange', (layers) =>
					{
						consumerPeer.notify(
							'consumerLayersChanged',
							{
								consumerId    : consumer.id,
								spatialLayer  : layers ? layers.spatialLayer : null,
								temporalLayer : layers ? layers.temporalLayer : null
							})
							.catch(() => {});
					});

					// NOTE: For testing.
					// await consumer.enableTraceEvent([ 'rtp', 'keyframe', 'nack', 'pli', 'fir' ]);
					// await consumer.enableTraceEvent([ 'pli', 'fir' ]);
					// await consumer.enableTraceEvent([ 'keyframe' ]);

					consumer.on('trace', (trace) =>
					{
						logger.debug(
							'consumer "trace" event [producerId:%s, trace.type:%s, trace:%o]',
							consumer.id, trace.type, trace);
					});

					// Send a protoo request to the remote Peer with Consumer parameters.
					try
					{
						await consumerPeer.request(
							'newConsumer',
							{
								peerId         : producerPeer.id,
								producerId     : producer.id,
								id             : consumer.id,
								kind           : consumer.kind,
								rtpParameters  : consumer.rtpParameters,
								type           : consumer.type,
								appData        : producer.appData,
								producerPaused : consumer.producerPaused
							});

						// Now that we got the positive response from the remote endpoint, resume
						// the Consumer so the remote endpoint will receive the a first RTP packet
						// of this new stream once its PeerConnection is already ready to process
						// and associate it.
						await consumer.resume();

						consumerPeer.notify(
							'consumerScore',
							{
								consumerId : consumer.id,
								score      : consumer.score
							})
							.catch(() => {});

						resolve();
					}
					catch (error)
					{
						logger.warn('_createConsumer() | failed:%o', error);

						resolve();
					}
				})
			);
		}

		try
		{
			await Promise.all(promises);
		}
		catch (error)
		{
			logger.warn('_createConsumer() | failed:%o', error);
		}
	}

	/**
	 * Creates a mediasoup DataConsumer for the given mediasoup DataProducer.
	 *
	 * @async
	 */
	async _createDataConsumer(
		{
			dataConsumerPeer,
			dataProducerPeer = null, // This is null for the bot DataProducer.
			dataProducer
		})
	{
		// NOTE: Don't create the DataConsumer if the remote Peer cannot consume it.
		if (!dataConsumerPeer.data.sctpCapabilities)
			return;

		// Must take the Transport the remote Peer is using for consuming.
		const transport = Array.from(dataConsumerPeer.data.transports.values())
			.find((t) => t.appData.consuming);

		// This should not happen.
		if (!transport)
		{
			logger.warn('_createDataConsumer() | Transport for consuming not found');

			return;
		}

		// Create the DataConsumer.
		let dataConsumer;

		try
		{
			dataConsumer = await transport.consumeData(
				{
					dataProducerId : dataProducer.id
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | transport.consumeData():%o', error);

			return;
		}

		// Store the DataConsumer into the protoo dataConsumerPeer data Object.
		dataConsumerPeer.data.dataConsumers.set(dataConsumer.id, dataConsumer);

		// Set DataConsumer events.
		dataConsumer.on('transportclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);
		});

		dataConsumer.on('dataproducerclose', () =>
		{
			// Remove from its map.
			dataConsumerPeer.data.dataConsumers.delete(dataConsumer.id);

			dataConsumerPeer.notify(
				'dataConsumerClosed', { dataConsumerId: dataConsumer.id })
				.catch(() => {});
		});

		// Send a protoo request to the remote Peer with Consumer parameters.
		try
		{
			await dataConsumerPeer.request(
				'newDataConsumer',
				{
					// This is null for bot DataProducer.
					peerId               : dataProducerPeer ? dataProducerPeer.id : null,
					dataProducerId       : dataProducer.id,
					id                   : dataConsumer.id,
					sctpStreamParameters : dataConsumer.sctpStreamParameters,
					label                : dataConsumer.label,
					protocol             : dataConsumer.protocol,
					appData              : dataProducer.appData
				});
		}
		catch (error)
		{
			logger.warn('_createDataConsumer() | failed:%o', error);
		}
	}

	/**
	 * Start comprehensive room monitoring
	 */
	_startRoomMonitoring()
	{
		logger.info('Starting room monitoring [roomId:%s]', this._roomId);

		// Monitor room stats (ultra-conservative frequency)
		const roomStatsInterval = setInterval(() =>
		{
			this._collectRoomStats();
		}, 120000); // Increased from 45s to 2 minutes

		this._monitoringIntervals.set('roomStats', roomStatsInterval);

		// Monitor connection quality (optimized frequency)
		const qualityInterval = setInterval(() =>
		{
			this._monitorConnectionQuality();
		}, this._monitoringFrequency); // 15s instead of 10s

		this._monitoringIntervals.set('connectionQuality', qualityInterval);

		// Log detailed analytics (ultra-conservative frequency)
		const analyticsInterval = setInterval(() =>
		{
			this._logDetailedAnalytics();
		}, 600000); // Increased from 5m to 10m

		this._monitoringIntervals.set('analytics', analyticsInterval);

		// Memory cleanup interval
		const cleanupInterval = setInterval(() =>
		{
			this._cleanupAnalyticsMemory();
		}, this._analyticsCleanupInterval);

		this._monitoringIntervals.set('cleanup', cleanupInterval);

		this._monitoringIntervals.set('analytics', analyticsInterval);
	}

	/**
	 * Collect comprehensive room statistics
	 */
	_collectRoomStats()
	{
		const joinedPeers = this._getJoinedPeers();
		
		this._analytics.activePeers = joinedPeers.length;
		this._analytics.totalTransports = 0;
		this._analytics.totalProducers = 0;
		this._analytics.totalConsumers = 0;

		// Collect per-peer statistics
		joinedPeers.forEach((peer) =>
		{
			this._analytics.totalTransports += peer.data.transports.size;
			this._analytics.totalProducers += peer.data.producers.size;
			this._analytics.totalConsumers += peer.data.consumers.size;

			// Monitor each transport
			peer.data.transports.forEach((transport) =>
			{
				this._monitorTransportHealth(transport, peer);
			});

			// Monitor each producer
			peer.data.producers.forEach((producer) =>
			{
				this._monitorProducerHealth(producer, peer);
			});

			// Monitor each consumer
			peer.data.consumers.forEach((consumer) =>
			{
				this._monitorConsumerHealth(consumer, peer);
			});
		});

		// Log current room status
		logger.info(
			'Room stats [roomId:%s, peers:%d, transports:%d, producers:%d, consumers:%d]',
			this._roomId,
			this._analytics.activePeers,
			this._analytics.totalTransports,
			this._analytics.totalProducers,
			this._analytics.totalConsumers
		);
	}

	/**
	 * Monitor transport health
	 */
	_monitorTransportHealth(transport, peer)
	{
		// Get transport stats
		transport.getStats()
			.then((stats) =>
			{
				for (const stat of stats)
				{
					if (stat.type === 'transport')
					{
						const transportInfo = 
						{
							transportId     : transport.id,
							peerId          : peer.id,
							bytesReceived   : stat.bytesReceived || 0,
							bytesSent       : stat.bytesSent || 0,
							packetsReceived : stat.packetsReceived || 0,
							packetsSent     : stat.packetsSent || 0,
							timestamp       : Date.now()
						};

						// Update global data transfer metrics
						this._analytics.dataTransferred.received += stat.bytesReceived || 0;
						this._analytics.dataTransferred.sent += stat.bytesSent || 0;

						// Check for transport issues
						if (stat.packetLossPercentage > 5)
						{
							this._recordEvent('transport_high_packet_loss', 
								{
									transportId : transport.id,
									peerId      : peer.id,
									packetLoss  : stat.packetLossPercentage,
									severity    : 'warning'
								});
						}
					}
				}
			})
			.catch((error) =>
			{
				this._recordError('transport_stats_failed', error, 
					{
						transportId : transport.id,
						peerId      : peer.id
					});
			});
	}

	/**
	 * Monitor producer health
	 */
	_monitorProducerHealth(producer, peer)
	{
		// Get producer stats
		producer.getStats()
			.then((stats) =>
			{
				for (const stat of stats)
				{
					if (stat.type === 'outbound-rtp')
					{
						const producerInfo = 
						{
							producerId  : producer.id,
							peerId      : peer.id,
							kind        : producer.kind,
							packetsSent : stat.packetsSent || 0,
							bytesSent   : stat.bytesSent || 0,
							packetsLost : stat.packetsLost || 0,
							nackCount   : stat.nackCount || 0,
							timestamp   : Date.now()
						};

						// Check for producer issues
						if (stat.packetsLost > 50)
						{
							this._recordEvent('producer_high_packet_loss', 
								{
									producerId  : producer.id,
									peerId      : peer.id,
									kind        : producer.kind,
									packetsLost : stat.packetsLost,
									severity    : 'warning'
								});
						}

						if (producer.kind === 'video' && stat.framesPerSecond < 15)
						{
							this._recordEvent('producer_low_framerate', 
								{
									producerId : producer.id,
									peerId     : peer.id,
									framerate  : stat.framesPerSecond,
									severity   : 'warning'
								});
						}
					}
				}
			})
			.catch((error) =>
			{
				this._recordError('producer_stats_failed', error, 
					{
						producerId : producer.id,
						peerId     : peer.id
					});
			});
	}

	/**
	 * Monitor consumer health
	 */
	_monitorConsumerHealth(consumer, peer)
	{
		// Get consumer stats
		consumer.getStats()
			.then((stats) =>
			{
				for (const stat of stats)
				{
					if (stat.type === 'inbound-rtp')
					{
						const consumerInfo = 
						{
							consumerId      : consumer.id,
							peerId          : peer.id,
							kind            : consumer.kind,
							packetsReceived : stat.packetsReceived || 0,
							bytesReceived   : stat.bytesReceived || 0,
							packetsLost     : stat.packetsLost || 0,
							jitter          : stat.jitter || 0,
							timestamp       : Date.now()
						};

						// Check for consumer issues
						if (stat.packetsLost > 50)
						{
							this._recordEvent('consumer_high_packet_loss', 
								{
									consumerId  : consumer.id,
									peerId      : peer.id,
									kind        : consumer.kind,
									packetsLost : stat.packetsLost,
									severity    : 'warning'
								});
						}

						// Check audio quality issues
						if (consumer.kind === 'audio' && stat.jitter > 0.1)
						{
							this._recordEvent('consumer_high_jitter', 
								{
									consumerId : consumer.id,
									peerId     : peer.id,
									jitter     : stat.jitter,
									severity   : 'warning'
								});
						}
					}
				}
			})
			.catch((error) =>
			{
				this._recordError('consumer_stats_failed', error, 
					{
						consumerId : consumer.id,
						peerId     : peer.id
					});
			});
	}

	/**
	 * Monitor connection quality for all peers
	 */
	_monitorConnectionQuality()
	{
		const joinedPeers = this._getJoinedPeers();

		joinedPeers.forEach((peer) =>
		{
			const qualityMetrics = this._connectionQuality.get(peer.id) || 
			{
				score      : 5,
				rtt        : 0,
				packetLoss : 0,
				lastUpdate : Date.now(),
				issues     : []
			};

			// Calculate quality score based on recent issues
			let qualityScore = 5;
			const recentIssues = this._analytics.connectionEvents.filter(
				(event) => event.peerId === peer.id && 
				Date.now() - event.timestamp < 60000 // Last minute
			);

			// Reduce score based on issues
			recentIssues.forEach((issue) =>
			{
				switch (issue.type)
				{
					case 'transport_high_packet_loss':
					case 'producer_high_packet_loss':
					case 'consumer_high_packet_loss':
						qualityScore -= 1;
						break;
					case 'producer_low_framerate':
					case 'consumer_high_jitter':
						qualityScore -= 0.5;
						break;
				}
			});

			qualityScore = Math.max(1, Math.min(5, qualityScore));
			qualityMetrics.score = qualityScore;
			qualityMetrics.lastUpdate = Date.now();
			qualityMetrics.issues = recentIssues.slice(-5); // Keep last 5 issues

			this._connectionQuality.set(peer.id, qualityMetrics);

			// Notify peer about connection quality
			if (qualityScore < 3)
			{
				peer.notify('connectionQualityChanged', 
					{
						quality : qualityScore,
						issues  : recentIssues.map((issue) => issue.type)
					}).catch(() => {});
			}
		});
	}

	/**
	 * Record events for analytics
	 */
	_recordEvent(type, data)
	{
		const event = 
		{
			type,
			timestamp : Date.now(),
			...data
		};

		this._analytics.connectionEvents.push(event);

		// Keep only recent events (memory optimized)
		if (this._analytics.connectionEvents.length > this._maxConnectionEvents)
		{
			this._analytics.connectionEvents = 
				this._analytics.connectionEvents.slice(-this._maxConnectionEvents);
		}

		// Only log important events to reduce log noise
		if (type.includes('drop') || type.includes('error') || type.includes('fail'))
		{
			logger.warn('Event recorded [roomId:%s, type:%s, data:%o]', 
				this._roomId, type, data);
		}

		// Emit event for external monitoring
		this.emit('analyticsEvent', event);
	}

	/**
	 * Record errors for analytics
	 */
	_recordError(type, error, context = {})
	{
		const errorEvent = 
		{
			type,
			timestamp : Date.now(),
			message   : error.message || error,
			stack     : error.stack,
			context
		};

		this._analytics.errors.push(errorEvent);

		// Keep only recent errors (memory optimized)
		if (this._analytics.errors.length > this._maxErrors)
		{
			this._analytics.errors = this._analytics.errors.slice(-this._maxErrors);
		}

		logger.error('Error recorded [roomId:%s, type:%s, error:%s, context:%o]', 
			this._roomId, type, error.message || error, context);

		// Emit error for external monitoring
		this.emit('analyticsError', errorEvent);
	}

	/**
	 * Log detailed analytics
	 */
	_logDetailedAnalytics()
	{
		const uptimeMinutes = 
			Math.floor((Date.now() - this._analytics.roomCreatedAt) / 60000);
		const joinedPeers = this._getJoinedPeers();

		const analytics = 
		{
			roomId            : this._roomId,
			uptime            : uptimeMinutes,
			currentPeers      : joinedPeers.length,
			totalPeersJoined  : this._analytics.totalPeers,
			totalTransports   : this._analytics.totalTransports,
			totalProducers    : this._analytics.totalProducers,
			totalConsumers    : this._analytics.totalConsumers,
			dataTransferred   : this._analytics.dataTransferred,
			recentErrors      : this._analytics.errors.slice(-10),
			recentEvents      : this._analytics.connectionEvents.slice(-20),
			connectionQuality : Array.from(this._connectionQuality.entries())
				.map(([ peerId, quality ]) => ({
					peerId,
					score  : quality.score,
					issues : quality.issues.length
				}))
		};

		logger.info('Room analytics [roomId:%s]:\n%s', 
			this._roomId, JSON.stringify(analytics, null, 2));

		// Emit analytics for external monitoring
		this.emit('roomAnalytics', analytics);
	}

	/**
	 * Get room analytics (public method)
	 */
	getRoomAnalytics()
	{
		const joinedPeers = this._getJoinedPeers();
		
		return {
			roomId            : this._roomId,
			uptime            : Date.now() - this._analytics.roomCreatedAt,
			currentPeers      : joinedPeers.length,
			totalPeersJoined  : this._analytics.totalPeers,
			totalTransports   : this._analytics.totalTransports,
			totalProducers    : this._analytics.totalProducers,
			totalConsumers    : this._analytics.totalConsumers,
			dataTransferred   : this._analytics.dataTransferred,
			recentErrors      : this._analytics.errors.slice(-5),
			recentEvents      : this._analytics.connectionEvents.slice(-10),
			connectionQuality : Array.from(this._connectionQuality.entries())
				.map(([ peerId, quality ]) => 
				{
					const peerData = joinedPeers.find((p) => p.id === peerId);
					const displayName = peerData && peerData.data ? peerData.data.displayName : 'Unknown';
				
					return {
						peerId       : peerId,
						displayName  : displayName,
						score        : quality.score,
						lastUpdate   : quality.lastUpdate,
						recentIssues : quality.issues.length
					};
				})
		};
	}

	/**
	 * Clean up analytics memory to prevent memory leaks
	 */
	_cleanupAnalyticsMemory()
	{
		const now = Date.now();
		const oldEventThreshold = now - (3600000); // 1 hour ago

		// Clean old connection events
		this._analytics.connectionEvents = this._analytics.connectionEvents
			.filter((event) => event.timestamp > oldEventThreshold)
			.slice(-this._maxConnectionEvents);

		// Clean old errors  
		this._analytics.errors = this._analytics.errors
			.filter((error) => error.timestamp > oldEventThreshold)
			.slice(-this._maxErrors);

		// Clean old peer events
		this._analytics.peerEvents = this._analytics.peerEvents
			.filter((event) => event.timestamp > oldEventThreshold)
			.slice(-this._maxPeerEvents);

		// Clean up connection quality for disconnected peers
		const activePeerIds = new Set();
		
		for (const peer of this._getJoinedPeers())
		{
			activePeerIds.add(peer.id);
		}

		for (const peerId of this._connectionQuality.keys())
		{
			if (!activePeerIds.has(peerId))
			{
				this._connectionQuality.delete(peerId);
			}
		}

		logger.debug('Analytics memory cleanup completed [roomId:%s]', this._roomId);
	}

	/**
	 * Get real-time stats for a specific peer
	 */
	getPeerStats(peerId)
	{
		const peer = this._protooRoom.getPeer(peerId);

		if (!peer || !peer.data.joined)
			return null;

		return {
			peerId            : peerId,
			displayName       : peer.data.displayName,
			device            : peer.data.device,
			transports        : peer.data.transports.size,
			producers         : peer.data.producers.size,
			consumers         : peer.data.consumers.size,
			connectionQuality : this._connectionQuality.get(peerId) || { score: 5, issues: [] }
		};
	}

	/**
	 * Get all producers stats in the room
	 */
	getProducersStats()
	{
		const producersStats = [];
		const joinedPeers = this._getJoinedPeers();

		for (const peer of joinedPeers)
		{
			for (const producer of peer.data.producers.values())
			{
				producersStats.push({
					id              : producer.id,
					peerId          : peer.id,
					peerDisplayName : peer.data.displayName,
					kind            : producer.kind,
					type            : producer.type,
					paused          : producer.paused,
					score           : producer.score,
					rtpParameters   : {
						codecs           : producer.rtpParameters.codecs,
						headerExtensions : producer.rtpParameters.headerExtensions.length
					},
					appData : producer.appData
				});
			}
		}

		return producersStats;
	}

	/**
	 * Get all consumers stats in the room
	 */
	getConsumersStats()
	{
		const consumersStats = [];
		const joinedPeers = this._getJoinedPeers();

		for (const peer of joinedPeers)
		{
			for (const consumer of peer.data.consumers.values())
			{
				consumersStats.push({
					id              : consumer.id,
					peerId          : peer.id,
					peerDisplayName : peer.data.displayName,
					producerId      : consumer.producerId,
					kind            : consumer.kind,
					type            : consumer.type,
					paused          : consumer.paused,
					producerPaused  : consumer.producerPaused,
					score           : consumer.score,
					preferredLayers : consumer.preferredLayers,
					currentLayers   : consumer.currentLayers,
					appData         : consumer.appData
				});
			}
		}

		return consumersStats;
	}

	/**
	 * Get specific producer stats
	 */
	getProducerStats(producerId)
	{
		const joinedPeers = this._getJoinedPeers();

		for (const peer of joinedPeers)
		{
			const producer = peer.data.producers.get(producerId);

			if (producer)
			{
				return {
					id              : producer.id,
					peerId          : peer.id,
					peerDisplayName : peer.data.displayName,
					kind            : producer.kind,
					type            : producer.type,
					paused          : producer.paused,
					score           : producer.score,
					rtpParameters   : producer.rtpParameters,
					appData         : producer.appData,
					stats           : producer.getStats ? producer.getStats() : null
				};
			}
		}

		return null;
	}

	/**
	 * Get specific consumer stats
	 */
	getConsumerStats(consumerId)
	{
		const joinedPeers = this._getJoinedPeers();

		for (const peer of joinedPeers)
		{
			const consumer = peer.data.consumers.get(consumerId);

			if (consumer)
			{
				return {
					id              : consumer.id,
					peerId          : peer.id,
					peerDisplayName : peer.data.displayName,
					producerId      : consumer.producerId,
					kind            : consumer.kind,
					type            : consumer.type,
					paused          : consumer.paused,
					producerPaused  : consumer.producerPaused,
					score           : consumer.score,
					preferredLayers : consumer.preferredLayers,
					currentLayers   : consumer.currentLayers,
					appData         : consumer.appData,
					stats           : consumer.getStats ? consumer.getStats() : null
				};
			}
		}

		return null;
	}

	/**
	 * Start recording the room - captures ALL participants
	 */
	async _startRecording({ peer })
	{
		// Prevent concurrent recording operations with a lock
		if (this._recordingLock)
		{
			throw new Error('Another recording operation is in progress, please wait');
		}

		if (this._gstreamer)
		{
			// Return info about who started recording so client can show appropriate message
			const initiator = this._getJoinedPeers().find((p) => p.id === this._recordingInitiatorPeerId);
			const initiatorName = (initiator && initiator.data && initiator.data.displayName) || 'Another user';

			throw new Error(`Recording already in progress (started by ${initiatorName})`);
		}

		// Acquire lock
		this._recordingLock = true;

		try
		{
			logger.info('_startRecording() [peerId:%s]', peer.id);

			// Collect ALL video and audio producers from ALL peers
			const videoProducers = [];
			const audioProducers = [];

			for (const joinedPeer of this._getJoinedPeers())
			{
				for (const producer of joinedPeer.data.producers.values())
				{
					if (producer.kind === 'video')
					{
						videoProducers.push({ producer, peer: joinedPeer });
						logger.info('_startRecording() Found video producer [peerId:%s, producerId:%s]',
							joinedPeer.id, producer.id);
					}
					else if (producer.kind === 'audio')
					{
						audioProducers.push({ producer, peer: joinedPeer });
						logger.info('_startRecording() Found audio producer [peerId:%s, producerId:%s]',
							joinedPeer.id, producer.id);
					}
				}
			}

			logger.info('_startRecording() Found %d video producers and %d audio producers',
				videoProducers.length, audioProducers.length);

			if (videoProducers.length === 0)
			{
				throw new Error('No video producers found for recording');
			}

			// Publish RTP streams for ALL video producers with peer names
			const videoInfos = [];

			for (const { producer, peer: producerPeer } of videoProducers)
			{
				const videoInfo = await this._publishProducerRtpStream(producer);

				// Add peer display name for overlay
				videoInfo.peerName = producerPeer.data.displayName || `Peer ${producerPeer.id.slice(0, 6)}`;
				videoInfos.push(videoInfo);
			}

			// Publish RTP streams for ALL audio producers
			const audioInfos = [];

			for (const { producer } of audioProducers)
			{
				const audioInfo = await this._publishProducerRtpStream(producer);

				audioInfos.push(audioInfo);
			}

			// Build recording info for GStreamer with multiple streams
			// Include room ID in filename for easy identification
			// Use segment number for multiple segments when new participants join
			const segmentNumber = this._recordingSegments.length;
			const segmentFileName = `recording-${this._roomId}-segment-${segmentNumber}-${Date.now()}`;

			// Initialize base filename on first segment
			if (segmentNumber === 0)
			{
				this._recordingBaseFileName = `recording-${this._roomId}-${Date.now()}`;
			}

			const recordInfo = {
				videos   : videoInfos,
				audios   : audioInfos,
				fileName : segmentFileName
			};

			// Track this segment for later merging
			const segmentPath = `./recordings/${segmentFileName}.mp4`;

			this._recordingSegments.push(segmentPath);

			logger.info('_startRecording() Creating segment %d: %s', segmentNumber, segmentPath);
			logger.info('_startRecording() creating GStreamer with %d videos and %d audios',
				videoInfos.length, audioInfos.length);

			// Create GStreamer process
			this._gstreamer = new GStreamer(recordInfo);

			// Handle GStreamer events
			this._gstreamer.on('process-close', () =>
			{
				logger.info('_startRecording() GStreamer process closed');
				this._gstreamer = undefined;
			});

			this._gstreamer.on('error', (error) =>
			{
				logger.error('_startRecording() GStreamer error:%o', error);
			});

			// Wait for GStreamer to fully start, then resume consumers and request keyframes
			// This is critical - if we resume too early, packets may be lost
			setTimeout(async () =>
			{
				logger.info('_startRecording() Resuming consumers after GStreamer startup delay');

				for (const { consumer, transport } of this._recordingConsumers.values())
				{
					try
					{
					// Log transport state before resuming
						logger.info('_startRecording() Transport before resume: tuple=%o, rtcpTuple=%o',
							transport.tuple, transport.rtcpTuple);

						await consumer.resume();
						await consumer.requestKeyFrame();
						logger.info('_startRecording() Resumed consumer [id:%s, kind:%s]',
							consumer.id, consumer.kind);

						// Log consumer stats after a short delay
						setTimeout(async () =>
						{
							try
							{
								const stats = await consumer.getStats();

								logger.info('_startRecording() Consumer stats [kind:%s]: %o',
									consumer.kind, stats);
							}
							catch (err)
							{
								logger.error('_startRecording() Error getting stats:%o', err);
							}
						}, 2000);
					}
					catch (error)
					{
						logger.error('_startRecording() Error resuming consumer:%o', error);
					}
				}
			}, 2000);

			// Store recording metadata
			this._recordingInitiatorPeerId = peer.id;
			this._recordingStartTime = Date.now();

			logger.info('_startRecording() Recording started successfully');

			// Notify all peers that recording has started
			for (const otherPeer of this._getJoinedPeers())
			{
				otherPeer.notify('recordingStarted', {
					initiatorPeerId : peer.id,
					initiatorName   : peer.data.displayName,
					startTime       : this._recordingStartTime
				}).catch(() => {});
			}
		}
		finally
		{
			// Release lock
			this._recordingLock = false;
		}
	}

	/**
	 * Stop recording
	 * @param {Object} options
	 * @param {String} options.reason - Reason for stopping
	 * @param {Boolean} options.skipMerge - Skip merging segments (for internal restart)
	 */
	async _stopRecording({ reason = 'user_requested', skipMerge = false } = {})
	{
		// Prevent concurrent operations
		if (this._recordingLock)
		{
			throw new Error('Another recording operation is in progress, please wait');
		}

		// Check if recording was supposed to be active (even if GStreamer crashed)
		const hadRecording = this._recordingInitiatorPeerId !== undefined;

		if (!this._gstreamer && !hadRecording)
		{
			throw new Error('No recording in progress');
		}

		this._recordingLock = true;

		try
		{
			logger.info('_stopRecording() [reason:%s, skipMerge:%s, gstreamerActive:%s]',
				reason, skipMerge, Boolean(this._gstreamer));

			const recordingDuration = this._recordingStartTime 
				? Date.now() - this._recordingStartTime 
				: 0;

			// Kill GStreamer process (may already be undefined if it crashed)
			if (this._gstreamer)
			{
				this._gstreamer.kill();
				this._gstreamer = undefined;
			}

			// Close all recording consumers and transports
			for (const { transport, consumer } of this._recordingConsumers.values())
			{
				try { consumer.close(); }
				catch (e) { /* ignore */ }
				try { transport.close(); }
				catch (e) { /* ignore */ }
			}

			this._recordingConsumers.clear();
			this._usedRecordingPorts.clear();

			const initiatorPeerId = this._recordingInitiatorPeerId;
			const segments = [ ...this._recordingSegments ];
			const baseFileName = this._recordingBaseFileName;

			// Only clear recording state if not skipping merge (final stop)
			if (!skipMerge)
			{
				this._recordingInitiatorPeerId = undefined;
				this._recordingStartTime = undefined;
				this._recordingSegments = [];
				this._recordingBaseFileName = undefined;
			}

			logger.info('_stopRecording() Recording stopped [duration:%dms, reason:%s, segments:%d]',
				recordingDuration, reason, segments.length);

			// Merge segments if there are multiple and not skipping
			if (!skipMerge && segments.length > 0)
			{
				// Notify peers that merging is starting
				for (const peer of this._getJoinedPeers())
				{
					peer.notify('recordingMerging', {
						segmentCount : segments.length,
						status       : 'starting'
					}).catch(() => {});
				}

				// Wait a bit for GStreamer to finalize files
				logger.info('_stopRecording() Waiting for segments to finalize...');
				await new Promise((resolve) => setTimeout(resolve, 2000));

				// Merge segments asynchronously
				this._mergeRecordingSegments(segments, baseFileName, initiatorPeerId)
					.catch((error) =>
					{
						logger.error('_stopRecording() Merge failed: %o', error);
					});
			}

			// Notify all peers that recording has stopped
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('recordingStopped', {
					reason,
					duration        : recordingDuration,
					initiatorPeerId,
					segmentCount    : segments.length,
					mergeInProgress : !skipMerge && segments.length > 1
				}).catch(() => {});
			}
		}
		finally
		{
			this._recordingLock = false;
		}
	}

	/**
	 * Merge multiple recording segments into a single file using FFmpeg
	 */
	async _mergeRecordingSegments(segments, baseFileName, initiatorPeerId)
	{
		const fs = require('fs');
		const path = require('path');
		const { spawn } = require('child_process');

		const recordingsDir = './recordings';
		const finalFileName = `${baseFileName}-final.mp4`;
		const finalPath = path.join(recordingsDir, `${baseFileName}-final.mp4`);

		logger.info('========================================');
		logger.info('🎬 STARTING RECORDING MERGE PROCESS');
		logger.info('========================================');
		logger.info('📁 Segments to merge: %d', segments.length);

		segments.forEach((seg, i) =>
		{
			logger.info('   Segment %d: %s', i + 1, seg);
		});

		logger.info('📦 Output file: %s', finalPath);
		logger.info('----------------------------------------');

		// If only one segment, just rename it
		if (segments.length === 1)
		{
			logger.info('📝 Only one segment, renaming to final...');

			try
			{
				const srcPath = segments[0];

				// Wait for file to be fully written
				await new Promise((resolve) => setTimeout(resolve, 1000));

				if (fs.existsSync(srcPath))
				{
					fs.renameSync(srcPath, finalPath);
					logger.info('✅ Single segment renamed successfully');
					logger.info('📁 Final recording: %s', finalPath);

					// Notify peers
					this._notifyMergeComplete(finalFileName, initiatorPeerId);
				}
				else
				{
					logger.error('❌ Segment file not found: %s', srcPath);
				}
			}
			catch (error)
			{
				logger.error('❌ Error renaming segment: %o', error);
			}

			return;
		}

		// Create concat file list for FFmpeg
		const concatListPath = path.join(recordingsDir, `concat-${Date.now()}.txt`);

		logger.info('📝 Creating concat list: %s', concatListPath);

		// Filter out segments that exist
		const existingSegments = [];

		for (const segment of segments)
		{
			// Wait a bit for each file
			await new Promise((resolve) => setTimeout(resolve, 500));

			if (fs.existsSync(segment))
			{
				const stats = fs.statSync(segment);

				logger.info('   ✓ Found: %s (size: %d bytes)', segment, stats.size);

				if (stats.size > 0)
				{
					existingSegments.push(segment);
				}
				else
				{
					logger.warn('   ⚠ Skipping empty segment: %s', segment);
				}
			}
			else
			{
				logger.warn('   ⚠ Missing segment: %s', segment);
			}
		}

		if (existingSegments.length === 0)
		{
			logger.error('❌ No valid segments found to merge');

			return;
		}

		logger.info('📊 Valid segments: %d / %d', existingSegments.length, segments.length);

		// If only one valid segment, rename it
		if (existingSegments.length === 1)
		{
			logger.info('📝 Only one valid segment, renaming...');
			fs.renameSync(existingSegments[0], finalPath);
			logger.info('✅ Segment renamed to final');
			this._notifyMergeComplete(finalFileName, initiatorPeerId);

			return;
		}

		// Create concat list
		const concatContent = existingSegments
			.map((seg) => `file '${path.resolve(seg)}'`)
			.join('\n');

		fs.writeFileSync(concatListPath, concatContent);
		logger.info('📋 Concat list created with %d files', existingSegments.length);

		// Run FFmpeg to merge
		logger.info('----------------------------------------');
		logger.info('🚀 Starting FFmpeg merge process...');
		logger.info('   Command: ffmpeg -f concat -safe 0 -i %s -c copy %s',
			concatListPath, finalPath);

		const ffmpeg = spawn('ffmpeg', [
			'-f', 'concat',
			'-safe', '0',
			'-i', concatListPath,
			'-c', 'copy',
			'-y',
			finalPath
		]);

		ffmpeg.stdout.on('data', (data) =>
		{
			logger.info('📹 FFmpeg: %s', data.toString().trim());
		});

		ffmpeg.stderr.on('data', (data) =>
		{
			const msg = data.toString().trim();

			// FFmpeg outputs progress to stderr
			if (msg.includes('frame=') || msg.includes('time='))
			{
				logger.info('📹 FFmpeg progress: %s', msg);
			}
			else if (msg.includes('Error') || msg.includes('error'))
			{
				logger.error('📹 FFmpeg error: %s', msg);
			}
			else
			{
				logger.info('📹 FFmpeg: %s', msg);
			}
		});

		ffmpeg.on('close', (code) =>
		{
			logger.info('----------------------------------------');

			if (code === 0)
			{
				logger.info('✅ FFmpeg merge completed successfully!');

				// Get final file size
				if (fs.existsSync(finalPath))
				{
					const stats = fs.statSync(finalPath);

					logger.info('📁 Final recording: %s', finalPath);
					logger.info('📊 Final size: %d bytes (%.2f MB)',
						stats.size, stats.size / (1024 * 1024));
				}

				// Clean up segment files
				logger.info('🧹 Cleaning up segment files...');

				for (const segment of existingSegments)
				{
					try
					{
						if (fs.existsSync(segment))
						{
							fs.unlinkSync(segment);
							logger.info('   🗑 Deleted: %s', segment);
						}
					}
					catch (e)
					{
						logger.warn('   ⚠ Could not delete: %s', segment);
					}
				}

				// Clean up concat list
				try
				{
					fs.unlinkSync(concatListPath);
					logger.info('   🗑 Deleted concat list');
				}
				catch (e) { /* ignore */ }

				logger.info('========================================');
				logger.info('🎉 RECORDING MERGE COMPLETE!');
				logger.info('📁 File: %s', finalPath);
				logger.info('========================================');

				// Notify peers
				this._notifyMergeComplete(finalFileName, initiatorPeerId);
			}
			else
			{
				logger.error('❌ FFmpeg merge failed with code: %d', code);
				logger.info('⚠ Segment files preserved for manual recovery');
				logger.info('========================================');

				// Notify peers of failure
				for (const peer of this._getJoinedPeers())
				{
					peer.notify('recordingMerging', {
						status : 'failed',
						error  : `FFmpeg exited with code ${code}`
					}).catch(() => {});
				}
			}
		});

		ffmpeg.on('error', (error) =>
		{
			logger.error('❌ FFmpeg process error: %o', error);
			logger.info('⚠ Segment files preserved for manual recovery');

			// Notify peers
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('recordingMerging', {
					status : 'failed',
					error  : error.message
				}).catch(() => {});
			}
		});
	}

	/**
	 * Notify peers that merge is complete
	 */
	_notifyMergeComplete(finalFileName, initiatorPeerId)
	{
		for (const peer of this._getJoinedPeers())
		{
			peer.notify('recordingMerging', {
				status        : 'complete',
				finalFileName : finalFileName,
				initiatorPeerId
			}).catch(() => {});
		}
	}

	/**
	 * Restart recording to include a new participant
	 * This stops the current recording and starts a new one with all current producers
	 */
	async _restartRecordingForNewProducer(newPeer)
	{
		// Don't restart if lock is held (another operation in progress)
		if (this._recordingLock)
		{
			logger.warn('_restartRecordingForNewProducer() Skipping - recording lock held');

			return;
		}

		// Wait longer for the new peer's producers to be fully set up
		// New participants need time for ICE, DTLS, and producer creation
		logger.info('_restartRecordingForNewProducer() Waiting for new peer to set up producers...');
		await new Promise((resolve) => setTimeout(resolve, 5000));

		// Check if new peer actually has producers now
		const newPeerProducers = [];

		if (newPeer.data.producers)
		{
			for (const producer of newPeer.data.producers.values())
			{
				if (!producer.closed)
				{
					newPeerProducers.push(producer);
				}
			}
		}

		if (newPeerProducers.length === 0)
		{
			logger.info('_restartRecordingForNewProducer() New peer has no producers yet, skipping restart');

			return;
		}

		logger.info('_restartRecordingForNewProducer() New peer has %d producers', newPeerProducers.length);

		// Double-check recording is still active
		if (!this._gstreamer)
		{
			logger.info('_restartRecordingForNewProducer() Recording no longer active');

			return;
		}

		const initiatorPeerId = this._recordingInitiatorPeerId;

		logger.info('_restartRecordingForNewProducer() Restarting for new peer [peerId:%s]',
			newPeer.id);

		try
		{
			// Stop current recording (internal - don't notify as "stopped")
			this._recordingLock = true;

			// Kill GStreamer (may already be undefined if it crashed)
			if (this._gstreamer)
			{
				this._gstreamer.kill();
				this._gstreamer = undefined;
			}

			// Clean up current recording resources
			for (const { transport, consumer } of this._recordingConsumers.values())
			{
				try { consumer.close(); }
				catch (e) { /* ignore */ }
				try { transport.close(); }
				catch (e) { /* ignore */ }
			}
			this._recordingConsumers.clear();
			this._usedRecordingPorts.clear();

			// Wait longer for ports to be released and system to stabilize
			logger.info('_restartRecordingForNewProducer() Waiting for cleanup...');
			await new Promise((resolve) => setTimeout(resolve, 2000));

			this._recordingLock = false;

			// Find the initiator peer
			const initiatorPeer = this._getJoinedPeers()
				.find((p) => p.id === initiatorPeerId);

			if (!initiatorPeer)
			{
				logger.warn('_restartRecordingForNewProducer() Initiator peer no longer present');

				return;
			}

			// Start new recording with all current producers
			await this._startRecording({ peer: initiatorPeer });

			// Notify peers that recording was restarted to include new participant
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('recordingRestarted', {
					reason      : 'new_participant',
					newPeerId   : newPeer.id,
					newPeerName : newPeer.data.displayName
				}).catch(() => {});
			}

			logger.info('_restartRecordingForNewProducer() Recording restarted successfully');
		}
		catch (error)
		{
			logger.error('_restartRecordingForNewProducer() Failed: %o', error);
			this._recordingLock = false;

			// Notify peers of failure
			for (const peer of this._getJoinedPeers())
			{
				peer.notify('recordingStopped', {
					reason          : 'restart_failed',
					initiatorPeerId : initiatorPeerId
				}).catch(() => {});
			}
		}
	}

	/**
	 * Publish a producer's RTP stream to a PlainTransport for recording
	 */
	async _publishProducerRtpStream(producer)
	{
		logger.info('_publishProducerRtpStream() [producerId:%s]', producer.id);

		const listenIp = '127.0.0.1';

		// Create PlainTransport for RTP - let it choose its own ports
		const transport = await this._mediasoupRouter.createPlainTransport({
			listenIp : { ip: '0.0.0.0', announcedIp: listenIp },
			rtcpMux  : false,
			comedia  : false
		});

		logger.info('_publishProducerRtpStream() PlainTransport created [id:%s]', transport.id);

		// Get the ports MediaSoup is listening on
		const rtpTuple = transport.tuple;
		const rtcpTuple = transport.rtcpTuple;

		logger.info('_publishProducerRtpStream() Transport listening on [rtpPort:%d, rtcpPort:%d]',
			rtpTuple.localPort, rtcpTuple.localPort);

		// Allocate ports for GStreamer to listen on
		const gstreamerRtpPort = await this._getAvailableRecordingPort();
		const gstreamerRtcpPort = await this._getAvailableRecordingPort();

		logger.info('_publishProducerRtpStream() Allocated GStreamer ports [rtp:%d, rtcp:%d]',
			gstreamerRtpPort, gstreamerRtcpPort);

		// Connect transport - tell MediaSoup where GStreamer is listening
		await transport.connect({
			ip       : listenIp,
			port     : gstreamerRtpPort,
			rtcpPort : gstreamerRtcpPort
		});

		// Log the final tuple to verify connection
		logger.info('_publishProducerRtpStream() After connect - Transport tuple: %o',
			transport.tuple);
		logger.info('_publishProducerRtpStream() After connect - RTCP tuple: %o',
			transport.rtcpTuple);

		logger.info('_publishProducerRtpStream() PlainTransport will send to [ip:%s, rtpPort:%d, rtcpPort:%d]',
			listenIp, gstreamerRtpPort, gstreamerRtcpPort);

		// Create custom RTP capabilities without RTX for recording
		// This prevents RTX packets from being sent to GStreamer
		const routerRtpCapabilities = this._mediasoupRouter.rtpCapabilities;
		const recordingRtpCapabilities = {
			codecs : routerRtpCapabilities.codecs.filter(
				(codec) => !codec.mimeType.toLowerCase().includes('rtx')
			),
			headerExtensions : routerRtpCapabilities.headerExtensions
		};

		// Create consumer on this transport with RTP capabilities (no RTX)
		// Start paused - will be resumed after GStreamer is ready
		const consumer = await transport.consume({
			producerId      : producer.id,
			rtpCapabilities : recordingRtpCapabilities,
			paused          : true
		});

		logger.info('_publishProducerRtpStream() Consumer created [id:%s, kind:%s, paused:%s, producerPaused:%s]',
			consumer.id, consumer.kind, consumer.paused, consumer.producerPaused);

		// Log ALL codecs to understand what we're dealing with
		logger.info('_publishProducerRtpStream() Consumer ALL codecs: %o', consumer.rtpParameters.codecs);

		// Find the main codec (not RTX)
		const mainCodec = consumer.rtpParameters.codecs.find(
			(codec) => !codec.mimeType.toLowerCase().includes('rtx')
		);

		logger.info('_publishProducerRtpStream() Consumer main codec: %o', {
			ssrc        : consumer.rtpParameters.encodings[0].ssrc,
			payloadType : mainCodec.payloadType,
			mimeType    : mainCodec.mimeType,
			clockRate   : mainCodec.clockRate
		});

		// Store consumer and transport for cleanup
		this._recordingConsumers.set(producer.id, { transport, consumer });

		return {
			remoteRtpPort  : gstreamerRtpPort,
			remoteRtcpPort : gstreamerRtcpPort,
			localRtcpPort  : rtcpTuple.localPort,
			rtpParameters  : consumer.rtpParameters
		};
	}

	/**
	 * Get an available port for recording (20000-30000 range)
	 */
	async _getAvailableRecordingPort()
	{
		const minPort = 20000;
		const maxPort = 30000;
		const maxAttempts = 100;

		for (let i = 0; i < maxAttempts; i++)
		{
			const port = Math.floor(Math.random() * (maxPort - minPort + 1)) + minPort;

			if (!this._usedRecordingPorts.has(port))
			{
				this._usedRecordingPorts.add(port);

				return port;
			}
		}

		throw new Error('No available recording ports');
	}
}

module.exports = Room;
