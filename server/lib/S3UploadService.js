/**
 * S3UploadService - Uploads composed videos to AWS S3
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./Logger');

const logger = new Logger('S3UploadService');

// AWS SDK v3 - will be loaded dynamically
let S3Client, PutObjectCommand, GetObjectCommand;

class S3UploadService
{
	/**
	 * Static method to check if AWS S3 is configured
	 * @returns {{configured: boolean, reason: string, bucket: string|null}}
	 */
	static checkConfiguration()
	{
		const bucket = process.env.AWS_S3_BUCKET;
		const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
		const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
		const region = process.env.AWS_REGION;

		// Check for ECS/EKS IAM role credentials
		const hasIamRole = !!(
			process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || // ECS
			process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||            // EKS/IRSA
			process.env.AWS_EXECUTION_ENV                          // Lambda
		);

		if (!bucket)
		{
			return {
				configured : false,
				reason     : 'AWS_S3_BUCKET not set',
				bucket     : null
			};
		}

		if (!accessKeyId && !hasIamRole)
		{
			return {
				configured : false,
				reason     : 'No AWS credentials found (set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or use IAM role)',
				bucket     : bucket
			};
		}

		if (accessKeyId && !secretAccessKey)
		{
			return {
				configured : false,
				reason     : 'AWS_ACCESS_KEY_ID set but AWS_SECRET_ACCESS_KEY missing',
				bucket     : bucket
			};
		}

		return {
			configured : true,
			reason     : hasIamRole ? 'Using IAM role credentials' : 'Using environment credentials',
			bucket     : bucket,
			region     : region || 'us-east-1'
		};
	}

	constructor(options = {})
	{
		this._bucket = options.bucket || process.env.AWS_S3_BUCKET || 'mediasoup-recordings';
		this._region = options.region || process.env.AWS_REGION || 'us-east-1';
		this._prefix = options.prefix || 'recordings/';
		this._client = null;
		this._initialized = false;
	}

	async _ensureInitialized()
	{
		if (this._initialized) return;

		try
		{
			// Dynamically import AWS SDK v3
			const s3Module = await import('@aws-sdk/client-s3');

			S3Client = s3Module.S3Client;
			PutObjectCommand = s3Module.PutObjectCommand;
			GetObjectCommand = s3Module.GetObjectCommand;

			this._client = new S3Client({
				region : this._region
				// Credentials are automatically loaded from:
				// - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
				// - IAM role (if running on EC2/ECS/Lambda)
				// - AWS credentials file (~/.aws/credentials)
			});

			this._initialized = true;
			logger.info(`S3 client initialized for bucket: ${this._bucket}`);
		}
		catch (error)
		{
			logger.error(`Failed to initialize S3 client: ${error.message}`);
			throw new Error(`AWS SDK not available. Install with: npm install @aws-sdk/client-s3`);
		}
	}

	/**
	 * Upload a local file to S3
	 * @param {string} localPath - Path to local file
	 * @param {string} s3Key - S3 object key (optional, will generate from filename)
	 * @returns {Promise<{bucket: string, key: string, url: string}>}
	 */
	async uploadFile(localPath, s3Key = null)
	{
		await this._ensureInitialized();

		if (!fs.existsSync(localPath))
		{
			throw new Error(`File not found: ${localPath}`);
		}

		const filename = path.basename(localPath);
		const key = s3Key || `${this._prefix}${filename}`;
		const fileStream = fs.createReadStream(localPath);
		const stats = fs.statSync(localPath);

		// Determine content type
		const ext = path.extname(localPath).toLowerCase();
		const contentTypes = {
			'.mp4'  : 'video/mp4',
			'.webm' : 'video/webm',
			'.mkv'  : 'video/x-matroska',
			'.mov'  : 'video/quicktime',
			'.avi'  : 'video/x-msvideo'
		};
		const contentType = contentTypes[ext] || 'application/octet-stream';

		logger.info(`Uploading ${filename} to S3...`);
		logger.info(`  Bucket: ${this._bucket}`);
		logger.info(`  Key: ${key}`);
		logger.info(`  Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

		try
		{
			const command = new PutObjectCommand({
				Bucket      : this._bucket,
				Key         : key,
				Body        : fileStream,
				ContentType : contentType,
				Metadata    : {
					'uploaded-at' : new Date().toISOString(),
					'source'      : 'mediasoup-recorder'
				}
			});

			await this._client.send(command);

			const s3Url = `s3://${this._bucket}/${key}`;
			const httpsUrl = `https://${this._bucket}.s3.${this._region}.amazonaws.com/${key}`;

			logger.info(`✅ Upload complete: ${s3Url}`);

			return {
				bucket   : this._bucket,
				key      : key,
				s3Url    : s3Url,
				httpsUrl : httpsUrl,
				size     : stats.size
			};
		}
		catch (error)
		{
			logger.error(`Failed to upload to S3: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Generate a pre-signed URL for downloading (valid for 24 hours)
	 * @param {string} key - S3 object key
	 * @returns {Promise<string>} Pre-signed URL
	 */
	async getPresignedUrl(key)
	{
		await this._ensureInitialized();

		try
		{
			const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

			const command = new GetObjectCommand({
				Bucket : this._bucket,
				Key    : key
			});

			const url = await getSignedUrl(this._client, command, { expiresIn: 86400 }); // 24 hours

			return url;
		}
		catch (error)
		{
			logger.error(`Failed to generate presigned URL: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get the S3 URI for MediaConvert input
	 * @param {string} key - S3 object key
	 * @returns {string} S3 URI (s3://bucket/key)
	 */
	getS3Uri(key)
	{
		return `s3://${this._bucket}/${key}`;
	}

	/**
	 * Get bucket name
	 */
	getBucket()
	{
		return this._bucket;
	}

	/**
	 * Get region
	 */
	getRegion()
	{
		return this._region;
	}
}

module.exports = S3UploadService;
