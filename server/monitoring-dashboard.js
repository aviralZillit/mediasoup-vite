#!/usr/bin/env node

/**
 * MediaSoup Real-time Monitoring Dashboard
 * 
 * This script provides real-time monitoring of MediaSoup server performance,
 * connection quality, and call analytics.
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const path = require('path');
const https = require('https');
const Logger = require('./lib/Logger');

const logger = new Logger('MonitoringDashboard');

// Configure axios to accept self-signed certificates
const httpsAgent = new https.Agent({
	rejectUnauthorized : false
});

axios.defaults.httpsAgent = httpsAgent;

// Configuration
const config = {
	monitoringPort  : 8080,
	mediasoupUrl    : process.env.MEDIASOUP_URL || 'https://localhost:4443',
	updateInterval  : 30000, // Increased from 10s to 30s (ultra-conservative)
	alertThresholds : {
		highPacketLoss  : 5,
		lowQualityScore : 2,
		highErrorRate   : 10,
		lowFramerate    : 15
	}
};

class MonitoringDashboard
{
	constructor()
	{
		this.app = express();
		this.server = http.createServer(this.app);
		this.io = socketIo(this.server);
		
		this.alerts = [];
		this.metrics = {
			rooms     : [],
			server    : {},
			timestamp : Date.now()
		};

		this.setupRoutes();
		this.setupSocketHandlers();
		this.startMonitoring();
	}

	setupRoutes()
	{
		// Serve static files
		this.app.use(express.static(path.join(__dirname, 'monitoring-dashboard')));

		// API endpoints
		this.app.get('/api/metrics', (req, res) =>
		{
			try
			{
				const metrics = this.metrics;

				res.json(metrics);
			}
			catch (error)
			{
				logger.error('Failed to get metrics:', error);
				res.status(500).json({ error: 'Failed to collect metrics' });
			}
		});

		this.app.get('/api/alerts', (req, res) =>
		{
			res.json(this.alerts);
		});

		this.app.get('/api/rooms/:roomId', async (req, res) =>
		{
			try
			{
				const response = await axios.get(
					`${config.mediasoupUrl}/analytics/rooms/${req.params.roomId}`
				);

				res.json(response.data);
			}
			catch (error)
			{
				logger.error('Failed to get room data:', error);
				res.status(500).json({ error: 'Failed to get room data' });
			}
		});

		this.app.get('/', (req, res) =>
		{
			res.sendFile(path.join(__dirname, 'monitoring-dashboard', 'index.html'));
		});
	}

	setupSocketHandlers()
	{
		this.io.on('connection', (socket) =>
		{
			logger.info('Dashboard client connected');

			socket.emit('metrics', this.metrics);
			socket.emit('alerts', this.alerts);

			socket.on('disconnect', () =>
			{
				logger.info('Dashboard client disconnected');
			});

			socket.on('clearAlerts', () =>
			{
				this.alerts = [];
				this.io.emit('alerts', this.alerts);
			});
		});
	}

	startMonitoring()
	{
		logger.info(`Starting monitoring dashboard on port ${config.monitoringPort}`);

		setInterval(() =>
		{
			this.collectMetrics();
		}, config.updateInterval);

		this.server.listen(config.monitoringPort, () =>
		{
			logger.info(`Monitoring dashboard running on http://localhost:${config.monitoringPort}`);
		});
	}

	async collectMetrics()
	{
		try
		{
			const serverResponse = await axios.get(`${config.mediasoupUrl}/analytics/server`);
			const roomsResponse = await axios.get(`${config.mediasoupUrl}/analytics/rooms`);

			this.metrics = {
				server    : serverResponse.data,
				rooms     : roomsResponse.data,
				timestamp : Date.now()
			};

			this.checkAlerts();

			this.io.emit('metrics', this.metrics);
			this.io.emit('alerts', this.alerts);
		}
		catch (error)
		{
			logger.error('Failed to collect metrics:', error);
		}
	}

	checkAlerts()
	{
		const now = Date.now();

		this.metrics.rooms.forEach((room) =>
		{
			if (room.recentErrors && 
				room.recentErrors.length > config.alertThresholds.highErrorRate)
			{
				this.addAlert({
					type      : 'HIGH_ERROR_RATE',
					severity  : 'warning',
					message   : `Room ${room.roomId} has ${room.recentErrors.length} recent errors`,
					roomId    : room.roomId,
					timestamp : now
				});
			}

			if (room.connectionQuality)
			{
				room.connectionQuality.forEach((peer) =>
				{
					if (peer.score < config.alertThresholds.lowQualityScore)
					{
						this.addAlert({
							type      : 'LOW_CONNECTION_QUALITY',
							severity  : 'warning',
							message   : `Peer ${peer.displayName || peer.peerId} has low connection quality (${peer.score}/5)`,
							roomId    : room.roomId,
							peerId    : peer.peerId,
							timestamp : now
						});
					}
				});
			}

			if (room.recentEvents)
			{
				const consumerDrops = room.recentEvents.filter((event) => event.type === 'consumer-closed');

				if (consumerDrops.length > 0)
				{
					consumerDrops.forEach((drop) =>
					{
						this.addAlert({
							type      : 'CONSUMER_DROP',
							severity  : 'high',
							message   : `Consumer dropped in room ${room.roomId}: ${drop.reason || 'Unknown reason'}`,
							roomId    : room.roomId,
							timestamp : drop.timestamp || now
						});
					});
				}
			}
		});
	}

	addAlert(alert)
	{
		const isDuplicate = this.alerts.some((existing) =>
			existing.type === alert.type &&
			existing.roomId === alert.roomId &&
			existing.peerId === alert.peerId &&
			(Date.now() - existing.timestamp) < 60000
		);

		if (!isDuplicate)
		{
			this.alerts.unshift(alert);

			if (this.alerts.length > 100)
			{
				this.alerts = this.alerts.slice(0, 100);
			}

			logger.warn(`Alert: ${alert.type} - ${alert.message}`);
		}
	}

	stop()
	{
		this.server.close();
		logger.info('Monitoring dashboard stopped');
	}
}

if (require.main === module)
{
	const dashboard = new MonitoringDashboard();

	process.on('SIGINT', () =>
	{
		logger.info('Received SIGINT, shutting down gracefully');
		dashboard.stop();
		process.exit(0);
	});

	process.on('SIGTERM', () =>
	{
		logger.info('Received SIGTERM, shutting down gracefully');
		dashboard.stop();
		process.exit(0);
	});
}

module.exports = MonitoringDashboard;
