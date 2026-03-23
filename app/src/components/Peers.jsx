import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import classnames from 'classnames';
import * as appPropTypes from './appPropTypes';
import Peer from './Peer';
import PeerView from './PeerView';

// Error boundary to prevent crashes from taking down the whole page.
class PeersBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { hasError: false };
	}

	static getDerivedStateFromError() {
		return { hasError: true };
	}

	componentDidCatch(error, info) {
		console.error('Peers error boundary caught:', error, info);
	}

	render() {
		if (this.state.hasError) {
			return <div style={{ color: '#888', textAlign: 'center', paddingTop: 40 }}>Video layout error — try refreshing</div>;
		}

		return this.props.children;
	}
}

const Peers = ({
	peers,
	activeSpeakerId,
	screenShareConsumer,
	screenSharePeer,
	localShareProducer,
	me,
}) => {
	const isScreenSharing = Boolean(screenShareConsumer) || Boolean(localShareProducer);

	// ---- PRESENTATION MODE ----
	if (isScreenSharing) {
		let shareTrack = null;
		let shareLabel = '';
		let shareConsumerProps = null;

		const dummyDevice = { flag: 'chrome', name: 'Screen', version: '' };

		if (screenShareConsumer && screenSharePeer) {
			shareTrack = screenShareConsumer.track;
			shareLabel = `${screenSharePeer.displayName || 'Peer'} (Screen)`;
			shareConsumerProps = screenShareConsumer;
		} else if (localShareProducer) {
			shareTrack = localShareProducer.track;
			shareLabel = `${me.displayName || 'You'} (Screen)`;
		}

		const sharePeer = {
			id          : 'screen-share',
			displayName : shareLabel,
			device      : dummyDevice,
		};

		const noop = () => {};

		return (
			<div data-component="Peers" className="presentation-mode">
				<div className="share-main">
					<PeersBoundary>
						{shareConsumerProps ? (
							<PeerView
								peer={sharePeer}
								hideInfo
								videoConsumerId={shareConsumerProps.id}
								videoRtpParameters={shareConsumerProps.rtpParameters}
								consumerSpatialLayers={shareConsumerProps.spatialLayers}
								consumerTemporalLayers={shareConsumerProps.temporalLayers}
								consumerCurrentSpatialLayer={shareConsumerProps.currentSpatialLayer}
								consumerCurrentTemporalLayer={shareConsumerProps.currentTemporalLayer}
								consumerPreferredSpatialLayer={shareConsumerProps.preferredSpatialLayer}
								consumerPreferredTemporalLayer={shareConsumerProps.preferredTemporalLayer}
								consumerPriority={shareConsumerProps.priority}
								videoTrack={shareTrack}
								videoVisible={true}
								videoMultiLayer={shareConsumerProps.type !== 'simple'}
								videoCodec={shareConsumerProps.codec}
								videoScore={shareConsumerProps.score}
								faceDetection={false}
							/>
						) : (
							<PeerView
								isMe
								peer={sharePeer}
								hideInfo
								videoProducerId={localShareProducer ? localShareProducer.id : null}
								videoTrack={shareTrack}
								videoVisible={true}
								faceDetection={false}
							/>
						)}
					</PeersBoundary>
				</div>

				<div className="sidebar-strip">
					{peers.map(peer => (
						<div
							key={peer.id}
							className={classnames('thumbnail', {
								'active-speaker': peer.id === activeSpeakerId,
							})}
						>
							<Peer id={peer.id} />
						</div>
					))}
				</div>
			</div>
		);
	}

	// ---- GRID MODE ----
	const count = peers.length;
	let gridClass;

	if (count <= 1) gridClass = 'grid-1';
	else if (count === 2) gridClass = 'grid-2';
	else if (count === 3) gridClass = 'grid-3';
	else if (count === 4) gridClass = 'grid-4';
	else if (count <= 6) gridClass = 'grid-6';
	else if (count <= 9) gridClass = 'grid-9';
	else gridClass = 'grid-many';

	return (
		<div data-component="Peers" className={gridClass}>
			{peers.map(peer => (
				<div
					key={peer.id}
					className={classnames('peer-container', {
						'active-speaker': peer.id === activeSpeakerId,
					})}
				>
					<Peer id={peer.id} />
				</div>
			))}
		</div>
	);
};

Peers.propTypes = {
	peers: PropTypes.arrayOf(appPropTypes.Peer).isRequired,
	activeSpeakerId: PropTypes.string,
	screenShareConsumer: PropTypes.object,
	screenSharePeer: PropTypes.object,
	localShareProducer: PropTypes.object,
	me: PropTypes.object,
};

const mapStateToProps = state => {
	const peersArray = Object.values(state.peers);

	let screenShareConsumer = null;
	let screenSharePeer = null;

	for (const peer of peersArray) {
		for (const consumerId of peer.consumers) {
			const consumer = state.consumers[consumerId];

			if (
				consumer &&
				consumer.track?.kind === 'video' &&
				consumer.track?.readyState !== 'ended' &&
				consumer.appData?.share
			) {
				screenShareConsumer = consumer;
				screenSharePeer = peer;
				break;
			}
		}

		if (screenShareConsumer) break;
	}

	const producersArray = Object.values(state.producers);
	const localShareProducer = producersArray.find(
		p => p.track?.kind === 'video' && p.track?.readyState !== 'ended' && p.type === 'share'
	) || null;

	return {
		peers: peersArray,
		activeSpeakerId: state.room.activeSpeakerId,
		screenShareConsumer,
		screenSharePeer,
		localShareProducer,
		me: state.me,
	};
};

const PeersContainer = connect(mapStateToProps, null, null, {
	areStatesEqual: (next, prev) => {
		// Only re-render when structure changes (peers/consumers added/removed),
		// NOT when consumer scores update. Score updates create new consumer
		// objects but don't change the track or layout — re-rendering causes
		// video flicker because the entire Peers tree re-renders.
		return (
			prev.peers === next.peers &&
			prev.room.activeSpeakerId === next.room.activeSpeakerId &&
			prev.consumers === next.consumers &&
			prev.producers === next.producers &&
			prev.me === next.me
		);
	},
})(Peers);

export default PeersContainer;
