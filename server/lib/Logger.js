const debug = require('debug');
const fs = require('fs');
const path = require('path');
const util = require('util');

const APP_NAME = 'mediasoup-demo-server';

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir))
{
	fs.mkdirSync(logsDir, { recursive: true });
}

// Create a unique log file with timestamp for this server session
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFilePath = path.join(logsDir, `server-${timestamp}.log`);

// Create write stream for log file
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// Log startup message
logStream.write(`\n${'='.repeat(80)}\n`);
logStream.write(`Server started at: ${new Date().toISOString()}\n`);
logStream.write(`Log file: ${logFilePath}\n`);
logStream.write(`${'='.repeat(80)}\n\n`);

// Helper function to write to both console and file
function createLogFunction(originalFn, level)
{
	return function(...args)
	{
		// Format the message
		const formattedArgs = args.map((arg) =>
		{
			if (typeof arg === 'object')
			{
				return util.inspect(arg, { depth: 3, colors: false });
			}

			return arg;
		});
		
		const message = formattedArgs.join(' ');
		const timestampStr = new Date().toISOString();
		const logLine = `[${timestampStr}] [${level}] ${message}\n`;
		
		// Write to file
		logStream.write(logLine);
		
		// Call original console function
		originalFn.apply(console, args);
	};
}

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

		const prefixStr = prefix ? `[${prefix}]` : '';

		/* eslint-disable no-console */
		this._debug.log = createLogFunction(console.info.bind(console), `DEBUG${prefixStr}`);
		this._info.log = createLogFunction(console.info.bind(console), `INFO${prefixStr}`);
		this._warn.log = createLogFunction(console.warn.bind(console), `WARN${prefixStr}`);
		this._error.log = createLogFunction(console.error.bind(console), `ERROR${prefixStr}`);
		/* eslint-enable no-console */
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

// Export log file path for reference
Logger.logFilePath = logFilePath;

// Graceful shutdown - close log stream
process.on('exit', () =>
{
	logStream.write(`\nServer stopped at: ${new Date().toISOString()}\n`);
	logStream.end();
});

module.exports = Logger;
