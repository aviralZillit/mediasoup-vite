import qs from 'qs';

/**
 * Backend connection configuration.
 *
 * Set VITE_BACKEND_URL in your .env file:
 *
 *   VITE_BACKEND_URL=local          → wss://localhost:4443  (self-signed cert)
 *   VITE_BACKEND_URL=dev            → wss://meet-dev.zillit.com
 *   VITE_BACKEND_URL=qa             → wss://meet-qa.zillit.com
 *   VITE_BACKEND_URL=prod           → wss://meet.zillit.com
 *   VITE_BACKEND_URL=wss://custom   → custom full URL
 *
 * If not set, defaults to current window.location (original behavior).
 */

const ENV_BACKENDS = {
	local : { protocol: 'wss', hostname: 'localhost',            port: 4443 },
	dev   : { protocol: 'wss', hostname: 'meet-dev.zillit.com', port: null },
	qa    : { protocol: 'wss', hostname: 'meet-qa.zillit.com',  port: null },
	prod  : { protocol: 'wss', hostname: 'meet.zillit.com',     port: null },
};

function _resolveBackend()
{
	const envVal = (import.meta.env.VITE_BACKEND_URL || '').trim().toLowerCase();

	// 1) Named shortcut: local / dev / qa / prod
	if (ENV_BACKENDS[envVal])
	{
		return ENV_BACKENDS[envVal];
	}

	// 2) Full URL: wss://custom.example.com:4443
	if (envVal && (envVal.startsWith('wss://') || envVal.startsWith('ws://')))
	{
		try
		{
			const url = new URL(envVal);

			return {
				protocol : url.protocol.replace(':', ''),  // 'wss' or 'ws'
				hostname : url.hostname,
				port     : url.port ? Number(url.port) : null,
			};
		}
		catch (e)
		{
			console.warn('[urlFactory] Invalid VITE_BACKEND_URL:', envVal);
		}
	}

	// 3) Default: use current browser location (original behavior).
	const isLocalhost = window.location.hostname === 'localhost' ||
		window.location.hostname === '127.0.0.1';

	return {
		protocol : 'wss',
		hostname : window.location.hostname,
		port     : isLocalhost ? 4443 : null,
	};
}

const backend = _resolveBackend();

console.log(
	'[urlFactory] Backend: %s://%s%s',
	backend.protocol,
	backend.hostname,
	backend.port ? `:${backend.port}` : ''
);

export function getProtooUrl(params)
{
	const query = qs.stringify(params);
	const portPart = backend.port ? `:${backend.port}` : '';

	return `${backend.protocol}://${backend.hostname}${portPart}/?${query}`;
}
