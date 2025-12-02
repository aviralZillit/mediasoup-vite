/* eslint-disable no-unused-vars */
/* eslint-disable max-len */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('VideoComposer');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './recordings';

/**
 * Composes multiple raw stream recordings into a single grid layout video.
 * This runs AFTER recording stops - not in real-time.
 */
class VideoComposer
{
	/**
	 * Compose multiple video/audio streams into a single video
	 * @param {Object} options
	 * @param {Array} options.videoStreams - Array of {path, peerName, isScreenShare}
	 * @param {Array} options.audioStreams - Array of {path, peerName}
	 * @param {String} options.outputPath - Final output path
	 * @param {Function} options.onProgress - Progress callback
	 * @param {Function} options.onComplete - Completion callback
	 */
	static async compose({ videoStreams, audioStreams, outputPath, onProgress, onComplete })
	{
		logger.info('compose() Starting composition [videos:%d, audios:%d, output:%s]',
			videoStreams.length, audioStreams.length, outputPath);

		// Filter out empty or missing files
		const validVideos = videoStreams.filter((v) =>
		{
			if (!fs.existsSync(v.path))
			{
				logger.warn('compose() Video file not found: %s', v.path);
				
				return false;
			}
			const stats = fs.statSync(v.path);

			if (stats.size < 1000)
			{
				logger.warn('compose() Video file too small: %s (%d bytes)', v.path, stats.size);
				
				return false;
			}
			
			return true;
		});

		const validAudios = audioStreams.filter((a) =>
		{
			if (!fs.existsSync(a.path))
			{
				logger.warn('compose() Audio file not found: %s', a.path);
				
				return false;
			}
			const stats = fs.statSync(a.path);

			if (stats.size < 100)
			{
				logger.warn('compose() Audio file too small: %s (%d bytes)', a.path, stats.size);
				
				return false;
			}
			
			return true;
		});

		logger.info('compose() Valid streams [videos:%d, audios:%d]',
			validVideos.length, validAudios.length);

		if (validVideos.length === 0)
		{
			logger.error('compose() No valid video streams to compose');
			if (onComplete) onComplete(new Error('No valid video streams'));
			
			return;
		}

		// Build FFmpeg command for grid composition
		const ffmpegArgs = VideoComposer._buildFFmpegArgs(validVideos, validAudios, outputPath);

		logger.info('compose() FFmpeg args: %s', ffmpegArgs.join(' '));

		const ffmpeg = spawn('ffmpeg', ffmpegArgs);

		let lastProgress = '';

		ffmpeg.stderr.on('data', (data) =>
		{
			const msg = data.toString();
			
			// Extract progress info
			const timeMatch = msg.match(/time=(\d+:\d+:\d+\.\d+)/);

			if (timeMatch && onProgress)
			{
				const currentProgress = timeMatch[1];

				if (currentProgress !== lastProgress)
				{
					lastProgress = currentProgress;
					onProgress({ time: currentProgress, status: 'encoding' });
				}
			}

			// Log errors
			if (msg.includes('Error') || msg.includes('error'))
			{
				logger.error('compose() FFmpeg: %s', msg.trim());
			}
		});

		ffmpeg.on('close', (code) =>
		{
			if (code === 0)
			{
				logger.info('compose() Composition complete: %s', outputPath);
				
				// Get file size
				const stats = fs.statSync(outputPath);

				logger.info('compose() Final size: %.2f MB', stats.size / (1024 * 1024));

				if (onComplete) onComplete(null, outputPath);
			}
			else
			{
				logger.error('compose() FFmpeg failed with code: %d', code);
				if (onComplete) onComplete(new Error(`FFmpeg exited with code ${code}`));
			}
		});

		ffmpeg.on('error', (error) =>
		{
			logger.error('compose() FFmpeg error: %o', error);
			if (onComplete) onComplete(error);
		});
	}

	/**
	 * Build FFmpeg arguments for grid composition
	 */
	static _buildFFmpegArgs(videos, audios, outputPath)
	{
		const args = [];

		// Input files
		videos.forEach((v) =>
		{
			args.push('-i', v.path);
		});

		audios.forEach((a) =>
		{
			args.push('-i', a.path);
		});

		// Calculate grid layout
		const { filterComplex, outputMap } = VideoComposer._buildFilterComplex(videos, audios);

		args.push('-filter_complex', filterComplex);

		// Output mapping
		args.push('-map', '[vout]');
		if (audios.length > 0)
		{
			args.push('-map', '[aout]');
		}

		// Output settings - use WebM for compatibility with existing setup
		// Optimized for SPEED - composition should be fast
		args.push(
			'-c:v', 'libvpx', // VP8 encoder
			'-b:v', '3M', // 3 Mbps video bitrate (slightly lower)
			'-crf', '20', // Quality (higher = faster, slightly lower quality)
			'-deadline', 'realtime', // Fastest encoding
			'-cpu-used', '8', // Maximum speed (0-8, higher = faster)
			'-threads', '4', // Use multiple threads
			'-c:a', 'libopus', // Opus audio
			'-b:a', '96k', // 96 kbps audio (good enough)
			'-y', // Overwrite output
			outputPath
		);

		return args;
	}

	/**
	 * Build FFmpeg filter_complex for grid layout
	 */
	static _buildFilterComplex(videos, audios)
	{
		const OUTPUT_WIDTH = 1920;
		const OUTPUT_HEIGHT = 1080;

		// Find screen share
		const screenShareIdx = videos.findIndex((v) => v.isScreenShare);
		const hasScreenShare = screenShareIdx !== -1;

		const filterParts = [];
		const overlayInputs = [];

		if (hasScreenShare && videos.length > 1)
		{
			// Screen share layout: screen share 70% on left, webcams stacked on right
			const screenWidth = Math.floor(OUTPUT_WIDTH * 0.7);
			const webcamWidth = OUTPUT_WIDTH - screenWidth;
			const webcamCount = videos.length - 1;
			const webcamHeight = Math.floor(OUTPUT_HEIGHT / webcamCount);

			// Scale screen share
			filterParts.push(`[${screenShareIdx}:v]scale=${screenWidth}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${screenWidth}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1[screen]`);

			// Scale webcams
			let webcamIdx = 0;

			for (let i = 0; i < videos.length; i++)
			{
				if (i !== screenShareIdx)
				{
					filterParts.push(`[${i}:v]scale=${webcamWidth}:${webcamHeight}:force_original_aspect_ratio=decrease,pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[webcam${webcamIdx}]`);
					webcamIdx++;
				}
			}

			// Stack webcams vertically
			if (webcamCount === 1)
			{
				filterParts.push(`[webcam0]pad=${webcamWidth}:${OUTPUT_HEIGHT}:0:(${OUTPUT_HEIGHT}-ih)/2[webcams]`);
			}
			else
			{
				const vstackInputs = [];

				for (let i = 0; i < webcamCount; i++)
				{
					vstackInputs.push(`[webcam${i}]`);
				}
				filterParts.push(`${vstackInputs.join('')}vstack=inputs=${webcamCount}[webcams]`);
			}

			// Combine screen share and webcams
			filterParts.push('[screen][webcams]hstack=inputs=2[vout]');
		}
		else
		{
			// Simple grid layout for webcams only
			const gridSize = Math.ceil(Math.sqrt(videos.length));
			const cellWidth = Math.floor(OUTPUT_WIDTH / gridSize);
			const cellHeight = Math.floor(OUTPUT_HEIGHT / gridSize);

			// Scale all inputs
			for (let i = 0; i < videos.length; i++)
			{
				filterParts.push(`[${i}:v]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`);
			}

			// Build grid using xstack
			if (videos.length === 1)
			{
				filterParts.push(`[v0]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}[vout]`);
			}
			else if (videos.length === 2)
			{
				filterParts.push('[v0][v1]hstack=inputs=2[vout]');
			}
			else if (videos.length <= 4)
			{
				// 2x2 grid
				const inputs = [];

				for (let i = 0; i < 4; i++)
				{
					inputs.push(i < videos.length ? `[v${i}]` : `color=black:s=${cellWidth}x${cellHeight}[pad${i}];[pad${i}]`);
				}
				filterParts.push('[v0][v1]hstack=inputs=2[row0]');
				if (videos.length > 2)
				{
					const v2 = videos.length > 2 ? '[v2]' : `color=black:s=${cellWidth}x${cellHeight}:d=1[pad2];[pad2]`;
					const v3 = videos.length > 3 ? '[v3]' : `color=black:s=${cellWidth}x${cellHeight}:d=1[pad3];[pad3]`;

					filterParts.push(`${v2}${v3}hstack=inputs=2[row1]`);
					filterParts.push('[row0][row1]vstack=inputs=2[vout]');
				}
				else
				{
					filterParts.push(`[row0]pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:0:0[vout]`);
				}
			}
			else
			{
				// Generic grid using xstack
				let layout = '';
				let xstackInputs = '';

				for (let i = 0; i < videos.length; i++)
				{
					const row = Math.floor(i / gridSize);
					const col = i % gridSize;

					xstackInputs += `[v${i}]`;
					layout += `${col * cellWidth}_${row * cellHeight}`;
					if (i < videos.length - 1) layout += '|';
				}
				filterParts.push(`${xstackInputs}xstack=inputs=${videos.length}:layout=${layout}[vout]`);
			}
		}

		// Mix all audio streams
		if (audios.length > 0)
		{
			const audioInputs = audios.map((_, i) => `[${videos.length + i}:a]`).join('');

			filterParts.push(`${audioInputs}amix=inputs=${audios.length}:duration=longest[aout]`);
		}

		return {
			filterComplex : filterParts.join(';'),
			outputMap     : '[vout]'
		};
	}

	/**
	 * Clean up raw stream files after composition
	 */
	static cleanupRawFiles(filePaths)
	{
		for (const filePath of filePaths)
		{
			try
			{
				if (fs.existsSync(filePath))
				{
					fs.unlinkSync(filePath);
					logger.info('cleanupRawFiles() Deleted: %s', filePath);
				}
			}
			catch (error)
			{
				logger.warn('cleanupRawFiles() Failed to delete: %s', filePath);
			}
		}
	}
}

module.exports = VideoComposer;
