import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import classnames from 'classnames';
import * as appPropTypes from './appPropTypes';
import { withRoomContext } from '../RoomContext';
import * as stateActions from '../redux/stateActions';
import PeerView from './PeerView';

const Peer = props => {
	const {
		roomClient,
		peer,
		audioConsumer,
		videoConsumer,
		shareConsumer,
		audioMuted,
		faceDetection,
		isPinned,
		onSetStatsPeerId,
		showShare,
		showWebcam,
	} = props;

	const audioEnabled =
		Boolean(audioConsumer) &&
		!audioConsumer.locallyPaused &&
		!audioConsumer.remotelyPaused;

	const videoVisible =
		Boolean(videoConsumer) &&
		!videoConsumer.locallyPaused &&
		!videoConsumer.remotelyPaused;

	const shareVisible =
		Boolean(shareConsumer) &&
		!shareConsumer.locallyPaused &&
		!shareConsumer.remotelyPaused;

	// Handle pin toggle - calls server to sync with all peers
	const handlePinToggle = async () => {
		const tileId = showShare ? `${peer.id}-share` : peer.id;
		
		if (isPinned) {
			// Unpin
			await roomClient.unpinPeer();
		} else {
			// Pin this tile
			await roomClient.pinPeer(tileId);
			
			// Boost video quality for the pinned content
			const consumer = showShare ? shareConsumer : videoConsumer;
			if (consumer && consumer.spatialLayers > 1) {
				const maxSpatialLayer = consumer.spatialLayers - 1;
				const maxTemporalLayer = consumer.temporalLayers - 1;
				roomClient.setConsumerPreferredLayers(
					consumer.id,
					maxSpatialLayer,
					maxTemporalLayer
				);
				roomClient.setConsumerPriority(consumer.id, 255);
			}
		}
	};

	// Determine which consumer to show based on props
	const activeConsumer = showShare ? shareConsumer : videoConsumer;
	const isVideoVisible = showShare ? shareVisible : videoVisible;
	const displayName = showShare ? `${peer.displayName}'s Screen` : peer.displayName;

	return (
		<div data-component="Peer">
			<div className="indicators">
				{/* Only show audio indicator on webcam tile */}
				{!showShare && !audioEnabled && <div className="icon mic-off" />}
				{!activeConsumer && <div className="icon webcam-off" />}
			</div>

			<PeerView
				peer={{ ...peer, displayName }}
				isPinned={isPinned}
				onPinToggle={handlePinToggle}
				audioConsumerId={!showShare && audioConsumer ? audioConsumer.id : null}
				videoConsumerId={activeConsumer ? activeConsumer.id : null}
				audioRtpParameters={!showShare && audioConsumer ? audioConsumer.rtpParameters : null}
				videoRtpParameters={activeConsumer ? activeConsumer.rtpParameters : null}
				consumerSpatialLayers={
					activeConsumer ? activeConsumer.spatialLayers : null
				}
				consumerTemporalLayers={
					activeConsumer ? activeConsumer.temporalLayers : null
				}
				consumerCurrentSpatialLayer={
					activeConsumer ? activeConsumer.currentSpatialLayer : null
				}
				consumerCurrentTemporalLayer={
					activeConsumer ? activeConsumer.currentTemporalLayer : null
				}
				consumerPreferredSpatialLayer={
					activeConsumer ? activeConsumer.preferredSpatialLayer : null
				}
				consumerPreferredTemporalLayer={
					activeConsumer ? activeConsumer.preferredTemporalLayer : null
				}
				consumerPriority={activeConsumer ? activeConsumer.priority : null}
				audioTrack={!showShare && audioConsumer ? audioConsumer.track : null}
				videoTrack={activeConsumer ? activeConsumer.track : null}
				audioMuted={audioMuted}
				videoVisible={isVideoVisible}
				videoMultiLayer={activeConsumer && activeConsumer.type !== 'simple'}
				audioCodec={!showShare && audioConsumer ? audioConsumer.codec : null}
				videoCodec={activeConsumer ? activeConsumer.codec : null}
				audioScore={!showShare && audioConsumer ? audioConsumer.score : null}
				videoScore={activeConsumer ? activeConsumer.score : null}
				faceDetection={showShare ? false : faceDetection}
				isScreenShare={showShare}
				onChangeVideoPreferredLayers={(spatialLayer, temporalLayer) => {
					if (activeConsumer) {
						roomClient.setConsumerPreferredLayers(
							activeConsumer.id,
							spatialLayer,
							temporalLayer
						);
					}
				}}
				onChangeVideoPriority={priority => {
					if (activeConsumer) {
						roomClient.setConsumerPriority(activeConsumer.id, priority);
					}
				}}
				onRequestKeyFrame={() => {
					if (activeConsumer) {
						roomClient.requestConsumerKeyFrame(activeConsumer.id);
					}
				}}
				onStatsClick={onSetStatsPeerId}
			/>
		</div>
	);
};

Peer.propTypes = {
	roomClient: PropTypes.any.isRequired,
	peer: appPropTypes.Peer.isRequired,
	audioConsumer: appPropTypes.Consumer,
	videoConsumer: appPropTypes.Consumer,
	shareConsumer: appPropTypes.Consumer,
	audioMuted: PropTypes.bool,
	faceDetection: PropTypes.bool.isRequired,
	isPinned: PropTypes.bool.isRequired,
	onSetStatsPeerId: PropTypes.func.isRequired,
	showShare: PropTypes.bool,
	showWebcam: PropTypes.bool,
};

Peer.defaultProps = {
	showShare: false,
	showWebcam: true,
};

const mapStateToProps = (state, { id, showShare }) => {
	const me = state.me;
	const peer = state.peers[id];
	const consumersArray = peer.consumers.map(
		consumerId => state.consumers[consumerId]
	);
	const audioConsumer = consumersArray.find(
		consumer => consumer && consumer.track?.kind === 'audio'
	);
	// Webcam consumer (video that is NOT share)
	const videoConsumer = consumersArray.find(
		consumer => consumer && consumer.track?.kind === 'video' && !consumer.appData?.share
	);
	// Screen share consumer
	const shareConsumer = consumersArray.find(
		consumer => consumer && consumer.track?.kind === 'video' && consumer.appData?.share
	);

	// Determine the tile ID for pinning
	const tileId = showShare ? `${id}-share` : id;

	return {
		peer,
		audioConsumer,
		videoConsumer,
		shareConsumer,
		audioMuted: me.audioMuted,
		faceDetection: state.room.faceDetection,
		isPinned: state.room.pinnedPeerId === tileId,
	};
};

const mapDispatchToProps = dispatch => {
	return {
		onSetStatsPeerId: peerId =>
			dispatch(stateActions.setRoomStatsPeerId(peerId)),
	};
};

const PeerContainer = withRoomContext(
	connect(mapStateToProps, mapDispatchToProps)(Peer)
);

export default PeerContainer;
