/**
 * AWS Lambda Video Composer
 * 
 * This Lambda function:
 * 1. Downloads individual WebM stream recordings from S3
 * 2. Uses FFmpeg to compose them into a grid/screen-share layout
 * 3. Uploads the composed MP4 back to S3
 * 
 * Requires: FFmpeg Lambda Layer (see README for setup)
 */

const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });

// Lambda /tmp has 512MB-10GB storage (configurable)
const TEMP_DIR = '/tmp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/opt/bin/ffmpeg';

exports.handler = async (event) => 
{
	console.log('Video Composer Lambda invoked');
	console.log('Event:', JSON.stringify(event, null, 2));

	const {
		bucket,
		roomId,
		streams, // Array of stream metadata
		outputKey, // S3 key for output file
		encodingMode = 'fast' // 'fast' or 'quality'
	} = event;

	if (!bucket || !roomId || !streams || !outputKey) 
	{
		throw new Error('Missing required parameters: bucket, roomId, streams, outputKey');
	}

	const tempFiles = [];
	const startTime = Date.now();

	try 
	{
		console.log(`Processing ${streams.length} streams for room ${roomId}`);

		// Step 1: Download all stream files from S3
		const downloadedStreams = await downloadStreams(bucket, streams, tempFiles);

		console.log(`Downloaded ${downloadedStreams.length} stream files`);

		// Step 2: Separate video and audio streams
		const videoStreams = downloadedStreams.filter((s) => s.kind === 'video' && s.localPath);
		const audioStreams = downloadedStreams.filter((s) => s.kind === 'audio' && s.localPath);

		console.log(`Video streams: ${videoStreams.length}, Audio streams: ${audioStreams.length}`);

		if (videoStreams.length === 0) 
		{
			throw new Error('No video streams to compose');
		}

		// Step 3: Build and run FFmpeg command
		const outputPath = path.join(TEMP_DIR, `output-${roomId}-${Date.now()}.mp4`);

		tempFiles.push(outputPath);

		await runFFmpegComposition(videoStreams, audioStreams, outputPath, encodingMode);
		console.log('FFmpeg composition complete');

		// Step 4: Upload composed video to S3
		const stats = fs.statSync(outputPath);

		console.log(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

		await uploadToS3(bucket, outputKey, outputPath);
		console.log(`Uploaded to s3://${bucket}/${outputKey}`);

		// Step 5: Optionally delete source files from S3
		if (event.deleteSourceFiles) 
		{
			await deleteSourceFiles(bucket, streams);
			console.log('Deleted source files from S3');
		}

		const duration = ((Date.now() - startTime) / 1000).toFixed(2);

		console.log(`Total processing time: ${duration}s`);

		return {
			statusCode : 200,
			body       : {
				success        : true,
				outputKey,
				outputUrl      : `s3://${bucket}/${outputKey}`,
				processingTime : duration,
				videoStreams   : videoStreams.length,
				audioStreams   : audioStreams.length
			}
		};
	}
	catch (error) 
	{
		console.error('Composition failed:', error);
		throw error;
	}
	finally 
	{
		// Cleanup temp files
		for (const file of tempFiles) 
		{
			try 
			{
				if (fs.existsSync(file)) 
				{
					fs.unlinkSync(file);
					console.log(`Cleaned up: ${file}`);
				}
			}
			catch (e) 
			{
				console.warn(`Failed to cleanup ${file}:`, e.message);
			}
		}
	}
};

/**
 * Download streams from S3 to local temp storage
 */
async function downloadStreams(bucket, streams, tempFiles) 
{
	const downloadPromises = streams.map(async (stream, index) => 
	{
		const localPath = path.join(TEMP_DIR, `stream-${index}-${stream.kind}.webm`);

		tempFiles.push(localPath);

		try 
		{
			const response = await s3Client.send(new GetObjectCommand({
				Bucket : bucket,
				Key    : stream.s3Key
			}));

			await pipeline(response.Body, fs.createWriteStream(localPath));

			const stats = fs.statSync(localPath);

			console.log(`Downloaded ${stream.s3Key}: ${(stats.size / 1024).toFixed(1)} KB`);

			return {
				...stream,
				localPath,
				fileSize : stats.size
			};
		}
		catch (error) 
		{
			console.error(`Failed to download ${stream.s3Key}:`, error.message);
			
			return { ...stream, localPath: null, error: error.message };
		}
	});

	return Promise.all(downloadPromises);
}

/**
 * Run FFmpeg composition
 */
async function runFFmpegComposition(videoStreams, audioStreams, outputPath, encodingMode) 
{
	return new Promise((resolve, reject) => 
	{
		const args = buildFFmpegArgs(videoStreams, audioStreams, outputPath, encodingMode);

		console.log(`FFmpeg command: ${FFMPEG_PATH} ${args.join(' ')}`);

		const ffmpeg = spawn(FFMPEG_PATH, args);
		let stderr = '';

		ffmpeg.stderr.on('data', (data) => 
		{
			stderr += data.toString();
			// Log progress
			const progressMatch = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/);

			if (progressMatch) 
			{
				console.log(`Progress: ${progressMatch[1]}`);
			}
		});

		ffmpeg.on('close', (code) => 
		{
			if (code === 0) 
			{
				resolve();
			}
			else 
			{
				console.error('FFmpeg stderr:', stderr);
				reject(new Error(`FFmpeg exited with code ${code}`));
			}
		});

		ffmpeg.on('error', (error) => 
		{
			reject(error);
		});
	});
}

/**
 * Build FFmpeg arguments for composition
 */
function buildFFmpegArgs(videoStreams, audioStreams, outputPath, encodingMode) 
{
	const args = [ '-y' ]; // Overwrite output

	// Calculate delays based on recording start time
	const allStreams = [ ...videoStreams, ...audioStreams ];
	const earliestStart = Math.min(...allStreams.map((s) => s.startTime || 0));

	videoStreams.forEach((s) => 
	{
		s.delayMs = Math.max(0, (s.startTime || 0) - earliestStart);
	});
	audioStreams.forEach((s) => 
	{
		s.delayMs = Math.max(0, (s.startTime || 0) - earliestStart);
	});

	// Add video inputs
	videoStreams.forEach((stream) => 
	{
		args.push('-i', stream.localPath);
	});

	// Add audio inputs
	audioStreams.forEach((stream) => 
	{
		args.push('-i', stream.localPath);
	});

	// Build filter complex
	const filterComplex = buildFilterComplex(videoStreams, audioStreams);

	args.push('-filter_complex', filterComplex);

	// Map outputs
	args.push('-map', '[outv]');
	if (audioStreams.length > 0) 
	{
		args.push('-map', '[outa]');
	}

	// Encoding settings
	if (encodingMode === 'fast') 
	{
		args.push(
			'-c:v', 'libx264',
			'-preset', 'fast',
			'-crf', '23',
			'-b:v', '3M',
			'-maxrate', '4M',
			'-bufsize', '6M',
			'-pix_fmt', 'yuv420p',
			'-movflags', '+faststart'
		);
		if (audioStreams.length > 0) 
		{
			args.push('-c:a', 'aac', '-b:a', '192k');
		}
	}
	else 
	{
		args.push(
			'-c:v', 'libx264',
			'-preset', 'medium',
			'-crf', '20',
			'-b:v', '5M',
			'-maxrate', '7M',
			'-bufsize', '10M',
			'-pix_fmt', 'yuv420p',
			'-movflags', '+faststart'
		);
		if (audioStreams.length > 0) 
		{
			args.push('-c:a', 'aac', '-b:a', '256k');
		}
	}

	args.push(outputPath);
	
	return args;
}

/**
 * Build FFmpeg filter_complex for grid/screen-share layout
 */
function buildFilterComplex(videoStreams, audioStreams) 
{
	const outputWidth = 1920;
	const outputHeight = 1080;

	let filter = '';

	// Check for screen share
	const screenShare = videoStreams.find((s) => s.isScreenShare);
	const webcams = videoStreams.filter((s) => !s.isScreenShare);

	// Determine which streams to use
	let usedVideoStreams = [];
	let usedVideoInputIndices = [];

	if (screenShare) 
	{
		const screenShareIndex = videoStreams.indexOf(screenShare);

		usedVideoStreams.push(screenShare);
		usedVideoInputIndices.push(screenShareIndex);

		// Add up to 4 webcams
		webcams.slice(0, 4).forEach((wc) => 
		{
			usedVideoStreams.push(wc);
			usedVideoInputIndices.push(videoStreams.indexOf(wc));
		});
	}
	else 
	{
		usedVideoStreams = videoStreams.slice(0, 9);
		usedVideoInputIndices = usedVideoStreams.map((_, i) => i);
	}

	// Normalize video inputs with delays - create sequential [vin0], [vin1], etc.
	usedVideoInputIndices.forEach((inputIndex, outputIndex) => 
	{
		const stream = videoStreams[inputIndex];
		const delayMs = stream.delayMs || 0;

		if (delayMs > 100) 
		{
			const delaySec = (delayMs / 1000).toFixed(3);

			filter += `[${inputIndex}:v]setpts=PTS-STARTPTS,format=yuv420p,` +
				`tpad=start_duration=${delaySec}:start_mode=clone[vin${outputIndex}];`;
		}
		else 
		{
			filter += `[${inputIndex}:v]setpts=PTS-STARTPTS,format=yuv420p[vin${outputIndex}];`;
		}
	});

	// Build layout
	if (screenShare && usedVideoStreams.length > 1) 
	{
		filter += buildScreenShareLayout(usedVideoStreams, outputWidth, outputHeight);
	}
	else if (usedVideoStreams.length === 1) 
	{
		const name = escapeFFmpegText(usedVideoStreams[0].peerName || 'Unknown');

		filter += `[vin0]scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
			`pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${name}':fontsize=36:fontcolor=white:` +
			'borderw=2:bordercolor=black:x=20:y=h-60[outv];';
	}
	else 
	{
		filter += buildGridLayout(usedVideoStreams, outputWidth, outputHeight);
	}

	// Audio mixing
	if (audioStreams.length > 0) 
	{
		const audioInputOffset = videoStreams.length;

		audioStreams.forEach((stream, i) => 
		{
			const delayMs = stream.delayMs || 0;

			if (delayMs > 100) 
			{
				filter += `[${audioInputOffset + i}:a]asetpts=PTS-STARTPTS,` +
					`adelay=${Math.round(delayMs)}:all=1[ain${i}];`;
			}
			else 
			{
				filter += `[${audioInputOffset + i}:a]asetpts=PTS-STARTPTS[ain${i}];`;
			}
		});

		if (audioStreams.length === 1) 
		{
			filter += '[ain0]anull[outa]';
		}
		else 
		{
			let audioMixInputs = '';

			audioStreams.forEach((_, i) => { audioMixInputs += `[ain${i}]`; });
			filter += `${audioMixInputs}amix=inputs=${audioStreams.length}:` +
				'duration=longest:dropout_transition=0:normalize=0[outa]';
		}
	}

	return filter;
}

/**
 * Build screen share layout
 */
function buildScreenShareLayout(usedVideoStreams, outputWidth, outputHeight) 
{
	const screenWidth = Math.floor(outputWidth * 0.7);
	const webcamWidth = outputWidth - screenWidth;
	const webcamCount = usedVideoStreams.length - 1;
	const webcamHeight = Math.floor(outputHeight / Math.max(webcamCount, 1));

	let filter = '';

	// Screen share [vin0]
	const screenName = escapeFFmpegText(
		usedVideoStreams[0].peerName ? `${usedVideoStreams[0].peerName}'s screen` : 'Screen Share'
	);

	filter += `[vin0]scale=${screenWidth}:${outputHeight}:force_original_aspect_ratio=decrease,` +
		`pad=${screenWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
		`drawtext=text='${screenName}':fontsize=28:fontcolor=white:` +
		'borderw=2:bordercolor=black:x=20:y=h-50[screen];';

	// Webcams [vin1], [vin2], etc.
	for (let i = 1; i < usedVideoStreams.length; i++) 
	{
		const wcName = escapeFFmpegText(usedVideoStreams[i].peerName || 'Unknown');
		const fontSize = webcamCount <= 2 ? 24 : 18;
		const wcIndex = i - 1;

		filter += `[vin${i}]scale=${webcamWidth}:${webcamHeight}:force_original_aspect_ratio=decrease,` +
			`pad=${webcamWidth}:${webcamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${wcName}':fontsize=${fontSize}:fontcolor=white:` +
			`borderw=2:bordercolor=black:x=10:y=h-40[wc${wcIndex}];`;
	}

	// Stack webcams
	if (webcamCount === 1) 
	{
		filter += `[wc0]pad=${webcamWidth}:${outputHeight}:0:(oh-ih)/2[webcams];`;
	}
	else if (webcamCount === 2) 
	{
		filter += '[wc0][wc1]vstack=inputs=2[webcams];';
	}
	else if (webcamCount === 3) 
	{
		filter += '[wc0][wc1][wc2]vstack=inputs=3[webcams];';
	}
	else 
	{
		filter += '[wc0][wc1][wc2][wc3]vstack=inputs=4[webcams];';
	}

	filter += '[screen][webcams]hstack=inputs=2[outv];';
	
	return filter;
}

/**
 * Build grid layout
 */
function buildGridLayout(usedVideoStreams, outputWidth, outputHeight) 
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

	// Scale each video
	usedVideoStreams.forEach((stream, i) => 
	{
		const name = escapeFFmpegText(stream.peerName || 'Unknown');
		const fontSize = cols >= 3 ? 20 : 28;

		filter += `[vin${i}]scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease,` +
			`pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
			`drawtext=text='${name}':fontsize=${fontSize}:fontcolor=white:` +
			`borderw=2:bordercolor=black:x=10:y=h-40[v${i}];`;
	});

	// Build grid
	if (count === 1) 
	{
		filter += '[v0]null[outv];';
	}
	else if (count === 2) 
	{
		filter += '[v0][v1]hstack=inputs=2[outv];';
	}
	else if (count === 3) 
	{
		filter += '[v0][v1]hstack=inputs=2[row0];';
		filter += `[v2]pad=${cellWidth * 2}:${cellHeight}:(ow-iw)/2:0[row1];`;
		filter += '[row0][row1]vstack=inputs=2[outv];';
	}
	else if (count === 4) 
	{
		filter += '[v0][v1]hstack=inputs=2[row0];';
		filter += '[v2][v3]hstack=inputs=2[row1];';
		filter += '[row0][row1]vstack=inputs=2[outv];';
	}
	else if (count === 5) 
	{
		filter += '[v0][v1][v2]hstack=inputs=3[row0];';
		filter += '[v3][v4]hstack=inputs=2[row1p];';
		filter += `[row1p]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row1];`;
		filter += '[row0][row1]vstack=inputs=2[outv];';
	}
	else if (count === 6) 
	{
		filter += '[v0][v1][v2]hstack=inputs=3[row0];';
		filter += '[v3][v4][v5]hstack=inputs=3[row1];';
		filter += '[row0][row1]vstack=inputs=2[outv];';
	}
	else if (count === 7) 
	{
		filter += '[v0][v1][v2]hstack=inputs=3[row0];';
		filter += '[v3][v4][v5]hstack=inputs=3[row1];';
		filter += `[v6]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row2];`;
		filter += '[row0][row1]vstack=inputs=2[rows01];';
		filter += '[rows01][row2]vstack=inputs=2[outv];';
	}
	else if (count === 8) 
	{
		filter += '[v0][v1][v2]hstack=inputs=3[row0];';
		filter += '[v3][v4][v5]hstack=inputs=3[row1];';
		filter += '[v6][v7]hstack=inputs=2[row2p];';
		filter += `[row2p]pad=${cellWidth * 3}:${cellHeight}:(ow-iw)/2:0[row2];`;
		filter += '[row0][row1]vstack=inputs=2[rows01];';
		filter += '[rows01][row2]vstack=inputs=2[outv];';
	}
	else 
	{
		filter += '[v0][v1][v2]hstack=inputs=3[row0];';
		filter += '[v3][v4][v5]hstack=inputs=3[row1];';
		filter += '[v6][v7][v8]hstack=inputs=3[row2];';
		filter += '[row0][row1]vstack=inputs=2[rows01];';
		filter += '[rows01][row2]vstack=inputs=2[outv];';
	}

	return filter;
}

/**
 * Escape text for FFmpeg drawtext filter
 */
function escapeFFmpegText(text) 
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
 * Upload file to S3
 */
async function uploadToS3(bucket, key, filePath) 
{
	const fileStream = fs.createReadStream(filePath);
	const stats = fs.statSync(filePath);

	await s3Client.send(new PutObjectCommand({
		Bucket        : bucket,
		Key           : key,
		Body          : fileStream,
		ContentLength : stats.size,
		ContentType   : 'video/mp4'
	}));
}

/**
 * Delete source files from S3
 */
async function deleteSourceFiles(bucket, streams) 
{
	const deletePromises = streams.map((stream) =>
		s3Client.send(new DeleteObjectCommand({
			Bucket : bucket,
			Key    : stream.s3Key
		})).catch((e) => console.warn(`Failed to delete ${stream.s3Key}:`, e.message))
	);

	await Promise.all(deletePromises);
}
