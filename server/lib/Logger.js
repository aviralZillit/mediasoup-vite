const debug = require('debug');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'mediasoup-server';

class Logger
{
	constructor(prefix)
	{
		if (prefix)
		{
			this._debug = debug(`${APP_NAME}:${prefix}`);
			this._info = debug(`${APP_NAME}:INFO:${prefix}`);
			this._warn = debug(`${APP_NAME}:WARN:${prefix}`);
			this._error = debug(`${APP_NAME}:ERROR:${prefix}`);
		}
		else
		{
			this._debug = debug(APP_NAME);
			this._info = debug(`${APP_NAME}:INFO`);
			this._warn = debug(`${APP_NAME}:WARN`);
			this._error = debug(`${APP_NAME}:ERROR`);
		}

		// Enhanced logging with file output
		this._setupFileLogging();

		/* eslint-disable no-console */
		this._debug.log = console.info.bind(console);
		this._info.log = this._enhancedLog.bind(this, 'INFO');
		this._warn.log = this._enhancedLog.bind(this, 'WARN');
		this._error.log = this._enhancedLog.bind(this, 'ERROR');
		/* eslint-enable no-console */
	}

	/**
	 * Setup file logging for important events
	 * 
	 * @private
	 */
	_setupFileLogging()
	{
		// Create logs directory if it doesn't exist
		const logsDir = path.join(__dirname, '..', 'logs');
		
		if (!fs.existsSync(logsDir))
		{
			fs.mkdirSync(logsDir, { recursive: true });
		}

		// Create log file path
		const today = new Date()
			.toISOString()
			.split('T')[0];
		
		this._logFilePath = path.join(logsDir, `mediasoup-${today}.log`);
	}

	/**
	 * Enhanced logging function with file output
	 * 
	 * @private
	 * @param {String} level - Log level
	 * @param {String} message - Log message
	 */
	_enhancedLog(level, message)
	{
		const timestamp = new Date().toISOString();
		const logEntry = `[${timestamp}] [${level}] ${message}\n`;

		/* eslint-disable no-console */
		// Console output
		if (level === 'ERROR')
		{
			console.error(message);
		}
		else if (level === 'WARN')
		{
			console.warn(message);
		}
		else
		{
			console.info(message);
		}
		/* eslint-enable no-console */

		// File output for WARN and ERROR levels
		if (level === 'WARN' || level === 'ERROR')
		{
			try
			{
				fs.appendFileSync(this._logFilePath, logEntry);
			}
			catch (error)
			{
				/* eslint-disable no-console */
				console.error('Failed to write to log file:', error);
				/* eslint-enable no-console */
			}
		}
	}

	/**
	 * Log performance metrics
	 * 
	 * @param {String} operation - Operation name
	 * @param {Number} duration - Duration in milliseconds
	 * @param {Object} metadata - Additional metadata
	 */
	logPerformance(operation, duration, metadata = {})
	{
		const perfLog = {
			timestamp : new Date().toISOString(),
			operation,
			duration,
			...metadata
		};

		this._info(`Performance: ${JSON.stringify(perfLog)}`);
	}

	/**
	 * Log connection events
	 * 
	 * @param {String} event - Event type
	 * @param {String} peerId - Peer ID
	 * @param {Object} details - Event details
	 */
	logConnection(event, peerId, details = {})
	{
		const connLog = {
			timestamp : new Date().toISOString(),
			event,
			peerId,
			...details
		};

		this._info(`Connection: ${JSON.stringify(connLog)}`);
	}

	/**
	 * Log error with stack trace and context
	 * 
	 * @param {String} message - Error message
	 * @param {Error} error - Error object
	 * @param {Object} context - Additional context
	 */
	logError(message, error, context = {})
	{
		const errorLog = {
			timestamp : new Date().toISOString(),
			message,
			error     : error.message,
			stack     : error.stack,
			...context
		};

		this._error(`Error: ${JSON.stringify(errorLog, null, 2)}`);
	}

	get debug()
	{
		return this._debug;
	}

	get info()
	{
		return this._info;
	}

	get warn()
	{
		return this._warn;
	}

	get error()
	{
		return this._error;
	}
}

module.exports = Logger;
