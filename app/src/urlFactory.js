import qs from 'qs';

let protooPort = 4443;

if (window.location.hostname === 'test.mediasoup.org') 
{
	protooPort = 4444;
}

const hostname = window.location.hostname;
const protocol = 'wss';

// hostname = 'mediasoup-dev.zillit.com';
// const hostname = 'v3demo.mediasoup.org'
// const protocol = 'ws'

export function getProtooUrl(params) 
{
	const query = qs.stringify(params);

	return `${protocol}://${hostname}:${protooPort}/?${query}`;
}
