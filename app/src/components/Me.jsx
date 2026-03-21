import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import ReactTooltip from 'react-tooltip';
import * as appPropTypes from './appPropTypes';
import { withRoomContext } from '../RoomContext';
import * as stateActions from '../redux/stateActions';
import PeerView from './PeerView';

class Me extends React.Component {
	constructor(props) {
		super(props);

		this._mounted = false;
		this._rootNode = null;
	}

	render() {
		const {
			me,
			audioProducer,
			videoProducer,
			faceDetection,
			onSetStatsPeerId,
		} = this.props;

		const videoVisible = Boolean(videoProducer) && !videoProducer.paused;

		let micState;

		if (!audioProducer) micState = 'off';
		else if (!audioProducer.paused) micState = 'on';
		else micState = 'off';

		return (
			<div
				data-component="Me"
				ref={node => (this._rootNode = node)}
			>
				{/* Mic off indicator */}
				{micState === 'off' && (
					<div className="mic-off-badge">
						<div className="icon" />
					</div>
				)}

				<PeerView
					isMe
					peer={me}
					audioProducerId={audioProducer ? audioProducer.id : null}
					videoProducerId={videoProducer ? videoProducer.id : null}
					audioRtpParameters={
						audioProducer ? audioProducer.rtpParameters : null
					}
					videoRtpParameters={
						videoProducer ? videoProducer.rtpParameters : null
					}
					audioTrack={audioProducer ? audioProducer.track : null}
					videoTrack={videoProducer ? videoProducer.track : null}
					videoVisible={videoVisible}
					audioCodec={audioProducer ? audioProducer.codec : null}
					videoCodec={videoProducer ? videoProducer.codec : null}
					audioScore={audioProducer ? audioProducer.score : null}
					videoScore={videoProducer ? videoProducer.score : null}
					faceDetection={faceDetection}
					onChangeDisplayName={displayName => {
						this.props.roomClient.changeDisplayName(displayName);
					}}
					onChangeMaxSendingSpatialLayer={spatialLayer => {
						this.props.roomClient.setMaxSendingSpatialLayer(spatialLayer);
					}}
					onStatsClick={onSetStatsPeerId}
				/>

				<ReactTooltip
					type="light"
					effect="solid"
					delayShow={100}
					delayHide={100}
					delayUpdate={50}
				/>
			</div>
		);
	}

	componentDidMount() {
		this._mounted = true;
	}

	componentWillUnmount() {
		this._mounted = false;
	}
}

Me.propTypes = {
	roomClient: PropTypes.any.isRequired,
	me: appPropTypes.Me.isRequired,
	audioProducer: appPropTypes.Producer,
	videoProducer: appPropTypes.Producer,
	faceDetection: PropTypes.bool.isRequired,
	onSetStatsPeerId: PropTypes.func.isRequired,
};

const mapStateToProps = state => {
	const producersArray = Object.values(state.producers);
	const audioProducer = producersArray.find(
		producer => producer.track.kind === 'audio'
	);
	// Webcam (non-share) as primary video.
	const webcamProducer = producersArray.find(
		producer => producer.track.kind === 'video' && producer.type !== 'share'
	);
	const shareProducer = producersArray.find(
		producer => producer.track.kind === 'video' && producer.type === 'share'
	);
	const videoProducer = webcamProducer || shareProducer;

	return {
		me: state.me,
		audioProducer,
		videoProducer,
		faceDetection: state.room.faceDetection,
	};
};

const mapDispatchToProps = dispatch => {
	return {
		onSetStatsPeerId: peerId =>
			dispatch(stateActions.setRoomStatsPeerId(peerId)),
	};
};

const MeContainer = withRoomContext(
	connect(mapStateToProps, mapDispatchToProps)(Me)
);

export default MeContainer;
