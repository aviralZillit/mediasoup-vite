/**
 * MediaConvertService - Submits jobs to AWS MediaConvert for high-quality encoding
 * 
 * Flow:
 * 1. Local FFmpeg composes individual streams → composed.mp4 (fast, lower quality)
 * 2. Upload composed.mp4 to S3
 * 3. MediaConvert re-encodes → high-quality.mp4 (professional encoding)
 */

const Logger = require('./Logger');

const logger = new Logger('MediaConvertService');

// AWS SDK v3 - will be loaded dynamically
let MediaConvertClient, CreateJobCommand, GetJobCommand, DescribeEndpointsCommand;

class MediaConvertService
{
	constructor(options = {})
	{
		this._region = options.region || process.env.AWS_REGION || 'us-east-1';
		this._endpoint = options.endpoint || process.env.MEDIACONVERT_ENDPOINT || null;
		this._roleArn = options.roleArn || process.env.MEDIACONVERT_ROLE_ARN;
		this._outputBucket = options.outputBucket || process.env.AWS_S3_BUCKET || 'mediasoup-recordings';
		this._outputPrefix = options.outputPrefix || 'encoded/';
		this._client = null;
		this._initialized = false;
	}

	async _ensureInitialized()
	{
		if (this._initialized) return;

		try
		{
			// Dynamically import AWS SDK v3
			const mediaConvertModule = await import('@aws-sdk/client-mediaconvert');

			MediaConvertClient = mediaConvertModule.MediaConvertClient;
			CreateJobCommand = mediaConvertModule.CreateJobCommand;
			GetJobCommand = mediaConvertModule.GetJobCommand;
			DescribeEndpointsCommand = mediaConvertModule.DescribeEndpointsCommand;

			// First, get the account-specific endpoint if not provided
			if (!this._endpoint)
			{
				const describeClient = new MediaConvertClient({ region: this._region });
				const describeCommand = new DescribeEndpointsCommand({ MaxResults: 1 });
				const response = await describeClient.send(describeCommand);

				if (response.Endpoints && response.Endpoints.length > 0)
				{
					this._endpoint = response.Endpoints[0].Url;
					logger.info(`MediaConvert endpoint discovered: ${this._endpoint}`);
				}
				else
				{
					throw new Error('Could not discover MediaConvert endpoint');
				}
			}

			// Create client with the specific endpoint
			this._client = new MediaConvertClient({
				region   : this._region,
				endpoint : this._endpoint
			});

			this._initialized = true;
			logger.info(`MediaConvert client initialized`);
		}
		catch (error)
		{
			logger.error(`Failed to initialize MediaConvert client: ${error.message}`);
			throw new Error(`AWS SDK not available or MediaConvert not configured. Install with: npm install @aws-sdk/client-mediaconvert`);
		}
	}

	/**
	 * Submit a transcoding job to MediaConvert
	 * @param {Object} options
	 * @param {string} options.inputS3Uri - S3 URI of input video (s3://bucket/key)
	 * @param {string} options.outputKey - Output key prefix in S3
	 * @param {string} options.jobName - Name for the job
	 * @param {Object} options.settings - Optional custom settings
	 * @returns {Promise<{jobId: string, status: string, outputUri: string}>}
	 */
	async submitJob(options)
	{
		await this._ensureInitialized();

		const { inputS3Uri, outputKey, jobName = 'mediasoup-recording' } = options;

		if (!this._roleArn)
		{
			throw new Error('MediaConvert Role ARN not configured. Set MEDIACONVERT_ROLE_ARN environment variable.');
		}

		const outputDestination = `s3://${this._outputBucket}/${this._outputPrefix}${outputKey}/`;

		logger.info(`\n${'='.repeat(60)}`);
		logger.info('🎬 SUBMITTING MEDIACONVERT JOB');
		logger.info('='.repeat(60));
		logger.info(`Input: ${inputS3Uri}`);
		logger.info(`Output: ${outputDestination}`);

		const jobSettings = this._buildJobSettings(inputS3Uri, outputDestination);

		try
		{
			const command = new CreateJobCommand({
				Role     : this._roleArn,
				Settings : jobSettings,
				UserMetadata : {
					jobName   : jobName,
					createdAt : new Date().toISOString()
				},
				// Use on-demand queue (default) or specify a reserved queue
				Queue : options.queue || 'Default'
			});

			const response = await this._client.send(command);

			const jobId = response.Job.Id;
			const status = response.Job.Status;

			logger.info(`✅ Job submitted successfully`);
			logger.info(`   Job ID: ${jobId}`);
			logger.info(`   Status: ${status}`);

			return {
				jobId           : jobId,
				status          : status,
				outputUri       : outputDestination,
				outputBucket    : this._outputBucket,
				outputKeyPrefix : `${this._outputPrefix}${outputKey}/`
			};
		}
		catch (error)
		{
			logger.error(`Failed to submit MediaConvert job: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get the status of a MediaConvert job
	 * @param {string} jobId - The job ID
	 * @returns {Promise<{status: string, progress: number, outputUri: string}>}
	 */
	async getJobStatus(jobId)
	{
		await this._ensureInitialized();

		try
		{
			const command = new GetJobCommand({ Id: jobId });
			const response = await this._client.send(command);

			const job = response.Job;

			return {
				jobId            : job.Id,
				status           : job.Status,
				progress         : job.JobPercentComplete || 0,
				errorMessage     : job.ErrorMessage || null,
				outputGroupDetails : job.OutputGroupDetails || [],
				createdAt        : job.CreatedAt,
				finishedAt       : job.FinishedAt
			};
		}
		catch (error)
		{
			logger.error(`Failed to get job status: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Wait for a job to complete (polling)
	 * @param {string} jobId - The job ID
	 * @param {number} timeoutMs - Maximum time to wait (default: 30 minutes)
	 * @param {number} pollIntervalMs - Polling interval (default: 10 seconds)
	 * @returns {Promise<{status: string, outputUri: string}>}
	 */
	async waitForJobCompletion(jobId, timeoutMs = 1800000, pollIntervalMs = 10000)
	{
		const startTime = Date.now();

		logger.info(`Waiting for job ${jobId} to complete...`);

		while (Date.now() - startTime < timeoutMs)
		{
			const status = await this.getJobStatus(jobId);

			logger.info(`  Job ${jobId}: ${status.status} (${status.progress}%)`);

			if (status.status === 'COMPLETE')
			{
				logger.info(`✅ Job ${jobId} completed successfully`);

				return status;
			}

			if (status.status === 'ERROR' || status.status === 'CANCELED')
			{
				throw new Error(`Job ${jobId} failed with status: ${status.status}. ${status.errorMessage || ''}`);
			}

			await this._sleep(pollIntervalMs);
		}

		throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000} seconds`);
	}

	/**
	 * Build MediaConvert job settings for high-quality H.264 output
	 * @private
	 */
	_buildJobSettings(inputS3Uri, outputDestination)
	{
		return {
			Inputs : [
				{
					FileInput      : inputS3Uri,
					AudioSelectors : {
						'Audio Selector 1' : {
							DefaultSelection : 'DEFAULT'
						}
					},
					VideoSelector : {
						ColorSpace : 'FOLLOW'
					},
					TimecodeSource : 'ZEROBASED'
				}
			],
			OutputGroups : [
				{
					Name                  : 'File Group',
					OutputGroupSettings : {
						Type              : 'FILE_GROUP_SETTINGS',
						FileGroupSettings : {
							Destination : outputDestination
						}
					},
					Outputs : [
						{
							// High-quality MP4 output
							NameModifier   : '-hq',
							ContainerSettings : {
								Container   : 'MP4',
								Mp4Settings : {
									CslgAtom      : 'INCLUDE',
									FreeSpaceBox  : 'EXCLUDE',
									MoovPlacement : 'PROGRESSIVE_DOWNLOAD'
								}
							},
							VideoDescription : {
								CodecSettings : {
									Codec         : 'H_264',
									H264Settings : {
										// High quality settings
										RateControlMode    : 'QVBR',
										QvbrSettings       : {
											QvbrQualityLevel : 8  // 1-10, higher = better quality
										},
										MaxBitrate         : 8000000,  // 8 Mbps max
										CodecProfile       : 'HIGH',
										CodecLevel         : 'AUTO',
										InterlaceMode      : 'PROGRESSIVE',
										ParControl         : 'SPECIFIED',
										ParNumerator       : 1,
										ParDenominator     : 1,
										NumberBFramesBetweenReferenceFrames : 2,
										GopSize            : 90,
										GopSizeUnits       : 'FRAMES',
										GopClosedCadence   : 1,
										EntropyEncoding    : 'CABAC',
										Syntax             : 'DEFAULT',
										FramerateControl   : 'INITIALIZE_FROM_SOURCE',
										AdaptiveQuantization : 'HIGH',
										SceneChangeDetect  : 'ENABLED',
										QualityTuningLevel : 'SINGLE_PASS_HQ',
										SlowPal            : 'DISABLED',
										SpatialAdaptiveQuantization : 'ENABLED',
										TemporalAdaptiveQuantization : 'ENABLED',
										FlickerAdaptiveQuantization : 'ENABLED',
										Softness           : 0,
										Telecine           : 'NONE',
										MinIInterval       : 0,
										NumberReferenceFrames : 3
									}
								},
								Width  : 1920,
								Height : 1080,
								ScalingBehavior : 'DEFAULT',
								AntiAlias : 'ENABLED',
								Sharpness : 50,
								TimecodeInsertion : 'DISABLED',
								ColorMetadata : 'INSERT',
								RespondToAfd : 'NONE',
								AfdSignaling : 'NONE',
								DropFrameTimecode : 'ENABLED'
							},
							AudioDescriptions : [
								{
									AudioSourceName   : 'Audio Selector 1',
									CodecSettings     : {
										Codec        : 'AAC',
										AacSettings : {
											Bitrate         : 192000,  // 192 kbps
											CodingMode      : 'CODING_MODE_2_0',
											SampleRate      : 48000,
											RateControlMode : 'CBR',
											Specification   : 'MPEG4'
										}
									},
									AudioTypeControl : 'FOLLOW_INPUT',
									LanguageCodeControl : 'FOLLOW_INPUT'
								}
							]
						}
					]
				}
			],
			TimecodeConfig : {
				Source : 'ZEROBASED'
			}
		};
	}

	_sleep(ms)
	{
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

module.exports = MediaConvertService;
