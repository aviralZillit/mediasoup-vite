const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('Recording');

const RECORDING_BASE_DIR = process.env.RECORD_FILE_LOCATION_PATH ||
	path.join(__dirname, '..', 'recordings');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// Ports currently in use by active FFmpeg processes.
const _usedPorts = new Set();
let _nextPort = parseInt(process.env.RECORDING_PORT_START, 10) || 20000;

function _allocatePorts()
{
	for (let attempts = 0; attempts < 5000; attempts++)
	{
		const rtpPort = _nextPort;
		const rtcpPort = rtpPort + 1;

		_nextPort += 2;

		if (_nextPort > 29999)
			_nextPort = 20000;

		if (!_usedPorts.has(rtpPort) && !_usedPorts.has(rtcpPort))
		{
			_usedPorts.add(rtpPort);
			_usedPorts.add(rtcpPort);

			return { rtpPort, rtcpPort };
		}
	}

	throw new Error('No available recording ports');
}

function _freePorts({ rtpPort, rtcpPort })
{
	_usedPorts.delete(rtpPort);
	_usedPorts.delete(rtcpPort);
}

function _utcTag(date)
{
	const d = date || new Date();
	const pad = (n) => String(n).padStart(2, '0');

	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_` +
		`${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

function _safeName(name)
{
	return (name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
}

// =============================================================================
// Recording class
//
// Key design: FFmpeg writes to stdout (pipe:1) with -flush_packets 1.
// Node.js pipes stdout → WriteStream on disk. Data reaches disk in REAL-TIME.
// Even SIGKILL produces valid files because Node.js already wrote the data.
//
// NUT container format: does NOT need a trailer (unlike matroska/MKV).
// A truncated NUT file is still valid and playable.
// =============================================================================

class Recording
{
	constructor({ roomId, roomName, router, initiatorPeerId })
	{
		this._roomId = roomId;
		this._roomName = roomName || roomId;
		this._router = router;
		this._initiatorPeerId = initiatorPeerId;
		this._active = false;
		this._globalStartTime = null;

		this._transports = new Map();
		this._consumers = new Map();
		this._processes = new Map();
		this._ports = new Map();
		this._writeStreams = new Map(); // producerId -> fs.WriteStream
		this._stderrs = new Map();     // producerId -> () => string

		this._metadata = new Map();
		this._timeline = [];

		this._roomDir = path.join(RECORDING_BASE_DIR, roomId);
		this._rawDir = path.join(this._roomDir, 'raw');

		fs.mkdirSync(this._rawDir, { recursive: true });
	}

	get active() { return this._active; }
	get initiatorPeerId() { return this._initiatorPeerId; }
	set initiatorPeerId(id) { this._initiatorPeerId = id; }
	get globalStartTime() { return this._globalStartTime; }
	get roomDir() { return this._roomDir; }
	get rawDir() { return this._rawDir; }
	get roomName() { return this._roomName; }
	get roomId() { return this._roomId; }
	get metadata() { return this._metadata; }
	get timeline() { return this._timeline; }

	// -------------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------------

	async start(peers)
	{
		if (this._active)
			throw new Error('Recording already active');

		logger.info('start() [roomId:%s]', this._roomId);

		this._active = true;
		this._globalStartTime = Date.now();

		for (const peer of peers)
		{
			for (const producer of peer.data.producers.values())
			{
				try
				{
					await this._recordProducer(producer, peer);
				}
				catch (error)
				{
					logger.error(
						'start() | failed to record producer [producerId:%s]: %o',
						producer.id, error);
				}
			}
		}

		logger.info('start() completed [streams:%d]', this._processes.size);
	}

	async addProducer(producer, peer)
	{
		if (!this._active)
			return;

		try
		{
			await this._recordProducer(producer, peer);

			logger.info(
				'addProducer() [producerId:%s, peerId:%s]',
				producer.id, peer.id);
		}
		catch (error)
		{
			logger.error('addProducer() failed: %o', error);
		}
	}

	async removeProducer(producerId)
	{
		if (!this._active)
			return;

		const meta = this._metadata.get(producerId);

		if (meta)
		{
			const event = meta.share ? 'screenShareStop' : 'leave';

			this._timeline.push(
				{
					t           : Date.now() - this._globalStartTime,
					event,
					peerId      : meta.peerId,
					displayName : meta.displayName,
					producerId,
					kind        : meta.kind,
				});
		}

		await this._stopProducer(producerId);
	}

	/**
	 * Phase 1: Stop capture.
	 *
	 * The UI already updated optimistically — user sees "Recording stopped"
	 * instantly. This runs server-side.
	 *
	 * Strategy: FFmpeg writes to stdout pipe → Node.js WriteStream → disk.
	 * Data is already on disk in real-time. We just need to:
	 *   1. Close consumers (stops RTP flow)
	 *   2. Close transports
	 *   3. SIGKILL FFmpeg (safe: data is already on disk via pipe)
	 *   4. Close write streams
	 */
	async stopCapture()
	{
		if (!this._active)
			return;

		logger.info('stopCapture() [roomId:%s, streams:%d]',
			this._roomId, this._processes.size);

		this._active = false;

		// Step 1: Close all consumers — stops RTP data flow.
		for (const consumer of this._consumers.values())
		{
			try { consumer.close(); }
			catch (e) { /* ignore */ }
		}

		this._consumers.clear();

		// Step 2: Close all transports.
		for (const transport of this._transports.values())
		{
			try { transport.close(); }
			catch (e) { /* ignore */ }
		}

		this._transports.clear();

		// Step 3: Brief pause to let any in-flight data flush through the pipe.
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Step 4: Kill all FFmpeg processes. SIGKILL is SAFE here because
		// data flows: FFmpeg stdout → Node.js pipe → WriteStream → disk.
		// The data is already on disk; we don't need FFmpeg to flush anything.
		for (const proc of this._processes.values())
		{
			try { proc.kill('SIGKILL'); }
			catch (e) { /* ignore */ }
		}

		// Wait for all to exit.
		await Promise.all([ ...this._processes.entries() ].map(
			([ producerId, proc ]) => new Promise((resolve) =>
			{
				let done = false;

				const finish = () =>
				{
					if (!done) { done = true; resolve(); }
				};

				proc.on('exit', (code, signal) =>
				{
					logger.info(
						'FFmpeg exited [producerId:%s, code:%s, signal:%s]',
						producerId, code, signal);
					finish();
				});

				// Safety: resolve after 3s regardless.
				setTimeout(finish, 3000);
			})));

		this._processes.clear();

		// Step 5: End all write streams and wait for them to close.
		await Promise.all([ ...this._writeStreams.entries() ].map(
			([ producerId, ws ]) => new Promise((resolve) =>
			{
				ws.on('finish', resolve);
				ws.on('error', resolve);
				ws.end();

				// Safety timeout.
				setTimeout(resolve, 2000);
			})));

		this._writeStreams.clear();

		// Step 6: Write metadata and timeline JSON.
		this._writeMetadataFiles();

		// Log file sizes and FFmpeg stderr for debugging.
		for (const [ producerId, meta ] of this._metadata)
		{
			try
			{
				const stat = fs.statSync(meta.filePath);
				const sizeKB = Math.round(stat.size / 1024);

				logger.info(
					'  File: %s | %s | %dKB',
					path.basename(meta.filePath),
					meta.kind,
					sizeKB);

				if (sizeKB === 0)
				{
					const getStderr = this._stderrs.get(producerId);

					if (getStderr)
					{
						logger.warn(
							'  FFmpeg stderr [%s]: %s',
							producerId, getStderr().slice(-500));
					}
				}
			}
			catch (e)
			{
				logger.warn('  File missing: %s', meta.filePath);
			}
		}

		this._stderrs.clear();

		logger.info('stopCapture() completed');
	}

	close()
	{
		this._active = false;

		for (const proc of this._processes.values())
		{
			try { proc.kill('SIGKILL'); }
			catch (e) { /* ignore */ }
		}

		for (const ws of this._writeStreams.values())
		{
			try { ws.end(); }
			catch (e) { /* ignore */ }
		}

		for (const consumer of this._consumers.values())
		{
			try { consumer.close(); }
			catch (e) { /* ignore */ }
		}

		for (const transport of this._transports.values())
		{
			try { transport.close(); }
			catch (e) { /* ignore */ }
		}

		for (const ports of this._ports.values())
		{
			_freePorts(ports);
		}

		this._processes.clear();
		this._writeStreams.clear();
		this._consumers.clear();
		this._transports.clear();
		this._ports.clear();

		try { this._writeMetadataFiles(); }
		catch (e) { /* ignore */ }
	}

	// -------------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------------

	async _recordProducer(producer, peer)
	{
		if (this._consumers.has(producer.id))
		{
			logger.warn(
				'_recordProducer() | already recording [producerId:%s]',
				producer.id);

			return;
		}

		const streamStartOffset = Date.now() - this._globalStartTime;
		const isShare = Boolean(producer.appData && producer.appData.share);
		const displayName = peer.data.displayName || 'unknown';

		// 1) Create PlainTransport.
		const transport = await this._router.createPlainTransport(
			{
				listenInfo :
				{
					protocol : 'udp',
					ip       : '127.0.0.1',
				},
				rtcpMux : false,
				comedia : false,
			});

		// 2) Allocate ports for FFmpeg.
		const ports = _allocatePorts();

		// 3) Connect transport → FFmpeg.
		await transport.connect(
			{
				ip       : '127.0.0.1',
				port     : ports.rtpPort,
				rtcpPort : ports.rtcpPort,
			});

		// 4) Consume the producer on the transport.
		//
		//    CRITICAL: Pass rtpCapabilities with NO header extensions.
		//    mediasoup by default includes WebRTC extensions (abs-send-time,
		//    transport-cc, etc.) in every RTP packet. FFmpeg's VP8 RTP
		//    depacketizer cannot handle these — it results in frame=0 and
		//    empty video files. Stripping header extensions makes mediasoup
		//    send clean standard RTP that FFmpeg can parse correctly.
		const consumer = await transport.consume(
			{
				producerId      : producer.id,
				rtpCapabilities :
				{
					codecs           : this._router.rtpCapabilities.codecs,
					headerExtensions : [],
				},
				paused : true,
			});

		// Log what was negotiated so we can debug any issues.
		const negotiatedExts = (consumer.rtpParameters.headerExtensions || [])
			.map((e) => e.uri.split('/').pop())
			.join(', ');

		logger.info(
			'Consumer created [producerId:%s, kind:%s, exts:%s]',
			producer.id, producer.kind, negotiatedExts || 'none');

		// 5) Extract codec info.
		const codec = consumer.rtpParameters.codecs[0];
		const payloadType = codec.payloadType;
		const codecName = codec.mimeType.split('/')[1];
		const clockRate = codec.clockRate;
		const channels = codec.channels;

		// 6) Build filename — NUT container for all streams.
		const safeDN = _safeName(displayName);
		let fileTag;

		if (producer.kind === 'audio')
			fileTag = `${safeDN}-audio-${Date.now()}`;
		else if (isShare)
			fileTag = `${safeDN}-screen-${Date.now()}`;
		else
			fileTag = `${safeDN}-video-${Date.now()}`;

		const filePath = path.join(this._rawDir, `${fileTag}.nut`);

		// 7) Build FFmpeg args — output to pipe:1 (stdout).
		const ffmpegArgs = producer.kind === 'audio'
			? this._buildAudioArgs(ports.rtpPort, payloadType, codecName, clockRate, channels)
			: this._buildVideoArgs(ports.rtpPort, payloadType, codecName, clockRate);

		// 8) Store metadata.
		this._metadata.set(producer.id,
			{
				peerId            : peer.id,
				displayName,
				kind              : producer.kind,
				codecName,
				share             : isShare,
				streamStartOffset,
				filePath,
			});

		// 9) Log timeline event.
		const event = isShare ? 'screenShareStart' : 'join';

		this._timeline.push(
			{
				t           : streamStartOffset,
				event,
				peerId      : peer.id,
				displayName,
				producerId  : producer.id,
				kind        : producer.kind,
			});

		// 10) Spawn FFmpeg — stdout is piped to a WriteStream on disk.
		logger.info(
			'Spawning FFmpeg [peer:%s, kind:%s, codec:%s, port:%d, file:%s]',
			displayName, producer.kind, codecName, ports.rtpPort,
			path.basename(filePath));

		const proc = spawn(FFMPEG_PATH, ffmpegArgs,
			{ stdio: [ 'ignore', 'pipe', 'pipe' ] });

		// Pipe FFmpeg stdout → file on disk. With -flush_packets 1 and NUT,
		// data flows to disk in real-time. Even SIGKILL leaves valid data.
		const writeStream = fs.createWriteStream(filePath);

		proc.stdout.pipe(writeStream);

		proc.on('error', (error) =>
		{
			logger.error(
				'FFmpeg process error [producerId:%s]: %o', producer.id, error);
		});

		let stderrBuf = '';

		proc.stderr.on('data', (data) =>
		{
			stderrBuf += data.toString();

			if (stderrBuf.length > 4096)
				stderrBuf = stderrBuf.slice(-2048);
		});

		this._stderrs.set(producer.id, () => stderrBuf);

		proc.on('exit', (code, signal) =>
		{
			_freePorts(ports);
			this._ports.delete(producer.id);

			if (code !== 0 && code !== null &&
				signal !== 'SIGTERM' && signal !== 'SIGINT' && signal !== 'SIGKILL')
			{
				logger.warn(
					'FFmpeg exited abnormally [producerId:%s, code:%s, signal:%s]',
					producer.id, code, signal);
				logger.warn('  stderr: %s', stderrBuf.slice(-500));
			}
		});

		// Store state.
		this._transports.set(producer.id, transport);
		this._consumers.set(producer.id, consumer);
		this._processes.set(producer.id, proc);
		this._ports.set(producer.id, ports);
		this._writeStreams.set(producer.id, writeStream);

		// 11) Resume consumer — FFmpeg starts receiving RTP data.
		try
		{
			await consumer.resume();

			logger.info(
				'Consumer resumed [producerId:%s, codec:%s]',
				producer.id, codecName);

			if (producer.kind === 'video')
			{
				// Aggressively request keyframes for the first 5 seconds.
				// The first participant can take 5-10s without this because
				// the browser's VP8 encoder only sends keyframes periodically.
				// Multiple requests ensure we get one quickly.
				const intervals = [ 0, 200, 500, 1000, 1500, 2000, 3000, 4000, 5000 ];

				for (const ms of intervals)
				{
					setTimeout(() =>
					{
						if (this._consumers.has(producer.id))
						{
							consumer.requestKeyFrame().catch(() => {});
						}
					}, ms);
				}
			}
		}
		catch (error)
		{
			logger.error(
				'_recordProducer() | failed to resume consumer [producerId:%s]: %o',
				producer.id, error);
		}
	}

	_buildVideoArgs(rtpPort, payloadType, codecName, clockRate)
	{
		const sdp = [
			'v=0',
			'o=- 0 0 IN IP4 127.0.0.1',
			's=Recording',
			'c=IN IP4 127.0.0.1',
			't=0 0',
			`m=video ${rtpPort} RTP/AVP ${payloadType}`,
			`a=rtpmap:${payloadType} ${codecName}/${clockRate}`,
			'a=recvonly',
		].join('\r\n') + '\r\n';

		const sdpPath = path.join(this._rawDir, `sdp-video-${rtpPort}.sdp`);

		fs.writeFileSync(sdpPath, sdp);

		return [
			'-protocol_whitelist', 'file,udp,rtp',
			'-analyzeduration', '2000000',
			'-probesize', '2000000',
			'-fflags', '+genpts+nobuffer',
			'-i', sdpPath,
			'-c:v', 'copy',
			'-f', 'nut',
			'-flush_packets', '1',     // Flush each packet to stdout immediately
			'pipe:1',                   // Write to stdout → Node.js pipe → disk
		];
	}

	_buildAudioArgs(rtpPort, payloadType, codecName, clockRate, channels)
	{
		const ch = channels || 2;

		const sdp = [
			'v=0',
			'o=- 0 0 IN IP4 127.0.0.1',
			's=Recording',
			'c=IN IP4 127.0.0.1',
			't=0 0',
			`m=audio ${rtpPort} RTP/AVP ${payloadType}`,
			`a=rtpmap:${payloadType} ${codecName}/${clockRate}/${ch}`,
			...(codecName.toLowerCase() === 'opus'
				? [ `a=fmtp:${payloadType} minptime=10;useinbandfec=1` ]
				: []),
			'a=recvonly',
		].join('\r\n') + '\r\n';

		const sdpPath = path.join(this._rawDir, `sdp-audio-${rtpPort}.sdp`);

		fs.writeFileSync(sdpPath, sdp);

		return [
			'-protocol_whitelist', 'file,udp,rtp',
			'-analyzeduration', '2000000',
			'-probesize', '2000000',
			'-fflags', '+genpts+nobuffer',
			'-i', sdpPath,
			'-c:a', 'copy',
			'-f', 'nut',
			'-flush_packets', '1',
			'pipe:1',
		];
	}

	async _stopProducer(producerId)
	{
		const consumer = this._consumers.get(producerId);

		if (consumer)
		{
			try { consumer.close(); }
			catch (e) { /* ignore */ }
			this._consumers.delete(producerId);
		}

		const transport = this._transports.get(producerId);

		if (transport)
		{
			try { transport.close(); }
			catch (e) { /* ignore */ }
			this._transports.delete(producerId);
		}

		const proc = this._processes.get(producerId);

		if (proc)
		{
			// Data already on disk via pipe — safe to SIGKILL.
			try { proc.kill('SIGKILL'); }
			catch (e) { /* ignore */ }

			await new Promise((resolve) =>
			{
				proc.on('exit', resolve);
				setTimeout(resolve, 3000);
			});

			this._processes.delete(producerId);
		}

		const ws = this._writeStreams.get(producerId);

		if (ws)
		{
			await new Promise((resolve) =>
			{
				ws.on('finish', resolve);
				ws.on('error', resolve);
				ws.end();
				setTimeout(resolve, 1000);
			});

			this._writeStreams.delete(producerId);
		}
	}

	// -------------------------------------------------------------------------
	// Metadata files
	// -------------------------------------------------------------------------

	_writeMetadataFiles()
	{
		const startDate = new Date(this._globalStartTime);

		const metadataObj = {
			roomId          : this._roomId,
			roomName        : this._roomName,
			globalStartTime : this._globalStartTime,
			startDateUTC    : startDate.toISOString(),
			streams         : {},
		};

		for (const [ producerId, meta ] of this._metadata)
		{
			metadataObj.streams[producerId] = { ...meta };
		}

		fs.writeFileSync(
			path.join(this._rawDir, 'metadata.json'),
			JSON.stringify(metadataObj, null, 2));

		fs.writeFileSync(
			path.join(this._rawDir, 'timeline.json'),
			JSON.stringify(this._timeline, null, 2));

		logger.info(
			'_writeMetadataFiles() [streams:%d, events:%d]',
			this._metadata.size, this._timeline.length);
	}
}

module.exports = Recording;
