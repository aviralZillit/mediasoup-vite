/**
 * S3Uploader — Upload recording MP4 to S3 and generate presigned URLs.
 *
 * S3 folder structure:
 *   s3://mediasoup-recordings/
 *   └── recordings/
 *       └── {roomId}/
 *           └── {YYYY-MM-DD}/
 *               └── Room-{roomId}_{YYYY-MM-DD}_{HH-mm-ss}_UTC.mp4
 *
 * After upload:
 *   - Returns presigned download URL (24h expiry)
 *   - Deletes local files (raw/ + MP4) to free disk
 */

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const Logger = require('./Logger');

const logger = new Logger('S3Uploader');

const MAX_RETRIES = 3;
const PRESIGNED_EXPIRY = 24 * 60 * 60; // 24 hours in seconds

// Read directly from process.env — config.js is gitignored and may
// not have the aws block on deployed servers.
// Read at module load time — dotenv should have already run in server.js.
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'mediasoup-recordings';

// Log for debugging credential issues.
const _keyId = process.env.AWS_ACCESS_KEY_ID;
const _secret = process.env.AWS_SECRET_ACCESS_KEY;

if (_keyId)
{
	logger.info('AWS credentials found [keyId:%s***]', _keyId.slice(0, 8));
}
else
{
	logger.warn('AWS_ACCESS_KEY_ID not set — S3 uploads will fail');
}

let _s3Client = null;

function _getS3Client()
{
	if (!_s3Client)
	{
		// Read credentials at call time (not module load time) to ensure
		// dotenv has had a chance to populate process.env.
		const keyId = process.env.AWS_ACCESS_KEY_ID;
		const secret = process.env.AWS_SECRET_ACCESS_KEY;
		const region = process.env.AWS_REGION || 'us-east-1';

		const clientConfig = { region };

		if (keyId && secret)
		{
			logger.info('Using explicit AWS credentials [keyId:%s***]',
				keyId.slice(0, 8));

			clientConfig.credentials = {
				accessKeyId     : keyId,
				secretAccessKey : secret,
			};
		}
		else
		{
			logger.warn('No explicit AWS credentials — relying on SDK default chain');
		}

		_s3Client = new S3Client(clientConfig);
	}

	return _s3Client;
}

/**
 * Upload a file to S3.
 *
 * @param {String} localPath  - Absolute path to the local file.
 * @param {String} roomId     - Room ID for the folder structure.
 * @returns {Object} { s3Key, presignedUrl }
 */
async function uploadRecording(localPath, roomId)
{
	const bucket = AWS_S3_BUCKET;

	if (!bucket)
		throw new Error('AWS_S3_BUCKET not configured');

	const fileName = path.basename(localPath);
	const stat = fs.statSync(localPath);

	// S3 key: recordings/{roomId}/{YYYY-MM-DD}/{filename}
	const date = new Date();
	const dateFolder = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
	const s3Key = `recordings/${roomId}/${dateFolder}/${fileName}`;

	logger.info(
		'Uploading [file:%s, size:%sMB, bucket:%s, key:%s]',
		fileName,
		(stat.size / (1024 * 1024)).toFixed(1),
		bucket,
		s3Key);

	const s3 = _getS3Client();
	const fileStream = fs.createReadStream(localPath);

	const command = new PutObjectCommand({
		Bucket      : bucket,
		Key         : s3Key,
		Body        : fileStream,
		ContentType : 'video/mp4',
		Metadata    : {
			roomId,
			uploadedAt : new Date().toISOString(),
		},
	});

	// Retry with exponential backoff.
	let lastError;

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++)
	{
		try
		{
			await s3.send(command);

			logger.info(
				'Upload complete [key:%s, attempt:%d]', s3Key, attempt);

			// Generate presigned URL.
			const presignedUrl = await getPresignedUrl(bucket, s3Key);

			return { s3Key, presignedUrl };
		}
		catch (error)
		{
			lastError = error;

			logger.warn(
				'Upload attempt %d failed: %s', attempt, error.message);

			if (attempt < MAX_RETRIES)
			{
				const delay = Math.pow(2, attempt) * 1000; // 2s, 4s

				await new Promise((resolve) => setTimeout(resolve, delay));

				// Re-create the file stream for retry (previous one was consumed).
				command.input.Body = fs.createReadStream(localPath);
			}
		}
	}

	throw lastError;
}

/**
 * Generate a presigned download URL for an S3 object.
 *
 * @param {String} bucket
 * @param {String} s3Key
 * @param {Number} [expiresIn=86400] - Seconds until URL expires.
 * @returns {String} Presigned URL.
 */
async function getPresignedUrl(bucket, s3Key, expiresIn)
{
	const s3 = _getS3Client();

	const command = new GetObjectCommand({
		Bucket : bucket,
		Key    : s3Key,
	});

	const url = await getSignedUrl(s3, command, {
		expiresIn : expiresIn || PRESIGNED_EXPIRY,
	});

	return url;
}

/**
 * Delete local recording files after successful S3 upload.
 *
 * @param {String} roomDir - Path to recordings/{roomId}/
 * @param {String} mp4Path - Path to the final MP4 file.
 */
function cleanupLocal(roomDir, mp4Path)
{
	try
	{
		// Delete the raw/ folder.
		const rawDir = path.join(roomDir, 'raw');

		if (fs.existsSync(rawDir))
		{
			fs.rmSync(rawDir, { recursive: true, force: true });
			logger.info('Deleted raw/ folder [path:%s]', rawDir);
		}

		// Delete the MP4.
		if (mp4Path && fs.existsSync(mp4Path))
		{
			fs.unlinkSync(mp4Path);
			logger.info('Deleted local MP4 [path:%s]', mp4Path);
		}

		// Try to remove the room directory if empty.
		try
		{
			const remaining = fs.readdirSync(roomDir)
				.filter((f) => f !== '.DS_Store');

			if (remaining.length === 0)
			{
				fs.rmSync(roomDir, { recursive: true, force: true });
				logger.info('Deleted empty room directory [path:%s]', roomDir);
			}
		}
		catch (e)
		{
			// ignore
		}
	}
	catch (error)
	{
		logger.warn('Cleanup failed: %o', error);
	}
}

module.exports = {
	uploadRecording,
	getPresignedUrl,
	cleanupLocal,
};
