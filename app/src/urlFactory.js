import qs from 'qs';

let protooPort = 4443;

if (window.location.hostname === 'test.mediasoup.org') 
{
	protooPort = 4444;
}

const hostname = window.location.hostname;
const protocol = 'wss';

// const hostname = 'v3demo.mediasoup.org'
// const hostname = 'calling-sfu-qa.zillit.com'
// const protocol = 'ws'

export function getProtooUrl(params) 
{
	const query = qs.stringify(params);

	return `${protocol}://${hostname}:${protooPort}/?${query}`;
}

// for testing QA purpose only

// if (window.location.hostname === 'test.mediasoup.org') 
// {
// 	protooPort = 4444;
// }

// // const hostname = window.location.hostname;
// const protocol = 'wss';

// // const hostname = 'v3demo.mediasoup.org'
// const hostname = 'calling-sfu-qa.zillit.com';
// // const protocol = 'ws'

// export function getProtooUrl(params) 
// {
// 	const query = qs.stringify(params);

// 	return `${protocol}://${hostname}/?${query}`;
// }
