/* eslint-disable no-unused-vars */
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('RawStreamRecorder');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './recordings';
const GSTREAMER_COMMAND = process.env.GSTREAMER_PATH || '/opt/homebrew/bin/gst-launch-1.0';

/**
 * Records individual RTP streams to raw WebM files.
 * Each producer gets its own file - no real-time composition.
 * After recording stops, use FFmpeg to compose them.
 */
class RawStreamRecorder extends EventEmitter
{
	constructor(streamInfo)
	{
		super();
		this.setMaxListeners(Infinity);

		this._streamInfo = streamInfo;
		this._process = undefined;
		this._outputPath = streamInfo.outputPath;
		this._startTime = Date.now();

		this._createProcess();
	}

	_createProcess()
	{
		const { port, codec, clockRate, payloadType, kind, isScreenShare, peerName } =
			this._streamInfo;

		logger.info('_createProcess() Recording %s stream [port:%d, codec:%s, peer:%s, isScreenShare:%s]',
			kind, port, codec, peerName, isScreenShare);

		let pipeline;

		if (kind === 'video')
		{
			let depay, parse;

			if (codec === 'VP8') 
			{
				depay = 'rtpvp8depay';
				parse = 'vp8parse';
			}
			else if (codec === 'VP9') 
			{
				depay = 'rtpvp9depay';
				parse = 'vp9parse';
			}
			else if (codec === 'H264') 
			{
				depay = 'rtph264depay';
				parse = 'h264parse';
			}
			else 
			{
				depay = 'rtpvp8depay';
				parse = 'vp8parse';
			}

			// Record raw video to WebM without re-encoding
			// Need parser between depay and mux for proper framing
			pipeline = `udpsrc address=127.0.0.1 port=${port} ` +
				`caps="application/x-rtp,media=video,clock-rate=${clockRate},` +
				`encoding-name=${codec},payload=${payloadType}" ` +
				'do-timestamp=true ! ' +
				'queue max-size-buffers=1000 max-size-time=10000000000 leaky=downstream ! ' +
				`${depay} ! ${parse} ! ` +
				'webmmux streamable=true ! ' +
				`filesink location="${this._outputPath}" sync=false`;
		}
		else if (kind === 'audio')
		{
			// Record raw audio to WebM (Opus passthrough)
			pipeline = `udpsrc address=127.0.0.1 port=${port} ` +
				`caps="application/x-rtp,media=audio,clock-rate=${clockRate},` +
				`encoding-name=OPUS,payload=${payloadType}" ` +
				'do-timestamp=true ! ' +
				'queue max-size-buffers=1000 max-size-time=10000000000 leaky=downstream ! ' +
				'rtpopusdepay ! opusparse ! ' +
				'webmmux streamable=true ! ' +
				`filesink location="${this._outputPath}" sync=false`;
		}

		const fullCommand = `${GSTREAMER_COMMAND} -e ${pipeline}`;

		logger.info('_createProcess() Command: %s', fullCommand);

		const env = {
			...process.env,
			GST_DEBUG         : 2,
			DYLD_LIBRARY_PATH : '/opt/homebrew/lib',
			GST_PLUGIN_PATH   : '/opt/homebrew/lib/gstreamer-1.0'
		};

		this._process = childProcess.spawn('sh', [ '-c', fullCommand ], {
			detached : false,
			env
		});

		if (this._process.stderr)
		{
			this._process.stderr.on('data', (data) =>
			{
				const msg = data.toString().trim();

				if (msg.includes('ERROR') || msg.includes('error'))
				{
					logger.error('gstreamer::stderr [%s]', msg);
				}
			});
		}

		this._process.on('error', (error) =>
		{
			logger.error('gstreamer::error [error:%o]', error);
			this.emit('error', error);
		});

		this._process.on('close', (code) =>
		{
			logger.info('gstreamer::close [code:%d, path:%s]', code, this._outputPath);
			this.emit('close', { code, outputPath: this._outputPath });
		});
	}

	kill()
	{
		return new Promise((resolve) =>
		{
			if (!this._process || this._process.killed)
			{
				resolve();
				
				return;
			}

			this._process.once('close', () => resolve());
			this._process.kill('SIGINT');

			// Force kill after 5 seconds
			setTimeout(() =>
			{
				if (this._process && !this._process.killed)
				{
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

	get duration()
	{
		return Date.now() - this._startTime;
	}
}

module.exports = RawStreamRecorder;
