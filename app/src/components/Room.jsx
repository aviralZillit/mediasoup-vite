import React from 'react';
import { connect } from 'react-redux';
import PropTypes from 'prop-types';
import ReactTooltip from 'react-tooltip';
import classnames from 'classnames';
import clipboardCopy from 'clipboard-copy';
import * as appPropTypes from './appPropTypes';
import { withRoomContext } from '../RoomContext';
import * as requestActions from '../redux/requestActions';
import * as stateActions from '../redux/stateActions';
import { Appear } from './transitions';
import Me from './Me';
import ChatPanel from './ChatPanel';
import Peers from './Peers';
import Stats from './Stats';
import Notifications from './Notifications';
import NetworkThrottle from './NetworkThrottle';

class Room extends React.Component {
	constructor(props) {
		super(props);

		this.state = {
			recordingElapsed : 0,
			toolbarVisible   : true,
		};

		this._recordingTimer = null;
		this._recordingStartTime = null;
		this._hideTimer = null;
		this._handleMouseMove = this._handleMouseMove.bind(this);
	}

	render() {
		const {
			roomClient,
			room,
			me,
			amActiveSpeaker,
			onRoomLinkCopy,
			recording,
			recordingInProgress,
			recordingComposing,
			chatOpen,
			chatUnread,
			onToggleChat,
		} = this.props;

		const { recordingElapsed } = this.state;

		let micState;

		if (!me.canSendMic) micState = 'unsupported';
		else {
			const producersArray = Object.values(this.props.producers || {});
			const audioProducer = producersArray.find(
				p => p.track && p.track.kind === 'audio'
			);

			if (!audioProducer) micState = 'off';
			else if (!audioProducer.paused) micState = 'on';
			else micState = 'off';
		}

		let webcamState;

		if (!me.canSendWebcam) webcamState = 'unsupported';
		else {
			const producersArray = Object.values(this.props.producers || {});
			const videoProducer = producersArray.find(
				p => p.track && p.track.kind === 'video' && p.type !== 'share'
			);

			webcamState = videoProducer ? 'on' : 'off';
		}

		const producersArray = Object.values(this.props.producers || {});
		const shareProducer = producersArray.find(
			p => p.track && p.track.kind === 'video' && p.type === 'share'
		);
		const shareState = shareProducer ? 'on' : 'off';

		// Recorder bot mode — render ONLY the video grid, no UI chrome.
		// This is what the headless Chrome bot sees and records.
		if (window.IS_RECORDER_BOT)
		{
			return (
				<div data-component="Room" className="recorder-mode">
					<Peers />
				</div>
			);
		}

		return (
			<Appear duration={300}>
				<div data-component="Room">
					<Notifications />

					{/* Main content area + chat sidebar */}
					<div className={classnames('main-area', { 'chat-open': chatOpen })}>
						<div className="main-content">
							{/* Top bar — hides with toolbar */}
							<div className={classnames('top-bar', {
								hidden: !this.state.toolbarVisible,
							})}>
								<div className="top-left">
									<div className={classnames('status-dot', room.state)} />
									{recording && (
										<div className="rec-badge">
											<div className="rec-dot" />
											<span>REC {this._formatTime(recordingElapsed)}</span>
										</div>
									)}
									{recordingComposing && (
										<span className="composing-badge">Processing...</span>
									)}
								</div>

								<div className="top-right">
									<a
										className="invite-link"
										href={room.url}
										onClick={event => {
											if (event.ctrlKey || event.shiftKey || event.metaKey ||
												(event.button && event.button === 1)) return;
											event.preventDefault();
											clipboardCopy(room.url).then(onRoomLinkCopy);
										}}
									>
										Copy invite link
									</a>
								</div>
							</div>

							<Peers />

							{/* Self-view PIP */}
							<div className={classnames('self-view', {
								'active-speaker': amActiveSpeaker,
							})}>
								<Me />
							</div>
						</div>

						{/* Chat sidebar panel */}
						{chatOpen && (
							<div className="chat-sidebar">
								<ChatPanel onClose={onToggleChat} />
							</div>
						)}
					</div>

					{/* Bottom toolbar — auto-hides after 3s, shows on mouse move */}
					<div className={classnames('bottom-toolbar', {
						hidden: !this.state.toolbarVisible,
					})}>
						<div className="toolbar-center">
							<button
								className={classnames('toolbar-btn', 'mic', {
									off: micState !== 'on',
								})}
								data-tip={micState === 'on' ? 'Turn off microphone' : 'Turn on microphone'}
								onClick={() => {
									micState === 'on'
										? roomClient.muteMic()
										: roomClient.unmuteMic();
								}}
							>
								<div className="btn-icon" />
							</button>

							<button
								className={classnames('toolbar-btn', 'webcam', {
									off: webcamState !== 'on',
									disabled: me.webcamInProgress,
								})}
								data-tip={webcamState === 'on' ? 'Turn off camera' : 'Turn on camera'}
								onClick={() => {
									if (webcamState === 'on')
										roomClient.disableWebcam();
									else
										roomClient.enableWebcam();
								}}
							>
								<div className="btn-icon" />
							</button>

							<button
								className={classnames('toolbar-btn', 'share', {
									active: shareState === 'on',
									disabled: me.shareInProgress,
								})}
								data-tip={shareState === 'on' ? 'Stop sharing' : 'Share screen'}
								onClick={() => {
									shareState === 'on'
										? roomClient.disableShare()
										: roomClient.enableShare();
								}}
							>
								<div className="btn-icon" />
							</button>

							<button
								className={classnames('toolbar-btn', 'record', {
									active: recording,
									disabled: recordingInProgress || recordingComposing,
								})}
								data-tip={recording ? 'Stop recording' : 'Start recording'}
								onClick={() => {
									recording
										? roomClient.stopRecording()
										: roomClient.startRecording();
								}}
							>
								<div className="btn-icon" />
							</button>

							<button
								className={classnames('toolbar-btn', 'chat', {
									active: chatOpen,
								})}
								data-tip="Chat"
								onClick={onToggleChat}
							>
								<div className="btn-icon" />
								{chatUnread > 0 && (
									<span className="badge">{chatUnread}</span>
								)}
							</button>

							<button
								className="toolbar-btn hangup"
								data-tip="Leave call"
								onClick={() => roomClient.close()}
							>
								<div className="btn-icon" />
							</button>
						</div>
					</div>

					<Stats />

					{window.NETWORK_THROTTLE_SECRET && (
						<NetworkThrottle secret={window.NETWORK_THROTTLE_SECRET} />
					)}

					<ReactTooltip
						type="light"
						effect="solid"
						delayShow={100}
						delayHide={100}
						delayUpdate={50}
					/>
				</div>
			</Appear>
		);
	}

	componentDidMount() {
		const { roomClient } = this.props;

		roomClient.join();

		// Auto-hide toolbar after 3s of no mouse movement.
		document.addEventListener('mousemove', this._handleMouseMove);
		document.addEventListener('mousedown', this._handleMouseMove);

		this._hideTimer = setTimeout(() => {
			this.setState({ toolbarVisible: false });
		}, 3000);
	}

	componentDidUpdate(prevProps) {
		if (this.props.recording && !prevProps.recording) {
			this._recordingStartTime = Date.now();
			this.setState({ recordingElapsed: 0 });

			this._recordingTimer = setInterval(() => {
				this.setState({
					recordingElapsed: Math.floor(
						(Date.now() - this._recordingStartTime) / 1000
					),
				});
			}, 1000);
		} else if (!this.props.recording && prevProps.recording) {
			clearInterval(this._recordingTimer);
			this._recordingTimer = null;
			this._recordingStartTime = null;
		}
	}

	componentWillUnmount() {
		if (this._recordingTimer) {
			clearInterval(this._recordingTimer);
		}

		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
		}

		document.removeEventListener('mousemove', this._handleMouseMove);
		document.removeEventListener('mousedown', this._handleMouseMove);
	}

	_handleMouseMove() {
		// Show toolbar immediately on any mouse movement.
		if (!this.state.toolbarVisible) {
			this.setState({ toolbarVisible: true });
		}

		// Reset the hide timer.
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
		}

		this._hideTimer = setTimeout(() => {
			this.setState({ toolbarVisible: false });
		}, 3000);
	}

	_formatTime(totalSeconds) {
		const h = Math.floor(totalSeconds / 3600);
		const m = Math.floor((totalSeconds % 3600) / 60);
		const s = totalSeconds % 60;

		const pad = n => String(n).padStart(2, '0');

		return h > 0
			? `${pad(h)}:${pad(m)}:${pad(s)}`
			: `${pad(m)}:${pad(s)}`;
	}
}

Room.propTypes = {
	roomClient: PropTypes.any.isRequired,
	room: appPropTypes.Room.isRequired,
	me: appPropTypes.Me.isRequired,
	producers: PropTypes.object.isRequired,
	amActiveSpeaker: PropTypes.bool.isRequired,
	recording: PropTypes.bool.isRequired,
	recordingInProgress: PropTypes.bool.isRequired,
	recordingComposing: PropTypes.bool.isRequired,
	chatOpen: PropTypes.bool.isRequired,
	chatUnread: PropTypes.number.isRequired,
	onRoomLinkCopy: PropTypes.func.isRequired,
	onToggleChat: PropTypes.func.isRequired,
};

const mapStateToProps = state => {
	return {
		room: state.room,
		me: state.me,
		producers: state.producers,
		amActiveSpeaker: state.me.id === state.room.activeSpeakerId,
		recording: state.room.recording,
		recordingInProgress: state.room.recordingInProgress,
		recordingComposing: state.room.recordingComposing,
		chatOpen: state.room.chatOpen,
		chatUnread: state.room.chatUnread,
	};
};

const mapDispatchToProps = dispatch => {
	return {
		onRoomLinkCopy: () => {
			dispatch(
				requestActions.notify({
					text: 'Room link copied to the clipboard',
				})
			);
		},
		onToggleChat: () => {
			dispatch(stateActions.toggleChatOpen());
		},
	};
};

const RoomContainer = withRoomContext(
	connect(mapStateToProps, mapDispatchToProps)(Room)
);

export default RoomContainer;
