const childProcess = require('child_process');
const { EventEmitter } = require('events');
const Logger = require('./Logger');

const logger = new Logger('GStreamer');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './recordings';
const GSTREAMER_DEBUG_LEVEL = process.env.GSTREAMER_DEBUG_LEVEL || 3;
const GSTREAMER_COMMAND = process.env.GSTREAMER_PATH || '/opt/homebrew/bin/gst-launch-1.0';

// Output video dimensions for the composed recording
const OUTPUT_WIDTH = 1280;
const OUTPUT_HEIGHT = 720;
const GRID_PADDING = 8; // Padding between video tiles

/**
 * GStreamer class for recording RTP streams from mediasoup.
 * Supports multiple participants with video composition and audio mixing.
 */
class GStreamer extends EventEmitter
{
	/**
	 * @param {Object} recordInfo - Recording information
	 * @param {Array} recordInfo.videos - Array of video RTP info objects with peerName
	 * @param {Array} recordInfo.audios - Array of audio RTP info objects
	 * @param {String} recordInfo.fileName - Output filename (without extension)
	 */
	constructor(recordInfo)
	{
		super();

		this.setMaxListeners(Infinity);

		this._recordInfo = recordInfo;
		this._process = undefined;
		this._outputPath = `${RECORD_FILE_LOCATION_PATH}/${this._recordInfo.fileName}.mp4`;

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
				// Log all stderr for debugging
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
	 * Calculate grid layout positions for N videos with padding
	 */
	_calculateGridLayout(numVideos)
	{
		// Determine grid dimensions based on number of videos
		let cols, rows;

		if (numVideos === 1)
		{
			cols = 1;
			rows = 1;
		}
		else if (numVideos === 2)
		{
			cols = 2;
			rows = 1;
		}
		else if (numVideos <= 4)
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
		else
		{
			cols = 4;
			rows = Math.ceil(numVideos / 4);
		}

		const padding = GRID_PADDING;
		const totalPaddingX = padding * (cols + 1);
		const totalPaddingY = padding * (rows + 1);
		const cellWidth = Math.floor((OUTPUT_WIDTH - totalPaddingX) / cols);
		const cellHeight = Math.floor((OUTPUT_HEIGHT - totalPaddingY) / rows);

		const positions = [];

		for (let i = 0; i < numVideos; i++)
		{
			const col = i % cols;
			const row = Math.floor(i / cols);

			positions.push({
				x      : padding + (col * (cellWidth + padding)),
				y      : padding + (row * (cellHeight + padding)),
				width  : cellWidth,
				height : cellHeight
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

		logger.info('_buildPipeline() Building pipeline for %d videos and %d audios',
			videos.length, audios.length);

		const pipelineParts = [];

		// IMPORTANT: mp4mux must be declared FIRST so that other elements can reference it
		// Remove fragment-duration and streamable for proper MP4 with duration metadata
		// faststart moves moov atom to beginning for better playback
		pipelineParts.push(
			`mp4mux name=mux faststart=true reserved-moov-update-period=1000 reserved-max-duration=36000000000000 ! filesink location="${this._outputPath}" sync=false`
		);

		// Create compositor for video mixing
		const gridPositions = this._calculateGridLayout(videos.length);

		// Build compositor sink pads string
		let compositorSinks = '';

		for (let i = 0; i < videos.length; i++)
		{
			const pos = gridPositions[i];

			compositorSinks += ` sink_${i}::xpos=${pos.x} sink_${i}::ypos=${pos.y} sink_${i}::width=${pos.width} sink_${i}::height=${pos.height}`;
		}

		// Compositor output - using x264enc for H.264 video (MP4 compatible)
		pipelineParts.push(
			`compositor name=comp background=black${compositorSinks} ! video/x-raw,width=${OUTPUT_WIDTH},height=${OUTPUT_HEIGHT},framerate=30/1 ! videoconvert ! x264enc tune=zerolatency bitrate=2000 speed-preset=ultrafast key-int-max=30 ! video/x-h264,profile=baseline ! queue ! mux.video_0`
		);

		// Add video input pipelines with name overlays
		for (let i = 0; i < videos.length; i++)
		{
			const video = videos[i];
			// Find the main video codec (not RTX)
			const videoCodec = video.rtpParameters.codecs.find(
				(codec) => !codec.mimeType.toLowerCase().includes('rtx')
			) || video.rtpParameters.codecs[0];
			const videoPayloadType = videoCodec.payloadType;
			const videoClockRate = videoCodec.clockRate;
			const videoMimeType = videoCodec.mimeType.toLowerCase();
			const peerName = video.peerName || `Participant ${i + 1}`;

			// Determine encoding name and depayloader based on codec
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
				// Default to VP8
				encodingName = 'VP8';
				depayloader = 'rtpvp8depay';
			}

			// For video: VP8=96/101, VP9=98, H264=various
			// MediaSoup typically uses dynamic payload types starting from 96
			// Use a simple caps with only clock-rate, no PT restriction
			// Skip rtpjitterbuffer and use queue instead for simpler handling
			logger.info('_buildPipeline() Video %d: port=%d, pt=%d, clockRate=%d, codec=%s, encoding=%s, peer=%s',
				i, video.remoteRtpPort, videoPayloadType, videoClockRate, videoMimeType, encodingName, peerName);

			// Simpler pipeline without jitterbuffer - use decodebin to auto-detect the codec
			pipelineParts.push(
				`udpsrc address=127.0.0.1 port=${video.remoteRtpPort} caps="application/x-rtp,media=video,clock-rate=${videoClockRate},encoding-name=${encodingName},payload=${videoPayloadType}" ! queue ! ${depayloader} ! decodebin ! videoconvert ! videoscale ! videorate ! video/x-raw,framerate=30/1 ! textoverlay text="${peerName}" valignment=bottom halignment=center font-desc="Sans Bold 16" shaded-background=true ! queue max-size-buffers=100 ! comp.sink_${i}`
			);
		}

		// Add audio mixer if there are audio streams
		if (audios.length > 0)
		{
			// Create audiomixer with AAC encoder for MP4 compatibility
			pipelineParts.push(
				'audiomixer name=amix ! audioconvert ! audioresample ! audio/x-raw,rate=44100,channels=2 ! avenc_aac bitrate=128000 ! queue ! mux.audio_0'
			);

			// Add audio input pipelines
			for (let i = 0; i < audios.length; i++)
			{
				const audio = audios[i];
				// Find the main audio codec (not RTX)
				const audioCodec = audio.rtpParameters.codecs.find(
					(codec) => !codec.mimeType.toLowerCase().includes('rtx')
				) || audio.rtpParameters.codecs[0];
				const audioPayloadType = audioCodec.payloadType;
				const audioClockRate = audioCodec.clockRate;
				const audioMimeType = audioCodec.mimeType.toLowerCase();

				// Determine encoding name and depayloader based on codec
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
					audioDecoder = ''; // No decoder needed for raw PCM
				}
				else if (audioMimeType.includes('g722'))
				{
					audioEncodingName = 'G722';
					audioDepayloader = 'rtpg722depay';
					audioDecoder = 'avdec_g722';
				}
				else
				{
					// Default to Opus
					audioEncodingName = 'OPUS';
					audioDepayloader = 'rtpopusdepay';
					audioDecoder = 'opusdec';
				}

				// Simpler pipeline without jitterbuffer
				logger.info('_buildPipeline() Audio %d: port=%d, pt=%d, clockRate=%d, codec=%s',
					i, audio.remoteRtpPort, audioPayloadType, audioClockRate, audioMimeType);

				const decoderPart = audioDecoder ? `${audioDecoder} ! ` : '';

				pipelineParts.push(
					`udpsrc address=127.0.0.1 port=${audio.remoteRtpPort} caps="application/x-rtp,media=audio,clock-rate=${audioClockRate},encoding-name=${audioEncodingName},payload=${audioPayloadType}" ! queue ! ${audioDepayloader} ! ${decoderPart}audioconvert ! audioresample ! queue max-size-buffers=100 ! amix.`
				);
			}
		}

		// Join all pipeline parts
		const pipeline = pipelineParts.join(' ');

		return pipeline;
	}

	/**
	 * Kill the GStreamer process
	 */
	kill()
	{
		logger.info('kill() [pid:%d]', this._process.pid);

		// Send SIGINT first for graceful shutdown (writes EOS)
		this._process.kill('SIGINT');

		// Force kill after 5 seconds if not terminated
		setTimeout(() =>
		{
			if (this._process && !this._process.killed)
			{
				logger.warn('kill() Force killing GStreamer process [pid:%d]', this._process.pid);
				this._process.kill('SIGKILL');
			}
		}, 5000);
	}

	/**
	 * Get the output file path
	 */
	get outputPath()
	{
		return this._outputPath;
	}
}

module.exports = GStreamer;
