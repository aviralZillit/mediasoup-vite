/**
 * PostRecordingComposer - Composes individual stream recordings into a final video
 * This runs AFTER the recording stops, similar to Zoom/Google Meet.
 * 
 * Flow:
 * 1. Individual WebM streams recorded by GStreamer
 * 2. FFmpeg composes them locally into a single video (fast mode)
 * 3. (Optional) Upload to S3 and trigger MediaConvert for high-quality encoding
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('PostRecordingComposer');

// Lazy load AWS services
let S3UploadService = null;
let MediaConvertService = null;

class PostRecordingComposer
{
	constructor(options)
	{
		this._roomId = options.roomId;
		this._outputDir = options.outputDir || './recordings';
		this._streams = []; // Array of stream metadata
		this._recordingStartTime = options.recordingStartTime;
		this._recordingEndTime = null;
		// Use 'fast' for quicker encoding with H.264, 'quality' for VP9 (default)
		this._encodingMode = options.encodingMode || 'quality';
		// Use 'static' for reliable composition, 'dynamic' for timeline-based transitions
		this._layoutMode = options.layoutMode || 'static';

		// AWS integration options
		this._s3Bucket = options.s3Bucket || process.env.AWS_S3_BUCKET;
		this._awsRegion = options.awsRegion || process.env.AWS_REGION || 'us-east-1';
		this._mediaConvertRoleArn = options.mediaConvertRoleArn || process.env.MEDIACONVERT_ROLE_ARN;
		this._awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
		this._awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

		// Check if AWS is properly configured
		this._awsConfigured = this._checkAwsConfiguration();
		
		// Only use MediaConvert if explicitly enabled AND AWS is configured
		this._useMediaConvert = (options.useMediaConvert || process.env.USE_MEDIACONVERT === 'true') 
			&& this._awsConfigured;

		// Services (lazy initialized)
		this._s3Service = null;
		this._mediaConvertService = null;

		// Log configuration status
		this._logConfigurationStatus();
	}

	/**
	 * Check if AWS is properly configured
	 * @private
	 */
	_checkAwsConfiguration()
	{
		// Need at least S3 bucket and credentials (or IAM role)
		const hasS3Bucket = Boolean(this._s3Bucket) && this._s3Bucket.length > 0;
		const hasCredentials = (
			(Boolean(this._awsAccessKeyId) && this._awsAccessKeyId.length > 0) ||
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || // ECS
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE // EKS/IRSA
		);
		const hasMediaConvertRole = Boolean(this._mediaConvertRoleArn) && this._mediaConvertRoleArn.length > 0;

		return hasS3Bucket && (hasCredentials || hasMediaConvertRole);
	}

	/**
	 * Log configuration status
	 * @private
	 */
	_logConfigurationStatus()
	{
		if (this._awsConfigured)
		{
			logger.info('✅ AWS S3 configured - recordings will be uploaded to cloud');
			logger.info(`   Bucket: ${this._s3Bucket}`);
			logger.info(`   Region: ${this._awsRegion}`);
			if (this._useMediaConvert)
			{
				logger.info('   MediaConvert: ENABLED (fast local compose → cloud transcoding)');
			}
		}
		else
		{
			logger.info('⚠️  AWS S3 not configured - recordings will be saved locally only');
			if (!this._s3Bucket)
			{
				logger.info('   Missing: AWS_S3_BUCKET');
			}
			if (!this._awsAccessKeyId && !process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)
			{
				logger.info('   Missing: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or IAM role)');
			}
			logger.info('   Recordings will use high-quality local encoding');
		}
	}

	/**
	 * Check if AWS is configured (for external use)
	 */
	isAwsConfigured()
	{
		return this._awsConfigured;
	}

	addStream(metadata)
	{
		this._streams.push(metadata);
		logger.info(`Added stream to composer: ${metadata.peerName} (${metadata.kind}, isShare:${metadata.isScreenShare})`);
	}

	getStreams()
	{
		return this._streams;
	}

	async compose()
	{
		this._recordingEndTime = Date.now();

		logger.info(`\n${ '='.repeat(60)}`);
		logger.info('🎬 POST-RECORDING COMPOSITION STARTED');
		logger.info('='.repeat(60));
		logger.info(`Room: ${this._roomId}`);
		logger.info(`Total streams: ${this._streams.length}`);
		logger.info(`AWS configured: ${this._awsConfigured}`);
		logger.info(`MediaConvert enabled: ${this._useMediaConvert}`);
		logger.info(`Storage mode: ${this._awsConfigured ? 'Cloud (S3)' : 'Local only'}`);

		// Minimum file size thresholds (WebM headers are ~300-500 bytes)
		// Files smaller than these are likely empty/corrupted
		const MIN_VIDEO_SIZE = 1000; // 1KB minimum for video
		const MIN_AUDIO_SIZE = 1000; // 1KB minimum for audio

		// Separate video and audio streams, filtering out empty/corrupted files
		const videoStreams = this._streams.filter((s) => s.kind === 'video' && s.fileSize >= MIN_VIDEO_SIZE);
		const audioStreams = this._streams.filter((s) => s.kind === 'audio' && s.fileSize >= MIN_AUDIO_SIZE);

		// Log any skipped streams
		const skippedVideo = this._streams.filter((s) => s.kind === 'video' && s.fileSize < MIN_VIDEO_SIZE);
		const skippedAudio = this._streams.filter((s) => s.kind === 'audio' && s.fileSize < MIN_AUDIO_SIZE);

		if (skippedVideo.length > 0)
		{
			logger.warn(`Skipping ${skippedVideo.length} empty/corrupted video file(s): ${skippedVideo.map((s) => `${s.peerName}(${s.fileSize}b)`).join(', ')}`);
		}
		if (skippedAudio.length > 0)
		{
			logger.warn(`Skipping ${skippedAudio.length} empty/corrupted audio file(s) (muted mics?): ${skippedAudio.map((s) => `${s.peerName}(${s.fileSize}b)`).join(', ')}`);
		}

		logger.info(`Video streams: ${videoStreams.length}`);
		logger.info(`Audio streams: ${audioStreams.length}`);

		if (videoStreams.length === 0)
		{
			logger.error('No valid video streams to compose');

			return null;
		}

		// SYNC FIX: For same participant, use the same start time for audio/video
		// This ensures their audio and video are perfectly synced
		this._alignAudioVideoByPeer(videoStreams, audioStreams);

		// Log each stream
		videoStreams.forEach((s, i) =>
		{
			const duration = s.duration ? s.duration.toFixed(1) : '0';

			logger.info(`  Video ${i + 1}: ${s.peerName} (${s.isScreenShare ? 'SCREEN' : 'webcam'}) - ${(s.fileSize / 1024).toFixed(1)} KB, ${duration}s, start: ${s.startTime}`);
		});
		audioStreams.forEach((s, i) =>
		{
			const duration = s.duration ? s.duration.toFixed(1) : '0';

			logger.info(`  Audio ${i + 1}: ${s.peerName} - ${(s.fileSize / 1024).toFixed(1)} KB, ${duration}s, start: ${s.startTime}`);
		});

		try
		{
			// Step 1: Local FFmpeg composition
			const localOutputPath = await this._composeWithFFmpeg(videoStreams, audioStreams);

			logger.info('='.repeat(60));
			logger.info(`✅ LOCAL COMPOSITION COMPLETE: ${localOutputPath}`);

			// Step 2: If MediaConvert is enabled, upload and trigger high-quality encoding
			if (this._useMediaConvert && this._s3Bucket)
			{
				try
				{
					const result = await this._uploadAndTranscode(localOutputPath);

					logger.info(`✅ MEDIACONVERT JOB SUBMITTED: ${result.jobId}`);
					logger.info(`   Output will be at: ${result.outputUri}`);
					logger.info(`${'='.repeat(60) }\n`);

					return {
						localPath             : localOutputPath,
						s3Uri                 : result.s3Uri,
						mediaConvertJobId     : result.jobId,
						mediaConvertOutputUri : result.outputUri,
						status                : 'processing' // MediaConvert is async
					};
				}
				catch (awsError)
				{
					logger.error(`MediaConvert failed, but local file is available: ${awsError.message}`);

					return {
						localPath : localOutputPath,
						status    : 'local-only',
						error     : awsError.message
					};
				}
			}

			logger.info(`${'='.repeat(60) }\n`);

			return {
				localPath : localOutputPath,
				status    : 'complete'
			};
		}
		catch (error)
		{
			logger.error(`Composition failed: ${error.message}`);

			return null;
		}
	}

	/**
	 * Upload composed video to S3 and submit MediaConvert job
	 * @private
	 */
	async _uploadAndTranscode(localPath)
	{
		logger.info(`\n${'='.repeat(60)}`);
		logger.info('☁️  UPLOADING TO S3 & TRIGGERING MEDIACONVERT');
		logger.info('='.repeat(60));

		// Lazy load S3 service
		if (!this._s3Service)
		{
			if (!S3UploadService)
			{
				S3UploadService = require('./S3UploadService');
			}
			// Use room-specific prefix: recordings/{roomId}/raw/
			this._s3Service = new S3UploadService({
				bucket : this._s3Bucket,
				region : this._awsRegion,
				prefix : `recordings/${this._roomId}/raw/`
			});
		}

		// Upload to S3
		const uploadResult = await this._s3Service.uploadFile(localPath);

		logger.info(`Uploaded to S3: ${uploadResult.s3Url}`);

		// Lazy load MediaConvert service
		if (!this._mediaConvertService)
		{
			if (!MediaConvertService)
			{
				MediaConvertService = require('./MediaConvertService');
			}
			// Use room-specific output prefix: recordings/{roomId}/encoded/
			this._mediaConvertService = new MediaConvertService({
				region       : this._awsRegion,
				roleArn      : this._mediaConvertRoleArn,
				outputBucket : this._s3Bucket,
				outputPrefix : `recordings/${this._roomId}/encoded/`
			});
		}

		// Submit MediaConvert job
		const timestamp = Date.now();
		const outputKey = `composed-${timestamp}`;

		const jobResult = await this._mediaConvertService.submitJob({
			inputS3Uri : uploadResult.s3Url,
			outputKey  : outputKey,
			jobName    : `mediasoup-${this._roomId}`
		});

		return {
			s3Uri     : uploadResult.s3Url,
			s3Key     : uploadResult.key,
			jobId     : jobResult.jobId,
			outputUri : jobResult.outputUri
		};
	}

	/**
	 * Get MediaConvert job status (for polling from client)
	 */
	async getMediaConvertJobStatus(jobId)
	{
		if (!this._mediaConvertService)
		{
			if (!MediaConvertService)
			{
				MediaConvertService = require('./MediaConvertService');
			}
			this._mediaConvertService = new MediaConvertService({
				region  : this._awsRegion,
				roleArn : this._mediaConvertRoleArn
			});
		}

		return this._mediaConvertService.getJobStatus(jobId);
	}

	async _composeWithFFmpeg(videoStreams, audioStreams)
	{
		const timestamp = Date.now();
		const outputPath = path.join(this._outputDir, `recording-${this._roomId}-${timestamp}-final.webm`);

		// Check for screen share
		const screenShare = videoStreams.find((s) => s.isScreenShare);
		const webcams = videoStreams.filter((s) => !s.isScreenShare);

		logger.info(`Layout: ${screenShare ? 'Screen share + webcams' : 'Webcams only'}`);
		logger.info(`Webcams: ${webcams.length}, Screen share: ${screenShare ? 'Yes' : 'No'}`);

		// Build FFmpeg command
		const ffmpegArgs = this._buildFFmpegCommand(videoStreams, audioStreams, screenShare, webcams, outputPath);

		logger.info(`FFmpeg command: ffmpeg ${ffmpegArgs.join(' ')}`);

		return new Promise((resolve, reject) =>
		{
			const ffmpeg = spawn('ffmpeg', ffmpegArgs);
			let ffmpegOutput = '';

			ffmpeg.stderr.on('data', (data) =>
			{
				ffmpegOutput += data.toString();
				const progressMatch = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);

				if (progressMatch)
				{
					logger.info(`  Composing progress: ${progressMatch[1]}`);
				}
			});

			ffmpeg.on('close', (code) =>
			{
				if (code === 0)
				{
				// Keep individual stream files in raw folder (don't clean up)
					logger.info('Individual stream files preserved in raw folder');
					resolve(outputPath);
				}
				else
				{
					logger.error(`FFmpeg failed with code ${code}`);
					logger.error(`FFmpeg output: ${ffmpegOutput}`);
					reject(new Error(`FFmpeg failed with code ${code}`));
				}
			});			ffmpeg.on('error', (error) =>
			{
				reject(error);
			});
		});
	}

	_buildFFmpegCommand(videoStreams, audioStreams, screenShare, webcams, outputPath)
	{
		const args = [];

		// Use recording start time as THE reference point for sync
		const allStreams = [ ...videoStreams, ...audioStreams ];
		const recordingStart = this._recordingStartTime || Math.min(...allStreams.map((s) => s.startTime || 0));
		const recordingEnd = this._recordingEndTime || Date.now();
		const totalRecordingDuration = (recordingEnd - recordingStart) / 1000; // in seconds

		logger.info(`Recording start time: ${recordingStart}`);
		logger.info(`Recording end time: ${recordingEnd}`);
		logger.info(`Total recording duration: ${totalRecordingDuration.toFixed(2)}s`);

		// Calculate delays for each stream relative to recording start
		videoStreams.forEach((stream, i) =>
		{
			const streamStart = stream.startTime || recordingStart;
			const rawDelay = streamStart - recordingStart;

			stream.delayMs = Math.max(0, rawDelay);
			const streamDuration = stream.duration || 0;

			logger.info(`  Video ${i} (${stream.peerName}, ${stream.isScreenShare ? 'SCREEN' : 'webcam'}): delay=${(stream.delayMs / 1000).toFixed(2)}s, duration=${streamDuration.toFixed(2)}s`);
		});

		audioStreams.forEach((stream, i) =>
		{
			const streamStart = stream.startTime || recordingStart;
			const rawDelay = streamStart - recordingStart;

			stream.delayMs = Math.max(0, rawDelay);
			const streamDuration = stream.duration || 0;

			logger.info(`  Audio ${i} (${stream.peerName}): delay=${(stream.delayMs / 1000).toFixed(2)}s, duration=${streamDuration.toFixed(2)}s`);
		});

		logger.info(`Video streams: ${videoStreams.length}, Audio streams: ${audioStreams.length}`);

		// Global options
		args.push('-y'); // Overwrite output

		// Add video inputs (NO -itsoffset, timing handled in filter with tpad)
		videoStreams.forEach((stream) =>
		{
			args.push('-i', stream.outputPath);
		});

		// Add audio inputs (NO -itsoffset, timing handled in filter with adelay)
		const hasAudio = audioStreams.length > 0;

		audioStreams.forEach((stream) =>
		{
			args.push('-i', stream.outputPath);
		});

		// Build filter complex with proper layout (uses tpad/adelay for timing)
		const filterComplex = this._buildFilterComplexOptimized(
			videoStreams, audioStreams, screenShare, totalRecordingDuration
		);

		args.push('-filter_complex', filterComplex);
		
		// Set output duration to match total recording
		args.push('-t', totalRecordingDuration.toFixed(3));

		// Map outputs
		args.push('-map', '[outv]');

		if (hasAudio)
		{
			args.push('-map', '[outa]');
		}

		// Choose encoding based on mode
		// If MediaConvert is enabled, use ultrafast WebM (composition only, let cloud do encoding)
		if (this._useMediaConvert)
		{
			// ULTRAFAST mode: Use VP8 (much faster than VP9!) for quick composition
			// MediaConvert will re-encode to high-quality H.264
			logger.info('Using ULTRAFAST WebM mode (VP8 - MediaConvert will handle quality encoding)');
			args.push(
				'-c:v', 'libvpx',
				'-pix_fmt', 'yuv420p', // Force no alpha channel
				'-auto-alt-ref', '0', // Disable auto_alt_ref (causes transparency issues)
				'-quality', 'realtime',
				'-cpu-used', '16',
				'-deadline', 'realtime',
				'-crf', '30',
				'-b:v', '2M',
				'-threads', '4',
				'-error-resilient', '1'
			);

			if (hasAudio)
			{
				args.push(
					'-c:a', 'libopus',
					'-b:a', '128k'
				);
			}

			args.push(outputPath);

			return args;
		}
		else if (this._encodingMode === 'fast')
		{
			// FAST mode: Use VP8 for quick WebM encoding
			logger.info('Using FAST encoding mode (VP8 WebM)');
			args.push(
				'-c:v', 'libvpx',
				'-pix_fmt', 'yuv420p',
				'-auto-alt-ref', '0',
				'-quality', 'good',
				'-cpu-used', '8',
				'-deadline', 'good',
				'-crf', '23',
				'-b:v', '3M',
				'-maxrate', '4M',
				'-bufsize', '6M',
				'-threads', '4'
			);

			if (hasAudio)
			{
				args.push(
					'-c:a', 'libopus',
					'-b:a', '192k'
				);
			}

			args.push(outputPath);

			return args;
		}
		else
		{
			// QUALITY mode: Use VP9 for best quality (slower but smaller files)
			logger.info('Using QUALITY encoding mode (VP9 - slower but better compression)');
			args.push(
				'-c:v', 'libvpx-vp9',
				'-b:v', '4M',
				'-minrate', '2M',
				'-maxrate', '6M',
				'-crf', '28',
				'-deadline', 'good',
				'-cpu-used', '4', // Balanced speed/quality
				'-row-mt', '1',
				'-threads', '8',
				'-tile-columns', '2',
				'-frame-parallel', '1'
			);

			if (hasAudio)
			{
				args.push(
					'-c:a', 'libopus',
					'-b:a', '192k' // Higher audio bitrate
				);
			}

			args.push(outputPath);

			return args;
		}
	}

	/**
	 * Build optimized filter complex with proper layouts and name labels.
	 * Uses tpad for timing (adds black frames at start for delayed streams).
	 * Dynamically switches between grid layout (no screen) and screen+webcams layout.
	 */
	_buildFilterComplexOptimized(videoStreams, audioStreams, screenShare, totalDuration)
	{
		// Use dynamic layout system with timeline-based transitions
		return this._buildDynamicLayoutWithTransitions(videoStreams, audioStreams, screenShare, totalDuration);
	}

	/**
	 * Build a SIMPLIFIED filter complex that's much faster.
	 * Uses -itsoffset for timing instead of tpad (which is slow).
	 * Creates a black background and overlays videos on top.
	 * 
	 * IMPORTANT: Uses fps,scale with eval=frame to handle dynamic resolution changes
	 * that can occur in WebRTC streams (e.g., webcam switching from 640x360 to 1280x720).
	 */
	_buildSimplifiedFilterComplex(videoStreams, audioStreams, screenShare, totalDuration)
	{
		const outputWidth = 1920;
		const outputHeight = 1080;

		let filter = '';

		// Create a black background for the full duration
		filter += `color=c=black:s=${outputWidth}x${outputHeight}:d=${totalDuration}:r=30[bg];`;

		// Separate screen share and webcams
		const webcamStreams = videoStreams.filter((s) => !s.isScreenShare);
		const screenStream = videoStreams.find((s) => s.isScreenShare);

		if (screenStream && webcamStreams.length > 0)
		{
			// SCREEN SHARE LAYOUT: Screen on left (70%), webcams stacked on right (30%)
			const screenWidth = Math.floor(outputWidth * 0.7);
			const webcamWidth = outputWidth - screenWidth;
			const webcamHeight = Math.floor(outputHeight / Math.min(webcamStreams.length, 4));
			const screenIdx = videoStreams.indexOf(screenStream);

			// Scale screen share - fps filter normalizes frame rate, scale with eval=frame handles resolution changes
			filter += `[${screenIdx}:v]fps=30,format=yuv420p,` +
				`scale=${screenWidth}:${outputHeight}:force_original_aspect_ratio=decrease:eval=frame,` +
				`pad=${screenWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[screen];`;

			// Scale webcams - fps filter normalizes frame rate, scale with eval=frame handles resolution changes
			webcamStreams.slice(0, 4).forEach((wc, i) =>
			{
				const wcIdx = videoStreams.indexOf(wc);

				filter += `[${wcIdx}:v]fps=30,format=yuv420p,` +
					`scale=${webcamWidth}:${webcamHeight}:force_original_aspect_ratio=decrease:eval=frame,` +
					`pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[wc${i}];`;
			});

			// Overlay screen on background (left side)
			filter += '[bg][screen]overlay=0:0:eof_action=pass[tmp0];';

			// Stack and overlay webcams on right side
			const numWebcams = Math.min(webcamStreams.length, 4);

			for (let i = 0; i < numWebcams; i++)
			{
				const yPos = i * webcamHeight;
				const prevTmp = i === 0 ? 'tmp0' : `tmp${i}`;
				const nextTmp = i === numWebcams - 1 ? 'outv' : `tmp${i + 1}`;

				filter += `[${prevTmp}][wc${i}]overlay=${screenWidth}:${yPos}:` +
					`eof_action=pass[${nextTmp}];`;
			}
		}
		else if (webcamStreams.length > 0)
		{
			// GRID LAYOUT: No screen share, arrange webcams in grid
			const count = Math.min(webcamStreams.length, 9);
			let cols, rows;

			if (count === 1) { cols = 1; rows = 1; }
			else if (count === 2) { cols = 2; rows = 1; }
			else if (count <= 4) { cols = 2; rows = 2; }
			else if (count <= 6) { cols = 3; rows = 2; }
			else { cols = 3; rows = 3; }

			const cellWidth = Math.floor(outputWidth / cols);
			const cellHeight = Math.floor(outputHeight / rows);

			// Scale all webcams - fps filter normalizes frame rate, scale with eval=frame handles resolution changes
			webcamStreams.slice(0, count).forEach((wc, i) =>
			{
				const wcIdx = videoStreams.indexOf(wc);

				filter += `[${wcIdx}:v]fps=30,format=yuv420p,` +
					`scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease:eval=frame,` +
					`pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
			});

			// Overlay each webcam on background
			let prevOutput = 'bg';

			for (let i = 0; i < count; i++)
			{
				const col = i % cols;
				const row = Math.floor(i / cols);
				const x = col * cellWidth;
				const y = row * cellHeight;
				const nextOutput = i === count - 1 ? 'outv' : `ovl${i}`;

				filter += `[${prevOutput}][v${i}]overlay=${x}:${y}:` +
					`eof_action=pass[${nextOutput}];`;
				prevOutput = nextOutput;
			}
		}
		else if (screenStream)
		{
			// Only screen share, no webcams - fps filter normalizes, scale with eval=frame handles resolution changes
			const screenIdx = videoStreams.indexOf(screenStream);

			filter += `[${screenIdx}:v]fps=30,format=yuv420p,` +
				`scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease:eval=frame,` +
				`pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,` +
				'setsar=1[scaled];';
			filter += '[bg][scaled]overlay=0:0:eof_action=pass[outv];';
		}
		else
		{
			// No video at all - just output background
			filter += '[bg]null[outv];';
		}

		// Audio mixing - NO adelay needed since we use -itsoffset for timing!
		// Using adelay here would DOUBLE the delay and cause sync issues
		if (audioStreams.length > 0)
		{
			const audioOffset = videoStreams.length;

			// Just pass through audio (timing handled by -itsoffset on input)
			audioStreams.forEach((stream, i) =>
			{
				filter += `[${audioOffset + i}:a]anull[a${i}];`;
			});

			// Mix all audio streams
			if (audioStreams.length === 1)
			{
				filter += '[a0]anull[outa]';
			}
			else
			{
				let audioInputs = '';

				for (let i = 0; i < audioStreams.length; i++)
				{
					audioInputs += `[a${i}]`;
				}
				filter += `${audioInputs}amix=inputs=${audioStreams.length}:` +
					'duration=longest:normalize=0[outa]';
			}
		}

		return filter;
	}

	/**
	 * Build filter complex with proper format conversion and sync delays for each input.
	 * CRITICAL: Maps original input indices to sequential output indices [vin0], [vin1], etc.
	 * This ensures layout functions receive properly numbered inputs.
	 * @param {number} totalDuration - Total recording duration in seconds
	 */
	_buildFilterComplexWithFormat(videoStreams, audioStreams, screenShare, webcams, totalDuration)
	{
		const outputWidth = 1920;
		const outputHeight = 1080;

		let filter = '';

		// Determine which video streams will actually be used in the layout
		// Screen share layout: 1 screen + max 4 webcams = 5 videos max
		// Grid layout: max 9 videos
		let usedVideoStreams = [];
		let usedVideoInputIndices = []; // Original FFmpeg input indices

		if (screenShare)
		{
			// Screen share layout - include screen share + up to 4 webcams
			const screenShareIndex = videoStreams.findIndex((s) => s.isScreenShare);

			usedVideoStreams.push(videoStreams[screenShareIndex]);
			usedVideoInputIndices.push(screenShareIndex);

			// Add webcams (up to 4)
			const webcamStreams = videoStreams.filter((s) => !s.isScreenShare).slice(0, 4);

			webcamStreams.forEach((wc) =>
			{
				const originalIndex = videoStreams.indexOf(wc);

				usedVideoStreams.push(wc);
				usedVideoInputIndices.push(originalIndex);
			});

			logger.info(`Screen share layout: using ${usedVideoStreams.length} streams (1 screen + ${webcamStreams.length} webcams)`);
		}
		else
		{
			// Grid layout - use all videos (up to 9)
			usedVideoStreams = videoStreams.slice(0, 9);
			usedVideoInputIndices = usedVideoStreams.map((s, i) => i);
		}

		// Step 1: Normalize video inputs with padding at START and END
		// This ensures ALL streams have the same duration as the total recording
		usedVideoInputIndices.forEach((inputIndex, outputIndex) =>
		{
			const stream = videoStreams[inputIndex];
			const startDelayMs = stream.delayMs || 0;
			const endPaddingSec = stream.endPadding || 0;
			
			let filterChain = `[${inputIndex}:v]setpts=PTS-STARTPTS,format=yuv420p`;
			
			// Add padding at START if stream started after recording began
			if (startDelayMs > 100)
			{
				const startDelaySec = (startDelayMs / 1000).toFixed(3);

				filterChain += `,tpad=start_duration=${startDelaySec}:start_mode=clone`;
			}
			
			// Add padding at END if stream ended before recording stopped
			// This ensures all streams have the same total length
			if (endPaddingSec > 0.5)
			{
				filterChain += `,tpad=stop_duration=${endPaddingSec.toFixed(3)}:stop_mode=clone`;
			}
			
			filter += `${filterChain}[vin${outputIndex}];`;
		});

		// Build video layout filter using SEQUENTIAL normalized inputs [vin0], [vin1], etc.
		// Pass the usedVideoStreams array which is in the same order as [vin0], [vin1]...
		const videoFilter = this._buildVideoLayoutFilterSequential(
			usedVideoStreams, screenShare, outputWidth, outputHeight
		);

		filter += videoFilter;

		// Step 2: Build audio mix filter with delays for sync
		if (audioStreams.length > 0)
		{
			const audioInputOffset = videoStreams.length;

			audioStreams.forEach((stream, i) =>
			{
				const delayMs = stream.delayMs || 0;
				const endPaddingSec = stream.endPadding || 0;
				
				let audioFilterChain = `[${audioInputOffset + i}:a]asetpts=PTS-STARTPTS`;

				// Add delay at start
				if (delayMs > 100)
				{
					audioFilterChain += `,adelay=${Math.round(delayMs)}:all=1`;
				}
				
				// Add padding at end (silence) if audio ended early
				if (endPaddingSec > 0.5)
				{
					audioFilterChain += `,apad=pad_dur=${endPaddingSec.toFixed(3)}`;
				}
				
				filter += `${audioFilterChain}[ain${i}];`;
			});

			if (audioStreams.length === 1)
			{
				filter += '[ain0]anull[outa]';
			}
			else
			{
				let audioMixInputs = '';

				audioStreams.forEach((stream, i) =>
				{
					audioMixInputs += `[ain${i}]`;
				});
				filter += `${audioMixInputs}amix=inputs=${audioStreams.length}:` +
					'duration=longest:dropout_transition=0:normalize=0[outa]';
			}
		}

		return filter;
	}

	/**
	 * Build video layout filter using SEQUENTIAL inputs [vin0], [vin1], etc.
	 * usedVideoStreams is ordered to match: [vin0] = usedVideoStreams[0], [vin1] = usedVideoStreams[1], etc.
	 */
	_buildVideoLayoutFilterSequential(usedVideoStreams, screenShare, outputWidth, outputHeight)
	{
		if (screenShare && usedVideoStreams.length > 1)
		{
			// First stream is screen share, rest are webcams
			return this._buildScreenShareLayoutFilterSequential(usedVideoStreams, outputWidth, outputHeight);
		}
		else if (usedVideoStreams.length === 1)
		{
			const name = this._escapeFFmpegText(usedVideoStreams[0].peerName || 'Unknown');

			return `[vin0]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
				`pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${name}':fontsize=36:fontcolor=white:` +
				'borderw=2:bordercolor=black:x=20:y=h-60[outv];';
		}
		else
		{
			return this._buildGridLayoutFilterSequential(usedVideoStreams, outputWidth, outputHeight);
		}
	}

	/**
	 * Build screen share layout with sequential inputs
	 * [vin0] = screen share, [vin1], [vin2], etc. = webcams
	 */
	_buildScreenShareLayoutFilterSequential(usedVideoStreams, outputWidth, outputHeight)
	{
		const screenWidth = Math.floor(outputWidth * 0.7);
		const webcamWidth = outputWidth - screenWidth;
		const webcamCount = usedVideoStreams.length - 1; // First is screen share
		const webcamHeight = Math.floor(outputHeight / Math.max(webcamCount, 1));

		let filter = '';

		// Screen share is [vin0]
		const screenShareName = this._escapeFFmpegText(
			usedVideoStreams[0].peerName ? `${usedVideoStreams[0].peerName}'s screen` : 'Screen Share'
		);

		// Add screen with better name styling (larger font, semi-transparent background box)
		filter += `[vin0]scale=${screenWidth}:${outputHeight}:` +
			'force_original_aspect_ratio=decrease,' +
			`pad=${screenWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${screenShareName}':fontsize=40:fontcolor=white:` +
			'box=1:boxcolor=black@0.7:boxborderw=10:' +
			'x=30:y=h-th-30[screen];';

		// Webcams are [vin1], [vin2], etc.
		for (let i = 1; i < usedVideoStreams.length; i++)
		{
			const wcName = this._escapeFFmpegText(usedVideoStreams[i].peerName || 'Unknown');
			const fontSize = webcamCount <= 2 ? 24 : 18;
			const wcIndex = i - 1; // wc0, wc1, etc.

			// Better webcam name styling with semi-transparent background
			filter += `[vin${i}]scale=${webcamWidth}:${webcamHeight}:` +
				'force_original_aspect_ratio=decrease,' +
				`pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${wcName}':fontsize=${fontSize}:fontcolor=white:` +
				'box=1:boxcolor=black@0.7:boxborderw=8:' +
				`x=15:y=h-th-15[wc${wcIndex}];`;
		}

		// Stack webcams vertically (shortest=0 uses longest stream)
		if (webcamCount === 1)
		{
			filter += `[wc0]pad=${webcamWidth}:${outputHeight}:0:(oh-ih)/2[webcams];`;
		}
		else if (webcamCount === 2)
		{
			filter += '[wc0][wc1]vstack=inputs=2:shortest=0[webcams];';
		}
		else if (webcamCount === 3)
		{
			filter += '[wc0][wc1][wc2]vstack=inputs=3:shortest=0[webcams];';
		}
		else if (webcamCount >= 4)
		{
			filter += '[wc0][wc1][wc2][wc3]vstack=inputs=4:shortest=0[webcams];';
		}

		// Combine screen share and webcams (shortest=0 uses longest stream)
		filter += '[screen][webcams]hstack=inputs=2:shortest=0[outv];';

		return filter;
	}

	/**
	 * Build grid layout with sequential inputs [vin0], [vin1], etc.
	 */
	_buildGridLayoutFilterSequential(usedVideoStreams, outputWidth, outputHeight)
	{
		const count = usedVideoStreams.length;
		let cols, rows;

		if (count <= 2) { cols = 2; rows = 1; }
		else if (count <= 4) { cols = 2; rows = 2; }
		else if (count <= 6) { cols = 3; rows = 2; }
		else { cols = 3; rows = 3; }

		const cellWidth = Math.floor(outputWidth / cols);
		const cellHeight = Math.floor(outputHeight / rows);

		let filter = '';

		// Scale each video - inputs are sequential [vin0], [vin1], etc.
		usedVideoStreams.forEach((stream, i) =>
		{
			const name = this._escapeFFmpegText(stream.peerName || 'Unknown');
			const fontSize = cols >= 3 ? 22 : 32;

			// Better grid name styling with semi-transparent background
			filter += `[vin${i}]scale=${cellWidth}:${cellHeight}:` +
				'force_original_aspect_ratio=decrease,' +
				`pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${name}':fontsize=${fontSize}:fontcolor=white:` +
				'box=1:boxcolor=black@0.7:boxborderw=8:' +
				`x=15:y=h-th-15[v${i}];`;
		});

		// Build grid based on count (shortest=0 ensures longest stream is used)
		if (count === 1)
		{
			filter += '[v0]null[outv];';
		}
		else if (count === 2)
		{
			filter += '[v0][v1]hstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 3)
		{
			filter += '[v0][v1]hstack=inputs=2:shortest=0[row0];';
			filter += `[v2]pad=${cellWidth * 2}:${cellHeight}:(ow-iw)/2:0[row1];`;
			filter += '[row0][row1]vstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 4)
		{
			filter += '[v0][v1]hstack=inputs=2:shortest=0[row0];';
			filter += '[v2][v3]hstack=inputs=2:shortest=0[row1];';
			filter += '[row0][row1]vstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 5)
		{
			filter += '[v0][v1][v2]hstack=inputs=3:shortest=0[row0];';
			filter += '[v3][v4]hstack=inputs=2:shortest=0[row1p];';
			filter += `[row1p]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row1];`;
			filter += '[row0][row1]vstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 6)
		{
			filter += '[v0][v1][v2]hstack=inputs=3:shortest=0[row0];';
			filter += '[v3][v4][v5]hstack=inputs=3:shortest=0[row1];';
			filter += '[row0][row1]vstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 7)
		{
			filter += '[v0][v1][v2]hstack=inputs=3:shortest=0[row0];';
			filter += '[v3][v4][v5]hstack=inputs=3:shortest=0[row1];';
			filter += `[v6]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row2];`;
			filter += '[row0][row1]vstack=inputs=2:shortest=0[rows01];';
			filter += '[rows01][row2]vstack=inputs=2:shortest=0[outv];';
		}
		else if (count === 8)
		{
			filter += '[v0][v1][v2]hstack=inputs=3:shortest=0[row0];';
			filter += '[v3][v4][v5]hstack=inputs=3:shortest=0[row1];';
			filter += '[v6][v7]hstack=inputs=2:shortest=0[row2p];';
			filter += `[row2p]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row2];`;
			filter += '[row0][row1]vstack=inputs=2:shortest=0[rows01];';
			filter += '[rows01][row2]vstack=inputs=2:shortest=0[outv];';
		}
		else // 9+
		{
		// Dynamic grid for 9-25 participants
			const fullRows = Math.floor(count / cols);
			const remainder = count % cols;
		
			// Create full rows
			for (let row = 0; row < fullRows; row++)
			{
				const rowInputs = [];

				for (let col = 0; col < cols; col++)
				{
					const idx = row * cols + col;

					rowInputs.push(`[v${idx}]`);
				}
				filter += `${rowInputs.join('')}hstack=inputs=${cols}:shortest=0[row${row}];`;
			}
		
			// Handle incomplete last row if there's a remainder
			if (remainder > 0)
			{
				const lastRowInputs = [];

				for (let col = 0; col < remainder; col++)
				{
					const idx = fullRows * cols + col;

					lastRowInputs.push(`[v${idx}]`);
				}
			
				if (remainder === 1)
				{
					filter += `${lastRowInputs[0]}pad=${cellWidth * cols}:${cellHeight}:(ow-iw)/2:0[row${fullRows}];`;
				}
				else
				{
					filter += `${lastRowInputs.join('')}hstack=inputs=${remainder}:shortest=0[row${fullRows}p];`;
					filter += `[row${fullRows}p]pad=${cellWidth * cols}:${cellHeight}:(ow-iw)/2:0[row${fullRows}];`;
				}
			}
		
			// Stack all rows vertically
			const totalRows = fullRows + (remainder > 0 ? 1 : 0);
			const rowInputs = [];

			for (let i = 0; i < totalRows; i++)
			{
				rowInputs.push(`[row${i}]`);
			}
			filter += `${rowInputs.join('')}vstack=inputs=${totalRows}:shortest=0[outv];`;
		}

		return filter;
	}	/**
	 * Build transition layout: starts with grid (50/50), transitions to screen share (70/30)
	 * Uses xfade filter to create smooth transition when screen sharing starts
	 */
	_buildTransitionLayout(usedVideoStreams, outputWidth, outputHeight, screenDelayMs)
	{
		const transitionDuration = 1; // 1 second crossfade
		const transitionOffset = (screenDelayMs / 1000) - (transitionDuration / 2); // Center transition on screen start
		
		const screenStream = usedVideoStreams[0]; // Screen share is first
		const webcamStreams = usedVideoStreams.slice(1); // Webcams
		
		let filter = '';
		
		// ============= PHASE 1: Grid Layout (before screen share) =============
		// Create 50/50 split of webcams for the period before screen sharing
		
		const gridCols = 2;
		const gridRows = 1;
		const gridCellWidth = Math.floor(outputWidth / gridCols);
		const gridCellHeight = outputHeight;
		
		// Scale webcams for grid layout (50/50)
		webcamStreams.forEach((stream, i) => 
		{
			const vinIndex = i + 1; // vin1, vin2 (vin0 is screen)
			const wcName = this._escapeFFmpegText(stream.peerName || 'Unknown');
			
			filter += `[vin${vinIndex}]scale=${gridCellWidth}:${gridCellHeight}:` +
				'force_original_aspect_ratio=decrease,' +
				`pad=${gridCellWidth}:${gridCellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${wcName}':fontsize=32:fontcolor=white:` +
				'box=1:boxcolor=black@0.7:boxborderw=10:' +
				`x=30:y=h-th-30[grid_wc${i}];`;
		});
		
		// Stack webcams horizontally for grid
		if (webcamStreams.length === 1) 
		{
			filter += `[grid_wc0]pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2[grid_layout];`;
		}
		else if (webcamStreams.length === 2) 
		{
			filter += '[grid_wc0][grid_wc1]hstack=inputs=2:shortest=0[grid_layout];';
		}
		else 
		{
			// More than 2 webcams - use 2x2 grid
			const grid2x2CellWidth = Math.floor(outputWidth / 2);
			const grid2x2CellHeight = Math.floor(outputHeight / 2);
			
			// Re-scale for 2x2 grid
			webcamStreams.slice(0, 4).forEach((stream, i) => 
			{
				const vinIndex = i + 1;

				filter += `[vin${vinIndex}]scale=${grid2x2CellWidth}:${grid2x2CellHeight}:` +
					'force_original_aspect_ratio=decrease,' +
					`pad=${grid2x2CellWidth}:${grid2x2CellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[grid2x2_wc${i}];`;
			});
			
			if (webcamStreams.length === 3) 
			{
				filter += '[grid2x2_wc0][grid2x2_wc1]hstack=inputs=2:shortest=0[grid_row0];';
				filter += `[grid2x2_wc2]pad=${outputWidth}:${grid2x2CellHeight}:(ow-iw)/2:0[grid_row1];`;
				filter += '[grid_row0][grid_row1]vstack=inputs=2:shortest=0[grid_layout];';
			}
			else 
			{ // 4 webcams
				filter += '[grid2x2_wc0][grid2x2_wc1]hstack=inputs=2:shortest=0[grid_row0];';
				filter += '[grid2x2_wc2][grid2x2_wc3]hstack=inputs=2:shortest=0[grid_row1];';
				filter += '[grid_row0][grid_row1]vstack=inputs=2:shortest=0[grid_layout];';
			}
		}
		
		// ============= PHASE 2: Screen Share Layout (70/30) =============
		
		const screenWidth = Math.floor(outputWidth * 0.7);
		const webcamWidth = outputWidth - screenWidth;
		const webcamHeight = Math.floor(outputHeight / Math.max(webcamStreams.length, 1));
		
		// Screen share scaling
		const screenShareName = this._escapeFFmpegText(
			screenStream.peerName ? `${screenStream.peerName}'s screen` : 'Screen Share'
		);
		
		filter += `[vin0]scale=${screenWidth}:${outputHeight}:` +
			'force_original_aspect_ratio=decrease,' +
			`pad=${screenWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${screenShareName}':fontsize=40:fontcolor=white:` +
			'box=1:boxcolor=black@0.7:boxborderw=10:' +
			'x=30:y=h-th-30[screen_share_scaled];';
		
		// Webcams for screen layout (30% width)
		webcamStreams.forEach((stream, i) => 
		{
			const vinIndex = i + 1;
			const wcName = this._escapeFFmpegText(stream.peerName || 'Unknown');
			const fontSize = webcamStreams.length <= 2 ? 24 : 18;
			
			filter += `[vin${vinIndex}]scale=${webcamWidth}:${webcamHeight}:` +
				'force_original_aspect_ratio=decrease,' +
				`pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${wcName}':fontsize=${fontSize}:fontcolor=white:` +
				'box=1:boxcolor=black@0.7:boxborderw=8:' +
				`x=15:y=h-th-15[screen_wc${i}];`;
		});
		
		// Stack webcams vertically for screen layout
		if (webcamStreams.length === 1) 
		{
			filter += `[screen_wc0]pad=${webcamWidth}:${outputHeight}:0:(oh-ih)/2[screen_webcams];`;
		}
		else if (webcamStreams.length === 2) 
		{
			filter += '[screen_wc0][screen_wc1]vstack=inputs=2:shortest=0[screen_webcams];';
		}
		else if (webcamStreams.length === 3) 
		{
			filter += '[screen_wc0][screen_wc1][screen_wc2]vstack=inputs=3:shortest=0[screen_webcams];';
		}
		else 
		{
			filter += '[screen_wc0][screen_wc1][screen_wc2][screen_wc3]vstack=inputs=4:shortest=0[screen_webcams];';
		}
		
		// Combine screen and webcams for screen layout
		filter += '[screen_share_scaled][screen_webcams]hstack=inputs=2:shortest=0[screen_layout];';
		
		// ============= PHASE 3: Transition with xfade =============
		
		filter += `[grid_layout][screen_layout]xfade=transition=fade:duration=${transitionDuration}:offset=${transitionOffset.toFixed(3)}[outv];`;
		
		return filter;
	}

	/**
	 * Align audio and video streams from the same peer to use consistent start times.
	 * This ensures audio/video sync for each participant's webcam.
	 * Screen shares are NOT aligned - they keep their own start time.
	 */
	_alignAudioVideoByPeer(videoStreams, audioStreams)
	{
		// Group WEBCAM video streams by peerId (NOT screen shares)
		const peerWebcamStartTimes = new Map();

		// First pass: find the earliest WEBCAM video start time for each peer
		videoStreams.forEach((stream) =>
		{
			const peerId = stream.peerId;

			// Skip screen shares - they have their own timing
			if (!peerId || stream.isScreenShare) return;

			const existing = peerWebcamStartTimes.get(peerId);

			if (!existing || stream.startTime < existing)
			{
				peerWebcamStartTimes.set(peerId, stream.startTime);
			}
		});

		// Also consider audio streams for the earliest time
		audioStreams.forEach((stream) =>
		{
			const peerId = stream.peerId;

			if (!peerId) return;

			const existing = peerWebcamStartTimes.get(peerId);

			if (!existing || stream.startTime < existing)
			{
				peerWebcamStartTimes.set(peerId, stream.startTime);
			}
		});

		// Second pass: align webcam videos and audio to use earliest start time
		// DO NOT align screen shares
		videoStreams.forEach((stream) =>
		{
			const peerId = stream.peerId;

			// Skip screen shares - they stay at their own time
			if (!peerId || stream.isScreenShare) return;

			const alignedTime = peerWebcamStartTimes.get(peerId);

			if (alignedTime && stream.startTime !== alignedTime)
			{
				logger.info(`  Aligning webcam for ${stream.peerName}: ${stream.startTime} -> ${alignedTime}`);
				stream.startTime = alignedTime;
			}
		});

		audioStreams.forEach((stream) =>
		{
			const peerId = stream.peerId;

			if (!peerId) return;

			const alignedTime = peerWebcamStartTimes.get(peerId);

			if (alignedTime && stream.startTime !== alignedTime)
			{
				logger.info(`  Aligning audio for ${stream.peerName}: ${stream.startTime} -> ${alignedTime}`);
				stream.startTime = alignedTime;
			}
		});
	}

	/**
	 * Escape special characters for FFmpeg drawtext filter
	 */
	_escapeFFmpegText(text)
	{
		if (!text) return 'Unknown';

		return text
			.replace(/\\/g, '\\\\\\\\')
			.replace(/'/g, "'\\''")
			.replace(/:/g, '\\:')
			.replace(/\[/g, '\\[')
			.replace(/\]/g, '\\]');
	}

	/**
	 * Build dynamic layout with transitions based on participant join/leave and screen share
	 */
	_buildDynamicLayoutWithTransitions(videoStreams, audioStreams, screenShare, totalDuration)
	{
		const outputWidth = 1920;
		const outputHeight = 1080;

		// Build timeline of layout changes
		const timeline = this._buildLayoutTimeline(videoStreams, totalDuration);
		
		logger.info('Layout timeline:');
		for (const segment of timeline)
		{
			logger.info(`  ${segment.startTime.toFixed(1)}s - ${segment.endTime.toFixed(1)}s: ${segment.layout} (${segment.participants.length} people)`);
		}
		
		let filter = '';
		
		// Normalize all video inputs first
		videoStreams.forEach((stream, i) =>
		{
			const delayMs = stream.delayMs || 0;
			
			filter += `[${i}:v]fps=30,format=yuv420p,setsar=1`;
			
			if (delayMs > 100)
			{
				const delaySec = (delayMs / 1000).toFixed(3);

				filter += `,tpad=start_duration=${delaySec}:start_mode=add:color=black`;
			}
			
			filter += `[vin${i}];`;
		});
		
		if (timeline.length === 1)
		{
			// Single layout for entire video
			const segment = timeline[0];

			filter += this._buildSegmentLayout(segment, videoStreams, outputWidth, outputHeight, 'outv');
		}
		else
		{
			// Multiple segments with transitions
			filter += this._buildTransitionedLayout(timeline, videoStreams, outputWidth, outputHeight);
		}
		
		// Build audio mix
		if (audioStreams.length > 0)
		{
			const audioOffset = videoStreams.length;
			
			audioStreams.forEach((stream, i) =>
			{
				const delayMs = stream.delayMs || 0;
				
				if (delayMs > 100)
				{
					filter += `[${audioOffset + i}:a]adelay=${Math.round(delayMs)}:all=1[a${i}];`;
				}
				else
				{
					filter += `[${audioOffset + i}:a]anull[a${i}];`;
				}
			});
			
			if (audioStreams.length === 1)
			{
				filter += '[a0]anull[outa]';
			}
			else
			{
				let audioInputs = '';

				for (let i = 0; i < audioStreams.length; i++)
				{
					audioInputs += `[a${i}]`;
				}
				filter += `${audioInputs}amix=inputs=${audioStreams.length}:duration=longest:normalize=0[outa]`;
			}
		}
		
		return filter;
	}

	/**
	 * Build timeline of layout changes
	 */
	_buildLayoutTimeline(videoStreams, totalDuration)
	{
		const events = [];
		
		// Add video stream start events
		for (const stream of videoStreams)
		{
			const startTime = (stream.delayMs || 0) / 1000;
			
			events.push({
				time   : startTime,
				type   : 'video_start',
				stream : stream
			});
		}
		
		// Sort events by time
		events.sort((a, b) => a.time - b.time);
		
		// Build timeline segments
		const segments = [];
		let currentTime = 0;
		const activeStreams = [];
		
		for (let i = 0; i < events.length; i++)
		{
			const event = events[i];
			const nextEvent = events[i + 1];
			const segmentEnd = nextEvent ? nextEvent.time : totalDuration;
			
			// Add stream to active list
			if (event.type === 'video_start')
			{
				activeStreams.push(event.stream);
			}
			
			// Determine layout type
			const hasScreenShare = activeStreams.some((s) => s.isScreenShare);
			const webcams = activeStreams.filter((s) => !s.isScreenShare);
			
			let layout;

			if (hasScreenShare)
			{
				layout = 'screen_share';
			}
			else if (webcams.length === 1)
			{
				layout = 'single';
			}
			else if (webcams.length === 2)
			{
				layout = 'grid_2';
			}
			else if (webcams.length <= 4)
			{
				layout = 'grid_4';
			}
			else if (webcams.length <= 9)
			{
				layout = 'grid_9';
			}
			else
			{
				layout = 'grid_large';
			}
			
			segments.push({
				startTime    : currentTime,
				endTime      : segmentEnd,
				duration     : segmentEnd - currentTime,
				layout       : layout,
				participants : [ ...activeStreams ],
				webcams      : webcams,
				screenShare  : hasScreenShare ? activeStreams.find((s) => s.isScreenShare) : null
			});
			
			currentTime = segmentEnd;
		}
		
		return segments;
	}

	/**
	 * Build layout for a single segment
	 */
	_buildSegmentLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, useExtendedInputs = false)
	{
		// Add suffix to input references if using extended inputs
		const inputSuffix = useExtendedInputs ? '_extended' : '';

		if (segment.layout === 'screen_share')
		{
			return this._buildScreenShareLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix);
		}
		else if (segment.layout === 'single')
		{
			return this._buildSingleLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix);
		}
		else
		{
			return this._buildGridLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix);
		}
	}

	/**
	 * Build screen share layout (70/30)
	 */
	_buildScreenShareLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix = '')
	{
		const screenWidth = Math.floor(outputWidth * 0.7);
		const webcamWidth = outputWidth - screenWidth;
		const webcams = segment.webcams.slice(0, 4);
		const webcamHeight = Math.floor(outputHeight / Math.max(webcams.length, 1));
		
		let filter = '';
		
		// Screen share
		const screenStream = segment.screenShare;
		const screenIdx = videoStreams.indexOf(screenStream);
		const screenName = this._escapeFFmpegText(
			screenStream.peerName ? `${screenStream.peerName}'s screen` : 'Screen Share'
		);
		
		filter += `[vin${screenIdx}${inputSuffix}]scale=${screenWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
			`pad=${screenWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${screenName}':fontsize=40:fontcolor=white:` +
			'box=1:boxcolor=black@0.7:boxborderw=10:x=30:y=h-th-30[screen];';
		
		// Webcams
		for (let i = 0; i < webcams.length; i++)
		{
			const webcam = webcams[i];
			const wcIdx = videoStreams.indexOf(webcam);
			const wcName = this._escapeFFmpegText(webcam.peerName || 'Unknown');
			const fontSize = webcams.length <= 2 ? 24 : 18;
			
			filter += `[vin${wcIdx}${inputSuffix}]scale=${webcamWidth}:${webcamHeight}:force_original_aspect_ratio=decrease,` +
				`pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${wcName}':fontsize=${fontSize}:fontcolor=white:` +
				`box=1:boxcolor=black@0.7:boxborderw=8:x=15:y=h-th-15[wc${i}];`;
		}
		
		// Stack webcams
		if (webcams.length === 1)
		{
			filter += `[wc0]pad=${webcamWidth}:${outputHeight}:0:(oh-ih)/2[webcams];`;
		}
		else if (webcams.length === 2)
		{
			filter += '[wc0][wc1]vstack=inputs=2:shortest=0[webcams];';
		}
		else if (webcams.length === 3)
		{
			filter += '[wc0][wc1][wc2]vstack=inputs=3:shortest=0[webcams];';
		}
		else
		{
			filter += '[wc0][wc1][wc2][wc3]vstack=inputs=4:shortest=0[webcams];';
		}
		
		filter += `[screen][webcams]hstack=inputs=2:shortest=0[${outputLabel}];`;
		
		return filter;
	}

	/**
	 * Build single video layout
	 */
	_buildSingleLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix = '')
	{
		const video = segment.webcams[0];
		const videoIdx = videoStreams.indexOf(video);
		const name = this._escapeFFmpegText(video.peerName || 'Unknown');
		
		return `[vin${videoIdx}${inputSuffix}]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
			`pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${name}':fontsize=44:fontcolor=white:` +
			`box=1:boxcolor=black@0.7:boxborderw=10:x=30:y=h-th-30[${outputLabel}];`;
	}

	/**
	 * Build grid layout
	 */
	_buildGridLayout(segment, videoStreams, outputWidth, outputHeight, outputLabel, inputSuffix = '')
	{
		const webcams = segment.webcams;
		const count = Math.min(webcams.length, 25);
		
		// Determine grid dimensions
		let cols, rows;

		if (count <= 1) { cols = 1; rows = 1; }
		else if (count <= 2) { cols = 2; rows = 1; }
		else if (count <= 4) { cols = 2; rows = 2; }
		else if (count <= 6) { cols = 3; rows = 2; }
		else if (count <= 9) { cols = 3; rows = 3; }
		else if (count <= 12) { cols = 4; rows = 3; }
		else if (count <= 16) { cols = 4; rows = 4; }
		else if (count <= 20) { cols = 5; rows = 4; }
		else { cols = 5; rows = 5; }
		
		const cellWidth = Math.floor(outputWidth / cols);
		const cellHeight = Math.floor(outputHeight / rows);
		let fontSize;

		if (cols >= 5) fontSize = 16;
		else if (cols >= 4) fontSize = 18;
		else if (cols >= 3) fontSize = 22;
		else fontSize = 32;
		
		let filter = '';
		
		// Scale each video
		for (let i = 0; i < count; i++)
		{
			const stream = webcams[i];
			const streamIdx = videoStreams.indexOf(stream);
			const name = this._escapeFFmpegText(stream.peerName || 'Unknown');
			
			filter += `[vin${streamIdx}${inputSuffix}]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
				`pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
				`drawtext=text='${name}':fontsize=${fontSize}:fontcolor=white:` +
				`box=1:boxcolor=black@0.7:boxborderw=8:x=15:y=h-th-15[v${i}];`;
		}
		
		// Build grid
		if (count === 1)
		{
			filter += `[v0]null[${outputLabel}];`;
		}
		else
		{
			const fullRows = Math.floor(count / cols);
			const remainder = count % cols;
			
			// Create full rows
			for (let row = 0; row < fullRows; row++)
			{
				const rowInputs = [];

				for (let col = 0; col < cols; col++)
				{
					const idx = row * cols + col;

					rowInputs.push(`[v${idx}]`);
				}
				filter += `${rowInputs.join('')}hstack=inputs=${cols}:shortest=0[row${row}];`;
			}
			
			// Handle incomplete last row
			if (remainder > 0)
			{
				const lastRowInputs = [];

				for (let col = 0; col < remainder; col++)
				{
					const idx = fullRows * cols + col;

					lastRowInputs.push(`[v${idx}]`);
				}
				
				if (remainder === 1)
				{
					filter += `${lastRowInputs[0]}pad=${cellWidth * cols}:${cellHeight}:(ow-iw)/2:0[row${fullRows}];`;
				}
				else
				{
					filter += `${lastRowInputs.join('')}hstack=inputs=${remainder}:shortest=0[row${fullRows}p];`;
					filter += `[row${fullRows}p]pad=${cellWidth * cols}:${cellHeight}:(ow-iw)/2:0[row${fullRows}];`;
				}
			}
			
			// Stack rows
			const totalRows = fullRows + (remainder > 0 ? 1 : 0);

			if (totalRows === 1)
			{
				filter += `[row0]null[${outputLabel}];`;
			}
			else
			{
				const rowInputs = [];

				for (let i = 0; i < totalRows; i++)
				{
					rowInputs.push(`[row${i}]`);
				}
				filter += `${rowInputs.join('')}vstack=inputs=${totalRows}:shortest=0[${outputLabel}];`;
			}
		}
		
		return filter;
	}

	/**
	 * Build transitioned layout with fade between segments
	 * Uses simpler approach: build static grid with all available videos
	 */
	_buildTransitionedLayout(timeline, videoStreams, outputWidth, outputHeight)
	{
		// For now, use the last segment (all participants) for the entire duration
		// This avoids the complexity of extending/looping videos that started at different times
		// TODO: Implement proper segment transitions once we figure out video extension
		
		const lastSegment = timeline[timeline.length - 1];
		
		return this._buildSegmentLayout(lastSegment, videoStreams, outputWidth, outputHeight, 'outv', false);
	}

	_cleanupStreamFiles()
	{
		logger.info('Cleaning up individual stream files...');

		this._streams.forEach((stream) =>
		{
			try
			{
				if (fs.existsSync(stream.outputPath))
				{
					fs.unlinkSync(stream.outputPath);
					logger.info(`  Deleted: ${stream.outputPath}`);
				}
			}
			catch (error)
			{
				logger.warn(`  Could not delete ${stream.outputPath}: ${error.message}`);
			}
		});
	}
}

module.exports = PostRecordingComposer;
