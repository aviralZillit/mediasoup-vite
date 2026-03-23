/**
 * RecorderBot — Headless Chrome "bot" that joins a room and records it.
 *
 * Google Meet approach to recording:
 *   1. Launch headless Chrome with the app URL
 *   2. Bot joins as a consume-only participant (no webcam/mic)
 *   3. CDP screenshots at ~15fps piped to FFmpeg → video
 *   4. Web Audio API captures all audio → MediaRecorder → audio file
 *   5. On stop → mux video+audio → final MP4
 *
 * Result: perfectly synced audio/video, exactly what users see.
 */

const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('RecorderBot');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const RECORDING_BASE_DIR = process.env.RECORD_FILE_LOCATION_PATH ||
	path.join(__dirname, '..', 'recordings');

const CAPTURE_FPS = 15; // CDP screenshot FPS (15 is smooth enough, low CPU)
const CAPTURE_WIDTH = 1920;
const CAPTURE_HEIGHT = 1080;
const JPEG_QUALITY = 80;

function _findChrome()
{
	const candidates = [
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
		'/Applications/Chromium.app/Contents/MacOS/Chromium',
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/snap/bin/chromium',
	];

	for (const c of candidates)
	{
		if (fs.existsSync(c)) return c;
	}

	return null;
}

function _utcTag(date)
{
	const d = date || new Date();
	const pad = (n) => String(n).padStart(2, '0');

	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_` +
		`${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
}

class RecorderBot
{
	constructor({ roomId, roomName, appUrl })
	{
		this._roomId = roomId;
		this._roomName = roomName || roomId;
		this._appUrl = appUrl || 'https://localhost:3000';
		this._active = false;
		this._startTime = null;
		this._browser = null;
		this._page = null;
		this._cdpClient = null;
		this._ffmpegVideo = null;
		this._ffmpegMux = null;
		this._captureInterval = null;
		this._frameCount = 0;

		this._roomDir = path.join(RECORDING_BASE_DIR, roomId);
		this._rawDir = path.join(this._roomDir, 'raw');
		this._videoPath = path.join(this._rawDir, 'bot-video.mp4');
		this._audioPath = path.join(this._rawDir, 'bot-audio.webm');

		fs.mkdirSync(this._rawDir, { recursive: true });
	}

	get active() { return this._active; }
	get roomDir() { return this._roomDir; }
	get rawDir() { return this._rawDir; }

	/**
	 * Launch the bot and start recording.
	 */
	async start()
	{
		if (this._active)
			throw new Error('RecorderBot already active');

		const chromePath = process.env.CHROME_PATH || _findChrome();

		if (!chromePath)
			throw new Error('Chrome/Chromium not found. Set CHROME_PATH env var.');

		logger.info('start() [roomId:%s, chrome:%s]', this._roomId, chromePath);

		this._active = true;
		this._startTime = Date.now();

		// 1) Launch Chrome.
		this._browser = await puppeteer.launch({
			executablePath : chromePath,
			headless       : 'new',
			args           : [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--ignore-certificate-errors',
				'--autoplay-policy=no-user-gesture-required',
				'--use-fake-ui-for-media-stream',
				'--use-fake-device-for-media-stream',
				`--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`,
			],
			defaultViewport : { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT },
		});

		// 2) Navigate to the room.
		const peerId = `recorder-${Date.now()}`;
		const joinUrl = `${this._appUrl}/?roomId=${encodeURIComponent(this._roomId)}` +
			`&displayName=${encodeURIComponent('Recorder')}` +
			`&peerId=${peerId}` +
			`&produce=false&consume=true&info=false&recorder=true`;

		this._page = await this._browser.newPage();

		const context = this._browser.defaultBrowserContext();

		await context.overridePermissions(this._appUrl, [
			'microphone', 'camera',
		]);

		logger.info('Navigating to room [url:%s]', joinUrl);

		await this._page.goto(joinUrl, {
			waitUntil : 'networkidle2',
			timeout   : 30000,
		});

		// 3) Wait for Room component + peers to appear.
		await this._page.waitForFunction(
			() => document.querySelector('[data-component="Room"]') !== null,
			{ timeout: 15000 }
		).catch(() => logger.warn('Timed out waiting for Room'));

		// Wait extra for consumers to be created.
		await new Promise((resolve) => setTimeout(resolve, 3000));

		// 4) Start audio capture via Web Audio API in the page.
		await this._startAudioCapture();

		// 5) Start video capture via CDP screenshots → FFmpeg.
		await this._startVideoCapture();

		// Save a debug screenshot so we can see what the bot renders.
		try
		{
			const debugScreenshot = path.join(this._rawDir, 'bot-debug-screenshot.png');

			await this._page.screenshot({ path: debugScreenshot, fullPage: false });

			logger.info('Debug screenshot saved [path:%s]', debugScreenshot);
		}
		catch (e)
		{
			logger.warn('Debug screenshot failed: %s', e.message);
		}

		// Log what the bot sees periodically for debugging.
		this._debugInterval = setInterval(async () =>
		{
			if (!this._page) return;

			try
			{
				const info = await this._page.evaluate(() =>
				{
					const videos = document.querySelectorAll('video');
					const peers = document.querySelectorAll('[data-component="Peer"]');
					const peerViews = document.querySelectorAll('[data-component="PeerView"]');

					return {
						peers     : peers.length,
						peerViews : peerViews.length,
						videos    : Array.from(videos).map((v) => ({
							w     : v.videoWidth,
							h     : v.videoHeight,
							ready : v.readyState,
							src   : !!v.srcObject,
						})),
					};
				});

				logger.info(
					'Bot DOM [peers:%d, views:%d, videos:%d: %s]',
					info.peers, info.peerViews, info.videos.length,
					info.videos.map((v) => `${v.w}x${v.h}/r${v.ready}`).join(', '));
			}
			catch (e)
			{
				// Page might be closed.
			}
		}, 5000);

		logger.info('Recording started [roomId:%s, fps:%d]',
			this._roomId, CAPTURE_FPS);
	}

	/**
	 * Stop recording and produce final MP4.
	 * @returns {String|null} Path to final MP4.
	 */
	async stop()
	{
		if (!this._active)
			return null;

		logger.info('stop() [roomId:%s, frames:%d]', this._roomId, this._frameCount);
		this._active = false;

		if (this._debugInterval)
		{
			clearInterval(this._debugInterval);
			this._debugInterval = null;
		}

		try
		{
			// 1) Stop video capture.
			this._stopVideoCapture();

			// 2) Stop audio capture and download the blob.
			await this._stopAudioCapture();

			// 3) Wait for video FFmpeg to finish.
			await this._waitForFFmpegVideo();

			// 4) Mux video + audio → final MP4.
			const outputFile = await this._muxFinal();

			return outputFile;
		}
		catch (error)
		{
			logger.error('stop() failed: %o', error);

			return null;
		}
		finally
		{
			await this._closeBrowser();
		}
	}

	async close()
	{
		this._active = false;
		this._stopVideoCapture();
		await this._closeBrowser();
	}

	// -------------------------------------------------------------------------
	// Video capture: CDP screenshots → FFmpeg
	// -------------------------------------------------------------------------

	async _startVideoCapture()
	{
		this._cdpClient = await this._page.createCDPSession();

		// Start FFmpeg to receive JPEG frames via stdin → output MP4.
		this._ffmpegVideo = spawn(FFMPEG_PATH, [
			'-f', 'image2pipe',
			'-framerate', String(CAPTURE_FPS),
			'-i', 'pipe:0',
			'-c:v', 'libx264',
			'-preset', 'ultrafast',
			'-crf', '23',
			'-pix_fmt', 'yuv420p',
			'-r', String(CAPTURE_FPS),
			'-y', this._videoPath,
		], { stdio: ['pipe', 'ignore', 'pipe'] });

		let ffStderr = '';

		this._ffmpegVideo.stderr.on('data', (d) =>
		{
			ffStderr += d.toString();

			if (ffStderr.length > 4000) ffStderr = ffStderr.slice(-2000);
		});

		this._ffmpegVideo.on('exit', (code) =>
		{
			if (code !== 0 && code !== null)
			{
				logger.warn('FFmpeg video exited [code:%d]\n%s', code,
					ffStderr.slice(-500));
			}
		});

		// Screenshot loop at CAPTURE_FPS.
		const intervalMs = Math.round(1000 / CAPTURE_FPS);

		this._captureInterval = setInterval(async () =>
		{
			if (!this._active || !this._cdpClient || !this._ffmpegVideo)
				return;

			try
			{
				const { data } = await this._cdpClient.send(
					'Page.captureScreenshot',
					{
						format        : 'jpeg',
						quality       : JPEG_QUALITY,
						fromSurface   : true,
						captureBeyondViewport : false,
					});

				const buffer = Buffer.from(data, 'base64');

				if (this._ffmpegVideo && this._ffmpegVideo.stdin.writable)
				{
					this._ffmpegVideo.stdin.write(buffer);
					this._frameCount++;
				}
			}
			catch (e)
			{
				// CDP might fail if page closed — ignore.
			}
		}, intervalMs);
	}

	_stopVideoCapture()
	{
		if (this._captureInterval)
		{
			clearInterval(this._captureInterval);
			this._captureInterval = null;
		}

		if (this._ffmpegVideo && this._ffmpegVideo.stdin.writable)
		{
			this._ffmpegVideo.stdin.end();
		}
	}

	_waitForFFmpegVideo()
	{
		return new Promise((resolve) =>
		{
			if (!this._ffmpegVideo)
			{
				resolve();

				return;
			}

			this._ffmpegVideo.on('exit', resolve);

			// Safety timeout.
			setTimeout(() =>
			{
				if (this._ffmpegVideo)
				{
					try { this._ffmpegVideo.kill('SIGKILL'); }
					catch (e) { /* ignore */ }
				}

				resolve();
			}, 30000);
		});
	}

	// -------------------------------------------------------------------------
	// Audio capture: Web Audio API → MediaRecorder
	// -------------------------------------------------------------------------

	async _startAudioCapture()
	{
		await this._page.evaluate(() =>
		{
			try
			{
				const audioCtx = new AudioContext();
				const dest = audioCtx.createMediaStreamDestination();

				// Connect all existing audio/video elements.
				const connectAudio = (el) =>
				{
					if (el.srcObject && !el._botAudioConnected)
					{
						const audioTracks = el.srcObject.getAudioTracks();

						if (audioTracks.length > 0)
						{
							try
							{
								const src = audioCtx.createMediaStreamSource(
									new MediaStream(audioTracks));

								src.connect(dest);
								el._botAudioConnected = true;
							}
							catch (e)
							{
								// ignore
							}
						}
					}
				};

				document.querySelectorAll('audio, video').forEach(connectAudio);

				// Watch for new elements.
				const observer = new MutationObserver(() =>
				{
					document.querySelectorAll('audio, video').forEach(connectAudio);
				});

				observer.observe(document.body, { childList: true, subtree: true });

				// Also periodically check for new streams (consumers added dynamically).
				const intervalId = setInterval(() =>
				{
					document.querySelectorAll('audio, video').forEach(connectAudio);
				}, 2000);

				// Start recording audio.
				const recorder = new MediaRecorder(dest.stream, {
					mimeType : 'audio/webm;codecs=opus',
				});

				const chunks = [];

				recorder.ondataavailable = (e) =>
				{
					if (e.data.size > 0) chunks.push(e.data);
				};

				recorder.onstop = () =>
				{
					window._audioBlobReady = new Blob(chunks,
						{ type: 'audio/webm' });
				};

				recorder.start(1000);

				window._audioRecorder = recorder;
				window._audioObserver = observer;
				window._audioIntervalId = intervalId;
				window._audioCtx = audioCtx;
			}
			catch (e)
			{
				console.error('Audio capture failed:', e);
			}
		});
	}

	async _stopAudioCapture()
	{
		if (!this._page) return;

		try
		{
			// Stop recorder and observer.
			await this._page.evaluate(() =>
			{
				if (window._audioRecorder &&
					window._audioRecorder.state !== 'inactive')
				{
					window._audioRecorder.stop();
				}

				if (window._audioObserver)
					window._audioObserver.disconnect();

				if (window._audioIntervalId)
					clearInterval(window._audioIntervalId);

				if (window._audioCtx)
					window._audioCtx.close().catch(() => {});
			});

			// Wait for blob.
			await this._page.waitForFunction(
				() => window._audioBlobReady !== undefined,
				{ timeout: 5000 }
			).catch(() => {});

			// Download audio blob.
			const hasAudio = await this._page.evaluate(
				() => !!window._audioBlobReady);

			if (hasAudio)
			{
				const base64 = await this._page.evaluate(async () =>
				{
					const blob = window._audioBlobReady;
					const buf = await blob.arrayBuffer();
					const u8 = new Uint8Array(buf);
					let bin = '';

					for (let i = 0; i < u8.length; i++)
						bin += String.fromCharCode(u8[i]);

					return btoa(bin);
				});

				const buffer = Buffer.from(base64, 'base64');

				fs.writeFileSync(this._audioPath, buffer);

				logger.info('Audio saved [size:%dKB]',
					Math.round(buffer.length / 1024));
			}
			else
			{
				logger.warn('No audio captured');
			}
		}
		catch (e)
		{
			logger.warn('Audio stop failed: %o', e);
		}
	}

	// -------------------------------------------------------------------------
	// Final mux: video + audio → MP4
	// -------------------------------------------------------------------------

	async _muxFinal()
	{
		const startDate = new Date(this._startTime);
		const utcTag = _utcTag(startDate);
		const outputFile = path.join(
			this._roomDir,
			`Room-${this._roomId}_${utcTag}_UTC.mp4`);

		const hasVideo = fs.existsSync(this._videoPath) &&
			fs.statSync(this._videoPath).size > 0;
		const hasAudio = fs.existsSync(this._audioPath) &&
			fs.statSync(this._audioPath).size > 0;

		if (!hasVideo)
		{
			logger.error('No video file — cannot produce output');

			return null;
		}

		if (!hasAudio)
		{
			// Video only — just copy/remux.
			logger.info('Muxing video-only → %s', outputFile);

			fs.copyFileSync(this._videoPath, outputFile);

			return outputFile;
		}

		// Mux video + audio.
		logger.info('Muxing video + audio → %s', outputFile);

		return new Promise((resolve, reject) =>
		{
			const args = [
				'-i', this._videoPath,
				'-i', this._audioPath,
				'-c:v', 'copy',
				'-c:a', 'aac', '-b:a', '128k',
				'-shortest',
				'-movflags', '+faststart',
				'-y', outputFile,
			];

			const proc = spawn(FFMPEG_PATH, args,
				{ stdio: ['ignore', 'pipe', 'pipe'] });

			let stderr = '';

			proc.stderr.on('data', (d) =>
			{
				stderr += d.toString();

				if (stderr.length > 8000) stderr = stderr.slice(-4000);

				const match = d.toString().match(/time=(\S+)/);

				if (match)
					logger.info('  Mux progress: time=%s', match[1]);
			});

			proc.on('error', reject);

			proc.on('exit', (code) =>
			{
				if (code === 0)
				{
					const stat = fs.statSync(outputFile);

					logger.info(
						'========================================');
					logger.info(
						'  RECORDING COMPLETE');
					logger.info(
						'  Room: %s', this._roomId);
					logger.info(
						'  Frames: %d', this._frameCount);
					logger.info(
						'  Size: %sMB',
						(stat.size / (1024 * 1024)).toFixed(1));
					logger.info(
						'  Output: %s', outputFile);
					logger.info(
						'========================================');

					resolve(outputFile);
				}
				else
				{
					logger.error('Mux failed [code:%d]\n%s',
						code, stderr.slice(-500));
					reject(new Error(`Mux FFmpeg exited with code ${code}`));
				}
			});
		});
	}

	// -------------------------------------------------------------------------
	// Cleanup
	// -------------------------------------------------------------------------

	async _closeBrowser()
	{
		try
		{
			if (this._cdpClient)
			{
				await this._cdpClient.detach().catch(() => {});
				this._cdpClient = null;
			}

			if (this._page)
			{
				await this._page.close().catch(() => {});
				this._page = null;
			}

			if (this._browser)
			{
				await this._browser.close().catch(() => {});
				this._browser = null;
			}
		}
		catch (e)
		{
			// ignore
		}
	}
}

module.exports = RecorderBot;
