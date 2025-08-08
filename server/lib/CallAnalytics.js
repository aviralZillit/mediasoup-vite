const EventEmitter = require('events').EventEmitter;
const Logger = require('./Logger');

const logger = new Logger('CallAnalytics');

/**
 * CallAnalytics class for real-time monitoring and analytics
 */
class CallAnalytics extends EventEmitter
{
	constructor()
	{
		super();

		this.setMaxListeners(Infinity);

		// Call sessions tracking
		this._callSessions = new Map();
		
		// Room analytics
		this._roomAnalytics = new Map();
		
		// Global metrics
		this._globalMetrics = 
		{
			totalCalls           : 0,
			activeCalls          : 0,
			totalParticipants    : 0,
			averageCallDuration  : 0,
			totalDataTransferred : 0,
			errors               :
			{
				connectionFailures : 0,
				producerFailures   : 0,
				consumerFailures   : 0,
				transportFailures  : 0
			}
		};

		// Start metrics collection
		this._startMetricsCollection();
	}

	/**
     * Start a new call session
     */
	startCallSession({ roomId, peerId, displayName, device }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = {
			sessionId,
			roomId,
			peerId,
			displayName,
			device,
			startTime  : Date.now(),
			endTime    : null,
			duration   : 0,
			producers  : new Map(),
			consumers  : new Map(),
			transports : new Map(),
			stats      : {
				audioStats : {
					packetsLost     : 0,
					packetsReceived : 0,
					packetsSent     : 0,
					bytesReceived   : 0,
					bytesSent       : 0,
					audioLevel      : 0,
					jitter          : 0
				},
				videoStats : {
					packetsLost      : 0,
					packetsReceived  : 0,
					packetsSent      : 0,
					bytesReceived    : 0,
					bytesSent        : 0,
					framerate        : 0,
					resolution       : { width: 0, height: 0 },
					keyFramesDecoded : 0
				},
				connectionQuality : {
					score      : 5, // 1-5 scale
					rtt        : 0,
					bandwidth  : 0,
					packetLoss : 0
				}
			},
			events : []
		};

		this._callSessions.set(sessionId, session);
		this._globalMetrics.totalCalls++;
		this._globalMetrics.activeCalls++;
		this._globalMetrics.totalParticipants++;

		logger.info('Call session started [sessionId:%s, roomId:%s, peerId:%s]', 
			sessionId, roomId, peerId);

		this.emit('callSessionStarted', session);
		
		return session;
	}

	/**
     * End a call session
     */
	endCallSession({ roomId, peerId }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = this._callSessions.get(sessionId);
        
		if (!session) 
		{
			logger.warn('Call session not found [sessionId:%s]', sessionId);
			
			return null;
		}

		session.endTime = Date.now();
		session.duration = session.endTime - session.startTime;
        
		// Update global metrics
		this._globalMetrics.activeCalls--;
		this._globalMetrics.totalParticipants--;
        
		// Calculate average call duration
		const totalDuration = Array.from(this._callSessions.values())
			.filter((s) => s.endTime)
			.reduce((sum, s) => sum + s.duration, 0);
		const completedCalls = Array.from(this._callSessions.values())
			.filter((s) => s.endTime).length;

		this._globalMetrics.averageCallDuration = completedCalls > 0 ? totalDuration / completedCalls : 0;

		logger.info('Call session ended [sessionId:%s, duration:%dms]', 
			sessionId, session.duration);

		this.emit('callSessionEnded', session);
        
		// Archive session after 1 hour
		setTimeout(() => 
		{
			this._callSessions.delete(sessionId);
		}, 3600000);

		return session;
	}

	/**
     * Track producer events
     */
	trackProducer({ roomId, peerId, producerId, kind, producer }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = this._callSessions.get(sessionId);
        
		if (!session) 
		{
			logger.warn('Session not found for producer tracking [sessionId:%s]', sessionId);
			
			return;
		}

		const producerData = {
			id        : producerId,
			kind,
			startTime : Date.now(),
			endTime   : null,
			stats     : {
				packetsLost : 0,
				packetsSent : 0,
				bytesSent   : 0,
				score       : [],
				errors      : []
			}
		};

		session.producers.set(producerId, producerData);
		session.events.push({
			type      : 'producer_created',
			timestamp : Date.now(),
			data      : { producerId, kind }
		});

		// Monitor producer stats
		this._monitorProducer(producer, session, producerData);

		logger.debug('Producer tracked [sessionId:%s, producerId:%s, kind:%s]', 
			sessionId, producerId, kind);

		this.emit('producerTracked', { session, producerData });
	}

	/**
     * Track consumer events
     */
	trackConsumer({ roomId, peerId, consumerId, producerId, kind, consumer }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = this._callSessions.get(sessionId);
        
		if (!session) 
		{
			logger.warn('Session not found for consumer tracking [sessionId:%s]', sessionId);
			
			return;
		}

		const consumerData = {
			id        : consumerId,
			producerId,
			kind,
			startTime : Date.now(),
			endTime   : null,
			stats     : {
				packetsLost     : 0,
				packetsReceived : 0,
				bytesReceived   : 0,
				score           : [],
				errors          : []
			}
		};

		session.consumers.set(consumerId, consumerData);
		session.events.push({
			type      : 'consumer_created',
			timestamp : Date.now(),
			data      : { consumerId, producerId, kind }
		});

		// Monitor consumer stats
		this._monitorConsumer(consumer, session, consumerData);

		logger.debug('Consumer tracked [sessionId:%s, consumerId:%s, kind:%s]', 
			sessionId, consumerId, kind);

		this.emit('consumerTracked', { session, consumerData });
	}

	/**
     * Track transport events
     */
	trackTransport({ roomId, peerId, transportId, transport }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = this._callSessions.get(sessionId);
        
		if (!session) 
		{
			logger.warn('Session not found for transport tracking [sessionId:%s]', sessionId);
			
			return;
		}

		const transportData = {
			id              : transportId,
			type            : transport.constructor.name,
			startTime       : Date.now(),
			connectionState : 'new',
			iceState        : 'new',
			dtlsState       : 'new',
			stats           : {
				bytesReceived        : 0,
				bytesSent            : 0,
				packetsReceived      : 0,
				packetsSent          : 0,
				packetLossPercentage : 0,
				roundTripTime        : 0
			},
			events : []
		};

		session.transports.set(transportId, transportData);
		session.events.push({
			type      : 'transport_created',
			timestamp : Date.now(),
			data      : { transportId, type: transportData.type }
		});

		// Monitor transport events
		this._monitorTransport(transport, session, transportData);

		logger.debug('Transport tracked [sessionId:%s, transportId:%s]', 
			sessionId, transportId);

		this.emit('transportTracked', { session, transportData });
	}

	/**
     * Record error events
     */
	recordError({ roomId, peerId, type, error, context = {} }) 
	{
		const sessionId = `${roomId}-${peerId}`;
		const session = this._callSessions.get(sessionId);
        
		const errorEvent = {
			type      : 'error',
			errorType : type,
			timestamp : Date.now(),
			message   : error.message || error,
			stack     : error.stack,
			context
		};

		if (session) 
		{
			session.events.push(errorEvent);
		}

		// Update global error metrics
		switch (type) 
		{
			case 'connection_failure':
				this._globalMetrics.errors.connectionFailures++;
				break;
			case 'producer_failure':
				this._globalMetrics.errors.producerFailures++;
				break;
			case 'consumer_failure':
				this._globalMetrics.errors.consumerFailures++;
				break;
			case 'transport_failure':
				this._globalMetrics.errors.transportFailures++;
				break;
		}

		logger.error('Error recorded [sessionId:%s, type:%s, error:%s]', 
			sessionId, type, error.message || error);

		this.emit('errorRecorded', { sessionId, errorEvent });
	}

	/**
     * Get session analytics
     */
	getSessionAnalytics(sessionId) 
	{
		return this._callSessions.get(sessionId);
	}

	/**
     * Get room analytics
     */
	getRoomAnalytics(roomId) 
	{
		const sessions = Array.from(this._callSessions.values())
			.filter((session) => session.roomId === roomId);

		const activeParticipants = sessions.filter((s) => !s.endTime).length;
		const totalParticipants = sessions.length;
        
		const avgConnectionQuality = sessions.length > 0 
			? sessions.reduce((sum, s) => sum + s.stats.connectionQuality.score, 0) / sessions.length 
			: 0;

		return {
			roomId,
			activeParticipants,
			totalParticipants,
			averageConnectionQuality : avgConnectionQuality,
			sessions                 : sessions.map((s) => ({
				sessionId         : s.sessionId,
				peerId            : s.peerId,
				displayName       : s.displayName,
				startTime         : s.startTime,
				duration          : s.endTime ? s.duration : Date.now() - s.startTime,
				connectionQuality : s.stats.connectionQuality,
				isActive          : !s.endTime
			}))
		};
	}

	/**
     * Get global metrics
     */
	getGlobalMetrics() 
	{
		return {
			...this._globalMetrics,
			timestamp : Date.now(),
			uptime    : Date.now() - this._startTime
		};
	}

	/**
     * Get real-time stats for a session
     */
	getRealtimeStats(sessionId) 
	{
		const session = this._callSessions.get(sessionId);

		if (!session) return null;

		return {
			sessionId,
			connectionQuality : session.stats.connectionQuality,
			audioStats        : session.stats.audioStats,
			videoStats        : session.stats.videoStats,
			producers         : Array.from(session.producers.values()),
			consumers         : Array.from(session.consumers.values()),
			transports        : Array.from(session.transports.values()),
			recentEvents      : session.events.slice(-10) // Last 10 events
		};
	}

	/**
     * Monitor producer stats
     */
	_monitorProducer(producer, session, producerData) 
	{
		// Monitor producer score
		producer.on('score', (score) => 
		{
			producerData.stats.score.push({
				timestamp      : Date.now(),
				score          : score.score,
				producerScore  : score.producerScore,
				producerScores : score.producerScores
			});

			// Update session stats based on producer kind
			if (producer.kind === 'audio') 
			{
				session.stats.audioStats.score = score.score;
			}
			else if (producer.kind === 'video') 
			{
				session.stats.videoStats.score = score.score;
			}

			// Keep only last 100 score entries
			if (producerData.stats.score.length > 100) 
			{
				producerData.stats.score = producerData.stats.score.slice(-100);
			}

			this.emit('producerScore', {
				sessionId  : session.sessionId,
				producerId : producer.id,
				score
			});
		});

		// Monitor producer close
		producer.on('close', () => 
		{
			producerData.endTime = Date.now();
			session.events.push({
				type      : 'producer_closed',
				timestamp : Date.now(),
				data      : { producerId: producer.id }
			});

			this.emit('producerClosed', {
				sessionId  : session.sessionId,
				producerId : producer.id
			});
		});

		// Get stats periodically
		const statsInterval = setInterval(async () => 
		{
			try 
			{
				const stats = await producer.getStats();

				this._updateProducerStats(producerData, stats, session);
			}
			catch (error) 
			{
				logger.error('Error getting producer stats: %o', error);
				clearInterval(statsInterval);
			}
		}, 5000);

		producer.on('close', () => clearInterval(statsInterval));
	}

	/**
     * Monitor consumer stats
     */
	_monitorConsumer(consumer, session, consumerData) 
	{
		// Monitor consumer score
		consumer.on('score', (score) => 
		{
			consumerData.stats.score.push({
				timestamp      : Date.now(),
				score          : score.score,
				producerScore  : score.producerScore,
				producerScores : score.producerScores
			});

			// Update connection quality based on consumer scores
			this._updateConnectionQuality(session);

			// Keep only last 100 score entries
			if (consumerData.stats.score.length > 100) 
			{
				consumerData.stats.score = consumerData.stats.score.slice(-100);
			}

			this.emit('consumerScore', {
				sessionId  : session.sessionId,
				consumerId : consumer.id,
				score
			});
		});

		// Monitor consumer close
		consumer.on('close', () => 
		{
			consumerData.endTime = Date.now();
			session.events.push({
				type      : 'consumer_closed',
				timestamp : Date.now(),
				data      : { consumerId: consumer.id }
			});

			this.emit('consumerClosed', {
				sessionId  : session.sessionId,
				consumerId : consumer.id
			});
		});

		// Monitor producer close (consumer will be affected)
		consumer.on('producerclose', () => 
		{
			session.events.push({
				type      : 'consumer_producer_closed',
				timestamp : Date.now(),
				data      : { 
					consumerId : consumer.id,
					producerId : consumerData.producerId
				}
			});

			this.emit('consumerProducerClosed', {
				sessionId  : session.sessionId,
				consumerId : consumer.id,
				producerId : consumerData.producerId
			});
		});

		// Get stats periodically
		const statsInterval = setInterval(async () => 
		{
			try 
			{
				const stats = await consumer.getStats();

				this._updateConsumerStats(consumerData, stats, session);
			}
			catch (error) 
			{
				logger.error('Error getting consumer stats: %o', error);
				clearInterval(statsInterval);
			}
		}, 5000);

		consumer.on('close', () => clearInterval(statsInterval));
	}

	/**
     * Monitor transport events
     */
	_monitorTransport(transport, session, transportData) 
	{
		// Monitor connection state changes
		transport.on('connectionstatechange', (state) => 
		{
			transportData.connectionState = state;
			transportData.events.push({
				type      : 'connectionstatechange',
				timestamp : Date.now(),
				state
			});

			if (state === 'failed' || state === 'disconnected') 
			{
				this.recordError({
					roomId  : session.roomId,
					peerId  : session.peerId,
					type    : 'transport_failure',
					error   : `Transport connection state changed to ${state}`,
					context : { transportId: transport.id, state }
				});
			}

			this.emit('transportConnectionStateChange', {
				sessionId   : session.sessionId,
				transportId : transport.id,
				state
			});
		});

		// Monitor ICE state changes (WebRTC transports)
		if (transport.iceState !== undefined) 
		{
			transport.on('icestatechange', (state) => 
			{
				transportData.iceState = state;
				transportData.events.push({
					type      : 'icestatechange',
					timestamp : Date.now(),
					state
				});

				this.emit('transportIceStateChange', {
					sessionId   : session.sessionId,
					transportId : transport.id,
					state
				});
			});
		}

		// Monitor DTLS state changes (WebRTC transports)
		if (transport.dtlsState !== undefined) 
		{
			transport.on('dtlsstatechange', (state) => 
			{
				transportData.dtlsState = state;
				transportData.events.push({
					type      : 'dtlsstatechange',
					timestamp : Date.now(),
					state
				});

				if (state === 'failed' || state === 'closed') 
				{
					this.recordError({
						roomId  : session.roomId,
						peerId  : session.peerId,
						type    : 'transport_failure',
						error   : `Transport DTLS state changed to ${state}`,
						context : { transportId: transport.id, state }
					});
				}

				this.emit('transportDtlsStateChange', {
					sessionId   : session.sessionId,
					transportId : transport.id,
					state
				});
			});
		}

		// Get transport stats periodically
		const statsInterval = setInterval(async () => 
		{
			try 
			{
				const stats = await transport.getStats();

				this._updateTransportStats(transportData, stats, session);
			}
			catch (error) 
			{
				logger.error('Error getting transport stats: %o', error);
				clearInterval(statsInterval);
			}
		}, 10000);

		transport.on('close', () => clearInterval(statsInterval));
	}

	/**
     * Update producer stats
     */
	_updateProducerStats(producerData, stats, session) 
	{
		for (const stat of stats) 
		{
			if (stat.type === 'outbound-rtp') 
			{
				producerData.stats.packetsSent = stat.packetsSent || 0;
				producerData.stats.bytesSent = stat.bytesSent || 0;
				producerData.stats.packetsLost = stat.packetsLost || 0;

				// Update session stats
				if (stat.kind === 'audio') 
				{
					session.stats.audioStats.packetsSent += stat.packetsSent || 0;
					session.stats.audioStats.bytesSent += stat.bytesSent || 0;
				}
				else if (stat.kind === 'video') 
				{
					session.stats.videoStats.packetsSent += stat.packetsSent || 0;
					session.stats.videoStats.bytesSent += stat.bytesSent || 0;
					session.stats.videoStats.framerate = stat.framesPerSecond || 0;
				}
			}
		}

		this._globalMetrics.totalDataTransferred += producerData.stats.bytesSent;
	}

	/**
     * Update consumer stats
     */
	_updateConsumerStats(consumerData, stats, session) 
	{
		for (const stat of stats) 
		{
			if (stat.type === 'inbound-rtp') 
			{
				consumerData.stats.packetsReceived = stat.packetsReceived || 0;
				consumerData.stats.bytesReceived = stat.bytesReceived || 0;
				consumerData.stats.packetsLost = stat.packetsLost || 0;

				// Update session stats
				if (stat.kind === 'audio') 
				{
					session.stats.audioStats.packetsReceived += stat.packetsReceived || 0;
					session.stats.audioStats.bytesReceived += stat.bytesReceived || 0;
					session.stats.audioStats.jitter = stat.jitter || 0;
				}
				else if (stat.kind === 'video') 
				{
					session.stats.videoStats.packetsReceived += stat.packetsReceived || 0;
					session.stats.videoStats.bytesReceived += stat.bytesReceived || 0;
					session.stats.videoStats.keyFramesDecoded = stat.keyFramesDecoded || 0;
                    
					if (stat.frameWidth && stat.frameHeight) 
					{
						session.stats.videoStats.resolution = {
							width  : stat.frameWidth,
							height : stat.frameHeight
						};
					}
				}
			}
		}

		this._globalMetrics.totalDataTransferred += consumerData.stats.bytesReceived;
	}

	/**
     * Update transport stats
     */
	_updateTransportStats(transportData, stats, session) 
	{
		for (const stat of stats) 
		{
			if (stat.type === 'transport') 
			{
				transportData.stats.bytesReceived = stat.bytesReceived || 0;
				transportData.stats.bytesSent = stat.bytesSent || 0;
				transportData.stats.packetsReceived = stat.packetsReceived || 0;
				transportData.stats.packetsSent = stat.packetsSent || 0;
			}
			else if (stat.type === 'candidate-pair' && stat.nominated) 
			{
				transportData.stats.roundTripTime = stat.currentRoundTripTime || 0;
				session.stats.connectionQuality.rtt = stat.currentRoundTripTime || 0;
			}
		}
	}

	/**
     * Update connection quality score
     */
	_updateConnectionQuality(session) 
	{
		const consumers = Array.from(session.consumers.values());
		const transports = Array.from(session.transports.values());

		let totalScore = 0;
		let scoreCount = 0;

		// Calculate average consumer score
		consumers.forEach((consumer) => 
		{
			if (consumer.stats.score.length > 0) 
			{
				const latestScore = consumer.stats.score[consumer.stats.score.length - 1];

				totalScore += latestScore.score;
				scoreCount++;
			}
		});

		// Factor in RTT and packet loss
		let qualityScore = scoreCount > 0 ? totalScore / scoreCount : 5;
        
		const avgRtt = session.stats.connectionQuality.rtt;

		if (avgRtt > 300) qualityScore -= 2;
		else if (avgRtt > 150) qualityScore -= 1;
		else if (avgRtt > 80) qualityScore -= 0.5;

		// Ensure score is between 1 and 5
		session.stats.connectionQuality.score = Math.max(1, Math.min(5, qualityScore));

		// Emit quality update if score changed significantly
		this.emit('connectionQualityUpdate', {
			sessionId : session.sessionId,
			quality   : session.stats.connectionQuality
		});
	}

	/**
     * Start periodic metrics collection
     */
	_startMetricsCollection() 
	{
		this._startTime = Date.now();

		// Emit global metrics every 30 seconds
		setInterval(() => 
		{
			this.emit('globalMetrics', this.getGlobalMetrics());
		}, 30000);

		// Emit room analytics every minute
		setInterval(() => 
		{
			const roomIds = new Set();

			this._callSessions.forEach((session) => roomIds.add(session.roomId));
            
			roomIds.forEach((roomId) => 
			{
				this.emit('roomAnalytics', this.getRoomAnalytics(roomId));
			});
		}, 60000);
	}
}

module.exports = CallAnalytics;
