/**
 * IndividualStreamRecorder - Records a single media stream to a file
 * This is a lightweight recorder that just saves RTP packets to a file
 * without any compositing or heavy encoding.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('IndividualStreamRecorder');

// Simple port management
let nextPort = 30000;
const usedPorts = new Set();

function getPort() 
{
	while (usedPorts.has(nextPort)) 
	{
		nextPort++;
		if (nextPort > 40000) nextPort = 30000;
	}
	usedPorts.add(nextPort);
	
	return nextPort++;
}

function releasePort(port) 
{
	usedPorts.delete(port);
}

class IndividualStreamRecorder
{
	constructor(options)
	{
		this._id = options.id || `stream-${Date.now()}`;
		this._peerId = options.peerId;
		this._peerName = options.peerName || 'Unknown';
		this._kind = options.kind; // 'video' or 'audio'
		this._codec = options.codec;
		this._isScreenShare = options.isScreenShare || false;
		this._outputPath = options.outputPath;
		this._rtpPort = null;
		this._rtcpPort = null;
		this._process = null;
		this._startTime = null;
		this._endTime = null;
		this._metadata = {};
	}

	get id() { return this._id; }
	get peerId() { return this._peerId; }
	get peerName() { return this._peerName; }
	get kind() { return this._kind; }
	get isScreenShare() { return this._isScreenShare; }
	get outputPath() { return this._outputPath; }
	get rtpPort() { return this._rtpPort; }
	get rtcpPort() { return this._rtcpPort; }
	get startTime() { return this._startTime; }
	get endTime() { return this._endTime; }

	get duration()
	{
		if (!this._startTime) return 0;
		const end = this._endTime || Date.now();

		return (end - this._startTime) / 1000; // seconds
	}

	get metadata() { return this._metadata; }

	async start()
	{
		// Get ports for RTP/RTCP
		this._rtpPort = getPort();
		this._rtcpPort = this._rtpPort + 1;

		logger.info(`Starting recorder [id:${this._id}, peer:${this._peerName}, kind:${this._kind}, isShare:${this._isScreenShare}]`);
		logger.info(`  RTP port: ${this._rtpPort}, Output: ${this._outputPath}`);

		// Build GStreamer pipeline based on codec
		const pipeline = this._buildPipeline();

		logger.info(`  Pipeline: ${pipeline}`);

		// Use gst-launch-1.0 with the full path
		const gstPath = process.platform === 'darwin' 
			? '/opt/homebrew/bin/gst-launch-1.0' 
			: 'gst-launch-1.0';

		this._process = spawn(gstPath, [ '-e', ...pipeline.split(' ').filter((s) => s.length > 0) ], {
			stdio : [ 'pipe', 'pipe', 'pipe' ]
		});

		this._process.stderr.on('data', (data) =>
		{
			const msg = data.toString();

			if (msg.includes('ERROR'))
			{
				logger.error(`[${this._id}] GStreamer error: ${msg}`);
			}
		});

		this._process.on('close', (code) =>
		{
			logger.info(`[${this._id}] GStreamer closed with code ${code}`);
			this._endTime = Date.now();
		});

		this._process.on('error', (error) =>
		{
			logger.error(`[${this._id}] GStreamer error: ${error.message}`);
		});

		this._startTime = Date.now();

		// Store metadata for later composition
		this._metadata = {
			id            : this._id,
			peerId        : this._peerId,
			peerName      : this._peerName,
			kind          : this._kind,
			codec         : this._codec,
			isScreenShare : this._isScreenShare,
			outputPath    : this._outputPath,
			rtpPort       : this._rtpPort,
			startTime     : this._startTime
		};

		return {
			rtpPort  : this._rtpPort,
			rtcpPort : this._rtcpPort
		};
	}

	_buildPipeline()
	{
		if (this._kind === 'video')
		{
			return this._buildVideoPipeline();
		}
		else
		{
			return this._buildAudioPipeline();
		}
	}

	_buildVideoPipeline()
	{
		const codec = this._codec.toUpperCase();

		// Key optimizations to reduce frame drops:
		// 1. buffer-size=2097152 (2MB) - Larger UDP receive buffer
		// 2. latency=1000 - 1 second jitter buffer (handles network variance)
		// 3. drop-on-latency=false - Don't drop frames, wait for them
		// 4. wait-for-keyframe=true - Start cleanly
		// 5. queue with large buffers - Prevent pipeline stalls
		// 6. sync=false async=false - Don't wait for clock, just write

		if (codec === 'VP8')
		{
			return `udpsrc port=${this._rtpPort} buffer-size=2097152 ` +
				'caps="application/x-rtp,media=video,clock-rate=90000,encoding-name=VP8,payload=101" ' +
				'! rtpjitterbuffer latency=1000 drop-on-latency=false ' +
				'! rtpvp8depay wait-for-keyframe=false ' +
				'! queue max-size-buffers=1000 max-size-time=5000000000 max-size-bytes=0 leaky=downstream ' +
				'! webmmux ' +
				`! filesink location="${this._outputPath}" sync=false async=false`;
		}
		else if (codec === 'VP9')
		{
			return `udpsrc port=${this._rtpPort} buffer-size=2097152 ` +
				'caps="application/x-rtp,media=video,clock-rate=90000,encoding-name=VP9,payload=101" ' +
				'! rtpjitterbuffer latency=1000 drop-on-latency=false ' +
				'! rtpvp9depay wait-for-keyframe=true ' +
				'! queue max-size-buffers=1000 max-size-time=5000000000 max-size-bytes=0 leaky=downstream ' +
				'! webmmux ' +
				`! filesink location="${this._outputPath}" sync=false async=false`;
		}
		else if (codec === 'H264')
		{
			return `udpsrc port=${this._rtpPort} buffer-size=2097152 ` +
				'caps="application/x-rtp,media=video,clock-rate=90000,encoding-name=H264,payload=101" ' +
				'! rtpjitterbuffer latency=1000 drop-on-latency=false ' +
				'! rtph264depay wait-for-keyframe=true ' +
				'! h264parse ' +
				'! queue max-size-buffers=1000 max-size-time=5000000000 max-size-bytes=0 leaky=downstream ' +
				'! mp4mux fragment-duration=1000 ' +
				`! filesink location="${this._outputPath}" sync=false async=false`;
		}

		throw new Error(`Unsupported video codec: ${codec}`);
	}

	_buildAudioPipeline()
	{
		const codec = this._codec.toUpperCase();

		// Audio pipeline with larger buffers to prevent drops
		if (codec === 'OPUS')
		{
			return `udpsrc port=${this._rtpPort} buffer-size=1048576 ` +
				'caps="application/x-rtp,media=audio,clock-rate=48000,encoding-name=OPUS,payload=100" ' +
				'! rtpjitterbuffer latency=1000 drop-on-latency=false ' +
				'! rtpopusdepay ' +
				'! queue max-size-buffers=1000 max-size-time=5000000000 max-size-bytes=0 leaky=downstream ' +
				'! opusparse ' +
				'! webmmux ' +
				`! filesink location="${this._outputPath}" sync=false async=false`;
		}

		throw new Error(`Unsupported audio codec: ${codec}`);
	}

	async stop()
	{
		logger.info(`Stopping recorder [id:${this._id}]`);

		this._endTime = Date.now();
		this._metadata.endTime = this._endTime;
		this._metadata.duration = this.duration;

		if (this._process)
		{
			// Send SIGINT for clean shutdown (triggers EOS)
			this._process.kill('SIGINT');

			// Wait briefly for graceful shutdown (reduced from 1000ms)
			await new Promise((resolve) => setTimeout(resolve, 200));

			// Force kill if still running
			if (this._process && !this._process.killed)
			{
				this._process.kill('SIGKILL');
			}

			this._process = null;
		}

		// Release ports
		if (this._rtpPort)
		{
			releasePort(this._rtpPort);
			releasePort(this._rtcpPort);
			this._rtpPort = null;
			this._rtcpPort = null;
		}

		// Brief delay for file to be written
		await new Promise((resolve) => setTimeout(resolve, 100));

		try
		{
			const stats = fs.statSync(this._outputPath);

			logger.info(`[${this._id}] Output file: ${this._outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
			this._metadata.fileSize = stats.size;
		}
		catch (error)
		{
			logger.warn(`[${this._id}] Output file not found or empty: ${this._outputPath}`);
			this._metadata.fileSize = 0;
		}

		return this._metadata;
	}

	kill()
	{
		if (this._process && !this._process.killed)
		{
			this._process.kill('SIGKILL');
			this._process = null;
		}

		if (this._rtpPort)
		{
			releasePort(this._rtpPort);
			releasePort(this._rtcpPort);
			this._rtpPort = null;
			this._rtcpPort = null;
		}
	}
}

module.exports = IndividualStreamRecorder;
