const childProcess = require('child_process');
const { EventEmitter } = require('events');
const Logger = require('./Logger');

const logger = new Logger('GStreamer');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './recordings';
const GSTREAMER_DEBUG_LEVEL = process.env.GSTREAMER_DEBUG_LEVEL || 3;
const GSTREAMER_COMMAND = process.env.GSTREAMER_PATH || '/opt/homebrew/bin/gst-launch-1.0';

// Output video dimensions for the composed recording (16:9 Full HD)
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const GRID_PADDING = 10; // Padding between video tiles

// Aspect ratios
const ASPECT_RATIO_16_9 = 16 / 9;
const ASPECT_RATIO_4_3 = 4 / 3;

/**
 * Production-level GStreamer class for recording RTP streams from mediasoup.
 * Supports:
 * - Multiple participants with proper aspect ratio preservation
 * - Screen share priority (larger tile when active)
 * - Dynamic grid layouts that adapt to participant count
 * - Professional video composition with audio mixing
 */
class GStreamer extends EventEmitter
{
	/**
	 * @param {Object} recordInfo - Recording information
	 * @param {Array} recordInfo.videos - Array of video RTP info objects with peerName and isScreenShare
	 * @param {Array} recordInfo.audios - Array of audio RTP info objects
	 * @param {String} recordInfo.fileName - Output filename (without extension)
	 */
	constructor(recordInfo)
	{
		super();

		this.setMaxListeners(Infinity);

		this._recordInfo = recordInfo;
		this._process = undefined;
		this._outputPath = `${RECORD_FILE_LOCATION_PATH}/${this._recordInfo.fileName}.webm`;

		this._createProcess();
	}

	/**
	 * Create and spawn the GStreamer process
	 */
	_createProcess()
	{
		logger.info('_createProcess() [command:%s]', GSTREAMER_COMMAND);

		// Build the complete pipeline command
		const pipelineCmd = this._buildPipeline();

		logger.info('_createProcess() Pipeline: %s', pipelineCmd);

		// Set up environment with library paths for macOS Homebrew
		const env = { 
			...process.env,
			GST_DEBUG         : GSTREAMER_DEBUG_LEVEL,
			DYLD_LIBRARY_PATH : '/opt/homebrew/lib',
			GST_PLUGIN_PATH   : '/opt/homebrew/lib/gstreamer-1.0'
		};

		// Use shell to run the complete command
		const fullCommand = `${GSTREAMER_COMMAND} -e ${pipelineCmd}`;

		logger.info('_createProcess() Full command: %s', fullCommand);

		this._process = childProcess.spawn('sh', [ '-c', fullCommand ], {
			detached : false,
			env      : env
		});

		if (this._process.stderr)
		{
			this._process.stderr.setEncoding('utf-8');
			this._process.stderr.on('data', (data) =>
			{
				logger.info('gstreamer::stderr [data:%s]', data.trim());
			});
		}

		if (this._process.stdout)
		{
			this._process.stdout.setEncoding('utf-8');
			this._process.stdout.on('data', (data) =>
			{
				logger.info('gstreamer::stdout [data:%s]', data.trim());
			});
		}

		this._process.on('error', (error) =>
		{
			logger.error('gstreamer::error [pid:%d, error:%o]', this._process.pid, error);
			this.emit('error', error);
		});

		this._process.once('close', (code, signal) =>
		{
			logger.info('gstreamer::close [pid:%d, code:%d, signal:%s]',
				this._process.pid, code, signal);
			this.emit('process-close', { code, signal });
		});

		logger.info('_createProcess() GStreamer process started [pid:%d]', this._process.pid);
	}

	/**
	 * Calculate tile dimensions preserving aspect ratio within a container
	 * @param {Number} containerWidth - Container width
	 * @param {Number} containerHeight - Container height
	 * @param {Number} aspectRatio - Desired aspect ratio (width/height)
	 * @returns {Object} { width, height, offsetX, offsetY }
	 */
	_fitAspectRatio(containerWidth, containerHeight, aspectRatio = ASPECT_RATIO_16_9)
	{
		const containerAspect = containerWidth / containerHeight;
		let width, height, offsetX, offsetY;

		if (containerAspect > aspectRatio)
		{
			// Container is wider than content - fit by height
			height = containerHeight;
			width = Math.floor(height * aspectRatio);
			offsetX = Math.floor((containerWidth - width) / 2);
			offsetY = 0;
		}
		else
		{
			// Container is taller than content - fit by width
			width = containerWidth;
			height = Math.floor(width / aspectRatio);
			offsetX = 0;
			offsetY = Math.floor((containerHeight - height) / 2);
		}

		return { width, height, offsetX, offsetY };
	}

	/**
	 * Calculate production-level grid layout for N videos
	 * Handles screen share priority - screen share gets 75% of width when active
	 * @param {Array} videos - Array of video objects with isScreenShare flag
	 * @returns {Array} Array of position objects
	 */
	_calculateGridLayout(videos)
	{
		const numVideos = videos.length;
		const padding = GRID_PADDING;
		const positions = [];

		// Check if there's a screen share
		const screenShareIndex = videos.findIndex(v => v.isScreenShare);
		const hasScreenShare = screenShareIndex !== -1;

		if (numVideos === 0)
		{
			return positions;
		}

		if (numVideos === 1)
		{
			// Single video - centered with proper aspect ratio
			const fit = this._fitAspectRatio(
				OUTPUT_WIDTH - (padding * 2),
				OUTPUT_HEIGHT - (padding * 2)
			);

			positions.push({
				x      : padding + fit.offsetX,
				y      : padding + fit.offsetY,
				width  : fit.width,
				height : fit.height
			});

			return positions;
		}

		// Screen share layout: screen share takes 75% width, others stack on right
		if (hasScreenShare)
		{
			const screenShareWidth = Math.floor((OUTPUT_WIDTH - (padding * 3)) * 0.75);
			const sidebarWidth = OUTPUT_WIDTH - screenShareWidth - (padding * 3);
			const screenShareHeight = OUTPUT_HEIGHT - (padding * 2);

			// Fit screen share with 16:9 aspect ratio
			const screenFit = this._fitAspectRatio(
				screenShareWidth, screenShareHeight, ASPECT_RATIO_16_9
			);

			// Calculate sidebar tile dimensions
			const otherVideos = numVideos - 1;
			const maxSidebarTiles = 4;
			const visibleSidebarTiles = Math.min(otherVideos, maxSidebarTiles);
			const sidebarTileHeight = visibleSidebarTiles > 0 
				? Math.floor((OUTPUT_HEIGHT - (padding * (visibleSidebarTiles + 1))) / visibleSidebarTiles)
				: 0;

			// Position all videos
			let sidebarIndex = 0;

			for (let i = 0; i < numVideos; i++)
			{
				if (i === screenShareIndex)
				{
					// Screen share - large tile on left
					positions.push({
						x             : padding + screenFit.offsetX,
						y             : padding + screenFit.offsetY,
						width         : screenFit.width,
						height        : screenFit.height,
						isScreenShare : true
					});
				}
				else if (sidebarIndex < maxSidebarTiles)
				{
					// Other videos - stacked on right sidebar
					const webcamFit = this._fitAspectRatio(
						sidebarWidth, sidebarTileHeight, ASPECT_RATIO_4_3
					);

					positions.push({
						x      : screenShareWidth + (padding * 2) + webcamFit.offsetX,
						y      : padding + (sidebarIndex * (sidebarTileHeight + padding)) + webcamFit.offsetY,
						width  : webcamFit.width,
						height : webcamFit.height
					});
					sidebarIndex++;
				}
				else
				{
					// Extra participants beyond sidebar limit - small tiles at bottom
					positions.push({
						x      : padding,
						y      : OUTPUT_HEIGHT - 100,
						width  : 160,
						height : 90
					});
				}
			}

			return positions;
		}

		// Standard grid layout (no screen share)
		let cols, rows;

		if (numVideos === 2)
		{
			// Side by side, equal size
			cols = 2;
			rows = 1;
		}
		else if (numVideos === 3)
		{
			cols = 3;
			rows = 1;
		}
		else if (numVideos === 4)
		{
			cols = 2;
			rows = 2;
		}
		else if (numVideos <= 6)
		{
			cols = 3;
			rows = 2;
		}
		else if (numVideos <= 9)
		{
			cols = 3;
			rows = 3;
		}
		else if (numVideos <= 12)
		{
			cols = 4;
			rows = 3;
		}
		else if (numVideos <= 16)
		{
			cols = 4;
			rows = 4;
		}
		else
		{
			cols = 5;
			rows = Math.ceil(numVideos / 5);
		}

		// Calculate cell dimensions
		const totalPaddingX = padding * (cols + 1);
		const totalPaddingY = padding * (rows + 1);
		const cellWidth = Math.floor((OUTPUT_WIDTH - totalPaddingX) / cols);
		const cellHeight = Math.floor((OUTPUT_HEIGHT - totalPaddingY) / rows);

		// Calculate last row for centering
		const lastRowStart = Math.floor((numVideos - 1) / cols) * cols;
		const lastRowCount = numVideos - lastRowStart;

		for (let i = 0; i < numVideos; i++)
		{
			const row = Math.floor(i / cols);
			const col = i % cols;

			// Center the last row if it's not full
			let xOffset = 0;

			if (row === Math.floor((numVideos - 1) / cols) && lastRowCount < cols)
			{
				xOffset = Math.floor((cols - lastRowCount) * (cellWidth + padding) / 2);
			}

			// Fit video with 16:9 aspect ratio inside cell
			const fit = this._fitAspectRatio(cellWidth, cellHeight, ASPECT_RATIO_16_9);

			positions.push({
				x      : padding + (col * (cellWidth + padding)) + xOffset + fit.offsetX,
				y      : padding + (row * (cellHeight + padding)) + fit.offsetY,
				width  : fit.width,
				height : fit.height
			});
		}

		return positions;
	}

	/**
	 * Build the GStreamer pipeline string for multiple participants
	 */
	_buildPipeline()
	{
		const { videos, audios } = this._recordInfo;

		// Safety check
		if (!videos || !Array.isArray(videos) || videos.length === 0)
		{
			throw new Error('No videos provided for recording');
		}

		logger.info('_buildPipeline() Building pipeline for %d videos and %d audios',
			videos.length, (audios || []).length);

		const pipelineParts = [];

		// WebM muxer - much lighter than MP4/H.264
		// WebM supports VP8/VP9 video and Opus/Vorbis audio natively
		// streamable=true allows the file to be playable during recording
		pipelineParts.push(
			`webmmux name=mux streamable=true ! ` +
			`filesink location="${this._outputPath}" sync=false`
		);

		// Calculate grid positions with screen share priority
		const gridPositions = this._calculateGridLayout(videos);

		// Build compositor sink pads configuration
		let compositorSinks = '';

		for (let i = 0; i < videos.length; i++)
		{
			const pos = gridPositions[i];

			compositorSinks += ` sink_${i}::xpos=${pos.x} sink_${i}::ypos=${pos.y} ` +
				`sink_${i}::width=${pos.width} sink_${i}::height=${pos.height}`;
		}

		// Video compositor and encoder pipeline
		// Using VP8 encoder instead of H.264 - much faster and lighter on CPU
		// cpu-used=8 is fastest (0-16 range), deadline=1 for realtime
		pipelineParts.push(
			`compositor name=comp background=black${compositorSinks} ! ` +
			`video/x-raw,width=${OUTPUT_WIDTH},height=${OUTPUT_HEIGHT},framerate=30/1 ! ` +
			`videoconvert ! ` +
			`vp8enc deadline=1 cpu-used=8 threads=4 target-bitrate=4000000 ` +
			`keyframe-max-dist=60 ! ` +
			`queue max-size-buffers=200 max-size-time=0 max-size-bytes=0 ! mux.video_0`
		);

		// Add video input pipelines
		for (let i = 0; i < videos.length; i++)
		{
			const video = videos[i];
			const pos = gridPositions[i];
			
			const videoCodec = video.rtpParameters.codecs.find(
				(codec) => !codec.mimeType.toLowerCase().includes('rtx')
			) || video.rtpParameters.codecs[0];
			
			const videoPayloadType = videoCodec.payloadType;
			const videoClockRate = videoCodec.clockRate;
			const videoMimeType = videoCodec.mimeType.toLowerCase();
			const peerName = video.peerName || `Participant ${i + 1}`;
			const isScreenShare = video.isScreenShare || false;

			let encodingName, depayloader;

			if (videoMimeType.includes('vp8'))
			{
				encodingName = 'VP8';
				depayloader = 'rtpvp8depay';
			}
			else if (videoMimeType.includes('vp9'))
			{
				encodingName = 'VP9';
				depayloader = 'rtpvp9depay';
			}
			else if (videoMimeType.includes('h264'))
			{
				encodingName = 'H264';
				depayloader = 'rtph264depay';
			}
			else
			{
				encodingName = 'VP8';
				depayloader = 'rtpvp8depay';
			}

			logger.info(
				'_buildPipeline() Video %d: port=%d, codec=%s, peer=%s, ' +
				'isScreenShare=%s, size=%dx%d @ (%d,%d)',
				i, video.remoteRtpPort, encodingName, peerName, 
				isScreenShare, pos.width, pos.height, pos.x, pos.y
			);

			const overlayText = isScreenShare ? `${peerName}'s Screen` : peerName;
			const fontSize = isScreenShare ? 18 : 14;

			// Video input pipeline with improved buffering for restart scenarios
			// - Larger queue buffers to handle timing gaps
			// - do-timestamp=true to generate fresh timestamps (important for restarts)
			pipelineParts.push(
				`udpsrc address=127.0.0.1 port=${video.remoteRtpPort} ` +
				`caps="application/x-rtp,media=video,clock-rate=${videoClockRate},` +
				`encoding-name=${encodingName},payload=${videoPayloadType}" ` +
				`do-timestamp=true ! ` +
				`queue max-size-buffers=500 max-size-time=5000000000 max-size-bytes=0 leaky=downstream ! ` +
				`${depayloader} ! ` +
				`decodebin ! ` +
				`videoconvert ! videoscale add-borders=true ! ` +
				`video/x-raw,width=${pos.width},height=${pos.height},pixel-aspect-ratio=1/1 ! ` +
				`videorate drop-only=false ! video/x-raw,framerate=30/1 ! ` +
				`textoverlay text="${overlayText}" valignment=bottom halignment=center ` +
				`font-desc="Sans Bold ${fontSize}" shaded-background=true draw-shadow=true ! ` +
				`queue max-size-buffers=100 ! comp.sink_${i}`
			);
		}

		// Add audio mixer if there are audio streams
		// Using Opus encoder for WebM (or Vorbis as fallback)
		// Opus is lighter than AAC and WebM native
		const safeAudios = audios || [];
		if (safeAudios.length > 0)
		{
			pipelineParts.push(
				'audiomixer name=amix latency=100000000 ! ' +
				'audioconvert ! audioresample ! ' +
				'audio/x-raw,rate=48000,channels=2 ! ' +
				'opusenc bitrate=128000 ! ' +
				'queue max-size-buffers=200 ! mux.audio_0'
			);

			for (let i = 0; i < safeAudios.length; i++)
			{
				const audio = safeAudios[i];
				
				const audioCodec = audio.rtpParameters.codecs.find(
					(codec) => !codec.mimeType.toLowerCase().includes('rtx')
				) || audio.rtpParameters.codecs[0];
				
				const audioPayloadType = audioCodec.payloadType;
				const audioClockRate = audioCodec.clockRate;
				const audioMimeType = audioCodec.mimeType.toLowerCase();

				let audioEncodingName, audioDepayloader, audioDecoder;

				if (audioMimeType.includes('opus'))
				{
					audioEncodingName = 'OPUS';
					audioDepayloader = 'rtpopusdepay';
					audioDecoder = 'opusdec';
				}
				else if (audioMimeType.includes('pcm') || audioMimeType.includes('l16'))
				{
					audioEncodingName = 'L16';
					audioDepayloader = 'rtpL16depay';
					audioDecoder = '';
				}
				else
				{
					audioEncodingName = 'OPUS';
					audioDepayloader = 'rtpopusdepay';
					audioDecoder = 'opusdec';
				}

				logger.info('_buildPipeline() Audio %d: port=%d, codec=%s',
					i, audio.remoteRtpPort, audioMimeType);

				const decoderPart = audioDecoder ? `${audioDecoder} ! ` : '';

				// Audio pipeline with do-timestamp for fresh timestamps on restart
				pipelineParts.push(
					`udpsrc address=127.0.0.1 port=${audio.remoteRtpPort} ` +
					`caps="application/x-rtp,media=audio,clock-rate=${audioClockRate},` +
					`encoding-name=${audioEncodingName},payload=${audioPayloadType}" ` +
					`do-timestamp=true ! ` +
					`queue max-size-buffers=500 max-size-time=5000000000 leaky=downstream ! ` +
					`${audioDepayloader} ! ${decoderPart}` +
					`audioconvert ! audioresample ! ` +
					`queue max-size-buffers=100 ! amix.`
				);
			}
		}

		return pipelineParts.join(' ');
	}

	/**
	 * Kill the GStreamer process gracefully and wait for it to finish
	 * @returns {Promise} Resolves when the process has closed
	 */
	kill()
	{
		return new Promise((resolve) =>
		{
			if (!this._process || this._process.killed)
			{
				logger.info('kill() Process already killed or not started');
				resolve();

				return;
			}

			logger.info('kill() [pid:%d]', this._process.pid);

			// Set up a one-time listener for process close
			const onClose = () =>
			{
				logger.info('kill() Process closed gracefully [pid:%d]', this._process.pid);
				clearTimeout(forceKillTimer);
				resolve();
			};

			this._process.once('close', onClose);

			// Send SIGINT for graceful shutdown with EOS
			this._process.kill('SIGINT');

			// Force kill after 5 seconds if it doesn't close gracefully
			const forceKillTimer = setTimeout(() =>
			{
				if (this._process && !this._process.killed)
				{
					logger.warn('kill() Force killing GStreamer process [pid:%d]', this._process.pid);
					this._process.removeListener('close', onClose);
					this._process.kill('SIGKILL');
					resolve();
				}
			}, 5000);
		});
	}

	get outputPath()
	{
		return this._outputPath;
	}
}

module.exports = GStreamer;
