const PostRecordingComposer = require('./lib/PostRecordingComposer.js');
const fs = require('fs');
const path = require('path');

// Find the latest recording session
const recordingsDir = './recordings/12322/raw';
const sessions = fs.readdirSync(recordingsDir);
const latestSession = sessions.sort().reverse()[0];
const rawDir = path.join(recordingsDir, latestSession);

console.log('Testing composition for session:', latestSession);
console.log('Raw directory:', rawDir);

// Read all stream files
const files = fs.readdirSync(rawDir).filter((f) => f.endsWith('.webm'));

console.log('Found files:', files);

// Create mock streams
const streams = files.map((file) => 
{
	const stats = fs.statSync(path.join(rawDir, file));
	const parts = file.split('-');
	const peerId = parts[1];
	const kind = file.includes('video') ? 'video' : 'audio';
	const isScreenShare = file.includes('screen');
	const timestamp = parseInt(parts[parts.length - 1].replace('.webm', ''));
	
	return {
		peerId,
		peerName   : peerId.substring(0, 8),
		kind,
		isScreenShare,
		outputPath : path.join(rawDir, file),
		fileSize   : stats.size,
		startTime  : timestamp,
		duration   : 10 // mock duration
	};
});

console.log('Streams:', JSON.stringify(streams, null, 2));

// Create composer
const composer = new PostRecordingComposer({
	roomId             : '12322',
	outputDir          : './recordings/12322',
	recordingStartTime : Math.min(...streams.map((s) => s.startTime))
});

// Add streams
streams.forEach((s) => composer.addStream(s));

// Try to compose
composer.compose()
	.then((result) => 
	{
		console.log('✅ Composition succeeded!');
		console.log('Result:', result);
	})
	.catch((error) => 
	{
		console.error('❌ Composition failed:');
		console.error(error);
		console.error('\nStack trace:');
		console.error(error.stack);
	});
