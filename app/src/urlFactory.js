import qs from 'qs';

/**
 * Backend connection — driven by NODE_ENV.
 *
 * Usage (in app/.env):
 *   VITE_NODE_ENV=local   → ws://localhost:4443
 *   VITE_NODE_ENV=dev     → wss://meet-dev.zillit.com
 *   VITE_NODE_ENV=qa      → wss://meet-qa.zillit.com
 *   VITE_NODE_ENV=prod    → wss://meet.zillit.com
 */

const BACKENDS = {
	local : { protocol: 'ws', hostname: 'localhost',                   port: 4443 },
	dev   : { protocol: 'wss', hostname: 'mediasoup-dev.zillit.com',  port: null },
	qa    : { protocol: 'wss', hostname: 'calling-sfu-qa.zillit.com',  port: null },
	prod  : { protocol: 'wss', hostname: 'calling-sfu-prod.zillit.com', port: null },
};

const env = (import.meta.env.VITE_NODE_ENV || 'local').trim().toLowerCase();
const backend = BACKENDS[env] || BACKENDS.local;

console.log('[urlFactory] ENV=%s → %s://%s%s',
	env, backend.protocol, backend.hostname,
	backend.port ? `:${backend.port}` : '');

export function getProtooUrl(params)
{
	const query = qs.stringify(params);
	const portPart = backend.port ? `:${backend.port}` : '';

	return `${backend.protocol}://${backend.hostname}${portPart}/?${query}`;
}
